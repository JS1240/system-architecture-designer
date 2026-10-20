import { describe, expect, it } from 'vitest'
import type { Answers, Evaluation } from '../domain/types'
import { kb } from '../knowledge'
import { evaluate } from './evaluate'
import { autoComplete } from './explore'

const v = (value: unknown) => ({ kind: 'value' as const, value: value as string })
const design = (answers: Answers): Evaluation => evaluate(kb, autoComplete(kb, answers))
const ids = (e: Evaluation) => e.architecture.components.map((c) => c.def.id)
const active = (e: Evaluation, id: string) => e.questions.find((q) => q.question.id === id)!.active
const scenario = (id: string): Answers => kb.scenarios.find((s) => s.id === id)!.answers
// The interview scenarios that predate the kind of task; they leave it at its default.
const ORIGINALS = ['internal-tool', 'url-shortener', 'social-network', 'chat-app', 'ecommerce', 'ride-hailing', 'video-streaming', 'ai-assistant', 'web-crawler', 'personal-finance', 'social-graph', 'query-cache', 'sales-rank']

describe('task kinds', () => {
  it('drops the request path for a data platform and asks the platform questions', () => {
    const e = design({ 'project.kind': v('data_platform'), 'data.history_tb': v(10) })
    for (const id of ['data.platform', 'data.table_format', 'data.freshness', 'data.source_count', 'data.growth_pct']) expect(active(e, id), id).toBe(true)
    for (const id of ['traffic.dau', 'traffic.requests_per_user', 'traffic.read_write', 'arch.api', 'arch.style', 'perf.latency', 'ops.deploy']) expect(active(e, id), id).toBe(false)
    expect(ids(e)).toEqual(expect.arrayContaining(['warehouse', 'lake-storage', 'ingestion', 'bi']))
    for (const id of ['app', 'lb', 'cdn', 'cache', 'api-gateway', 'auth', 'ws-gateway', 'waf', 'db-primary']) expect(ids(e), id).not.toContain(id)
    // The platform reads existing source systems instead of running a database of its own.
    expect(ids(e)).toContain('sources')
    // Kind defaults: analytics and a 99% target, and no application type to ask. The orchestrator schedules the loads, so no app-style job path hangs off the platform.
    expect([e.facts['product.type'], e.facts['product.features'], e.facts['reliability.nines']]).toEqual([undefined, ['analytics'], 99])
    for (const id of ['scheduler', 'queue', 'workers', 'object-storage', 'dns']) expect(ids(e), id).not.toContain(id)
    // The people in the design are the report viewers, and no application-definition card is asked.
    expect(e.architecture.components.find((c) => c.def.id === 'client')!.tech).toBe('Report viewers')
    for (const id of ['product.type', 'arch.async', 'arch.broker']) expect(active(e, id), id).toBe(false)
  })

  it('asks a data platform for its existing data and its growth before it picks the platform', () => {
    const answers: Answers = { 'project.kind': v('data_platform') }
    const asked: string[] = []
    for (let e = evaluate(kb, answers); e.next; e = evaluate(kb, answers)) {
      const id = e.next.question.id
      asked.push(id)
      answers[id] = id === 'data.history_tb' ? v(10) : e.next.recommendation.optionId ? v(e.next.recommendation.optionId) : { kind: 'unknown' }
    }
    const at = (id: string) => asked.indexOf(id)
    expect(at('data.history_tb')).toBeGreaterThanOrEqual(0)
    expect(at('data.history_tb')).toBeLessThan(at('data.growth_pct'))
    expect(at('data.growth_pct')).toBeLessThan(at('data.platform'))
    const e = evaluate(kb, answers)
    expect(e.questions.filter((q) => q.divergesFromRecommendation).map((q) => q.question.id)).toEqual([])
    expect(e.findings.filter((x) => x.rule.severity === 'error').map((x) => x.rule.id)).toEqual([])
  })

  it('takes the application type from a kind that names it, and asks it only for the app kinds', () => {
    // The first cards a guided walk shows once the kind is chosen on the Welcome screen.
    const walk = (kind: string) => {
      const answers: Answers = { 'project.kind': v(kind) }
      const asked: string[] = []
      for (let e = evaluate(kb, answers); e.next && asked.length < 6; e = evaluate(kb, answers)) {
        asked.push(e.next.question.id)
        answers[e.next.question.id] = { kind: 'unknown' }
      }
      return { asked, facts: evaluate(kb, answers).facts }
    }
    for (const [kind, type] of [['ai_app', 'ai'], ['event_streaming', 'iot'], ['integration', undefined], ['data_platform', undefined]]) {
      const { asked, facts } = walk(kind!)
      expect(asked, kind).not.toContain('product.type')
      expect(facts['product.type'], kind).toBe(type)
    }
    for (const kind of ['transactional_app', 'b2b_saas']) expect(walk(kind).asked[0], kind).toBe('product.type')
  })

  it('builds the LLM path for an AI app without the recommendations capability', () => {
    const e = design({ 'project.kind': v('ai_app'), 'product.features': v(['accounts']) })
    expect(active(e, 'ml.serving')).toBe(true)
    expect(ids(e)).toContain('llm-api')
    expect(e.facts['product.type']).toBe('ai')
  })

  it('adds the analytics platform to an app through the analytics add-on, keeping the request path', () => {
    const e = design({ 'project.addons': v(['analytics']), 'product.features': v(['accounts']) })
    expect(active(e, 'data.platform')).toBe(true)
    expect(ids(e)).toEqual(expect.arrayContaining(['app', 'warehouse']))
    expect(evaluate(kb, { 'project.kind': v('integration'), 'project.addons': v(['event_ingest']) }).facts).toMatchObject({ 'profile.integration': true, 'profile.events': true, 'profile.requestPath': true })
  })

  it('keeps every original scenario identical when the kind is stated as a transactional app', () => {
    const summary = (e: Evaluation) => ({
      components: e.architecture.components.map((c) => [c.def.id, c.tech, c.replicas, c.monthlyCost]),
      findings: e.findings.map((x) => x.rule.id),
      cost: e.monthlyCost,
      availability: e.availability,
    })
    for (const id of ORIGINALS) {
      const plain = design(scenario(id))
      expect(plain.facts['project.kind'], id).toBe('transactional_app')
      expect(summary(design({ ...scenario(id), 'project.kind': v('transactional_app') })), id).toEqual(summary(plain))
    }
  })

  it('keeps the warehouse on the native platform in the original scenarios that have one', () => {
    for (const id of ['url-shortener', 'web-crawler', 'personal-finance', 'sales-rank']) {
      const e = design(scenario(id))
      expect(ids(e), id).toContain('warehouse')
      expect(e.facts['data.platform'], id).toBe('native')
    }
  })
})

describe('task-type paths', () => {
  interface Path {
    answers: Answers
    active: string[]
    inactive: string[]
    /** Every entry must be present; an array entry needs one of its ids. */
    components: (string | string[])[]
  }
  const migration: Answers = { 'source.kinds': v(['rdbms']), 'source.rdbms_engine': v('oracle'), 'source.volume_gb': v(2_000), 'migration.downtime': v('minutes') }
  const replacing: Omit<Path, 'answers'> = { active: ['migration.strategy', 'migration.sync', 'migration.rollback'], inactive: ['data.platform'], components: ['cdc-pipeline', 'legacy-db', 'bulk-loader'] }
  const KINDS: Record<string, Path> = {
    transactional_app: { answers: {}, active: ['traffic.dau', 'arch.api'], inactive: ['data.platform', 'ai.model_hosting', 'migration.strategy'], components: ['app', 'db-primary'] },
    b2b_saas: { answers: {}, active: ['traffic.dau', 'arch.api'], inactive: ['data.platform', 'ai.model_hosting', 'migration.strategy'], components: ['app', 'auth', 'db-primary'] },
    data_platform: { answers: { 'data.history_tb': v(10) }, active: ['data.platform', 'data.table_format'], inactive: ['traffic.requests_per_user', 'arch.api', 'ai.model_hosting'], components: ['lake-storage', 'bi', 'warehouse', 'ingestion'] },
    ai_app: { answers: {}, active: ['ai.model_hosting', 'ml.serving'], inactive: ['data.table_format', 'migration.strategy'], components: [['llm-gateway', 'llm-api'], 'eval-tracing'] },
    integration: { answers: {}, active: ['arch.api'], inactive: ['ai.model_hosting', 'migration.strategy'], components: ['queue', 'workers'] },
    event_streaming: { answers: {}, active: ['data.platform', 'traffic.dau'], inactive: ['ai.model_hosting', 'migration.strategy'], components: ['ingestion', 'warehouse'] },
  }
  const ORIGINS: Record<string, Path> = {
    greenfield: { answers: {}, active: ['traffic.dau'], inactive: ['migration.strategy', 'migration.sync', 'migration.rollback'], components: ['app', 'db-primary'] },
    migrate_database: { answers: migration, ...replacing },
    replace_legacy_app: { answers: migration, ...replacing },
    modernize_app: { answers: migration, ...replacing },
    extend_existing: { answers: migration, active: ['migration.sync', 'migration.link'], inactive: ['migration.rollback', 'migration.strategy', 'migration.downtime', 'migration.coexistence_months'], components: ['legacy-db', 'landing-zone'] },
  }
  const options = (id: string) => kb.questions.find((q) => q.id === id)!.options!.map((o) => o.id)
  const cases = [
    ...options('project.kind').map((kind) => ({ label: `kind ${kind}`, path: KINDS[kind], answers: { 'project.kind': v(kind) } as Answers })),
    ...options('project.origin').map((origin) => ({ label: `origin ${origin}`, path: ORIGINS[origin], answers: { 'project.origin': v(origin) } as Answers })),
  ]

  it('covers every kind and origin', () => {
    expect(cases.filter((c) => !c.path).map((c) => c.label)).toEqual([])
  })

  for (const { label, path, answers } of cases) {
    it(`asks, skips and builds what a ${label} needs`, () => {
      const e = design({ ...answers, ...path.answers })
      for (const id of path.active) expect(active(e, id), `${label}: ${id} active`).toBe(true)
      for (const id of path.inactive) expect(active(e, id), `${label}: ${id} inactive`).toBe(false)
      for (const need of path.components) {
        const any = Array.isArray(need) ? need : [need]
        expect(any.some((id) => ids(e).includes(id)), `${label}: ${any.join(' or ')}`).toBe(true)
      }
      // At least one usage-billed line (a metered or SaaS service, no instance class) carries a cost.
      expect(e.architecture.components.some((c) => c.instanceClass === null && ['run', 'transfer', 'license'].includes(c.costKind) && c.monthlyCost > 0), label).toBe(true)
      expect(e.findings.filter((x) => x.rule.severity === 'error').map((x) => x.rule.id), label).toEqual([])
    })
  }
})

describe('guidance follows the kind of task', () => {
  const findings = (e: Evaluation) => e.findings.map((x) => x.rule.id)
  const edges = (e: Evaluation) => e.architecture.edges.map((x) => `${x.from}->${x.to}`)
  const component = (e: Evaluation, id: string) => e.architecture.components.find((c) => c.def.id === id)
  const dataPlatform = (answers: Answers) => design({ 'project.kind': v('data_platform'), 'data.history_tb': v(5), ...answers })

  it('sizes batch models on the lake without asking or pricing reports nobody asked for', () => {
    const ml = design(scenario('databricks-ml-aws'))
    for (const id of ['bi.tool', 'data.analytics_users', 'data.analytics_hours']) expect(active(ml, id), id).toBe(false)
    for (const id of ['warehouse', 'bi']) expect(ids(ml), id).not.toContain(id)
    expect(edges(ml)).toEqual(expect.arrayContaining(['ml-batch->lake-storage', 'ml-batch->catalog']))
    // Query hours no longer move the bill of a nightly recommender.
    const always = design({ ...scenario('databricks-ml-aws'), 'data.analytics_hours': v(24) })
    expect(always.monthlyCost).toBeCloseTo(ml.monthlyCost)
    // Reporting brings the SQL warehouse, the BI tool and their questions back.
    const reports = design({ ...scenario('databricks-ml-aws'), 'product.features': v(['accounts', 'ml', 'analytics']) })
    for (const id of ['bi.tool', 'data.analytics_users', 'data.analytics_hours']) expect(active(reports, id), id).toBe(true)
    expect(ids(reports)).toEqual(expect.arrayContaining(['warehouse', 'bi']))
  })

  it('offers a data platform only its own capabilities and no application cards', () => {
    const e = dataPlatform({ 'product.features': v(['analytics', 'feed']) })
    expect(findings(e)).toContain('infeasible-product.features')
    // Without the request path, feeds, payments or notifications add no queue and workers off a request the platform does not have.
    for (const id of ['queue', 'workers', 'dns']) expect(ids(e), id).not.toContain(id)
    for (const feature of ['analytics', 'ml', 'jobs']) {
      const option = kb.questions.find((q) => q.id === 'product.features')!.options!.find((o) => o.id === feature)!
      expect(option.feasibleWhen, feature).toBeUndefined()
    }
  })

  it('asks a new data platform for its source inventory and ingests each kind its own way', () => {
    const postgres = dataPlatform({ 'infra.cloud': v('aws'), 'data.platform': v('native'), 'source.kinds': v(['rdbms']), 'source.rdbms_engine': v('postgres'), 'source.location': v('aws') })
    for (const id of ['source.kinds', 'source.rdbms_engine', 'source.location']) expect(active(postgres, id), id).toBe(true)
    // An Aurora or RDS PostgreSQL source replicates into Redshift with zero-ETL; the same engine in a data center cannot.
    expect(postgres.facts['data.ingestion']).toBe('zero_etl')
    const inDc = dataPlatform({ 'infra.cloud': v('aws'), 'data.platform': v('native'), 'source.kinds': v(['rdbms']), 'source.rdbms_engine': v('postgres'), 'source.location': v('onprem_dc') })
    expect(inDc.questions.find((q) => q.question.id === 'data.ingestion')!.recommendation.scores.find((s) => s.optionId === 'zero_etl')!.feasible).toBe(false)
    expect(component(postgres, 'sources')!.tech).toBe('Source systems, databases')
    const saas = dataPlatform({ 'infra.cloud': v('aws'), 'source.kinds': v(['saas_api', 'crm']) })
    expect(saas.facts['data.ingestion']).toBe('saas_connectors')
    // SaaS apps and files have no log to read, so change data capture is ruled out.
    const cdc = saas.questions.find((q) => q.question.id === 'data.ingestion')!.recommendation.scores.find((s) => s.optionId === 'cdc')!
    expect(cdc.feasible).toBe(false)
    expect(dataPlatform({ 'source.kinds': v(['events']) }).facts['data.ingestion']).toBe('streaming')
    // One ingestion choice reads one kind, so the others get paths of their own; a database stays on its log, not on a connector or a stream.
    const mixed = dataPlatform({ 'infra.cloud': v('aws'), 'source.kinds': v(['rdbms', 'crm', 'files']), 'data.freshness': v('minutes') })
    expect(mixed.facts['data.ingestion']).toBe('cdc')
    expect(ids(mixed)).toEqual(expect.arrayContaining(['ingestion', 'ingestion-saas', 'ingestion-files']))
    for (const id of ['ingestion-saas', 'ingestion-files']) expect(mixed.architecture.edges.some((x) => x.from === 'sources' && x.to === id), id).toBe(true)
    expect(dataPlatform({ 'infra.cloud': v('aws'), 'source.kinds': v(['rdbms']), 'data.analytics': v('warehouse'), 'data.freshness': v('seconds') }).facts['data.ingestion']).toBe('cdc')
    const azure = dataPlatform({ 'infra.cloud': v('azure'), 'source.kinds': v(['rdbms', 'saas_api', 'events']) })
    // Events drive the main path to a stream; the database still gets its change capture path and the SaaS APIs their connectors.
    expect(azure.facts['data.ingestion']).toBe('streaming')
    expect(ids(azure)).toEqual(expect.arrayContaining(['ingestion-db', 'ingestion-saas']))
    expect(component(azure, 'ingestion-db')!.tech).toBe('Azure Data Factory change data capture')
    expect(ids(dataPlatform({ 'source.kinds': v(['rdbms', 'saas_api']), 'data.ingestion': v('batch') }))).toContain('ingestion-saas')
  })

  it('asks how partners authenticate to a public API and protects its edge', () => {
    const e = design({ 'project.kind': v('integration') })
    for (const id of ['security.auth', 'security.edge']) expect(active(e, id), id).toBe(true)
    expect(e.facts['security.auth']).toBe('api_keys')
    expect(ids(e)).toContain('waf')
    const audited = design({ 'project.kind': v('integration'), 'security.compliance': v(['soc2']) })
    expect(audited.facts['security.auth']).toBe('client_credentials')
    expect(component(audited, 'auth')!.tech).toMatch(/client credentials/)
  })

  it('asks for and converts database code only when the system is replaced', () => {
    const extend = design({ 'project.origin': v('extend_existing'), 'project.addons': v(['ai']), 'source.kinds': v(['rdbms']) })
    expect(active(extend, 'source.code_in_db')).toBe(false)
    expect(findings(extend)).not.toContain('db-code-conversion')
    const intoLake = design({ 'project.kind': v('data_platform'), 'project.origin': v('migrate_database'), 'source.kinds': v(['rdbms']), 'source.rdbms_engine': v('postgres'), 'source.code_in_db': v('heavy') })
    expect(findings(intoLake)).not.toContain('db-code-conversion')
    const replaced = design({ 'project.origin': v('migrate_database'), 'source.kinds': v(['rdbms']), 'source.rdbms_engine': v('oracle'), 'source.code_in_db': v('heavy'), 'data.primary_db': v('postgres') })
    expect(findings(replaced)).toContain('db-code-conversion')
  })

  it('wires an AI app to the data it keeps: embedded into retrieval or read live by tools', () => {
    const live = design(scenario('agents-on-kept-sqlserver'))
    expect(live.facts['ai.existing_data']).toBe('live_tools')
    // The agents run on Azure and the SQL Server stays in the data center, so the lookups cross a VPN.
    expect(edges(live)).toEqual(expect.arrayContaining(['tool-gateway->hybrid-link', 'hybrid-link->legacy-db']))
    expect(component(live, 'hybrid-link')!.tech).toBe('Azure VPN Gateway')
    for (const id of ['bulk-loader', 'cdc-pipeline', 'landing-zone']) expect(ids(live), id).not.toContain(id)
    // Nothing is copied, so the 500 GB source adds nothing to the lake (only the app's own database counts).
    expect(live.workload.lakeStorageTb).toBeLessThan(0.1)
    // Retrieval embeds the kept records: a larger source adds tokens to the one-off embedding and vectors to the index.
    const rag = (gb: number) => design({ 'project.kind': v('ai_app'), 'project.origin': v('extend_existing'), 'source.kinds': v(['rdbms']), 'source.volume_gb': v(gb), 'ai.capabilities': v(['assistant_chat', 'rag_documents']) })
    const [small, large] = [rag(1), rag(2_000)]
    expect(large.workload.vectors).toBeGreaterThan(small.workload.vectors)
    expect(component(large, 'embeddings-backfill')!.monthlyCost).toBeGreaterThan(component(small, 'embeddings-backfill')!.monthlyCost)
    expect(edges(large)).toContain('landing-zone->doc-ingestion')
    // No analytics platform, so no lake holds the 2 TB copy.
    expect(large.workload.lakeStorageTb).toBeLessThan(0.1)
  })

  it('copies nothing out of a kept system the AI reads live or not at all', () => {
    const kept = (kinds: string[], capabilities: string[], extra: Answers = {}) =>
      design({ 'project.kind': v('ai_app'), 'project.origin': v('extend_existing'), 'source.kinds': v(kinds), 'ai.capabilities': v(capabilities), ...extra })
    const copying = ['api-extractor', 'landing-zone', 'bulk-loader', 'cdc-pipeline']
    // A SaaS CRM or API read live through tools needs no extractor, and so no landing zone.
    for (const kind of ['crm', 'saas_api']) {
      const live = kept([kind], ['assistant_chat', 'agent_actions'], { 'ai.existing_data': v('live_tools') })
      for (const id of copying) expect(ids(live), `${kind} ${id}`).not.toContain(id)
    }
    // Files have no query path, so tools cannot read them live.
    expect(findings(kept(['files'], ['assistant_chat', 'agent_actions'], { 'ai.existing_data': v('live_tools') }))).toContain('infeasible-ai.existing_data')
    // A chat-only app reads no copy of the database it keeps.
    const chat = kept(['rdbms'], ['assistant_chat'])
    for (const id of copying) expect(ids(chat), id).not.toContain(id)
    expect(active(chat, 'source.history')).toBe(false)
  })

  it('puts a device gateway with per-device identity between field devices and the stream', () => {
    const iot = design(scenario('iot-telemetry-aws'))
    expect(edges(iot)).toEqual(expect.arrayContaining(['client->device-gateway', 'device-gateway->stream']))
    expect(edges(iot)).not.toContain('client->stream')
    // 20,000 readings a second are about 52,560 million a month, each a rule and an action on IoT Core Basic Ingest ($0.30 per million).
    expect(component(iot, 'device-gateway')!.tech).toBe('AWS IoT Core (Basic Ingest)')
    expect(component(iot, 'device-gateway')!.monthlyCost).toBeCloseTo(52_560 * 0.3, 0)
  })

  it('reads data-center databases over a private link from a cloud data platform, and prices free Data Transfer Service only for non-database sources', () => {
    const onGcp = (kinds: string[]) => design({ ...scenario('gcp-bigquery-marketing'), 'source.kinds': v(kinds), 'data.ingestion': v('batch') })
    const db = onGcp(['rdbms'])
    expect(edges(db)).toEqual(expect.arrayContaining(['sources->hybrid-link', 'hybrid-link->ingestion']))
    expect(component(db, 'ingestion')!.tech).not.toBe('BigQuery Data Transfer Service')
    const saas = onGcp(['crm', 'saas_api'])
    expect(ids(saas)).not.toContain('hybrid-link')
    expect(component(saas, 'ingestion')!.tech).toBe('BigQuery Data Transfer Service')
  })

  it('bills the bank aggregator per connected account', () => {
    // 10M daily users are about 30M monthly users, one connected account each at about $0.30.
    expect(component(design(scenario('personal-finance')), 'bank-aggregator')!.monthlyCost).toBe(9_000_000)
  })

  it('runs batch extraction and agent tasks off a queue, with parsing behind the workers', () => {
    const extraction = design({ 'project.kind': v('ai_app'), 'ai.capabilities': v(['extraction_batch']), 'ai.corpus_gb': v(50) })
    expect(extraction.facts['arch.async']).toBe('queue')
    expect(edges(extraction)).toContain('workers->doc-ingestion')
    expect(edges(extraction)).not.toContain('app->doc-ingestion')
    expect(design({ 'project.kind': v('ai_app'), 'ai.capabilities': v(['assistant_chat', 'agent_actions']) }).facts['arch.async']).toBe('queue')
  })

  it('flags batch and streaming choices that contradict the freshness', () => {
    expect(findings(dataPlatform({ 'data.analytics': v('streaming'), 'data.freshness': v('daily') }))).toContain('streaming-for-batch-reports')
    expect(findings(dataPlatform({ 'data.analytics': v('warehouse'), 'data.freshness': v('seconds') }))).toContain('batch-warehouse-for-live-reports')
    expect(findings(dataPlatform({ 'data.analytics': v('warehouse'), 'data.freshness': v('daily') }))).not.toEqual(expect.arrayContaining(['streaming-for-batch-reports', 'batch-warehouse-for-live-reports']))
  })

  it('recommends streaming analytics for seconds-fresh reports, whatever the history', () => {
    for (const tb of [1, 50]) {
      const e = dataPlatform({ 'data.freshness': v('seconds'), 'data.history_tb': v(tb) })
      expect(e.facts['data.analytics'], `${tb} TB`).toBe('streaming')
      expect(findings(e), `${tb} TB`).not.toContain('batch-warehouse-for-live-reports')
    }
  })
})
