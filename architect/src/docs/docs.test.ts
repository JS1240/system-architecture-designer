import { describe, expect, it } from 'vitest'
import { evaluate } from '../engine/evaluate'
import { autoComplete, compareOver } from '../engine/explore'
import { withOverrides } from '../engine/overrides'
import { kb } from '../knowledge'
import type { Overrides } from '../domain/types'
import { blankProject, parseProject, scopeOverrides } from '../store/projectStore'
import { BOM_HEADER, bomCsv, capacityMarkdown, generateMarkdown, mermaidDiagram, migrationMarkdown, PROVIDER_COST_HEADER, providerCostCsv } from './generate'
import { renderSafe } from './render'

const chat = kb.scenarios.find((s) => s.id === 'chat-app')!

describe('documentation', () => {
  const project = blankProject('Chat', chat.description, autoComplete(kb, chat.answers))
  const e = evaluate(kb, project.answers)
  const md = generateMarkdown(project, e, kb)

  it('contains spec sections, capacity, ADRs and guidance', () => {
    for (const heading of ['## 2. Requirements', '## 3. Capacity estimates', '## 4. Architecture diagram', '## 10. Architecture Decision Records', '## 11. Implementation guidance']) {
      expect(md).toContain(heading)
    }
    const decisions = e.questions.filter((q) => q.active && q.question.isDecision && q.status !== 'pending')
    expect(md.match(/### ADR-\d{3}/g)?.length).toBe(decisions.length)
    expect(md).toContain('Alternatives considered')
  })

  it('renders a mermaid flowchart with every component', () => {
    const diagram = mermaidDiagram(e)
    expect(diagram.startsWith('flowchart LR')).toBe(true)
    for (const c of e.architecture.components) expect(diagram).toContain(c.def.label)
  })

  it('keeps every scenario diagram renderable: subgraph ids never clash with node ids and edge labels are quoted', () => {
    for (const s of kb.scenarios) {
      const lines = mermaidDiagram(evaluate(kb, autoComplete(kb, s.answers))).split('\n')
      const subgraphs = lines.flatMap((l) => l.match(/^\s*subgraph (\S+?)\[/)?.[1] ?? [])
      const nodes = lines.flatMap((l) => l.match(/^\s*(\w+)\["/)?.[1] ?? [])
      expect(subgraphs.length, s.id).toBeGreaterThan(0)
      for (const g of subgraphs) expect(nodes, s.id).not.toContain(g)
      // Unquoted labels with parentheses, e.g. |Origin fetch (misses)|, are Mermaid parse errors.
      for (const l of lines.filter((x) => x.includes('->|'))) expect(l, s.id).toMatch(/-\.?->\|"[^"]*"\| \w+$/)
    }
  })

  it('states the media term behind the total storage figure', () => {
    const social = kb.scenarios.find((s) => s.id === 'social-network')!
    const capacity = capacityMarkdown(evaluate(kb, autoComplete(kb, social.answers)), kb)
    expect(capacity).toContain('DAU x uploads per user x 365 x media size')
    expect(capacity).toContain('records over 64 KB go to object storage')
  })

  it('reports what sizes a data platform instead of request-path zeros, and both tables for the analytics add-on', () => {
    const v = (value: unknown) => ({ kind: 'value' as const, value: value as string })
    const platform = capacityMarkdown(evaluate(kb, autoComplete(kb, { 'project.kind': v('data_platform'), 'data.history_tb': v(10), 'data.source_count': v(20), 'data.analytics_users': v(150) })), kb)
    expect(platform).not.toContain('Daily active users')
    expect(platform).not.toContain('Peak requests/s')
    for (const row of ['| Existing data loaded | 10 TB |', '| Source systems | 20 |', '| Report readers | 150 |', 'Report freshness', 'Lake size a year ahead', 'Data scanned per month']) expect(platform).toContain(row)
    const hybrid = capacityMarkdown(evaluate(kb, autoComplete(kb, { 'project.kind': v('transactional_app'), 'project.addons': v(['analytics']) })), kb)
    expect(hybrid).toContain('Daily active users')
    expect(hybrid).toContain('Lake size a year ahead')
    expect(capacityMarkdown(evaluate(kb, autoComplete(kb, chat.answers)), kb)).not.toContain('Lake size a year ahead')
  })

  it('reports concurrent connections only for designs that hold connections or track live locations', () => {
    const capacity = (id: string) => capacityMarkdown(evaluate(kb, autoComplete(kb, kb.scenarios.find((s) => s.id === id)!.answers)), kb)
    for (const id of ['chat-app', 'ride-hailing']) expect(capacity(id), id).toContain('Concurrent connections')
    for (const id of ['url-shortener', 'video-streaming', 'web-crawler']) expect(capacity(id), id).not.toContain('Concurrent connections')
  })

  it('escapes raw HTML and unsafe links from imported text', () => {
    const html = renderSafe('Hi <img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://example.com)')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="https://example.com"')
  })
})

describe('implementation guidance', () => {
  const guidance = (id: string) => {
    const s = kb.scenarios.find((x) => x.id === id)!
    const p = blankProject(s.name, s.description, autoComplete(kb, s.answers))
    return generateMarkdown(p, evaluate(kb, p.answers), kb)
  }

  it('starts a data platform fed only by a kept existing system with that system\'s feed', () => {
    const answers = autoComplete(kb, { 'project.kind': { kind: 'value', value: 'data_platform' }, 'project.origin': { kind: 'value', value: 'extend_existing' }, 'infra.cloud': { kind: 'value', value: 'azure' }, 'source.kinds': { kind: 'value', value: ['rdbms'] }, 'source.volume_gb': { kind: 'value', value: 5_120 }, 'data.source_count': { kind: 'value', value: 1 } })
    const md = generateMarkdown(blankProject('Kept', '', answers), evaluate(kb, answers), kb)
    expect(md).toContain("Ship the existing system's feed -> lake or warehouse")
    expect(md).toContain("The existing system's sync method carries the data in")
    expect(md).not.toContain('Ingestion is priced per source system')
  })

  it('routes reads to replicas only when consistency allows it', () => {
    const strong = guidance('ecommerce')
    expect(strong).not.toContain('route read-only queries to them')
    expect(strong).toContain('keep all reads on the primary')
    expect(guidance('url-shortener')).toContain('route read-only queries to them')
  })

  it('prints the migration line only for a migration', () => {
    // A new-build RAG assistant has a one-off embeddings backfill but nothing to migrate.
    expect(guidance('rag-assistant-azure')).not.toContain('- Migration:')
    expect(guidance('oracle-orders-to-aws')).toContain('- Migration:')
  })
})

describe('cost, provider and migration sections', () => {
  const docOf = (id: string, overrides?: Overrides) => {
    const s = kb.scenarios.find((x) => x.id === id)!
    const answers = autoComplete(kb, s.answers)
    // Bare component ids in unitPrice name the offer that prices the component, as the store saves them.
    const scoped = scopeOverrides(overrides, answers)
    const project = { ...blankProject(s.name, s.description, answers), ...(scoped && { overrides: scoped }) }
    const e = evaluate(withOverrides(kb, scoped), project.answers)
    return { project, e, md: generateMarkdown(project, e, kb) }
  }
  const fabric = docOf('fabric-bi-azure')
  const oracle = docOf('oracle-orders-to-aws')
  const sectionOf = (md: string, title: string) => md.split(/\n(?=## )/).find((x) => x.includes(`. ${title}\n`)) ?? ''
  const providers = kb.questions.find((q) => q.id === 'infra.cloud')!.options!

  it('adds the cost estimate, provider map and constraints sections and the cost basis to the summary', () => {
    for (const title of ['Cost estimate', 'Provider service map', 'Constraints and overrides']) expect(fabric.md, title).toMatch(new RegExp(`## \\d+\\. ${title}\\n`))
    expect(fabric.md).toContain('- Cost by kind: run ')
    expect(fabric.md).toContain('- Cost by tier: ')
    expect(fabric.md).toMatch(/- Cost basis: provider Azure, region .*, list prices as of \d{4}-\d{2} \(oldest offer\), 0 override\(s\)/)
    expect(fabric.md).toContain('| Component | Technology | Instances | Monthly | Why | Sizing |')
    // One cost estimate row per component, plus the staging and vendor support shares.
    const shares = ['nonprod', 'support'].filter((kind) => fabric.e.cost.byKind[kind]).length
    expect(fabric.e.cost.byKind.support).toBeGreaterThan(0)
    expect(sectionOf(fabric.md, 'Cost estimate').split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Component')).length).toBe(fabric.e.architecture.components.length + shares)
  })

  it('maps each component to its service on all four providers', () => {
    const table = sectionOf(fabric.md, 'Provider service map').split('\n').filter((l) => l.startsWith('|'))
    const header = table[0].split('|').slice(1, -1).map((c) => c.trim())
    expect(header).toEqual(['Component', 'Chosen service', 'AWS', 'Azure', 'Google Cloud', 'On-premises / self-hosted', 'Monthly'])
    expect(providers.length).toBe(4)
    for (const row of table.slice(2)) expect(row.split('|').length, row).toBe(header.length + 2)
    expect(table.some((r) => r.includes('Power BI'))).toBe(true)
    // Each column is that provider's own completed design, as in the cost per provider CSV: AWS runs no Fabric capacity.
    const aws = table.slice(2).map((r) => r.split('|')[3])
    expect(aws.join(' ')).not.toContain('Fabric')
  })

  it('writes the migration plan with a gantt chart only for a migration', () => {
    expect(fabric.md).not.toContain('Migration plan')
    expect(docOf('chat-app').md).not.toContain('Migration plan')
    const plan = sectionOf(oracle.md, 'Migration plan')
    expect(plan).toContain('| Existing database | Oracle Database |')
    expect(plan).toMatch(/Cutover estimate: .* against a .* window/)
    expect(plan).toContain('Wait until the CDC lag is 0.')
    expect(plan).toContain('Keep reverse CDC')
    expect(plan).toContain('```mermaid\ngantt')
    // The plan comes before the open questions and after the guidance, which starts with the migration.
    expect(sectionOf(oracle.md, 'Implementation guidance')).toContain('1. Migrate first')
    expect(sectionOf(fabric.md, 'Implementation guidance')).not.toContain('Migrate first')
    // Extending keeps the old systems: no cutover, rollback or decommission, only the load, sync and reconciliation.
    const extend = sectionOf(docOf('crm-to-ai-insights').md, 'Migration plan')
    expect(extend).toContain('Sync runbook:')
    expect(extend).toContain('Reconcile row counts')
    for (const absent of ['Freeze writes', 'Switch connection strings', 'Rollback', 'Decommission', 'Cutover', 'snapshot']) expect(extend, absent).not.toContain(absent)
  })

  it('leaves the cutover estimate open while the sync method, window or volume is pending, and drains a pending sync as a bulk copy', () => {
    const s = kb.scenarios.find((x) => x.id === 'oracle-orders-to-aws')!
    const plan = migrationMarkdown(evaluate(kb, s.answers))
    expect(plan).toContain('- Cutover estimate: open (answer sync method)')
    expect(plan).not.toMatch(/Cutover estimate: \d/)
    // The engine costs a pending sync as a bulk copy, so the runbook and the gantt load the full copy, not an increment.
    expect(plan).toContain('2. Export and load the full copy (sync method open).')
    expect(plan).toContain('Final full copy :b2')
    expect(plan).not.toContain('Final increments')
    const bare = migrationMarkdown(evaluate(kb, { 'project.origin': { kind: 'value', value: 'migrate_database' } }))
    expect(bare).toContain('- Cutover estimate: open (answer sync method, downtime window, volume)')
    expect(bare).toContain('- Coexistence: open (answer the migration strategy)')
    expect(bare).not.toContain('0 min window')
  })

  it('escapes pipes in free text so table cells stay in their columns', () => {
    const { md } = docOf('internal-tool', { extraLines: [{ label: 'Support | SLA plan', tier: 'ops', monthly: 100, costKind: 'license' }] })
    expect(sectionOf(md, 'Constraints and overrides')).toContain('| Added line: Support \\| SLA plan (license, ops) | - | $100 |')
    expect(sectionOf(md, 'Cost estimate')).toContain('| Support \\| SLA plan (added) | - | - | - | - | license | $100 | - |')
    const s = kb.scenarios.find((x) => x.id === 'internal-tool')!
    const answers = { ...autoComplete(kb, s.answers), 'data.primary_db': { kind: 'custom' as const, text: 'Postgres | Citus', treatAs: 'postgres' } }
    const custom = generateMarkdown(blankProject('x', '', answers), evaluate(kb, answers), kb)
    expect(custom).toContain('Postgres \\| Citus')
    for (const row of custom.split('\n').filter((l) => l.startsWith('|'))) expect(row).not.toMatch(/[^\\]\| Citus/)
  })

  it('states the cost of each decision against the next option, the rejected providers and the table format engines', () => {
    const adrs = oracle.md.split('### ADR-').slice(1)
    const decided = adrs.filter((a) => a.includes('- Cost: '))
    expect(decided.length).toBeGreaterThan(adrs.length / 2)
    for (const a of decided) expect(a).toMatch(/- Cost: [+-]\$[\d,]+\/mo.* vs .+/)
    const cloud = adrs.find((a) => a.includes(': Cloud provider'))!
    expect(cloud).toMatch(/Rejected providers \(run \+ people\): Google Cloud \$[\d,]+\/mo, Azure \$[\d,]+\/mo, On-premises/)
    const format = fabric.md.split('### ADR-').find((a) => a.includes(': Table format'))!
    expect(format).toMatch(/Engines that read or write Delta Lake on Microsoft Fabric: .*Fabric/)
  })

  it('lists every override next to its default', () => {
    const { md } = docOf('fabric-bi-azure', { discountPct: 12, reference: { appInstanceQps: 300 }, exclude: ['catalog'], unitPrice: { bi: 5 }, extraLines: [{ label: 'Support plan', tier: 'ops', monthly: 100, costKind: 'license' }] })
    const section = sectionOf(md, 'Constraints and overrides')
    expect(section).toContain('| Existing platforms |')
    expect(section).toContain('| Negotiated discount (azure only) | 0% | 12% |')
    expect(section).toContain(`| Reference: appInstanceQps | ${kb.reference.appInstanceQps.toLocaleString('en-US')} | 300 |`)
    expect(section).toContain('| Component: Table catalog | included | excluded |')
    expect(section).toContain('| Added line: Support plan (license, ops) | - | $100 |')
    expect(section).toMatch(/\| Unit price: .+ \(Power BI only\) \| \$[\d,]+ \| \$5 \|/)
    expect(md).toContain('5 override(s)')
  })

  it('exports the bill of materials and the cost per provider as CSV', () => {
    const bom = bomCsv(oracle.e).trimEnd().split('\n')
    expect(bom[0]).toBe(BOM_HEADER.join(','))
    expect(bom.length - 1).toBe(oracle.e.architecture.components.length + ['nonprod', 'support'].filter((kind) => oracle.e.cost.byKind[kind]).length)
    // Staging/dev and added lines are rows too, so the recurring BOM total is the run plus people cost.
    const shop = kb.scenarios.find((x) => x.id === 'ecommerce')!
    const extraLines = [{ label: 'Support plan', tier: 'ops' as const, monthly: 100, costKind: 'license' as const }]
    const staged = evaluate(withOverrides(kb, { extraLines }), { ...autoComplete(kb, shop.answers), 'ops.environments': { kind: 'value', value: 'prod_staging_dev' } })
    expect(staged.cost.byKind.nonprod).toBeGreaterThan(0)
    const rows = bomCsv(staged).trimEnd().split('\n').slice(1)
    expect(rows.length).toBe(staged.architecture.components.length + 3)
    expect(rows.some((l) => l.startsWith('Staging and dev environments,,'))).toBe(true)
    expect(rows.some((l) => l.startsWith('Vendor support and maintenance,,'))).toBe(true)
    expect(rows.some((l) => l.startsWith('Support plan (added),,'))).toBe(true)
    const recurring = rows.map((l) => l.split(',')).filter((c) => c.at(-3) !== 'one_time').reduce((sum, c) => sum + Number(c.at(-2)), 0)
    expect(Math.abs(recurring - (staged.cost.monthly + staged.cost.people))).toBeLessThan(rows.length)
    // A usage-billed line has no instance class: an empty cell, not a neutralized placeholder.
    expect(bom.find((l) => l.startsWith('Migration engineering,'))).toMatch(/,12500,,one_time,/)
    const chat = kb.scenarios.find((x) => x.id === 'internal-tool')!
    const perProvider = providerCostCsv(compareOver(kb, chat.answers, 'infra.cloud')).trimEnd().split('\n')
    expect(perProvider[0]).toBe(PROVIDER_COST_HEADER.join(','))
    expect(perProvider.slice(1).map((l) => l.split(',')[0])).toEqual(providers.map((p) => p.label))
  })

  it('quotes CSV cells and neutralizes spreadsheet formulas from imported text', () => {
    const s = kb.scenarios.find((x) => x.id === 'internal-tool')!
    const answers = { ...autoComplete(kb, s.answers), 'data.primary_db': { kind: 'custom' as const, text: '=HYPERLINK("x"), evil', treatAs: 'postgres' } }
    expect(bomCsv(evaluate(kb, answers))).toContain(`"'=HYPERLINK(""x""), evil"`)
  })
})

describe('project import', () => {
  it('drops unknown questions and malformed answers', () => {
    const p = parseProject(
      JSON.stringify({ name: 'X', answers: { 'traffic.dau': { kind: 'value', value: 5 }, bogus: { kind: 'value', value: 1 }, 'arch.style': { kind: 'evil' } } }),
    )
    expect(Object.keys(p.answers)).toEqual(['traffic.dau'])
  })

  it('drops values that are not options of their question, so the question is asked again', () => {
    const p = parseProject(
      JSON.stringify({
        name: 'X',
        answers: {
          'data.primary_db': { kind: 'value', value: 'cockroachdb' },
          'reliability.availability': { kind: 'custom', text: 'Six nines', treatAs: 'six' },
          'product.features': { kind: 'value', value: ['accounts', 'teleport'] },
          'traffic.dau': { kind: 'value', value: 'lots' },
          'product.type': { kind: 'value', value: 'commerce' },
        },
      }),
    )
    expect(Object.keys(p.answers)).toEqual(['product.type'])
  })

  it('keeps every answer of an auto-completed scenario on round trip', () => {
    for (const s of kb.scenarios) {
      const answers = autoComplete(kb, s.answers)
      expect(parseProject(JSON.stringify({ name: s.name, answers })).answers, s.id).toEqual(answers)
    }
  })

  it('rejects files without a name', () => {
    expect(() => parseProject('{"answers":{}}')).toThrow()
  })
})

describe('implementation guidance by kind of task', () => {
  const guidanceOf = (id: string) => {
    const s = kb.scenarios.find((x) => x.id === id)!
    const project = blankProject(s.name, s.description, autoComplete(kb, s.answers))
    const md = generateMarkdown(project, evaluate(kb, project.answers), kb)
    return md.slice(md.indexOf('## 11. Implementation guidance'))
  }

  it('starts a data platform with one source end to end, not an application path', () => {
    const steps = guidanceOf('onprem-iceberg-lakehouse')
    expect(steps).toContain('1. Ship one source -> ingestion -> lake or warehouse')
    expect(steps).not.toContain('clients -> DNS -> application')
    expect(steps).not.toContain('pre-signed uploads')
  })

  it('builds an AI app from the model call and its evals, then retrieval, guardrails and agents, and partitions only a split database', () => {
    const steps = guidanceOf('agent-support-copilot-aws')
    const order = ['Ship the model call with tracing', 'Add retrieval', 'Put the guardrails', 'Add agents last'].map((t) => steps.indexOf(t))
    expect(order.every((i) => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // A three-node replica set is one partition at low load.
    expect(steps).not.toContain('Partition the database')
  })
})
