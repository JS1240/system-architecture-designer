import { beforeEach, describe, expect, it } from 'vitest'
import { evaluate } from '../engine/evaluate'
import { activeSuggestions, autoComplete, diffEvaluations, newSuggestions, runAndPeople, suggestFromDescription } from '../engine/explore'
import { withOverrides } from '../engine/overrides'
import { kb } from '../knowledge'
import { blankProject, cleanOverrides, migrateStore, parseProject, useProjects } from './projectStore'

const store = () => useProjects.getState()
const dau = (value: number) => ({ kind: 'value' as const, value })

describe('project store', () => {
  beforeEach(() => useProjects.setState({ projects: {}, activeId: null, whatIf: null, whatIfLabel: null, history: {} }))

  it('creates a project and keeps the description detections in suggestions, not in answers', () => {
    const id = store().createProject('Shop', 'A marketplace where buyers search the catalog and pay at checkout')
    const p = store().projects[id]
    expect(store().activeId).toBe(id)
    expect(p.answers['product.type']).toBeUndefined()
    expect(p.suggestions?.['product.type']).toEqual({ kind: 'value', value: 'commerce' })
    // Answers given at creation (the Welcome constraints) win, so their question drops out of the suggestions.
    const q = store().createProject('Shop', 'A marketplace on Azure', { 'product.type': { kind: 'value', value: 'social' } })
    expect(store().projects[q].suggestions?.['product.type']).toBeUndefined()
    expect(store().projects[q].suggestions?.['infra.cloud']).toEqual({ kind: 'value', value: 'azure' })
    expect(evaluate(kb, store().projects[q].answers).facts['infra.cloud']).toBeUndefined()
  })

  it('keeps dismissed detections out of the suggestions, across description edits and export', () => {
    const brief = 'A marketplace on Azure where buyers pay at checkout'
    const id = store().createProject('Shop', brief, {}, undefined, ['infra.cloud=azure', 'nope=1'])
    expect(store().projects[id].dismissed).toEqual(['infra.cloud=azure'])
    expect(store().projects[id].suggestions?.['infra.cloud']).toBeUndefined()
    expect(store().projects[id].suggestions?.['product.type']).toBeDefined()
    store().setDescription(`${brief}, now with chat`)
    expect(store().projects[id].suggestions?.['infra.cloud']).toBeUndefined()
    const copy = parseProject(JSON.stringify(store().projects[id]))
    expect(copy.dismissed).toEqual(['infra.cloud=azure'])
    expect(copy.suggestions?.['infra.cloud']).toBeUndefined()
    expect(parseProject(JSON.stringify({ name: 'S', answers: {}, dismissed: 'x' })).dismissed).toBeUndefined()
  })

  it('counts only the brief suggestions whose question is active once they apply', () => {
    const suggestions = suggestFromDescription(kb, 'A web app where customers see their Salesforce data in Power BI dashboards on Fabric')
    expect(suggestions['source.crm_product']).toBeDefined()
    const active = activeSuggestions(kb, {}, suggestions)
    // Not a migration, so the CRM product question stays inactive and Apply labels it 'when relevant'.
    expect(active).not.toContain('source.crm_product')
    expect(active).toContain('bi.tool')
  })

  it('validates imported suggestions like answers', () => {
    const p = parseProject(
      JSON.stringify({
        name: 'S',
        answers: { 'traffic.dau': dau(10) },
        suggestions: { 'infra.cloud': { kind: 'value', value: 'azure' }, 'bi.tool': { kind: 'value', value: 'excel' }, nope: { kind: 'value', value: 1 }, 'traffic.dau': dau(5) },
      }),
    )
    expect(p.suggestions).toEqual({ 'infra.cloud': { kind: 'value', value: 'azure' } })
    expect(parseProject(JSON.stringify({ name: 'S', suggestions: 'x', answers: {} })).suggestions).toBeUndefined()
  })

  it('re-detects suggestions when the brief changes and applies chosen ones as one undoable what-if', () => {
    store().createProject('B', '')
    store().setDescription('Lakehouse on Databricks with Power BI')
    expect(store().active()!.suggestions?.['data.platform']).toEqual({ kind: 'value', value: 'databricks' })
    const chosen = { 'project.kind': { kind: 'value' as const, value: 'data_platform' }, 'bi.tool': { kind: 'value' as const, value: 'power_bi' } }
    store().applySuggestions(chosen)
    expect(store().whatIf).toEqual(chosen)
    expect(store().active()!.answers['bi.tool']).toBeUndefined()
    store().commitWhatIf()
    expect(store().active()!.answers).toMatchObject(chosen)
    expect(store().history[store().activeId!].past).toHaveLength(1)
    store().undo()
    expect(store().active()!.answers).toEqual({})
  })

  it('opens every scenario on its own answers, not on keywords guessed from its description', () => {
    // A scenario's description is narrative ("retires its on-premises SQL Server"); Welcome passes no suggestions, so auto-design matches the engine's.
    for (const s of kb.scenarios) {
      const id = store().createProject(s.name, s.description, s.answers, {})
      store().autoCompleteActive()
      expect(store().projects[id].answers, s.id).toEqual(autoComplete(kb, s.answers))
    }
  })

  it('never stores or applies brief suggestions that do not fit a data platform', () => {
    const platforms = kb.scenarios.filter((s) => s.answers['project.kind']?.kind === 'value' && s.answers['project.kind'].value === 'data_platform')
    expect(platforms.length).toBeGreaterThan(0)
    for (const s of platforms) {
      const id = store().createProject(s.name, `${s.description} An app with search, media uploads and notifications.`, s.answers)
      expect(store().projects[id].suggestions?.['product.type'], s.id).toBeUndefined()
      store().autoCompleteActive()
      const p = store().projects[id]
      expect(p.answers['product.type'], s.id).toBeUndefined()
      expect(evaluate(kb, p.answers).findings.map((x) => x.rule.id), s.id).not.toContain('infeasible-product.features')
    }
    // The brief's Apply drops the request-path capabilities a data platform cannot have.
    store().createProject('B', '', { 'project.kind': { kind: 'value', value: 'data_platform' } })
    store().applySuggestions({ 'product.features': { kind: 'value', value: ['search', 'media'] }, 'product.type': { kind: 'value', value: 'commerce' } })
    const applied = store().whatIf ?? {}
    expect(applied['product.features']).toBeUndefined()
    // An app type does not apply yet; it stays for when the design makes it relevant ('when relevant' on the Apply button).
    expect(applied['product.type']).toEqual({ kind: 'value', value: 'commerce' })
  })

  it('adds brief suggestions to a multi-choice answer instead of replacing it', () => {
    const multi = (...value: string[]) => ({ kind: 'value' as const, value })
    store().createProject('B', '', { 'org.existing_platforms': multi('aws_commit', 'sap'), 'security.compliance': multi('hipaa') })
    store().setDescription('Lakehouse on Databricks, GDPR')
    const p = store().active()!
    const fresh = newSuggestions(kb, p.answers, suggestFromDescription(kb, p.description))
    expect(fresh['security.compliance']).toEqual(multi('gdpr'))
    store().applySuggestions(fresh)
    store().commitWhatIf()
    expect(store().active()!.answers['security.compliance']).toEqual(multi('hipaa', 'gdpr'))
    expect(store().active()!.answers['org.existing_platforms']).toEqual(multi('aws_commit', 'sap', 'databricks_existing'))
    expect(newSuggestions(kb, store().active()!.answers, suggestFromDescription(kb, p.description))['security.compliance']).toBeUndefined()
  })

  it('saves, restores and compares versions', () => {
    store().createProject('Feed', '')
    store().setAnswer('product.type', { kind: 'value', value: 'social' })
    store().setAnswer('traffic.dau', dau(1_000))
    store().saveVersion('MVP')
    store().setAnswer('traffic.dau', dau(50_000_000))
    const p = store().active()!
    expect(p.versions).toHaveLength(1)
    expect(p.versions[0].answers['traffic.dau']).toEqual(dau(1_000))

    const diff = diffEvaluations(evaluate(kb, p.versions[0].answers), evaluate(kb, p.answers))
    expect(diff.added).toContain('lb')

    store().restoreVersion(p.versions[0].id)
    expect(store().active()!.answers['traffic.dau']).toEqual(dau(1_000))
    // Restoring first saved the unsaved 50M answers as a version of their own.
    expect(store().active()!.versions).toHaveLength(2)
    store().deleteVersion(p.versions[0].id)
    expect(store().active()!.versions).toHaveLength(1)
  })

  it('applies a what-if only on commit', () => {
    store().createProject('X', '')
    store().setWhatIf({ 'traffic.dau': dau(10) }, 'Small')
    expect(store().active()!.answers['traffic.dau']).toBeUndefined()
    store().commitWhatIf()
    expect(store().active()!.answers['traffic.dau']).toEqual(dau(10))
    expect(store().whatIf).toBeNull()
  })

  it('drops imported custom answers on questions the UI offers no custom answer for', () => {
    const p = parseProject(
      JSON.stringify({ name: 'S', answers: { 'product.features': { kind: 'custom', text: 'Payments and search', treatAs: 'payments' }, 'data.primary_db': { kind: 'custom', text: 'ScyllaDB', treatAs: 'cassandra' } } }),
    )
    expect(p.answers['product.features']).toBeUndefined()
    expect(p.answers['data.primary_db']).toEqual({ kind: 'custom', text: 'ScyllaDB', treatAs: 'cassandra' })
  })

  it('round-trips a project through JSON export and import', () => {
    store().createProject('Chat', 'messaging app')
    store().setAnswer('traffic.dau', dau(2_000_000))
    store().setAnswer('data.primary_db', { kind: 'custom', text: 'ScyllaDB', treatAs: 'cassandra' })
    store().saveVersion('v1')
    const exported = JSON.stringify(store().active())

    const importedId = store().importProject(exported)
    const imported = store().projects[importedId]
    const original = Object.values(store().projects).find((p) => p.id !== importedId)!
    expect(importedId).not.toBe(original.id)
    expect(imported.answers).toEqual(original.answers)
    expect(imported.versions.map((v) => v.name)).toEqual(['v1'])
    expect(store().activeId).toBe(importedId)
  })

  it('duplicates and deletes projects', () => {
    const id = store().createProject('A', '')
    store().duplicateProject(id)
    expect(Object.keys(store().projects)).toHaveLength(2)
    store().deleteProject(id)
    expect(Object.keys(store().projects)).toHaveLength(1)
    expect(store().activeId).toBeNull()
  })

  it('migrates projects saved by an older store version, dropping answers the knowledge base no longer has', () => {
    const saved = { id: 'p', name: 'Old', description: '', createdAt: '', updatedAt: '', answers: { 'traffic.dau': dau(500), 'gone.question': dau(1) }, versions: [{ id: 'v', name: 'MVP', createdAt: '', answers: { 'gone.question': dau(1) } }] }
    const state = migrateStore({ projects: { p: saved }, activeId: 'p' })
    expect(state.activeId).toBe('p')
    expect(state.projects.p.answers).toEqual({ 'traffic.dau': dau(500) })
    expect(state.projects.p.versions[0].answers).toEqual({})
  })

  it('maps the legacy budget bucket ids to numbers in imports and saved projects', () => {
    const legacy = { 'infra.budget': { kind: 'value', value: 'substantial' } }
    const imported = parseProject(JSON.stringify({ name: 'Old', answers: legacy, versions: [{ name: 'v1', answers: { 'infra.budget': { kind: 'custom', text: 'tight', treatAs: 'minimal' } } }] }))
    expect(imported.answers['infra.budget']).toEqual(dau(50_000))
    expect(imported.versions[0].answers['infra.budget']).toEqual(dau(500))
    const saved = { id: 'p', name: 'Old', description: '', createdAt: '', updatedAt: '', answers: { 'infra.budget': { kind: 'value' as const, value: 'enterprise' } }, versions: [] }
    expect(migrateStore({ projects: { p: saved }, activeId: 'p' }).projects.p.answers['infra.budget']).toEqual(dau(10_000_000))
    expect(evaluate(kb, imported.answers).facts['infra.budgetUsd']).toBe(50_000)
    // 'The target cloud' (store version 2) becomes the provider the project chose.
    const sameCloud = { 'source.location': { kind: 'value', value: 'same_cloud' } }
    expect(parseProject(JSON.stringify({ name: 'Old', answers: { ...sameCloud, 'infra.cloud': { kind: 'value', value: 'azure' } } })).answers['source.location']).toEqual({ kind: 'value', value: 'azure' })
    expect(parseProject(JSON.stringify({ name: 'Old', answers: sameCloud })).answers['source.location']).toBeUndefined()
  })

  it('validates imported overrides, dropping non-finite and negative values, unknown keys and unknown components', () => {
    const json = `{"name": "P", "answers": {}, "overrides": {
      "reference": {"appInstanceQps": 500, "migrationFteMonthsRefactor": 9, "migrationFteMonths": {"refactor": 9}, "dbPrimaryWriteQps": -1, "noSuchKey": 3, "latencyTable": 1, "cacheNodeOps": 1e999},
      "unitPrice": {"app": 120, "ghost": 50, "cache": "9"},
      "replicas": {"db-primary": 2, "app": 0, "ghost": 3, "cache": 1.5},
      "exclude": ["cdn", "ghost", 7],
      "discountPct": 95,
      "extraLines": [{"label": "Confluent Cloud", "tier": "async", "monthly": 900, "costKind": "run"}, {"label": "Bad", "tier": "nowhere", "monthly": 1, "costKind": "run"}],
      "extra": true
    }, "versions": [{"name": "v1", "answers": {}, "overrides": {"discountPct": 20, "unitPrice": {"app": -5}}}]}`
    const p = parseProject(json)
    expect(p.overrides).toEqual({
      reference: { appInstanceQps: 500, migrationFteMonthsRefactor: 9 },
      unitPrice: { app: 120 },
      replicas: { 'db-primary': 2 },
      exclude: ['cdn'],
      extraLines: [{ label: 'Confluent Cloud', tier: 'async', monthly: 900, costKind: 'run' }],
    })
    expect(p.versions[0].overrides).toEqual({ discountPct: 20 })
    expect(cleanOverrides({ unitPrice: { app: Number.NaN }, discountPct: Number.NaN })).toBeUndefined()
    expect(cleanOverrides('junk')).toBeUndefined()
  })

  it('drops a reference override of 0 for capacities and divisors, so every scenario keeps a finite cost', () => {
    expect(cleanOverrides({ reference: { appInstanceQps: 0, targetUtilization: 0, validationFactor: 0 } })).toEqual({ reference: { validationFactor: 0 } })
    // Every reference number set to 0 at once: the ones that survive validation must leave each scenario's cost finite.
    const zeros = Object.fromEntries(Object.entries(kb.reference).filter(([, value]) => typeof value === 'number').map(([key]) => [key, 0]))
    const kept = cleanOverrides({ reference: zeros })
    expect(Object.keys(kept!.reference!)).not.toContain('secondsPerDay')
    expect(Object.keys(kept!.reference!)).not.toContain('opsFteMonthlyUsd')
    // The people line divides by the engineer's cost, so the total with people stays finite too.
    for (const { id, answers } of kb.scenarios) expect(Number.isFinite(runAndPeople(evaluate(withOverrides(kb, kept), autoComplete(kb, answers)))), id).toBe(true)
    // A 0 saved by an older store version is dropped on load.
    const saved = { id: 'p', name: 'Old', description: '', createdAt: '', updatedAt: '', answers: {}, versions: [], overrides: { reference: { appInstanceQps: 0, opsFteMonthlyUsd: 0 } } }
    expect(migrateStore({ projects: { p: saved }, activeId: 'p' }).projects.p.overrides).toBeUndefined()
  })

  it('snapshots overrides with a version and restores them', () => {
    const id = store().createProject('O', '')
    useProjects.setState((s) => ({ projects: { ...s.projects, [id]: { ...s.projects[id], overrides: { discountPct: 10 } } } }))
    store().saveVersion('v1')
    useProjects.setState((s) => ({ projects: { ...s.projects, [id]: { ...s.projects[id], overrides: undefined } } }))
    store().restoreVersion(store().active()!.versions[0].id)
    expect(store().active()!.overrides).toEqual({ discountPct: 10 })
  })

  it('sets validated overrides that change the estimate and are saved with the project', () => {
    const id = store().createProject('Shop', '', autoComplete(kb, kb.scenarios.find((x) => x.id === 'ecommerce')!.answers))
    const before = evaluate(withOverrides(kb, store().active()!.overrides), store().active()!.answers).monthlyCost
    store().setOverrides({ unitPrice: { cdn: 5_000, nope: 1 }, discountPct: 200 })
    // A bare component id is stored under the offer that prices it.
    const cdnKey = evaluate(kb, store().active()!.answers).architecture.components.find((c) => c.def.id === 'cdn')!.priceKey
    expect(cdnKey).toContain('cdn|aws|')
    expect(store().active()!.overrides).toEqual({ unitPrice: { [cdnKey]: 5_000 } })
    const after = evaluate(withOverrides(kb, store().active()!.overrides), store().active()!.answers).monthlyCost
    expect(after).not.toBeCloseTo(before, 0)
    // The persisted slice (projects and activeId, as partialize keeps them) read back on reload keeps the overrides.
    const saved = JSON.parse(JSON.stringify({ projects: store().projects, activeId: store().activeId }))
    expect(migrateStore(saved).projects[id].overrides).toEqual({ unitPrice: { [cdnKey]: 5_000 } })
    store().setOverrides({})
    expect(store().active()!.overrides).toBeUndefined()
  })

  it('moves unit prices saved under a component id onto the offer that priced it, for the project and each version', () => {
    const answers = autoComplete(kb, kb.scenarios.find((x) => x.id === 'fabric-bi-azure')!.answers)
    const key = evaluate(kb, answers).architecture.components.find((c) => c.def.id === 'warehouse')!.priceKey
    const old = { projects: { p: { ...blankProject('Old', '', answers), id: 'p', overrides: { unitPrice: { warehouse: 900 } }, versions: [{ id: 'v', name: 'V1', createdAt: '', answers, overrides: { unitPrice: { warehouse: 800 } } }] } }, activeId: 'p' }
    const p = migrateStore(old).projects.p
    expect(key).toMatch(/^warehouse\|any\|Fabric .+\|F\d+$/)
    expect(p.overrides).toEqual({ unitPrice: { [key]: 900 } })
    expect(p.versions[0].overrides).toEqual({ unitPrice: { [key]: 800 } })
    expect(parseProject(JSON.stringify({ name: 'Old', answers, overrides: { unitPrice: { warehouse: 900 } } })).overrides).toEqual({ unitPrice: { [key]: 900 } })
  })

  it('keeps unit prices saved under a renamed offer or a push CDN that had no offer applying after the rename', () => {
    const option = (value: string) => ({ kind: 'value' as const, value })
    const answers = autoComplete(kb, { ...kb.scenarios.find((x) => x.id === 'web-crawler')!.answers, 'infra.cloud': option('azure'), 'data.primary_db': option('postgres'), 'data.partitioning': option('hash_sharding'), 'perf.cdn': option('push') })
    const keys = new Map(evaluate(kb, answers).architecture.components.map((c) => [c.def.id, c.priceKey]))
    const db = keys.get('db-primary')!
    expect(db).toContain('|Azure Database for PostgreSQL elastic clusters (Citus)')
    expect(keys.get('cdn')).toBe('cdn|any|Push CDN / own edge (Open Connect style)')
    // Store version 6 keyed the sharded PostgreSQL by its old name, and priced the push CDN under its bare id.
    const oldDb = db.replace('Azure Database for PostgreSQL elastic clusters (Citus)', 'Azure Cosmos DB for PostgreSQL (Citus)')
    const saved = { projects: { p: { ...blankProject('Old', '', answers), id: 'p', overrides: { unitPrice: { [oldDb]: 700, cdn: 9_000 } } } }, activeId: 'p' }
    expect(migrateStore(saved).projects.p.overrides).toEqual({ unitPrice: { [db]: 700, [keys.get('cdn')!]: 9_000 } })
  })

  it('saves unsaved prices and assumptions before restoring a version', () => {
    store().createProject('R', '', { 'infra.cloud': { kind: 'value', value: 'aws' } })
    store().saveVersion('V1')
    store().setOverrides({ discountPct: 15 })
    store().restoreVersion(store().active()!.versions[0].id)
    expect(store().active()!.overrides).toBeUndefined()
    const [, before] = store().active()!.versions
    expect(before.name).toMatch(/^Before restore/)
    // The discount names the cloud the project ran on when it was set.
    expect(before.overrides).toEqual({ discountPct: 15, discountProvider: 'aws' })
    // Restoring again with nothing unsaved adds no further version.
    store().restoreVersion(store().active()!.versions[0].id)
    expect(store().active()!.versions).toHaveLength(2)
  })

  it('adds, edits and removes cost lines of the project', () => {
    store().createProject('L', '')
    const line = { label: 'Vendor support', tier: 'ops' as const, monthly: 2_000, costKind: 'license' as const }
    store().setOverrides({ extraLines: [line] })
    store().setOverrides({ extraLines: [{ ...line, monthly: 2_500 }] })
    expect(store().active()!.overrides).toEqual({ extraLines: [{ ...line, monthly: 2_500 }] })
    store().setOverrides({ extraLines: [] })
    expect(store().active()!.overrides).toBeUndefined()
  })

  it('undoes and redoes answer changes with a label naming the change', () => {
    store().createProject('U', '')
    store().setAnswer('infra.cloud', { kind: 'value', value: 'aws' })
    store().setAnswer('infra.cloud', { kind: 'value', value: 'azure' })
    const id = store().activeId!
    expect(store().history[id].past.at(-1)!.label).toBe('Cloud provider = Azure')
    store().undo()
    expect(store().active()!.answers['infra.cloud']).toEqual({ kind: 'value', value: 'aws' })
    expect(store().history[id].future.at(-1)!.label).toBe('Cloud provider = Azure')
    store().redo()
    expect(store().active()!.answers['infra.cloud']).toEqual({ kind: 'value', value: 'azure' })
    // A new change clears the redo stack; an unchanged answer adds no step.
    store().undo()
    store().setAnswer('traffic.dau', dau(5_000))
    store().setAnswer('traffic.dau', dau(5_000))
    expect(store().history[id].future).toHaveLength(0)
    expect(store().history[id].past.map((e) => e.label)).toEqual(['Cloud provider = AWS', 'Daily active users = 5.0k'])
  })

  it('reverts Auto-design, a what-if and overrides in one step each', () => {
    store().createProject('A', '')
    store().setAnswer('product.type', { kind: 'value', value: 'social' })
    const before = store().active()!.answers
    store().autoCompleteActive()
    const id = store().activeId!
    expect(store().history[id].past.at(-1)!.label).toMatch(/^Auto-design \d+ answers$/)
    store().undo()
    expect(store().active()!.answers).toEqual(before)
    store().setWhatIf({ 'traffic.dau': dau(10) }, 'Small')
    store().commitWhatIf()
    store().setOverrides({ discountPct: 10 })
    store().undo()
    expect(store().active()!.overrides).toBeUndefined()
    store().undo()
    expect(store().active()!.answers['traffic.dau']).toBeUndefined()
    expect(store().history[id].future.map((e) => e.label)).toEqual(['Edit cost assumptions', 'Small'])
  })

  it('auto-designs with the answers detected in the brief before the recommendations', () => {
    const id = store().createProject('RAG', 'A chat assistant that answers questions over policy documents, on Azure, GDPR.')
    expect(store().projects[id].suggestions?.['infra.cloud']).toEqual({ kind: 'value', value: 'azure' })
    store().autoCompleteActive()
    const e = evaluate(kb, store().active()!.answers)
    expect(e.facts['infra.cloud']).toBe('azure')
    expect(store().active()!.answers['infra.cloud']).toEqual({ kind: 'value', value: 'azure' })
    expect(store().active()!.suggestions?.['infra.cloud']).toBeUndefined()
    // Dismissed detections stay out.
    const other = store().createProject('RAG', 'A chat assistant over policy documents, on Azure.', {}, undefined, ['infra.cloud=azure'])
    store().autoCompleteActive()
    expect(store().projects[other].answers['infra.cloud']).toEqual({ kind: 'unknown' })
  })

  it('keeps an answer the user gave over a detection, and applies the other detections', () => {
    const id = store().createProject('RAG', 'A chat assistant that answers questions over policy documents, on Azure, GDPR.')
    store().setAnswer('infra.cloud', { kind: 'value', value: 'aws' })
    store().autoCompleteActive()
    const answers = store().projects[id].answers
    expect(answers['infra.cloud']).toEqual({ kind: 'value', value: 'aws' })
    expect(evaluate(kb, answers).facts['security.compliance']).toEqual(expect.arrayContaining(['gdpr']))
  })

  it('auto-designs every data-platform scenario from its brief without app types or request-path capabilities', () => {
    for (const s of kb.scenarios.filter((x) => evaluate(kb, x.answers).facts['profile.dataPlatformOnly'] === true)) {
      const id = store().createProject(s.name, s.description, s.answers)
      store().autoCompleteActive()
      const answers = store().projects[id].answers
      const e = evaluate(kb, answers)
      expect(answers['product.type'], s.id).toBeUndefined()
      expect(e.findings.map((x) => x.rule.id), s.id).not.toContain('infeasible-product.features')
      expect(e.facts['product.features'], s.id).not.toContain('media')
    }
  })

  it('keeps a labelled what-if while an option is hovered and left again', () => {
    store().createProject('W', '')
    const azure = { 'infra.cloud': { kind: 'value' as const, value: 'azure' } }
    store().setWhatIf(azure, 'Move to Azure')
    store().previewOption({ 'bi.tool': { kind: 'value', value: 'looker' } })
    store().previewOption(null)
    expect(store().whatIf).toEqual(azure)
    expect(store().whatIfLabel).toBe('Move to Azure')
    // Without one, hovering previews the option and leaving clears it.
    store().setWhatIf(null)
    store().previewOption(azure)
    expect(store().whatIf).toEqual(azure)
    store().previewOption(null)
    expect(store().whatIf).toBeNull()
  })

  it('closes the side panel when a component is selected, so the inspector is not hidden under it', () => {
    store().createProject('P', '')
    store().setPanel('cost')
    store().select(null)
    expect(store().panel).toBe('cost')
    store().select('db-primary')
    expect(store().selectedComponent).toBe('db-primary')
    expect(store().panel).toBeNull()
  })

  it('commits a discount drag as one undo step after Auto-design', () => {
    store().createProject('D', '')
    store().autoCompleteActive()
    // The cost panel slider keeps intermediate values (1..29) as a local draft and writes only the released one.
    const drag = Array.from({ length: 30 }, (_, i) => i + 1)
    store().setOverrides({ discountPct: drag.at(-1) })
    const id = store().activeId!
    expect(store().history[id].past.map((e) => e.label.replace(/\d+/, 'N'))).toEqual(['Auto-design N answers', 'Edit cost assumptions'])
    store().undo()
    expect(store().active()!.overrides).toBeUndefined()
  })

  it('keeps at most 100 undo steps', () => {
    store().createProject('H', '')
    for (let i = 1; i <= 105; i++) store().setAnswer('traffic.dau', dau(i * 10))
    expect(store().history[store().activeId!].past).toHaveLength(100)
  })

  it('saves unsaved answers as a Before restore version, and not when a version holds them', () => {
    store().createProject('R', '')
    store().setAnswer('traffic.dau', dau(1_000))
    store().saveVersion('v1')
    store().setAnswer('traffic.dau', dau(9_000))
    store().restoreVersion(store().active()!.versions[0].id)
    const versions = store().active()!.versions
    expect(versions.map((v) => v.name)).toEqual(['v1', expect.stringMatching(/^Before restore /)])
    expect(versions[1].answers['traffic.dau']).toEqual(dau(9_000))
    // The restored answers match v1, so restoring again saves nothing.
    store().restoreVersion(versions[0].id)
    expect(store().active()!.versions).toHaveLength(2)
    // Undo returns to the answers before the restore.
    store().undo()
    expect(store().active()!.answers['traffic.dau']).toEqual(dau(9_000))
  })
})

describe('opening a question from a panel', () => {
  const withViewport = (narrow: boolean, run: () => void) => {
    const g = globalThis as { window?: unknown }
    const before = g.window
    g.window = { matchMedia: (q: string) => ({ matches: narrow && q === '(max-width: 900px)' }) }
    try {
      run()
    } finally {
      g.window = before
    }
  }

  it('closes the panel on a narrow viewport, where the panel hides the sidebar, and keeps it open on a wide one', () => {
    withViewport(true, () => {
      useProjects.setState({ panel: 'cost' })
      store().edit('bi.tool')
      expect(store().panel).toBeNull()
      expect(store().editing).toBe('bi.tool')
      useProjects.setState({ panel: 'explore' })
      store().showCategory('reliability')
      expect(store().panel).toBeNull()
    })
    withViewport(false, () => {
      useProjects.setState({ panel: 'cost' })
      store().edit('bi.tool')
      expect(store().panel).toBe('cost')
    })
  })
})
