import { describe, expect, it } from 'vitest'
import type { Answers, ComponentInstance, Evaluation, Facts, ServiceOffer } from '../domain/types'
import { offerFor, providerAlternatives } from '../engine/architecture'
import { evaluateCondition, f, referencedComponents, referencedFacts } from '../engine/conditions'
import { evaluate } from '../engine/evaluate'
import { autoComplete, suggestFromDescription } from '../engine/explore'
import { providerLine, summaryLines } from '../docs/summary'
import { kb } from '.'

const PROVIDERS = kb.questions.find((q) => q.id === 'infra.cloud')!.options!.map((o) => o.id)
const on = (answers: Answers, provider: string): Answers => ({ ...answers, 'infra.cloud': { kind: 'value', value: provider } })
const designs = kb.scenarios.flatMap((s) => PROVIDERS.map((provider) => ({ id: `${s.id}/${provider}`, provider, e: evaluate(kb, autoComplete(kb, on(s.answers, provider))) })))
const scenario = (id: string) => kb.scenarios.find((s) => s.id === id)!.answers
const component = (e: Evaluation, id: string) => e.architecture.components.find((c) => c.def.id === id)
// Brand words that only one provider's services carry.
const TOKENS: Record<string, RegExp> = { aws: /AWS|Amazon/, azure: /Azure|Microsoft|Entra/, gcp: /Google|BigQuery|Cloud Run|Vertex/ }
const matches = (o: ServiceOffer, c: ComponentInstance) => o.component === c.def.id || o.component === `@${c.def.group}`

/** A design may lack a provider's service when a finding about the provider rules it out (an infeasible option or a provider-only service). */
function excused(e: Evaluation, c: ComponentInstance): boolean {
  return e.findings.some((x) => {
    const facts = referencedFacts(x.rule.when)
    if (!facts.has('infra.cloud')) return false
    return x.rule.severity === 'error' || referencedComponents(x.rule.when).has(c.def.id) || (c.def.techFrom !== undefined && facts.has(c.def.techFrom.fact))
  })
}

describe('provider service catalog', () => {
  it('(a) gives a present component its provider service wherever another provider has one for the same design', () => {
    const missing: string[] = []
    for (const { id, provider, e } of designs) {
      for (const c of e.architecture.components) {
        const elsewhere = kb.services.some((o) => matches(o, c) && o.provider !== provider && o.provider !== 'any' && evaluateCondition(o.when, { facts: e.facts }))
        if (elsewhere && !offerFor(kb, c.def, e.facts) && !excused(e, c)) missing.push(`${id}: ${c.def.id}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('(b) never names another provider\'s service', () => {
    const names = (provider: string) => new Set(kb.services.filter((o) => o.provider === provider).map((o) => o.name))
    const leaks: string[] = []
    for (const { id, provider, e } of designs) {
      const own = [...names(provider)]
      // Another provider's service names, except those inside one of this provider's own names (RabbitMQ in Amazon MQ for RabbitMQ).
      const foreign = PROVIDERS.filter((p) => p !== provider).flatMap((p) => [...names(p)]).filter((name) => !own.some((mine) => mine.includes(name)))
      for (const c of e.architecture.components) {
        for (const name of foreign) if (c.tech.includes(name)) leaks.push(`${id}: ${c.def.id} "${c.tech}" names "${name}"`)
        // A hybrid design runs its analytics in the cloud data.analytics_cloud names, so those rows carry that cloud's brand.
        const hosted = (p: string) => provider === 'onprem' && e.facts['data.analytics_cloud'] === p
        for (const [p, re] of Object.entries(TOKENS)) if (p !== provider && !hosted(p) && re.test(c.tech)) leaks.push(`${id}: ${c.def.id} "${c.tech}" matches ${re}`)
      }
    }
    expect(leaks).toEqual([])
  })

  it('(c) changes the monthly cost with the provider', () => {
    const changed = kb.scenarios.filter((s) => new Set(designs.filter((d) => d.id.startsWith(`${s.id}/`)).map((d) => Math.round(d.e.monthlyCost))).size > 1)
    expect(changed.length).toBeGreaterThan(0)
  })

  it('(d) dates every offer and cites a source for it', () => {
    for (const o of kb.services) {
      const label = `${o.component}/${o.provider}/${o.name}`
      expect(o.asOf, label).toMatch(/^\d{4}-\d{2}$/)
      expect(o.sources?.length ?? 0, label).toBeGreaterThan(0)
    }
  })

  it('(e) keeps a golden review summary of every scenario on every provider, so price edits show as diffs', () => {
    expect(Object.fromEntries(designs.map(({ id, e }) => [id, summaryLines(e)]))).toMatchSnapshot()
  })

  it('(f) flags list prices older than 18 months', () => {
    const oldest = kb.services.map((o) => o.asOf).sort()[0]
    const [year, month] = oldest.split('-').map(Number)
    const now = new Date()
    // Fails by design once the catalog ages: re-check the prices and move their asOf forward.
    expect(now.getFullYear() * 12 + now.getMonth() + 1 - (year * 12 + month), `oldest offer ${oldest}`).toBeLessThanOrEqual(18)
  })

  it('prints the cost of each provider on one review line', () => {
    const ecommerce = designs.filter((d) => d.id.startsWith('ecommerce/'))
    const line = providerLine(ecommerce.map((d) => ({ option: kb.questions.find((q) => q.id === 'infra.cloud')!.options!.find((o) => o.id === d.provider)!, evaluation: d.e, feasible: true })))
    expect(line).toMatch(/^cost by provider: aws \$[\d,]+ \(\+people \$[\d,]+\), gcp .*, azure .*, onprem \$[\d,]+ \(\+people \$21,875\)$/)
  })

  it('names only the offer\'s own provider in every catalog row', () => {
    for (const o of kb.services) {
      // Hybrid rows are on-prem rows for analytics hosted in the cloud their condition names (data.analytics_cloud).
      const hosted = (p: string) => o.provider === 'onprem' && JSON.stringify(o.when ?? null).includes(JSON.stringify(f.eq('data.analytics_cloud', p)))
      for (const [p, re] of Object.entries(TOKENS)) if (p !== o.provider && !hosted(p)) expect(`${o.provider}: ${o.name}`).not.toMatch(re)
    }
  })

  it('prices own hardware lower and adds the platform team on-premises', () => {
    const aws = evaluate(kb, autoComplete(kb, on(scenario('ecommerce'), 'aws')))
    const onprem = evaluate(kb, autoComplete(kb, on(scenario('ecommerce'), 'onprem')))
    expect(Math.abs(onprem.monthlyCost / aws.monthlyCost - 1)).toBeGreaterThan(0.1)
    // The hardware base, the Kubernetes platform a cloud cluster needs too, and a quarter FTE for the e-commerce estate's own servers.
    expect(onprem.cost.people).toBe((kb.reference.onpremOpsFte + 1 + 0.25) * kb.reference.opsFteMonthlyUsd)
    // Instance lines follow the provider price factor; object storage follows the offer's per-TB price.
    const cache = (e: Evaluation) => component(e, 'cache')!
    expect(cache(onprem).unitCost / cache(aws).unitCost).toBeCloseTo(kb.reference.providerPriceFactor.onprem)
    expect(component(onprem, 'object-storage')!.unitCost).toBe(kb.reference.onpremStoragePerTbMonth)
    expect(component(aws, 'object-storage')!.unitCost).toBe(23)
  })

  it('carries a people line on every provider, sized by the compute platform, outside the monthly run cost', () => {
    const fte = kb.reference.opsFteMonthlyUsd
    const people = (answers: Answers) => evaluate(kb, autoComplete(kb, answers))
    const containers = people(on(scenario('ecommerce'), 'aws'))
    expect(containers.cost.people).toBe(0.25 * fte)
    expect(component(containers, 'platform-ops')!.costKind).toBe('people')
    expect(containers.cost.monthly).toBe(containers.monthlyCost)
    expect(people({ ...on(scenario('ecommerce'), 'gcp'), 'infra.compute': { kind: 'value', value: 'kubernetes' } }).cost.people).toBe(fte)
    // While the provider is pending there is no people line yet.
    expect(component(evaluate(kb, scenario('ecommerce')), 'platform-ops')).toBeUndefined()
  })

  it('names the Azure services of the e-commerce design', () => {
    const azure = evaluate(kb, autoComplete(kb, on(scenario('ecommerce'), 'azure')))
    const tech = azure.architecture.components.map((c) => c.tech)
    for (const name of ['Azure Service Bus', 'Application Gateway (L7)', 'Azure Database for PostgreSQL Flexible Server']) expect(tech.some((t) => t.startsWith(name)), name).toBe(true)
  })

  it('keeps managed PostgreSQL out of multi-primary and sharded designs', () => {
    const video = evaluate(kb, autoComplete(kb, on(scenario('video-streaming'), 'aws')))
    expect(video.facts['data.replication']).toBe('multi_primary')
    expect(component(video, 'db-primary')!.tech).toMatch(/^PostgreSQL on EC2, .*multi-primary via BDR/)
    const sharded = evaluate(kb, autoComplete(kb, { ...on(scenario('video-streaming'), 'azure'), 'data.replication': { kind: 'value', value: 'primary_replicas' } }))
    expect(sharded.facts['data.partitioning']).toBe('hash_sharding')
    expect(component(sharded, 'db-primary')!.tech).toMatch(/^Azure Database for PostgreSQL elastic clusters \(Citus\)/)
    const managed = kb.services.filter((o) => o.component === 'db-primary' && /^(RDS|Azure Database|Cloud SQL)/.test(o.name))
    const cases: Facts[] = [{ 'data.primary_db': 'postgres', 'data.replication': 'multi_primary' }, { 'data.primary_db': 'mysql', 'data.partitioning': 'range_sharding' }]
    for (const facts of cases) {
      expect(managed.filter((o) => evaluateCondition(o.when, { facts })).map((o) => o.name)).toEqual([])
    }
  })

  it('records a published SLA for every cloud provider of a component or for none', () => {
    const clouds = PROVIDERS.filter((p) => p !== 'onprem')
    const partial = [...new Set(kb.services.filter((o) => o.sla !== undefined).map((o) => o.component))].filter(
      (component) => !clouds.every((p) => kb.services.some((o) => o.component === component && o.provider === p && o.sla !== undefined)),
    )
    expect(partial).toEqual([])
  })

  it('picks the same disaster recovery for a scenario on AWS, Azure and Google Cloud', () => {
    // A standby region on one cloud only would come from an SLA recorded for that cloud alone, which skews the provider comparison.
    const drOf = (e: Evaluation) => e.facts['reliability.dr']
    const skewed = kb.scenarios
      .map((s) => ({ id: s.id, dr: ['aws', 'azure', 'gcp'].map((p) => drOf(designs.find((d) => d.id === `${s.id}/${p}`)!.e)) }))
      .filter((s) => new Set(s.dr).size > 1)
      .map((s) => `${s.id}: ${s.dr.join(' / ')}`)
    expect(skewed).toEqual([])
    expect(drOf(evaluate(kb, autoComplete(kb, on(scenario('url-shortener'), 'azure'))))).toBe('backups')
  })

  it('puts WebSocket servers behind the drawn and priced balancer on every provider', () => {
    for (const provider of PROVIDERS) {
      const e = evaluate(kb, autoComplete(kb, on(scenario('chat-app'), provider)))
      expect(e.facts['perf.realtime'], provider).toBe('websocket')
      const behind = component(e, 'ws-gateway')!.tech.split(' behind ')[1].replace(/^an? /, '')
      expect(component(e, 'lb')!.tech.startsWith(behind), `${provider}: ${behind}`).toBe(true)
      // On PaaS no lb is drawn, so the label names no balancer.
      const paas = evaluate(kb, autoComplete(kb, { ...on(scenario('chat-app'), provider), 'infra.compute': { kind: 'value', value: 'paas' } }))
      expect(component(paas, 'lb'), provider).toBeUndefined()
      expect(component(paas, 'ws-gateway')!.tech, provider).not.toContain('behind')
    }
  })

  it('lists the same service on the other providers, or none where a provider has no offer', () => {
    const v = (value: unknown) => ({ kind: 'value' as const, value: value as string })
    const e = evaluate(kb, autoComplete(kb, on(scenario('chat-app'), 'aws')))
    expect(providerAlternatives(kb, component(e, 'queue')!.def, e.facts).find((a) => a.provider === 'azure')?.name).toBe('Azure Service Bus')
    // The equivalent is resolved per provider, not by an identical condition: past 32 TB the AWS native warehouse maps to BigQuery.
    const native = evaluate(kb, autoComplete(kb, { ...scenario('onprem-iceberg-lakehouse'), 'security.residency': v('none'), 'infra.cloud': v('aws'), 'data.platform': v('native'), 'data.history_tb': v(50) }))
    expect(providerAlternatives(kb, component(native, 'warehouse')!.def, native.facts)).toEqual([
      { provider: 'gcp', name: 'BigQuery + BigLake' },
      { provider: 'azure', name: null },
      { provider: 'onprem', name: null },
    ])
    expect(providerAlternatives(kb, component(native, 'lake-storage')!.def, native.facts).find((a) => a.provider === 'onprem')?.name).toBe('MinIO or Ceph RGW')
    const hybrid = evaluate(kb, autoComplete(kb, { ...scenario('onprem-erp-databricks-hybrid'), 'data.platform': v('fabric'), 'data.ingestion': v('cdc') }))
    expect(providerAlternatives(kb, component(hybrid, 'ingestion')!.def, hybrid.facts).find((a) => a.provider === 'azure')?.name).toBe('Fabric Mirroring')
  })
})

describe('residency, formats and per-use billing', () => {
  const v = (value: unknown) => ({ kind: 'value' as const, value: value as string })
  const design = (answers: Answers) => evaluate(kb, autoComplete(kb, answers))
  const errors = (e: Evaluation) => e.findings.filter((x) => x.rule.severity === 'error').map((x) => x.rule.id)

  it('keeps BI on own hardware when data must stay there: server editions, no Google-hosted Looker', () => {
    const lake = { ...scenario('onprem-iceberg-lakehouse'), 'security.residency': v('air_gapped'), 'org.existing_platforms': v(['datacenter', 'm365']) }
    const e = design(lake)
    expect(component(e, 'bi')!.tech).not.toMatch(/Looker|Tableau Cloud/)
    for (const [tool, name] of [['power_bi', 'Power BI Report Server'], ['tableau', 'Tableau Server (self-hosted)']]) {
      const chosen = design({ ...lake, 'bi.tool': v(tool) })
      expect(component(chosen, 'bi')!.tech, tool).toBe(name)
      expect(errors(chosen), tool).toEqual([])
    }
    for (const tool of ['looker', 'looker_studio']) expect(errors(design({ ...lake, 'bi.tool': v(tool) })), tool).toContain('infeasible-bi.tool')
    // Data that may leave the site keeps the cloud service.
    expect(component(design({ ...scenario('fabric-bi-azure'), 'bi.tool': v('power_bi') }), 'bi')!.tech).toBe('Power BI')
  })

  it('rules out a hosted real-time service on premises, as it rules out hosted search', () => {
    const chat = { ...scenario('chat-app'), 'infra.cloud': v('onprem'), 'team.size': v('tiny') }
    expect(design(chat).facts['perf.realtime']).not.toBe('managed')
    expect(errors(design({ ...chat, 'perf.realtime': v('managed') }))).toContain('infeasible-perf.realtime')
  })

  it('writes Hudi on the open lakehouse on every provider, with a catalog there', () => {
    for (const cloud of ['aws', 'azure', 'gcp', 'onprem']) {
      const e = design({ ...scenario('onprem-iceberg-lakehouse'), 'security.residency': v('none'), 'infra.cloud': v(cloud), 'data.platform': v('oss_lakehouse'), 'data.table_format': v('hudi') })
      expect(errors(e), cloud).not.toContain('infeasible-data.table_format')
      expect(component(e, 'catalog')!.offer, cloud).toBeDefined()
    }
    expect(errors(design({ ...scenario('gcp-bigquery-marketing'), 'data.platform': v('native'), 'data.table_format': v('hudi') }))).toContain('infeasible-data.table_format')
  })

  it('names an Elasticsearch-compatible service for Elasticsearch on Azure', () => {
    const offer = offerFor(kb, kb.components.find((c) => c.id === 'search')!, { 'infra.cloud': 'azure', 'data.search': 'elasticsearch' })
    expect(offer!.name).toMatch(/Elastic/)
  })

  it('detects on-premises and the table format in a brief', () => {
    const value = (a: Answers, id: string) => (a[id]?.kind === 'value' ? a[id].value : undefined)
    const delta = suggestFromDescription(kb, 'Lakehouse on our own servers with Delta Lake tables')
    expect(value(delta, 'infra.cloud')).toBe('onprem')
    expect(value(delta, 'data.table_format')).toBe('delta')
    const hudi = suggestFromDescription(kb, 'Hudi tables on premises for CDC upserts')
    expect(value(hudi, 'infra.cloud')).toBe('onprem')
    expect(value(hudi, 'data.table_format')).toBe('hudi')
    expect(value(suggestFromDescription(kb, 'Iceberg in our onprem data center'), 'data.table_format')).toBe('iceberg')
  })

  it('bills gateways and WAFs per request, identity per monthly user and logs per GB on the cloud providers', () => {
    const e = design(on(scenario('url-shortener'), 'aws'))
    const millions = Number(e.facts['cap.requestsMonth']) / 1e6
    expect(millions).toBeGreaterThan(10_000)
    // The redirects reach the app through the load balancer; the gateway fronts only the link-creation API (the writes).
    const gateway = component(e, 'api-gateway')!
    expect(gateway.units).toBe(Math.ceil((Number(e.facts['cap.writeQps']) * 86_400 * 365) / 12 / 1e6))
    expect(gateway.monthlyCost).toBeLessThan(500)
    expect(component(e, 'waf')!.monthlyCost).toBeCloseTo(Math.ceil(millions) * 0.6, 0)
    expect(component(e, 'observability')!.units).toBe(Math.ceil(millions))
    // 10M daily users are about 30M monthly users past Cognito's free 10,000.
    const graph = component(design(on({ ...scenario('social-graph'), 'security.auth': { kind: 'value', value: 'oidc' } }, 'aws')), 'auth')!
    expect(graph.units).toBe(30_000_000 - 10_000)
    expect(graph.monthlyCost).toBeGreaterThan(50_000)
    // Federated sign-in (SSO) bills each monthly user past 50 too, not a flat line, so at 35M daily users the engine no longer recommends it.
    expect(e.facts['security.auth']).not.toBe('sso')
    const sso = component(design(on({ ...scenario('url-shortener'), 'security.auth': { kind: 'value', value: 'sso' } }, 'aws')), 'auth')!
    expect(sso.tech).toBe('Cognito SAML federation')
    expect(sso.units).toBe(Math.ceil(Number(e.facts['cap.dau']) * 3) - 50)
    expect(sso.monthlyCost).toBeCloseTo(sso.units * 0.015, 0)
    // Self-hosted rows keep their node pricing.
    const own = design(on(scenario('url-shortener'), 'onprem'))
    expect(component(own, 'waf')!.instanceClass).not.toBeNull()
    expect(component(own, 'observability')!.instanceClass).not.toBeNull()
  })

  it('bills API Gateway REST past 20 billion requests a month at the lower tier', () => {
    const gateway = component(design(on(scenario('social-network'), 'aws')), 'api-gateway')!
    expect(gateway.units).toBeGreaterThan(1e5)
    expect(gateway.unitCost).toBe(1.6)
  })

  it('inspects only HTTP requests on a WebSocket design and bills the balancer for the held connections', () => {
    const e = design(on(scenario('chat-app'), 'aws'))
    expect(component(e, 'waf')!.units).toBe(Math.ceil((Number(e.facts['cap.readQps']) * 86_400 * 365) / 12 / 1e6))
    const lb = component(e, 'lb')!
    expect(lb.units).toBe(Math.ceil(Number(e.facts['cap.connections']) / 3_000))
    expect(lb.monthlyCost).toBeGreaterThan(40_000)
  })

  it('sizes Kinesis on shards of 1,000 events/s, not on Kafka brokers', () => {
    const stream = component(design(scenario('iot-telemetry-aws')), 'stream')!
    expect(stream.tech).toBe('Kinesis Data Streams')
    expect(stream.units).toBeGreaterThanOrEqual(20)
    expect(stream.monthlyCost).toBe(stream.units * 44)
  })

  it('hosts every Logic Apps workflow on one Standard plan, not a fee per connected system', () => {
    const e = design(scenario('erp-crm-sync-azure'))
    expect(Number(e.facts['integration.systems'])).toBeGreaterThan(1)
    expect(component(e, 'integration-hub')!.monthlyCost).toBe(350)
  })

  it('keeps an own push-CDN edge fleet off the cloud bill that prices the support plan', () => {
    const cdn = component(design(on(scenario('video-streaming'), 'aws')), 'cdn')!
    expect(cdn.tech).toMatch(/own edge/)
    expect(cdn.billedBy).not.toBe('aws')
  })
})
