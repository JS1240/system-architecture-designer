import { describe, expect, it } from 'vitest'
import type { Answers, ComponentInstance, Overrides } from '../domain/types'
import { kb } from '../knowledge'
import { evaluate } from './evaluate'
import { autoComplete } from './explore'
import { withOverrides } from './overrides'

// Declarative (linear) sizings have no id; the checks below that key on named sizings skip them.
const sizingId = (c: ComponentInstance) => (typeof c.def.sizing === 'string' ? c.def.sizing : '')

const v = (value: unknown) => ({ kind: 'value' as const, value: value as string })
// No scenario covers a data platform with app capabilities ticked or add-ons, so these variants check that nothing hangs off a request path it lacks.
const dataPlatform = (answers: Answers): Answers => ({ 'project.kind': v('data_platform'), ...answers })
const FEATURES = ['accounts', 'media', 'search', 'chat', 'notifications', 'payments', 'geo', 'ml', 'feed', 'analytics', 'jobs', 'public_api', 'collab']
const variants: [string, Answers, Overrides?][] = [
  ...FEATURES.map((feature): [string, Answers] => [`data platform + ${feature}`, dataPlatform({ 'product.type': v('commerce'), 'product.features': v([feature]) })]),
  ['data platform + every capability', dataPlatform({ 'product.type': v('saas'), 'product.features': v(FEATURES) })],
  ['data platform + AI add-on', dataPlatform({ 'project.addons': v(['ai']) })],
  ['data platform + seconds freshness', dataPlatform({ 'data.freshness': v('seconds') })],
  ['data platform + GDPR on Azure', dataPlatform({ 'security.compliance': v(['gdpr']), 'infra.cloud': v('azure') })],
  ['data platform on AWS, 20 sources', dataPlatform({ 'infra.cloud': v('aws'), 'data.source_count': v(20), 'data.history_tb': v(10) })],
  ['data platform on premises', dataPlatform({ 'infra.cloud': v('onprem'), 'product.features': v(['analytics', 'jobs', 'ml']) })],
  // PostGIS writes every location update to the primary, so the drawn flows must carry them too.
  ['ride hailing on PostGIS', { ...kb.scenarios.find((s) => s.id === 'ride-hailing')!.answers, 'traffic.dau': v(20_000), 'data.geo_index': v('postgis') }],
  // Project overrides move the thresholds the components and flows read (blob size, instance capacity) and pin a fleet.
  [
    'query cache with 40 KB records, a 16 KB blob threshold, 100 req/s instances and a pinned app',
    { ...kb.scenarios.find((s) => s.id === 'query-cache')!.answers, 'data.object_kb': v(40) },
    { reference: { blobThresholdKb: 16, appInstanceQps: 100 }, replicas: { app: 200 } },
  ],
]

describe.each([...kb.scenarios.map((s): [string, Answers, Overrides?] => [s.id, s.answers]), ...variants])('architecture coherence: %s', (_id, answers, overrides) => {
  const k = withOverrides(kb, overrides)
  const e = evaluate(k, autoComplete(k, answers))
  const ids = new Set(e.architecture.components.map((c) => c.def.id))
  const requestEdges = e.architecture.edges.filter((x) => x.protocol !== 'telemetry')

  it('connects every component to at least one data flow', () => {
    const touched = new Set(e.architecture.edges.flatMap((x) => [x.from, x.to]))
    expect([...ids].filter((id) => !touched.has(id))).toEqual([])
  })

  it('reaches every request-path component from the clients', () => {
    // A data platform has no request path: its pipelines start at the source systems it ingests and at the schedulers that run its jobs,
    // so the walk also starts there, and checks that the rest of the data tier hangs off one of them.
    const pipelineStarts = e.facts['profile.requestPath'] === false ? ['sources', 'scheduler', 'orchestrator'] : []
    // The existing systems (tier legacy) are where migrated and extended data enters the design, so the walk starts there as well.
    const existing = e.architecture.components.filter((c) => c.def.tier === 'legacy').map((c) => c.def.id)
    const reached = new Set(['client', ...pipelineStarts, ...existing])
    for (let changed = true; changed; ) {
      changed = false
      for (const x of requestEdges) {
        if (reached.has(x.from) && !reached.has(x.to)) {
          reached.add(x.to)
          changed = true
        }
      }
    }
    // On a data platform the pipeline tier (ingestion, streams, queues, workers) is the path, so it must be fed too.
    const tiers = ['edge', 'ingress', 'compute', 'data', ...(pipelineStarts.length > 0 ? ['async'] : [])]
    // Migration tooling (transition phase) carries data in from the old system outside the design, so no client flow reaches it.
    const onPath = e.architecture.components.filter((c) => tiers.includes(c.def.tier) && c.def.shape !== 'external' && c.def.id !== 'warehouse' && c.phase !== 'transition')
    expect(onPath.map((c) => c.def.id).filter((id) => !reached.has(id))).toEqual([])
  })

  it('sizes every fleet within the 70% target utilization', () => {
    const over = e.architecture.components.filter((c) => c.utilization > k.reference.targetUtilization + 1e-9 && e.facts['data.partitioning'] !== 'vertical')
    expect(over.map((c) => `${c.def.id}=${c.utilization.toFixed(2)}`)).toEqual([])
  })

  it('keeps a spare instance in every request-path fleet when availability matters, so the survivors carry the peak', () => {
    if (Number(e.facts['reliability.nines']) < 99.9) return
    const fleets = e.architecture.components.filter((c) => ['app', 'service', 'location', 'inference', 'wsGateway'].includes(sizingId(c)))
    for (const c of fleets) expect(c.utilization * c.replicas, c.def.id).toBeLessThanOrEqual(c.replicas - 1 + 1e-9)
  })

  it('pairs producers and consumers', () => {
    expect(ids.has('workers')).toBe(ids.has('queue') || ids.has('stream'))
    if (ids.has('db-replica')) expect(e.facts['data.sql']).toBe(true)
    if (ids.has('cdn')) expect(ids.has('object-storage')).toBe(true)
    if (ids.has('api-gateway') || ids.has('lb')) expect(e.architecture.components.some((c) => c.def.group === 'service')).toBe(true)
  })

  it('gives every database partition a standby when availability matters', () => {
    // Applies to relational primaries; leaderless stores replicate inside the cluster.
    if (e.facts['data.sql'] !== true || Number(e.facts['reliability.nines']) < 99.9) return
    const primary = e.architecture.components.find((c) => c.def.id === 'db-primary')!
    const replica = e.architecture.components.find((c) => c.def.id === 'db-replica')
    expect(replica, 'standby replicas missing').toBeDefined()
    expect(replica!.replicas).toBeGreaterThanOrEqual(primary.replicas)
  })

  it('carries on each data flow the rate its target is sized on', () => {
    const w = e.workload
    const inbound = (to: string, keep: (label: string) => boolean = () => true) =>
      e.architecture.edges.filter((x) => x.to === to && x.protocol !== 'replication' && keep(x.label)).reduce((sum, x) => sum + x.qps, 0)
    const hit = ids.has('cache') ? Number(e.facts['perf.cacheHitRatio']) : 0
    const misses = w.peakLookupQps * (1 - hit)
    const readsOnPrimary = e.facts['data.strongConsistency'] === true || !ids.has('db-replica')
    if (ids.has('cache')) expect(inbound('cache')).toBeCloseTo(w.peakLookupQps + w.peakTimelineWriteQps)
    if (ids.has('db-replica')) expect(inbound('db-replica')).toBeCloseTo(readsOnPrimary ? 0 : misses)
    // Workers keep no second copy of a write; the synchronous flows carry every durable write the primary is sized on (PostGIS location rows included).
    expect(inbound('db-primary')).toBeCloseTo(w.peakDbWriteQps + (readsOnPrimary ? misses : 0))
    if (ids.has('search')) expect(inbound('search', (l) => l === 'Search queries')).toBeCloseTo(w.peakSearchQps * (1 - (e.facts['perf.cachesQueryResults'] === true ? hit : 0)))
    if (ids.has('presence')) expect(inbound('presence')).toBeCloseTo(w.concurrentConnections / 30 + w.peakWriteQps)
    if (ids.has('queue')) expect(inbound('queue')).toBeCloseTo(w.peakJobsQps)
    if (ids.has('workers')) expect(inbound('workers')).toBeCloseTo(w.peakJobsQps)
    if (ids.has('object-storage')) expect(inbound('object-storage', (l) => l === 'Pre-signed uploads')).toBeCloseTo(w.peakUploadQps)
    // Ingress and compute: each write arrives once, over HTTP or over a persistent connection.
    const capacity = { lb: k.reference.lbNodeQps, gateway: k.reference.lbNodeQps, app: k.reference.appInstanceQps, service: k.reference.appInstanceQps, location: k.reference.appInstanceQps } as Record<string, number>
    // Without a queue, compute also does the background work inside the requests, which no flow carries.
    const inline = w.peakInlineWorkQps
    const perService = inline / e.architecture.components.filter((x) => x.def.group === 'service').length
    const inlineShare = { app: inline, service: perService, location: perService } as Record<string, number>
    // A provider service billed per request (an API gateway) runs no instances to size.
    for (const c of e.architecture.components.filter((x) => capacity[sizingId(x)] && x.instanceClass !== null && (x.def.group === 'service' || x.def.tier === 'ingress'))) {
      expect(inbound(c.def.id) + (inlineShare[sizingId(c)] ?? 0), c.def.id).toBeCloseTo(c.utilization * c.replicas * capacity[sizingId(c)])
    }
  })

  it('sends client traffic through the WAF when there is one', () => {
    if (!ids.has('waf')) return
    // The CDN serves cached content at the edge; a peer region, a managed real-time service and the bucket behind a pre-signed URL have their own entry points.
    const bypass = requestEdges.filter((x) => x.from === 'client' && !['waf', 'dns', 'cdn', 'peer-region', 'realtime-service', 'object-storage'].includes(x.to))
    expect(bypass.map((x) => x.id)).toEqual([])
  })

  it('meets its availability target and reports a positive cost', () => {
    const target = e.facts['reliability.nines']
    if (typeof target === 'number') expect(e.availability).toBeGreaterThanOrEqual(target)
    expect(e.monthlyCost).toBeGreaterThan(0)
  })
})
