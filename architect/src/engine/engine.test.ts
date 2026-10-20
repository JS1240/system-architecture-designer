import { describe, expect, it } from 'vitest'
import type { Answers, ComponentDef, Evaluation, Facts, KnowledgeBase, LinearSizing, Question, QuestionOption, ServiceOffer } from '../domain/types'
import { kb } from '../knowledge'
import { crossCloudPlatform } from '../knowledge/questions'
import { fmt, formatAvailability } from './architecture'
import { estimateAvailability } from './availability'
import { couldHold, evaluateCondition, explainCondition, f } from './conditions'
import { evaluate } from './evaluate'
import { assumedDesign, assumptionSensitivity, autoComplete, cheapestOption, compareOver, costLevers, diffEvaluations, optionChange, pickSuggestions, runAndPeople, suggestFromDescription, suggestionKey, unmappedTerms, whatIfLevers } from './explore'
import { withOverrides } from './overrides'
import { defaultFor, questionsForRule, recommend } from './questions'

const scenario = (id: string): Answers => kb.scenarios.find((s) => s.id === id)!.answers
const design = (answers: Answers): Evaluation => evaluate(kb, autoComplete(kb, answers))
const ids = (e: Evaluation) => e.architecture.components.map((c) => c.def.id)
const value = (e: Evaluation, id: string) => e.facts[id]
const component = (e: Evaluation, id: string) => e.architecture.components.find((c) => c.def.id === id)

describe('conditions', () => {
  it('evaluates operators and combinators', () => {
    const facts = { a: 5, b: 'x', c: ['p', 'q'] }
    expect(evaluateCondition(f.all(f.gt('a', 4), f.eq('b', 'x'), f.inc('c', 'q')), { facts })).toBe(true)
    expect(evaluateCondition(f.any(f.lt('a', 1), f.in('b', ['y'])), { facts })).toBe(false)
    expect(evaluateCondition(f.not(f.exists('missing')), { facts })).toBe(true)
    expect(evaluateCondition(f.has('cache'), { facts, components: new Set(['cache']) })).toBe(true)
  })

  it('tells whether unknown facts could still make a condition hold', () => {
    const ctx = { facts: { a: 1, b: 'x' } }
    const unknown = new Set(['c'])
    expect(couldHold(f.all(f.eq('b', 'x'), f.eq('c', 'y')), ctx, unknown)).toBe(true)
    expect(couldHold(f.all(f.eq('b', 'z'), f.eq('c', 'y')), ctx, unknown)).toBe(false)
    expect(couldHold(f.not(f.any(f.eq('b', 'x'), f.eq('c', 'y'))), ctx, unknown)).toBe(false)
    expect(couldHold(f.not(f.eq('c', 'y')), ctx, unknown)).toBe(true)
  })
})

describe('question flow', () => {
  it('starts with the kind of task and asks only relevant questions', () => {
    const e = evaluate(kb, {})
    // The application type's defaults read the kind, so the kind comes first.
    expect(e.next?.question.id).toBe('project.kind')
    const inactive = e.questions.filter((q) => !q.active).map((q) => q.question.id)
    expect(inactive).toContain('perf.realtime')
    expect(inactive).toContain('payments.design')
  })

  it('branches on features: chat activates real-time questions', () => {
    const e = evaluate(kb, { 'product.features': { kind: 'value', value: ['chat'] } })
    const active = new Set(e.questions.filter((q) => q.active).map((q) => q.question.id))
    expect(active.has('perf.realtime')).toBe(true)
    expect(active.has('traffic.concurrency')).toBe(true)
  })

  it('tracks dependencies of a question on earlier answers', () => {
    const e = evaluate(kb, {})
    const cache = e.questions.find((q) => q.question.id === 'perf.cache')!
    expect(cache.dependsOn).toContain('traffic.read_write')
    expect(cache.dependsOn).toContain('traffic.dau')
  })

  it('lists the workload inputs beyond traffic and data sizing as dependencies of capacity-driven questions', () => {
    const e = evaluate(kb, scenario('ride-hailing'))
    const dependsOn = (id: string) => e.questions.find((q) => q.question.id === id)!.dependsOn
    // PostGIS turns every location update into a primary write, so partitioning waits for the geo index.
    for (const id of ['data.partitioning', 'data.replication']) expect(dependsOn(id), id).toEqual(expect.arrayContaining(['data.geo_index', 'data.primary_db', 'product.type']))
    // Location updates exist only for live-tracking (mobility) apps.
    expect(dependsOn('data.geo_index')).toContain('product.type')
  })

  it('treats unknown answers as the recommendation and custom answers as their mapped option', () => {
    const answers: Answers = {
      'product.type': { kind: 'value', value: 'saas' },
      'data.primary_db': { kind: 'custom', text: 'CockroachDB', treatAs: 'postgres' },
      'arch.style': { kind: 'unknown' },
    }
    const e = evaluate(kb, answers)
    expect(value(e, 'arch.style')).toBe('monolith')
    expect(component(e, 'db-primary')!.tech).toBe('CockroachDB')
  })

  it('asks the questions a recommendation depends on before it, so accepting each recommendation stays consistent', () => {
    // Clicking a recommended option pins it, so a question asked before its inputs would keep a stale choice.
    const walk = (id: string) => {
      const answers: Answers = { ...scenario(id) }
      const asked: string[] = []
      for (let e = evaluate(kb, answers); e.next; e = evaluate(kb, answers)) {
        asked.push(e.next.question.id)
        const { optionId } = e.next.recommendation
        answers[e.next.question.id] = optionId ? { kind: 'value', value: optionId } : { kind: 'unknown' }
      }
      return { asked, e: evaluate(kb, answers) }
    }
    // A brief that names its platform keeps it against a cheaper recommendation; the scenario notes why.
    const pinnedAgainstRecommendation: Record<string, string[]> = { 'sqlserver-dw-to-fabric': ['data.platform'], 'rag-assistant-azure': ['ai.vector_store'] }
    for (const { id } of kb.scenarios) {
      const { e } = walk(id)
      const pinned = pinnedAgainstRecommendation[id] ?? []
      expect(e.questions.filter((q) => q.divergesFromRecommendation && !pinned.includes(q.question.id)).map((q) => q.question.id), id).toEqual([])
      expect(e.findings.filter((x) => x.rule.severity === 'error').map((x) => x.rule.id), id).toEqual([])
    }
    const { asked, e } = walk('video-streaming')
    expect(asked.indexOf('reliability.multi_region')).toBeLessThan(asked.indexOf('data.replication'))
    expect(asked.indexOf('arch.style')).toBeLessThan(asked.indexOf('data.partitioning'))
    // A single primary cannot take the writes of every active region.
    const replication = e.questions.find((q) => q.question.id === 'data.replication')!
    expect(replication.recommendation.scores.find((x) => x.optionId === 'primary_replicas')!.feasible).toBe(false)
  })

  it('flags earlier decisions whose recommendation changed', () => {
    const base: Answers = { ...scenario('internal-tool'), 'arch.style': { kind: 'value', value: 'monolith' } }
    const grown = { ...base, 'team.size': { kind: 'value' as const, value: 'large' } }
    const state = evaluate(kb, grown).questions.find((q) => q.question.id === 'arch.style')!
    expect(state.recommendation.optionId).toBe('microservices')
    expect(state.divergesFromRecommendation).toBe(true)
  })
})

describe('capacity estimates', () => {
  it('matches the primer back-of-the-envelope math', () => {
    // scaling_aws: 1B writes and 100B reads per month is about 400 writes/s and 40,000 reads/s.
    const monthlySeconds = 2_592_000
    const dau = 1_000_000
    const requestsPerUser = (101e9 / monthlySeconds / dau) * 86_400
    const e = evaluate(kb, {
      'traffic.dau': { kind: 'value', value: dau },
      'traffic.requests_per_user': { kind: 'value', value: requestsPerUser },
      'traffic.read_write': { kind: 'value', value: 'read_heavy' },
    })
    expect(e.workload.writeQps).toBeCloseTo(385, -1)
    expect(e.workload.readQps).toBeCloseTo(38_580, -2)
  })
})

describe('realistic scenarios', () => {
  it('keeps an internal tool simple', () => {
    const e = design(scenario('internal-tool'))
    expect(value(e, 'arch.style')).toBe('monolith')
    expect(value(e, 'data.primary_db')).toBe('postgres')
    expect(ids(e)).not.toContain('cache')
    expect(ids(e)).not.toContain('lb')
    expect(ids(e)).not.toContain('stream')
    expect(component(e, 'app')!.replicas).toBe(1)
    expect(e.findings.filter((x) => x.rule.severity === 'error')).toEqual([])
  })

  it('designs a read-heavy URL shortener with cache, replicas and a gateway', () => {
    const e = design(scenario('url-shortener'))
    expect(value(e, 'perf.cache')).toBe('cache_aside')
    expect(ids(e)).toEqual(expect.arrayContaining(['lb', 'cache', 'db-replica', 'api-gateway', 'warehouse']))
    expect(e.findings.filter((x) => x.rule.severity === 'error')).toEqual([])
  })

  it('scales a social network to microservices, CDN, search cluster and sharding', () => {
    const e = design(scenario('social-network'))
    expect(value(e, 'arch.style')).toBe('microservices')
    expect(value(e, 'perf.cdn')).toBe('pull')
    expect(value(e, 'data.search')).toBe('elasticsearch')
    expect(ids(e)).toEqual(expect.arrayContaining(['cdn', 'svc-feed', 'svc-media', 'search', 'object-storage', 'mesh']))
    expect(component(e, 'app')).toBeUndefined()
    expect(component(e, 'cache')!.replicas).toBeGreaterThan(1)
  })

  it('gives a chat app WebSockets and a write-optimized store', () => {
    const e = design(scenario('chat-app'))
    expect(value(e, 'perf.realtime')).toBe('websocket')
    expect(value(e, 'data.primary_db')).toBe('cassandra')
    expect(component(e, 'ws-gateway')!.replicas).toBeGreaterThan(10)
  })

  it('protects payments in e-commerce', () => {
    const e = design(scenario('ecommerce'))
    expect(value(e, 'product.consistency')).toBe('strong')
    expect(value(e, 'security.edge')).toBe('waf')
    expect(ids(e)).toEqual(expect.arrayContaining(['waf', 'payment-psp', 'secrets', 'search']))
    expect(e.findings.map((x) => x.rule.id)).toContain('payments-idempotency')
  })

  it('sizes message and tweet rows as their sources do', () => {
    // WhatsApp case study: 100 bytes per message; primer Twitter: 8 B tweet_id + 32 B user_id + 140 B text, with media counted separately.
    for (const [id, sourceBytes] of [['chat-app', 100], ['social-network', 180]] as const) {
      const w = design(scenario(id)).workload
      const rowBytes = (w.dbStorageGb * 1024 ** 3) / (w.writeQps * 86_400 * 365 * 3)
      expect(rowBytes / sourceBytes, id).toBeCloseTo(1, 1)
    }
  })

  it('uses a geo index for ride hailing', () => {
    const e = design(scenario('ride-hailing'))
    expect(value(e, 'data.geo_index')).toBe('redis_geo')
    expect(ids(e)).toContain('geo-index')
  })

  it('pushes video to the edge for streaming', () => {
    const e = design(scenario('video-streaming'))
    expect(value(e, 'perf.cdn')).toBe('push')
    expect(value(e, 'reliability.multi_region')).toBe('active_active')
    // The primer and main README pair heavy traffic with pull CDNs, so egress alone must not score push.
    const pushScore = (s: Evaluation) => s.questions.find((q) => q.question.id === 'perf.cdn')!.recommendation.scores.find((x) => x.optionId === 'push')!
    expect(pushScore(e).reasons.join(' ')).not.toMatch(/egress/i)
    const social = design({ ...scenario('social-network'), 'traffic.dau': { kind: 'value', value: 1_000_000_000 } })
    expect(social.workload.egressMbps).toBeGreaterThan(50_000)
    expect(pushScore(social).reasons).toEqual([])
  })

  it('keeps number answers within their question bounds', () => {
    // The Traffic x100 what-if lever sends 10B daily users for the social network; traffic.dau stops at 1B.
    const dau = kb.questions.find((q) => q.id === 'traffic.dau')!.number!
    const e = evaluate(kb, { ...scenario('social-network'), 'traffic.dau': { kind: 'value', value: dau.max * 10 } })
    expect(e.facts['traffic.dau']).toBe(dau.max)
    const tiny = evaluate(kb, { ...scenario('personal-finance'), 'data.object_kb': { kind: 'value', value: 0 } })
    expect(tiny.facts['data.object_kb']).toBe(kb.questions.find((q) => q.id === 'data.object_kb')!.number!.min)
  })

  it('ships an AI assistant on a hosted LLM with retrieval', () => {
    const e = design(scenario('ai-assistant'))
    expect(value(e, 'ml.serving')).toBe('llm_api')
    expect(ids(e)).toContain('llm-api')
    // About 55M chunk embeddings outgrow pgvector, so the vector store recommendation moves them to managed vector search.
    expect(e.workload.vectors).toBeGreaterThan(50_000_000)
    expect(value(e, 'ai.vector_store')).toBe('managed')
    expect(ids(e)).toContain('vector-db')
    expect(component(e, 'db-primary')!.tech).not.toContain('pgvector')
    // Kept on pgvector, the embeddings stay in the PostgreSQL primary, and the scale warning fires.
    const pg = design({ ...scenario('ai-assistant'), 'ai.vector_store': { kind: 'value', value: 'pgvector' } })
    expect(ids(pg)).not.toContain('vector-db')
    expect(component(pg, 'db-primary')!.tech).toContain('pgvector')
    expect(pg.findings.map((x) => x.rule.id)).toContain('ai-pgvector-scale')
    const mongo = evaluate(kb, autoComplete(kb, { ...scenario('ai-assistant'), 'data.primary_db': { kind: 'value', value: 'mongodb' } }))
    expect(component(mongo, 'db-primary')!.tech).not.toContain('pgvector')
    expect(ids(mongo)).toContain('vector-db')
    expect(value(e, 'arch.style')).not.toBe('microservices')
  })

  it('keeps large crawled pages in object storage, not database rows', () => {
    const e = design(scenario('web-crawler'))
    expect(ids(e)).toContain('object-storage')
    expect(component(e, 'db-primary')!.replicas).toBeLessThan(200)
    expect(e.workload.totalStorageGb).toBeGreaterThan(e.workload.dbStorageGb * 100)
  })

  it('never recommends a design that its own warnings contradict', () => {
    // Warnings that point at a choice the engine itself made (not at user overrides or general advice).
    const selfContradictions = ['media-no-cdn', 'no-cache-reads', 'db-fts-load', 'over-budget', 'availability-gap', 'single-db-ha', 'vertical-insufficient', 'microservices-small-team', 'microservices-no-tracing', 'serverless-sustained', 'canary-high-nines']
    for (const s of kb.scenarios) {
      const hits = design(s.answers).findings.map((x) => x.rule.id).filter((id) => selfContradictions.includes(id))
      expect(hits, s.id).toEqual([])
    }
  })

  it('assumes the stated default when nothing points elsewhere', () => {
    const e = design({ 'product.type': { kind: 'value', value: 'saas' } })
    expect(e.facts['infra.budgetUsd']).toBe(5_000)
    expect(e.facts['reliability.nines']).toBe(99.9)
  })

  it('sizes from the second independent review: multi-primary, transcoding, cached search, storage limits', () => {
    const video = design(scenario('video-streaming'))
    expect(video.facts['data.replication']).toBe('multi_primary')
    expect(component(video, 'workers')!.replicas).toBeGreaterThanOrEqual(17)
    expect(component(design(scenario('query-cache')), 'search')!.replicas).toBeLessThanOrEqual(3)
    expect(design(scenario('url-shortener')).facts['data.partitioning']).not.toBe('vertical')
    const ride = design(scenario('ride-hailing'))
    expect(component(ride, 'geo-index')!.sizingNote).toContain('location updates/s')
  })

  it('keeps strongly consistent reads off asynchronous replicas', () => {
    const e = design(scenario('ecommerce'))
    expect(e.facts['data.strongConsistency']).toBe(true)
    expect(e.architecture.edges.filter((x) => x.to === 'db-replica' && x.label === 'Read queries')).toEqual([])
    const ride = design(scenario('ride-hailing'))
    expect(ride.workload.peakDbWriteQps).toBeLessThan(ride.workload.peakLocationQps)
  })

  it('sizes stores without a replica tier for their cache-miss reads', () => {
    const e = design({ ...scenario('chat-app'), 'traffic.read_write': { kind: 'value', value: 'read_heavy' }, 'data.retention_years': { kind: 'value', value: 0.1 } })
    expect(value(e, 'data.primary_db')).toBe('cassandra')
    const misses = e.workload.peakLookupQps * (1 - Number(value(e, 'perf.cacheHitRatio')))
    expect(component(e, 'db-primary')!.replicas).toBeGreaterThanOrEqual(Math.ceil(misses / (kb.reference.dbReplicaReadQps * kb.reference.targetUtilization)))
  })

  it('says that strongly consistent reads stay on the primary', () => {
    for (const id of ['ecommerce', 'ride-hailing', 'personal-finance']) {
      const note = component(design(scenario(id)), 'db-replica')!.sizingNote
      expect(note, id).toContain('Reads stay on the primary')
      expect(note, id).not.toContain('reach the database')
    }
  })

  it('does not justify replicas by read volume under strong consistency', () => {
    for (const id of ['ecommerce', 'ride-hailing']) {
      const state = design(scenario(id)).questions.find((q) => q.question.id === 'data.replication')!
      expect(state.recommendation.reasons, id).not.toContain('Read volume benefits from replicas.')
    }
  })

  it('keeps the availability minimum on the cache', () => {
    for (const id of ['query-cache', 'url-shortener']) expect(component(design(scenario(id)), 'cache')!.replicas, id).toBeGreaterThanOrEqual(2)
  })

  it('offers multi-primary replication whenever it recommends active-active', () => {
    // An open budget, so the price of a second stack does not decide here (a budget up to $50k prefers one region that meets the target).
    const global: Answers = { ...scenario('internal-tool'), 'product.type': { kind: 'value', value: 'saas' }, 'traffic.geo': { kind: 'value', value: 'global' }, 'infra.budget': { kind: 'value', value: 10_000_000 } }
    const e = design({ ...global, 'reliability.availability': { kind: 'value', value: 'three_half' } })
    expect(value(e, 'reliability.multi_region')).toBe('active_active')
    expect(value(e, 'data.replication')).toBe('multi_primary')
    expect(e.findings.filter((x) => x.rule.severity === 'error')).toEqual([])
    // Below 99.95% one region with several zones covers the target, as the question's help says, even for global users.
    expect(value(design(global), 'reliability.multi_region')).toBe('single_region')
  })

  it('recommends active-active for five nines, where a failover of minutes exceeds the budget, and can meet it', () => {
    for (const id of ['url-shortener', 'chat-app', 'sales-rank']) {
      const e = design({ ...scenario(id), 'reliability.availability': { kind: 'value', value: 'five' } })
      expect(value(e, 'reliability.multi_region'), id).toBe('active_active')
      expect(e.availability, id).toBeGreaterThanOrEqual(99.999)
      expect(e.findings.map((x) => x.rule.id), id).not.toContain('availability-gap')
    }
  })

  it('does not score active-passive on the single write region that one region also has', () => {
    for (const id of ['ecommerce', 'personal-finance']) {
      const state = design(scenario(id)).questions.find((q) => q.question.id === 'reliability.multi_region')!
      const score = (option: string) => state.recommendation.scores.find((x) => x.optionId === option)!.score
      expect(score('single_region'), id).toBeGreaterThan(score('active_passive'))
    }
    const ride = design(scenario('ride-hailing')).questions.find((q) => q.question.id === 'reliability.multi_region')!
    expect(ride.recommendation.reasons).toEqual(['Regional failover is needed for the availability target.'])
  })

  it('fails strongly consistent primaries over to a synchronous standby', () => {
    for (const id of ['ecommerce', 'ride-hailing', 'personal-finance']) {
      const e = design(scenario(id))
      expect(component(e, 'db-replica')!.tech, id).toContain('synchronous standby')
      expect(component(e, 'db-replica')!.sizingNote, id).toContain('synchronous failover standbys')
      const replication = e.architecture.edges.filter((x) => x.to === 'db-replica' && x.protocol === 'replication')
      expect(replication.map((x) => x.label), id).toEqual(['Synchronous replication (commit waits for the standby)'])
    }
    const eventual = design(scenario('url-shortener'))
    expect(component(eventual, 'db-replica')!.tech).not.toContain('synchronous')
    expect(eventual.architecture.edges.filter((x) => x.to === 'db-replica' && x.protocol === 'replication').map((x) => x.label)).toEqual(['Replication'])
  })

  it('gives every shard of an in-memory store a standby and counts the shards in series', () => {
    const cases = [['ride-hailing', 'geo-index'], ['chat-app', 'presence'], ['chat-app', 'cache'], ['sales-rank', 'cache'], ['query-cache', 'cache']] as const
    for (const [id, store] of cases) {
      const e = design(scenario(id))
      const c = component(e, store)!
      expect(c.replicas, `${id} ${store}`).toBe(2 * c.shards!)
      // Without its standby every shard is a single node the request path needs.
      const bare = { ...e.architecture, components: e.architecture.components.map((x) => (x === c ? { ...x, replicas: c.shards! } : x)) }
      // Compare downtime, since a peer region in parallel (chat) squares it.
      expect(100 - estimateAvailability(bare, e.facts), `${id} ${store}`).toBeGreaterThan(2 * (100 - e.availability))
    }
  })

  it('counts the CDN that carries a video product in series after the regions combine', () => {
    const video = design(scenario('video-streaming'))
    const withoutCdn = { ...video.architecture, components: video.architecture.components.filter((c) => c.def.id !== 'cdn') }
    expect(estimateAvailability(withoutCdn, video.facts)).toBeGreaterThan(video.availability)
    // One CDN provider at its 99.99% SLA leaves no room for four nines; an own edge lets players fail over between sites.
    const pull = design({ ...scenario('video-streaming'), 'perf.cdn': { kind: 'value', value: 'pull' } })
    expect(pull.availability).toBeLessThan(99.99)
    expect(pull.findings.map((x) => x.rule.id)).toContain('availability-gap')
  })

  it('credits the standby region from the topology fact, not from a custom tech label', () => {
    const plain = design(scenario('ride-hailing'))
    const custom = design({ ...scenario('ride-hailing'), 'reliability.multi_region': { kind: 'custom', text: 'Active-passive with Aurora Global Database', treatAs: 'active_passive' } })
    expect(component(custom, 'standby-region')!.tech).toBe('Active-passive with Aurora Global Database')
    expect(custom.availability).toBeCloseTo(plain.availability, 6)
  })

  it('charges a regional outage to one region and lets a second region recover only what fails the whole path', () => {
    const v = (x: string) => ({ kind: 'value' as const, value: x })
    // A whole region is out about 0.01% of the time, so one region cannot reach four nines however redundant it is inside.
    expect(design(scenario('url-shortener')).availability).toBeLessThan(99.99)
    // At 99.95% one region with backups meets the target, so no design pays for a pilot light it does not need.
    for (const id of ['url-shortener', 'ecommerce', 'web-crawler', 'personal-finance', 'sales-rank']) {
      const e = design(scenario(id))
      expect(value(e, 'reliability.dr'), id).toBe('backups')
      expect(value(e, 'availability.singleRegionGap'), id).toBeLessThanOrEqual(0)
      expect(e.findings.map((x) => x.rule.id), id).not.toContain('availability-gap')
    }
    // A failed Cassandra partition fails only its keys, so a warm standby does not take it over: 219 nodes in series miss four nines with one.
    const passive = design({ ...scenario('chat-app'), 'reliability.multi_region': v('active_passive') })
    expect(passive.availability).toBeLessThan(99.99)
    expect(passive.findings.map((x) => x.rule.id)).toContain('availability-gap')
  })

  it('picks the regional topology and DR from the gap each recovery option leaves on the design', () => {
    const v = (x: number | string) => ({ kind: 'value' as const, value: x })
    const gaps = (e: Evaluation) => e.findings.map((x) => x.rule.id).filter((id) => id === 'availability-gap')
    // Chat: even a warm standby misses four nines, so the Cassandra regions serve in parallel.
    const chat = design(scenario('chat-app'))
    expect(value(chat, 'availability.warmStandbyGap')).toBeGreaterThan(0)
    expect(value(chat, 'reliability.multi_region')).toBe('active_active')
    // Ten times the traffic adds shards in series; the recommended topology still meets the target.
    for (const id of ['web-crawler', 'chat-app']) {
      const dau = (scenario(id)['traffic.dau'] as { value: number }).value
      expect(gaps(design({ ...scenario(id), 'traffic.dau': v(dau * 10) })), id).toEqual([])
    }
    // Where backups miss but a pilot light meets the target, DR recommends the pilot light for that reason.
    const crawler = design({ ...scenario('web-crawler'), 'traffic.dau': v(50_000_000) })
    expect(value(crawler, 'availability.singleRegionGap')).toBeGreaterThan(0)
    expect(value(crawler, 'reliability.dr')).toBe('pilot_light')
    expect(crawler.questions.find((q) => q.question.id === 'reliability.dr')!.recommendation.reasons).toContain('Restore from backup would exceed the downtime budget.')
    expect(gaps(crawler)).toEqual([])
    // At 99.9% the topology question opens once one region misses the target (5M devices x 200 requests on Cassandra).
    const iot = design({ 'product.type': v('iot'), 'traffic.dau': v(5_000_000), 'traffic.requests_per_user': v(200), 'team.size': v('small') })
    expect(value(iot, 'reliability.nines')).toBe(99.9)
    expect(iot.questions.find((q) => q.question.id === 'reliability.multi_region')!.active).toBe(true)
    expect(gaps(iot)).toEqual([])
  })

  it('credits a peer region in parallel only when every region takes writes', () => {
    const v = (x: string) => ({ kind: 'value' as const, value: x })
    // Strong consistency on one primary: writes fail over to its region, as with a warm standby.
    const ride = design({ ...scenario('ride-hailing'), 'reliability.multi_region': v('active_active') })
    expect(ride.findings.map((x) => x.rule.id)).toEqual(expect.arrayContaining(['active-active-strong', 'active-active-single-primary']))
    expect(ride.availability).toBeCloseTo(design(scenario('ride-hailing')).availability, 4)
    const single = design({ ...scenario('video-streaming'), 'data.replication': v('primary_replicas') })
    expect(single.findings.map((x) => x.rule.id)).toContain('active-active-single-primary')
    expect(single.availability).toBeLessThan(design(scenario('video-streaming')).availability - 0.001)
  })

  it('serves users on several continents with a sub-100 ms target from a region near each, or warns', () => {
    const v = (x: string) => ({ kind: 'value' as const, value: x })
    const chat = { ...scenario('chat-app'), 'reliability.availability': v('three') }
    expect(value(design(chat), 'reliability.multi_region')).toBeUndefined()
    expect(value(design({ ...chat, 'traffic.geo': v('multi') }), 'reliability.multi_region')).toBe('active_active')
    // Strong consistency rules out active-active, so ride hailing keeps one serving region and gets the latency warning.
    const ride = design({ ...scenario('ride-hailing'), 'traffic.geo': v('multi') })
    expect(value(ride, 'reliability.multi_region')).toBe('active_passive')
    expect(ride.findings.map((x) => x.rule.id)).toContain('global-latency')
  })

  it('prices a standby region as a full copy of the data it replicates plus a share of the rest, and says so', () => {
    const v = (x: string) => ({ kind: 'value' as const, value: x })
    // A warm standby (ride hailing) and a pilot light (URL shortener) both keep every database partition in the second region.
    for (const [id, answers] of [['ride-hailing', scenario('ride-hailing')], ['url-shortener', { ...scenario('url-shortener'), 'reliability.dr': v('pilot_light') }]] as const) {
      const e = design(answers)
      const standby = component(e, 'standby-region')!
      const replicated = ['db-primary', 'ledger', 'object-storage'].reduce((sum, x) => sum + (component(e, x)?.monthlyCost ?? 0), 0)
      expect(standby.monthlyCost, id).toBeGreaterThan(replicated)
      expect(standby.sizingNote, id).toContain('A full copy of the replicated data (Primary database')
    }
    expect(component(design(scenario('chat-app')), 'peer-region')!.sizingNote).toContain('A full copy of the regional stack')
  })

  it('prices object storage by the bytes it keeps and the CDN by the media it serves', () => {
    const month = 86_400 * (365 / 12)
    // One copy at $23 per TB-month: a managed store keeps its own redundant copies (all of it in the standard class here).
    const crawler = design({ ...scenario('web-crawler'), 'data.storage_class': { kind: 'value', value: 'standard' } })
    const objects = component(crawler, 'object-storage')!
    expect(objects.monthlyCost).toBe(Math.ceil(crawler.workload.objectStorageGb / 1024) * 23)
    expect(objects.monthlyCost).toBeGreaterThan(crawler.monthlyCost / 2)
    // A pull CDN at $40 per TB served.
    const social = design(scenario('social-network'))
    const tbServed = (social.workload.avgMediaEgressMbps * month) / 8 / 1024 / 1024
    expect(component(social, 'cdn')!.monthlyCost / 40).toBeCloseTo(tbServed, -1)
    // An own edge (push) runs cache servers sized for the peak, far cheaper than paying a pull CDN for every byte.
    const video = design(scenario('video-streaming'))
    const edge = component(video, 'cdn')!
    const peakGbps = (video.workload.avgMediaEgressMbps * video.workload.peakFactor) / 1000
    expect(edge.replicas).toBe(Math.ceil(peakGbps / (kb.reference.edgeServerGbps * kb.reference.targetUtilization)))
    const pull = design({ ...scenario('video-streaming'), 'perf.cdn': { kind: 'value', value: 'pull' } })
    expect(component(pull, 'cdn')!.monthlyCost).toBeGreaterThan(10 * edge.monthlyCost)
  })

  it('bills usage-priced services for what they serve, with no instance class', () => {
    const month = 86_400 * (365 / 12)
    // The AI assistant runs medium instances, but the hosted model bills each completion in full: one per assistant message, $3.50 per 1,000.
    const ai = design(scenario('ai-assistant'))
    const messages = ai.workload.dau * 2 * (365 / 12)
    expect(ai.workload.llmCallsMonth).toBeCloseTo(messages)
    expect(component(ai, 'llm-api')!.monthlyCost).toBe(Math.ceil(messages / 1_000) * 3.5)
    expect(ai.architecture.edges.find((x) => x.to === 'llm-api')!.qps).toBeCloseTo((messages * ai.workload.peakFactor) / month)
    // SQS bills send, receive and delete calls of up to 10 messages at $0.40 per million, not broker nodes.
    const social = design(scenario('social-network'))
    const queue = component(social, 'queue')!
    const calls = ((social.workload.peakJobsQps / social.workload.peakFactor) * month * 3) / 10
    expect(queue.replicas).toBe(1)
    expect(queue.monthlyCost).toBeCloseTo(Math.ceil(calls / 1e6) * 0.4)
    // A self-hosted RabbitMQ cluster is still priced per node.
    expect(component(design({ ...scenario('social-network'), 'arch.broker': { kind: 'value', value: 'rabbitmq' } }), 'queue')!.replicas).toBeGreaterThan(1)
  })

  it('prices functions per request, PaaS above managed containers and full tracing above basic logs', () => {
    const v = (x: string) => ({ kind: 'value' as const, value: x })
    const base = design(scenario('sales-rank'))
    // Under sustained high load per-request pricing exceeds the container fleet, as serverless-sustained says.
    const serverless = design({ ...scenario('sales-rank'), 'arch.style': v('serverless') })
    expect(serverless.findings.map((x) => x.rule.id)).toContain('serverless-sustained')
    expect(component(serverless, 'functions')!.monthlyCost).toBeGreaterThan(component(base, 'app')!.monthlyCost)
    // At a request every few seconds the functions cost less than one always-on instance.
    const tool = design({ ...scenario('internal-tool'), 'arch.style': v('serverless') })
    expect(component(tool, 'functions')!.monthlyCost).toBeLessThan(component(design(scenario('internal-tool')), 'app')!.monthlyCost)
    expect(component(design({ ...scenario('sales-rank'), 'infra.compute': v('paas') }), 'app')!.monthlyCost).toBeCloseTo(component(base, 'app')!.monthlyCost * 1.6)
    expect(component(design({ ...scenario('sales-rank'), 'ops.observability': v('full') }), 'observability')!.monthlyCost).toBeGreaterThan(component(base, 'observability')!.monthlyCost)
  })

  it('picks each fleet\'s instance class from the load it is sized on, not from HTTP requests alone', () => {
    const v = (x: number) => ({ kind: 'value' as const, value: x })
    // Below 1,000 req/s the old shared class priced every fleet as medium, though 200k location updates/s still need full-size nodes.
    const low = design({ ...scenario('ride-hailing'), 'traffic.requests_per_user': v(5) })
    const high = design({ ...scenario('ride-hailing'), 'traffic.requests_per_user': v(6) })
    expect(low.workload.peakQps).toBeLessThan(1_000)
    expect(high.workload.peakQps).toBeGreaterThan(1_000)
    for (const id of ['svc-geo', 'ws-gateway', 'geo-index']) {
      expect(component(low, id)!.replicas, id).toBe(component(high, id)!.replicas)
      expect(component(low, id)!.monthlyCost, id).toBe(component(high, id)!.monthlyCost)
    }
  })

  it('lets a tight budget pick the cheaper of two options that both meet the requirements', () => {
    const v = (x: number) => ({ kind: 'value' as const, value: x })
    const video = design(scenario('video-streaming'))
    const capped = design({ ...scenario('video-streaming'), 'infra.budget': v(50_000) })
    expect(value(video, 'reliability.multi_region')).toBe('active_active')
    // A warm standby also meets four nines, so a budget up to $50k drops the second active stack.
    expect(value(capped, 'reliability.multi_region')).toBe('active_passive')
    expect(capped.availability).toBeGreaterThanOrEqual(99.99)
    expect(capped.monthlyCost).toBeLessThan(video.monthlyCost)
    // The budget never buys a missed target: a warm standby leaves chat below four nines, so it keeps both active regions.
    expect(value(design({ ...scenario('chat-app'), 'infra.budget': v(50_000) }), 'reliability.multi_region')).toBe('active_active')
    expect(value(design({ ...scenario('query-cache'), 'infra.budget': v(500) }), 'security.edge')).toBe('tls')
  })

  it('counts a managed real-time service on the request path and prices it per connection', () => {
    const managed = (id: string) => design({ ...scenario(id), 'perf.realtime': { kind: 'value', value: 'managed' } })
    const ride = managed('ride-hailing')
    const without = { ...ride.architecture, components: ride.architecture.components.filter((c) => c.def.id !== 'realtime-service') }
    expect(estimateAvailability(without, ride.facts)).toBeGreaterThan(ride.availability)
    // 25M connections cost more on a managed service than on the WebSocket fleet, as the -2 score rule says.
    const chat = managed('chat-app')
    expect(component(chat, 'realtime-service')!.replicas).toBe(25_000)
    expect(chat.monthlyCost).toBeGreaterThan(design(scenario('chat-app')).monthlyCost)
  })

  it('truncates the displayed availability, so an estimate below its target never prints as the target', () => {
    expect(formatAvailability(99.9897)).toBe('99.989%')
    expect(formatAvailability(99.94962)).toBe('99.949%')
    expect(formatAvailability(99.99899)).toBe('99.9989%')
    expect(formatAvailability(99.99)).toBe('99.9900%')
    expect(formatAvailability(99.9)).toBe('99.900%')
    expect(formatAvailability(99.99995)).toBe('>99.9999%')
  })

  it('treats MongoDB as a single-primary store for active-active regions', () => {
    const answers: Answers = { ...scenario('video-streaming'), 'data.model': { kind: 'value', value: 'document' } }
    const e = design(answers)
    expect(value(e, 'data.primary_db')).toBe('mongodb')
    expect(value(e, 'reliability.multi_region')).not.toBe('active_active')
    const forced = design({ ...answers, 'reliability.multi_region': { kind: 'value', value: 'active_active' } })
    expect(forced.findings.map((x) => x.rule.id)).toContain('active-active-single-primary')
  })

  it('adds a GraphQL gateway only when there are services to federate', () => {
    for (const id of ['ecommerce', 'sales-rank']) expect(ids(design(scenario(id))), id).not.toContain('api-gateway')
    expect(ids(design(scenario('social-network')))).toContain('api-gateway')
  })

  it('counts every adjacency list a graph search fetches', () => {
    const e = design(scenario('social-graph'))
    const lookups = e.workload.peakLookupQps
    expect(Number(value(e, 'traffic.graph_lookups'))).toBeGreaterThan(1)
    expect(lookups).toBeCloseTo(e.workload.peakReadQps * Number(value(e, 'traffic.graph_lookups')))
    const misses = lookups * (1 - Number(value(e, 'perf.cacheHitRatio')))
    expect(component(e, 'db-replica')!.replicas * kb.reference.dbReplicaReadQps).toBeGreaterThanOrEqual(misses)
    // The traversal service reads the cache first and sends only the misses to the replicas; the application reads through it.
    const reads = e.architecture.edges.filter((x) => ['cache', 'db-replica', 'db-primary'].includes(x.to) && x.protocol === 'query' && x.qps > 0)
    expect(reads.map((x) => `${x.from}->${x.to}`).sort()).toEqual(['app->db-primary', 'graph-service->cache', 'graph-service->db-replica'])
    expect(reads.find((x) => x.label === 'Adjacency lists')!.qps).toBeCloseTo(misses)
    const strong = design({ ...scenario('social-graph'), 'product.consistency': { kind: 'value', value: 'strong' } })
    expect(value(strong, 'data.strongConsistency')).toBe(true)
    expect(strong.architecture.edges.find((x) => x.label === 'Adjacency lists')!.to).toBe('db-primary')
  })

  it('warns when graph traversals read every adjacency list from one unpartitioned database', () => {
    const e = design(scenario('social-graph'))
    expect(ids(e)).toContain('graph-service')
    expect(value(e, 'data.partitioning')).toBeUndefined()
    expect(e.findings.map((x) => x.rule.id)).toContain('graph-traversal')
    // The traversal service describes the single store it reads, not person servers the design does not have.
    expect(component(e, 'graph-service')!.def.description).not.toMatch(/shard/i)
    const sharded = design({ ...scenario('social-graph'), 'traffic.dau': { kind: 'value', value: 1e9 } })
    expect(value(sharded, 'data.partitioning')).toBe('hash_sharding')
    expect(sharded.findings.map((x) => x.rule.id)).not.toContain('graph-traversal')
  })

  it('persists precomputed recommendations in the database as well as the cache', () => {
    const e = design(scenario('video-streaming'))
    const targets = e.architecture.edges.filter((x) => x.from === 'ml-batch' && x.label.includes('recommendations')).map((x) => x.to)
    expect(targets).toEqual(expect.arrayContaining(['db-primary', 'cache']))
  })

  it('stores retrieval embeddings in the primary only when pgvector runs there', () => {
    const pgvector = design({ ...scenario('ai-assistant'), 'ai.vector_store': { kind: 'value', value: 'pgvector' } })
    const documents = pgvector.workload.dau * Number(value(pgvector, 'data.media_uploads_per_user')) * 365 * Number(value(pgvector, 'data.retention_years'))
    const embeddingsGb = (documents * Number(value(pgvector, 'data.media_chunks')) * kb.reference.embeddingKb) / 1024 / 1024
    expect(embeddingsGb).toBeGreaterThan(100)
    expect(pgvector.workload.dbStorageGb).toBeGreaterThanOrEqual(embeddingsGb)
    // A separate vector store holds them, so the primary is sized for its records alone.
    const managed = design({ ...scenario('ai-assistant'), 'ai.vector_store': { kind: 'value', value: 'managed' } })
    expect(managed.workload.dbStorageGb).toBeLessThan(pgvector.workload.dbStorageGb - embeddingsGb + 1)
  })

  it('runs reports on a read replica only when the design has one', () => {
    const answers: Answers = { ...scenario('internal-tool'), 'product.features': { kind: 'value', value: ['accounts', 'jobs', 'analytics'] } }
    const single = design(answers)
    expect(ids(single)).not.toContain('db-replica')
    expect(value(single, 'data.analytics')).toBe('warehouse')
    const replicated = design({ ...answers, 'reliability.availability': { kind: 'value', value: 'three' } })
    expect(value(replicated, 'data.analytics')).toBe('replica_queries')
    expect(ids(replicated)).toContain('db-replica')
  })

  it('scales up and tunes while writes and data fit one node, even with domain boundaries', () => {
    const answers: Answers = { ...scenario('ecommerce'), 'traffic.dau': { kind: 'value', value: 2_200_000 } }
    const e = design(answers)
    expect(e.questions.find((q) => q.question.id === 'data.partitioning')!.active).toBe(true)
    expect(value(e, 'data.partitioning')).toBe('vertical')
    // The design runs on AWS, so the provider's managed PostgreSQL names the store.
    expect(component(e, 'db-primary')!.tech).toBe('RDS for PostgreSQL, scaled up')
    const federated = design({ ...answers, 'data.partitioning': { kind: 'value', value: 'federation' } })
    expect(component(federated, 'db-primary')!.tech).not.toContain('sharded')
  })

  it('shards by key when data needs more nodes than one database per domain', () => {
    for (const id of ['ride-hailing', 'video-streaming']) {
      const e = design(scenario(id))
      expect(component(e, 'db-primary')!.replicas, id).toBeGreaterThan(e.architecture.components.filter((c) => c.def.group === 'service').length)
      expect(value(e, 'data.partitioning'), id).toBe('hash_sharding')
    }
  })

  it('gives every partition its own replica below 99.9% and credits only paired partitions', () => {
    const e = design({ ...scenario('web-crawler'), 'reliability.availability': { kind: 'value', value: 'two' } })
    const primary = component(e, 'db-primary')!
    expect(primary.replicas).toBeGreaterThan(1)
    expect(component(e, 'db-replica')!.replicas).toBeGreaterThanOrEqual(primary.replicas)
    const pool = { ...e.architecture, components: e.architecture.components.map((c) => (c.def.id === 'db-replica' ? { ...c, replicas: 4 } : c)) }
    expect(estimateAvailability(pool, e.facts)).toBeLessThan(e.availability - 1)
  })

  it('asks about replication for a partitioned primary below 99.9% and gives every partition a standby', () => {
    const e = design({ ...scenario('personal-finance'), 'traffic.dau': { kind: 'value', value: 30_000_000 }, 'reliability.availability': { kind: 'value', value: 'two' } })
    expect(value(e, 'reliability.nines')).toBe(99)
    expect(value(e, 'data.replication')).toBe('primary_replicas')
    const primary = component(e, 'db-primary')!
    expect(primary.replicas).toBeGreaterThan(1)
    expect(component(e, 'db-replica')!.replicas).toBeGreaterThanOrEqual(primary.replicas)
    expect(e.findings.map((x) => x.rule.id)).not.toContain('availability-gap')
  })

  it('credits store replication from facts, not from a custom tech label', () => {
    const cases = [['chat-app', 'ScyllaDB', 'cassandra'], ['url-shortener', 'Amazon DynamoDB', 'dynamodb'], ['ai-assistant', 'MongoDB Atlas', 'mongodb']] as const
    for (const [id, text, treatAs] of cases) {
      const plain = design({ ...scenario(id), 'data.primary_db': { kind: 'value', value: treatAs } })
      const custom = design({ ...scenario(id), 'data.primary_db': { kind: 'custom', text, treatAs } })
      expect(component(custom, 'db-primary')!.tech, id).toContain(text)
      expect(custom.availability, id).toBeCloseTo(plain.availability, 6)
    }
  })

  it('states the replication factor behind a leaderless node count', () => {
    for (const id of ['social-network', 'chat-app']) {
      const e = design(scenario(id))
      const primary = component(e, 'db-primary')!
      expect(primary.sizingNote, id).toContain(`${primary.replicas} nodes`)
      expect(primary.sizingNote, id).toContain(`x ${Number(value(e, 'data.storeReplicas'))} copies`)
      expect(primary.sizingNote, id).not.toContain('partitions')
    }
  })

  it('shows multi-primary replication in the design, not only in the validation', () => {
    const multi = design(scenario('video-streaming'))
    expect(value(multi, 'data.replication')).toBe('multi_primary')
    expect(component(multi, 'db-primary')!.tech).toContain('multi-primary via BDR / pgEdge')
    const single = design({ ...scenario('video-streaming'), 'data.replication': { kind: 'value', value: 'primary_replicas' } })
    expect(component(single, 'db-primary')!.tech).not.toContain('multi-primary')
    expect(diffEvaluations(multi, single).retech.map((x) => x.id)).toContain('db-primary')
  })

  it('keeps a leaderless cluster at least as large as its replication factor', () => {
    const e = design({ ...scenario('chat-app'), 'traffic.dau': { kind: 'value', value: 20_000 } })
    expect(value(e, 'data.primary_db')).toBe('cassandra')
    expect(component(e, 'db-primary')!.replicas).toBeGreaterThanOrEqual(Number(value(e, 'data.storeReplicas')))
  })

  it('sizes MongoDB as replica sets whose primaries absorb the writes', () => {
    for (const retention of [0.1, 0.02]) {
      const e = design({ ...scenario('chat-app'), 'data.primary_db': { kind: 'value', value: 'mongodb' }, 'data.retention_years': { kind: 'value', value: retention } })
      const sets = component(e, 'db-primary')!.replicas / Number(value(e, 'data.storeReplicas'))
      expect(Number.isInteger(sets), String(retention)).toBe(true)
      expect(sets * kb.reference.dbPrimaryWriteQps * Number(value(e, 'data.nodeWriteFactor'))).toBeGreaterThanOrEqual(e.workload.peakDbWriteQps)
    }
  })

  it('puts real-time pub/sub and write-behind on Redis, not Memcached', () => {
    const e = design({ ...scenario('query-cache'), 'product.features': { kind: 'value', value: ['search', 'notifications'] } })
    expect(ids(e)).toContain('ws-gateway')
    expect(e.architecture.edges.some((x) => x.from === 'ws-gateway' && x.to === 'cache')).toBe(true)
    expect(value(e, 'perf.cache_tech')).toBe('redis')
    const writeBehind = design({ ...scenario('chat-app'), 'perf.cache': { kind: 'value', value: 'write_behind' } })
    const memcached = writeBehind.questions.find((q) => q.question.id === 'perf.cache_tech')!.recommendation.scores.find((s) => s.optionId === 'memcached')!
    expect(memcached.feasible).toBe(false)
  })

  it('runs Cassandra at LOCAL_QUORUM when users must read their own writes', () => {
    for (const id of ['social-network', 'chat-app']) {
      const e = design(scenario(id))
      expect(value(e, 'product.consistency'), id).toBe('read_your_writes')
      expect(component(e, 'db-primary')!.tech, id).toContain('LOCAL_QUORUM')
    }
    const eventual = design({ ...scenario('chat-app'), 'product.consistency': { kind: 'value', value: 'eventual' } })
    expect(component(eventual, 'db-primary')!.tech).not.toContain('LOCAL_QUORUM')
  })

  it('sizes model serving on the reads it scores, the rate its flow carries', () => {
    const e = design(scenario('social-network'))
    const scoring = e.architecture.edges.filter((x) => x.to === 'ml-inference').reduce((sum, x) => sum + x.qps, 0)
    expect(scoring).toBeCloseTo(e.workload.peakReadQps)
    expect(component(e, 'ml-inference')!.replicas).toBe(Math.ceil(scoring / (kb.reference.appInstanceQps * kb.reference.targetUtilization)))
    // A small fleet keeps a spare: two instances for 1.3k reads/s would leave one survivor at 133%.
    const small = design({ ...scenario('social-network'), 'traffic.dau': { kind: 'value', value: 420_000 } })
    const serving = component(small, 'ml-inference')!
    expect(value(small, 'reliability.nines')).toBeGreaterThanOrEqual(99.9)
    expect(small.workload.peakReadQps / ((serving.replicas - 1) * kb.reference.appInstanceQps)).toBeLessThanOrEqual(1)
  })

  it('splits service sizing over the same services the gateway routes to', () => {
    const e = design(scenario('ride-hailing'))
    const routed = e.architecture.edges.filter((x) => x.from === 'api-gateway' && x.protocol === 'grpc')
    expect(routed.map((x) => x.to)).toContain('svc-geo')
    const core = component(e, 'svc-core')!
    // Writes arrive over the persistent connections, so the gateway and the connection fleet together carry the service's share.
    const inbound = e.architecture.edges.filter((x) => x.to === 'svc-core' && x.protocol !== 'telemetry').reduce((sum, x) => sum + x.qps, 0)
    expect(core.utilization * core.replicas * kb.reference.appInstanceQps).toBeCloseTo(inbound)
  })

  it('deploys and observes every fleet the team runs', () => {
    const fleets: [string, string[]][] = [
      ['chat-app', ['app', 'workers', 'ws-gateway']],
      ['social-network', ['svc-core', 'workers', 'ml-inference']],
      ['social-graph', ['app', 'graph-service']],
      ['video-streaming', ['svc-media', 'workers', 'ml-batch']],
    ]
    for (const [id, expected] of fleets) {
      const edges = design(scenario(id)).architecture.edges
      for (const fleet of expected) {
        expect(edges.some((x) => x.from === 'cicd' && x.to === fleet), `${id}: deploy ${fleet}`).toBe(true)
        expect(edges.some((x) => x.from === fleet && x.to === 'observability'), `${id}: telemetry ${fleet}`).toBe(true)
      }
    }
  })

  it('compares alternatives against the design that accepts the pending recommendations', () => {
    for (const [id, question] of [['ecommerce', 'perf.cache'], ['chat-app', 'data.primary_db']] as const) {
      const base = assumedDesign(kb, scenario(id))
      const rec = base.questions.find((s) => s.question.id === question)!.recommendation.optionId!
      // With the raw answers the pending questions add no facts, so the badge would name an option the auto-design does not pick.
      expect(evaluate(kb, scenario(id)).questions.find((s) => s.question.id === question)!.recommendation.optionId, id).not.toBe(rec)
      const row = assumedDesign(kb, { ...scenario(id), [question]: { kind: 'value', value: rec } })
      expect(value(row, question), id).toBe(rec)
      expect(row.monthlyCost, id).toBeCloseTo(base.monthlyCost)
      expect(row.findings.map((x) => x.rule.id), id).toEqual(base.findings.map((x) => x.rule.id))
    }
  })

  it('indexes crawled page text from the fetch workers, one version per page', () => {
    const e = design(scenario('web-crawler'))
    const feeds = e.architecture.edges.filter((x) => x.to === 'search' && x.from !== 'app')
    expect(feeds.map((x) => `${x.from}: ${x.label}`)).toEqual(['workers: Index page text'])
    const pages = e.workload.writeQps * kb.reference.secondsPerDay * kb.reference.pageRefreshDays
    expect(e.workload.searchIndexGb).toBeCloseTo((pages * (kb.reference.metadataRowKb + kb.reference.pageTextKb)) / 1024 / 1024)
  })

  it('sizes a streaming search index on the title catalog, not on activity rows', () => {
    const e = design(scenario('video-streaming'))
    expect(value(e, 'data.search_corpus')).toBe('catalog')
    const titles = e.workload.dau * Number(value(e, 'data.media_uploads_per_user')) * 365 * Number(value(e, 'data.retention_years'))
    expect(e.workload.searchIndexGb).toBeCloseTo((titles * kb.reference.metadataRowKb) / 1024 / 1024)
    expect(component(e, 'search')!.replicas).toBe(2)
  })

  it('discounts searches only for caches that store query results', () => {
    const writeThrough = design(scenario('ecommerce'))
    expect(value(writeThrough, 'perf.cache')).toBe('write_through')
    const nodes = Math.ceil(writeThrough.workload.peakSearchQps / (kb.reference.searchNodeQps * kb.reference.targetUtilization))
    expect(component(writeThrough, 'search')!.replicas).toBe(nodes)
    const aside = design({ ...scenario('ecommerce'), 'perf.cache': { kind: 'value', value: 'cache_aside' } })
    expect(component(aside, 'search')!.replicas).toBeLessThan(nodes)
  })

  it('sizes search shards on the index and copies of every shard on queries, since each query reads every shard', () => {
    const e = design(scenario('web-crawler'))
    const { searchNodeQps, dbNodeStorageGb, targetUtilization: h } = kb.reference
    const queries = e.workload.peakSearchQps * (1 - Number(value(e, 'perf.cacheHitRatio')))
    const shards = Math.ceil(e.workload.searchIndexGb / (dbNodeStorageGb * h))
    const copies = Math.ceil(queries / (searchNodeQps * h))
    expect(shards).toBeGreaterThan(1)
    expect(copies).toBeGreaterThan(2)
    expect(component(e, 'search')!.replicas).toBe(shards * copies)
  })

  it('sizes presence on heartbeats plus the messages it routes between gateway nodes', () => {
    const e = design(scenario('chat-app'))
    const perNode = kb.reference.cacheNodeOps * kb.reference.targetUtilization
    const heartbeats = e.workload.concurrentConnections / 30
    const presence = component(e, 'presence')!
    expect(presence.shards).toBe(Math.ceil((heartbeats + e.workload.peakWriteQps) / perNode))
    expect(presence.shards).toBeGreaterThan(Math.ceil(heartbeats / perNode))
    expect(presence.sizingNote).toContain('messages/s routed')
  })

  it('has workers pull transactions from the financial institutions in personal finance', () => {
    const e = design(scenario('personal-finance'))
    expect(e.architecture.edges.some((x) => x.from === 'workers' && x.to === 'bank-aggregator' && x.label === 'Pull transactions')).toBe(true)
  })

  it('stores the primer volume of tweet media: 5.4 PB in 3 years, one copy', () => {
    const e = design(scenario('social-network'))
    expect(e.workload.totalStorageGb / kb.reference.replicationFactor / 1024 / 1024).toBeCloseTo(5.4, 0)
  })

  it('gives live-tracking apps persistent connections even without chat', () => {
    const e = design({ ...scenario('ride-hailing'), 'product.features': { kind: 'value', value: ['accounts', 'geo', 'payments', 'notifications'] } })
    const active = new Set(e.questions.filter((q) => q.active).map((q) => q.question.id))
    expect(active.has('traffic.concurrency')).toBe(true)
    expect(value(e, 'perf.realtime')).toBe('websocket')
    // The same edge also carries the location service's share of the inbound messages.
    const toGeo = e.architecture.edges.find((x) => x.from === 'ws-gateway' && x.to === 'svc-geo')!
    expect(toGeo.label).toContain('Location updates')
    expect(toGeo.qps).toBeGreaterThanOrEqual(e.workload.peakLocationQps)
  })

  it('leaves precomputed recommendations to the batch job, not the transcoding workers', () => {
    const e = design(scenario('video-streaming'))
    expect(e.architecture.edges.filter((x) => x.from === 'workers' && x.to === 'cache')).toEqual([])
    expect(e.architecture.edges.some((x) => x.from === 'ml-batch' && x.to === 'cache')).toBe(true)
  })

  it('takes chat media from the WhatsApp source and serves each file to about one recipient', () => {
    const e = design(scenario('chat-app'))
    const filesPerDay = e.workload.dau * Number(value(e, 'data.media_uploads_per_user'))
    expect(filesPerDay).toBe(100_000_000)
    expect(filesPerDay * Number(value(e, 'data.media_mb'))).toBe(10_000_000)
    // 10 TB a day read once each at a 3x peak is about 2.8 Gbps; five views per user gave 139 Gbps.
    expect(e.workload.egressMbps).toBeLessThan(3_000)
  })

  it('keeps PostGIS location pings as write load, not retained rows or background jobs', () => {
    const small = { ...scenario('ride-hailing'), 'traffic.dau': { kind: 'value' as const, value: 20_000 } }
    const postgis = design(small)
    const redis = design({ ...small, 'data.geo_index': { kind: 'value', value: 'redis_geo' } })
    expect(value(postgis, 'data.geo_index')).toBe('postgis')
    expect(postgis.workload.dbStorageGb).toBeCloseTo(redis.workload.dbStorageGb)
    expect(postgis.workload.peakJobsQps).toBeCloseTo(redis.workload.peakJobsQps)
    expect(postgis.workload.peakDbWriteQps).toBeCloseTo(redis.workload.peakDbWriteQps + postgis.workload.peakLocationQps)
  })

  it('routes and sizes location updates on the application when there is no location service', () => {
    const e = design({ ...scenario('ride-hailing'), 'arch.style': { kind: 'value', value: 'modular_monolith' } })
    const w = e.workload
    const app = component(e, 'app')!
    expect(app.replicas * kb.reference.appInstanceQps * kb.reference.targetUtilization).toBeGreaterThanOrEqual(w.peakQps + w.peakLocationQps)
    const inbound = e.architecture.edges.find((x) => x.from === 'ws-gateway' && x.to === 'app')!
    expect(inbound.qps).toBeCloseTo(w.peakWriteQps + w.peakLocationQps)
  })

  it('adds a load balancer as soon as the application needs a second instance', () => {
    const e = design({ ...scenario('internal-tool'), 'traffic.dau': { kind: 'value', value: 216_000 }, 'infra.compute': { kind: 'value', value: 'managed_containers' } })
    expect(Number(value(e, 'reliability.nines'))).toBeLessThan(99.9)
    expect(component(e, 'app')!.replicas).toBe(2)
    expect(ids(e)).toContain('lb')
  })

  it('counts background work done inside requests when the application gets a second instance', () => {
    const v = (x: number | string) => ({ kind: 'value' as const, value: x })
    const cases: [string, number][] = [['ecommerce', 87_450], ['personal-finance', 500_000], ['url-shortener', 2_012_500]]
    for (const [id, dau] of cases) {
      const e = design({ ...scenario(id), 'traffic.dau': v(dau), 'reliability.availability': v('two'), 'infra.compute': v('managed_containers'), 'arch.async': v('none') })
      // Under 700 req/s of requests alone, so only the inline jobs give the app its second instance.
      expect(e.workload.peakQps, id).toBeLessThanOrEqual(700)
      expect(component(e, 'app')!.replicas, id).toBeGreaterThan(1)
      expect(ids(e), id).toContain('lb')
    }
  })

  it('lets the PaaS router balance requests instead of a separate load balancer', () => {
    const e = design(scenario('ai-assistant'))
    expect(value(e, 'infra.compute')).toBe('paas')
    expect(component(e, 'app')!.replicas).toBe(2)
    expect(ids(e)).not.toContain('lb')
  })

  it('charges media processing at 1 worker-second per 10 MB, with no per-file floor', () => {
    const e = design(scenario('social-network'))
    const w = e.workload
    const peakUploads = ((w.dau * Number(value(e, 'data.media_uploads_per_user'))) / 86_400) * (w.peakQps / w.avgQps)
    expect(w.peakMediaWorkSeconds).toBeCloseTo((peakUploads * Number(value(e, 'data.media_mb'))) / 10)
  })

  it('publishes analytics events to the stream that sits next to a job queue', () => {
    const iot = {
      'product.type': { kind: 'value' as const, value: 'iot' },
      'product.features': { kind: 'value' as const, value: ['analytics', 'notifications', 'media'] },
      'traffic.dau': { kind: 'value' as const, value: 1_000_000 },
      'traffic.requests_per_user': { kind: 'value' as const, value: 1000 },
    }
    const e = design({ ...iot, 'arch.async': { kind: 'value', value: 'queue' } })
    expect(ids(e)).toEqual(expect.arrayContaining(['queue', 'stream', 'stream-processor']))
    expect(e.architecture.edges.find((x) => x.from === 'app' && x.to === 'stream')!.qps).toBeCloseTo(e.workload.peakWriteQps)
    // Workers take their jobs from the queue; the stream feeds the stream processor.
    expect(e.architecture.edges.filter((x) => x.from === 'stream').map((x) => x.to)).toEqual(['stream-processor'])
    // Media jobs go to the queue; the stream carries one event per write.
    expect(e.workload.peakJobsQps).toBeGreaterThan(e.workload.peakWriteQps)
    expect(component(e, 'stream')!.sizingNote).toContain(`${fmt(e.workload.peakWriteQps)} events/s`)
    // Streaming analytics keeps a stream, so "Synchronous only" cannot describe the design.
    const none = design(iot).questions.find((q) => q.question.id === 'arch.async')!.recommendation.scores.find((s) => s.optionId === 'none')!
    expect(none.feasible).toBe(false)
  })

  it('tracks presence for chat over any connection fleet, not only WebSocket', () => {
    for (const transport of ['sse', 'long_polling']) {
      const e = design({ ...scenario('chat-app'), 'perf.realtime': { kind: 'value', value: transport } })
      expect(ids(e), transport).toEqual(expect.arrayContaining(['ws-gateway', 'presence']))
    }
  })

  it('connects clients to the WebSocket gateway through the WAF and load balancer', () => {
    for (const id of ['chat-app', 'ride-hailing']) {
      const e = design(scenario(id))
      const path = e.architecture.edges.filter((x) => x.protocol === 'ws' && ['client', 'waf', 'lb'].includes(x.from)).map((x) => `${x.from}->${x.to}`)
      expect(path, id).toEqual(['client->waf', 'waf->lb', 'lb->ws-gateway'])
      // The balancer bills the persistent connections it holds (ALB LCUs).
      expect(component(e, 'lb')!.sizingNote, id).toContain('concurrent connections held')
    }
  })

  it('splits writes between the HTTP path and the persistent connections without counting them twice', () => {
    const e = design(scenario('chat-app'))
    const w = e.workload
    const into = (to: string, protocol: string) => e.architecture.edges.filter((x) => x.to === to && x.protocol === protocol).reduce((sum, x) => sum + x.qps, 0)
    expect(into('app', 'http')).toBeCloseTo(w.peakQps - w.peakWriteQps)
    expect(into('app', 'ws')).toBeCloseTo(w.peakWriteQps)
  })

  it('draws the retrieval flow onto the primary that holds the pgvector embeddings, and only for LLM features', () => {
    const rag = design({ ...scenario('ai-assistant'), 'ai.vector_store': { kind: 'value', value: 'pgvector' } }).architecture.edges.find((x) => x.from === 'app' && x.to === 'db-primary')!
    expect(rag.label).toContain('Similarity search (embeddings)')
    const plain = design(scenario('url-shortener')).architecture.edges.find((x) => x.from === 'app' && x.to === 'db-primary')!
    expect(plain.label).toBe('Reads and writes')
  })

  it('serves local users in an active peer region and replicates its writes back', () => {
    for (const id of ['social-network', 'video-streaming']) {
      const e = design(scenario(id))
      const peer = e.architecture.edges.filter((x) => x.from === 'peer-region' || x.to === 'peer-region').map((x) => `${x.from}->${x.to}:${x.protocol}`)
      expect(peer, id).toEqual(expect.arrayContaining(['client->peer-region:http', 'db-primary->peer-region:replication', 'peer-region->db-primary:replication']))
    }
    // A passive standby takes neither users nor writes, only the replicated database and objects.
    const standby = design({ ...scenario('chat-app'), 'reliability.multi_region': { kind: 'value', value: 'active_passive' } }).architecture.edges.filter((x) => x.from === 'standby-region' || x.to === 'standby-region').map((x) => `${x.from}->${x.to}`)
    expect(standby).toEqual(['db-primary->standby-region', 'object-storage->standby-region'])
  })

  it('replicates object storage to the second region along with the database', () => {
    for (const s of kb.scenarios) {
      const e = design(s.answers)
      const region = ['standby-region', 'peer-region'].find((id) => ids(e).includes(id))
      if (!region || !ids(e).includes('object-storage')) continue
      const flow = e.architecture.edges.find((x) => x.from === 'object-storage' && x.to === region)
      expect(flow?.protocol, s.id).toBe('replication')
      expect(flow!.qps, s.id).toBeCloseTo(e.workload.peakUploadQps)
    }
  })

  it('draws pre-signed uploads from the client straight into object storage', () => {
    for (const id of ['social-network', 'chat-app']) {
      const uploads = design(scenario(id)).architecture.edges.filter((x) => x.to === 'object-storage' && x.label === 'Pre-signed uploads')
      expect(uploads.map((x) => x.from), id).toEqual(['client'])
    }
  })

  it('scores reads on the services that serve them, never more than a service receives', () => {
    const e = design(scenario('social-network'))
    const scoring = e.architecture.edges.filter((x) => x.to === 'ml-inference')
    expect(scoring.length).toBeGreaterThan(1)
    for (const flow of scoring) {
      const inbound = e.architecture.edges.filter((x) => x.to === flow.from && x.protocol !== 'telemetry').reduce((sum, x) => sum + x.qps, 0)
      expect(flow.qps, flow.from).toBeLessThanOrEqual(inbound)
    }
  })

  it('counts the reads a strongly consistent primary serves when deciding to partition it', () => {
    const v = (x: number | string) => ({ kind: 'value' as const, value: x })
    const small = { ...scenario('ecommerce'), 'traffic.dau': v(20_000_000), 'data.object_kb': v(0.1), 'data.retention_years': v(1) }
    const e = design(small)
    expect(value(e, 'cap.dbWriteLoad')).toBeLessThan(0.6)
    expect(value(e, 'cap.dbPrimaryLoad')).toBeGreaterThan(1.5)
    // Reads alone split the primary, so the partitioning question is asked and names the scheme.
    expect(e.questions.find((q) => q.question.id === 'data.partitioning')!.active).toBe(true)
    expect(component(e, 'db-primary')!.replicas).toBeGreaterThan(1)
    expect(component(e, 'db-primary')!.tech).toContain('sharded')
    const scaledUp = design({ ...small, 'arch.style': v('monolith'), 'data.partitioning': v('vertical') })
    expect(component(scaledUp, 'db-primary')!.utilization).toBeGreaterThan(1)
    expect(scaledUp.findings.map((x) => x.rule.id)).toContain('vertical-insufficient')
  })

  it('gives the payment ledger a standby, a replication flow to the standby region and a place on the request path', () => {
    const e = design({ ...scenario('ecommerce'), 'payments.design': { kind: 'value', value: 'ledger' }, 'reliability.dr': { kind: 'value', value: 'pilot_light' } })
    expect(component(e, 'ledger')!.replicas).toBe(2)
    expect(e.architecture.edges.some((x) => x.from === 'ledger' && x.to === 'standby-region' && x.protocol === 'replication')).toBe(true)
    // Checkout writes entries synchronously, so one ledger node would lower the estimate.
    const single = { ...e.architecture, components: e.architecture.components.map((c) => (c.def.id === 'ledger' ? { ...c, replicas: 1 } : c)) }
    expect(estimateAvailability(single, e.facts)).toBeLessThan(e.availability)
  })

  it('sends client messages over HTTP when the connection only pushes (SSE, long polling)', () => {
    const into = (e: Evaluation, to: string, protocol: string) => e.architecture.edges.filter((x) => x.to === to && x.protocol === protocol).reduce((sum, x) => sum + x.qps, 0)
    // On Google Cloud the balancer keeps its node model (it bills no held connections), so its load shows what the ingress carries.
    const gcp = { 'infra.cloud': { kind: 'value' as const, value: 'gcp' } }
    for (const transport of ['sse', 'long_polling']) {
      const chat = design({ ...scenario('chat-app'), ...gcp, 'perf.realtime': { kind: 'value', value: transport } })
      expect(into(chat, 'app', 'ws'), transport).toBe(0)
      expect(into(chat, 'app', 'http'), transport).toBeCloseTo(chat.workload.peakQps)
      const ride = design({ ...scenario('ride-hailing'), ...gcp, 'perf.realtime': { kind: 'value', value: transport } })
      expect(into(ride, 'svc-geo', 'ws'), transport).toBe(0)
      expect(into(ride, 'svc-geo', 'http'), transport).toBeGreaterThanOrEqual(ride.workload.peakLocationQps)
      // The ingress is sized on what it carries: HTTP requests and location posts; the connections only push, so they carry no client messages.
      for (const e of [chat, ride]) {
        expect(into(e, 'ws-gateway', 'ws') + into(e, 'lb', 'ws'), transport).toBe(0)
        const lb = component(e, 'lb')!
        expect(lb.utilization * lb.replicas * kb.reference.lbNodeQps, transport).toBeCloseTo(e.workload.peakQps + e.workload.peakLocationQps)
        expect(lb.sizingNote, transport).not.toContain('real-time messages/s')
      }
      for (const c of ride.architecture.components.filter((x) => ['lb', 'api-gateway'].includes(x.def.id))) {
        expect(into(ride, c.def.id, 'http') + into(ride, c.def.id, 'ws'), `${transport} ${c.def.id}`).toBeCloseTo(c.utilization * c.replicas * kb.reference.lbNodeQps)
      }
    }
  })

  it('draws the calls between services, with gRPC when the API decision says so', () => {
    const between = (e: Evaluation) => {
      const services = new Set(e.architecture.components.filter((c) => c.def.group === 'service').map((c) => c.def.id))
      return e.architecture.edges.filter((x) => services.has(x.from) && services.has(x.to))
    }
    for (const id of ['social-network', 'ride-hailing', 'video-streaming']) {
      const e = design(scenario(id))
      const calls = between(e)
      expect(calls.length, id).toBeGreaterThan(0)
      expect(new Set(calls.map((x) => x.protocol)), id).toEqual(new Set([value(e, 'arch.api') === 'rest_grpc' ? 'grpc' : 'http']))
    }
    const ride = design(scenario('ride-hailing'))
    // Dispatch finds drivers through the location service, once per ride request (Uber case study: 0.1 rides per daily user).
    const nearby = between(ride).find((x) => x.from === 'svc-dispatch' && x.to === 'svc-geo')!
    expect(nearby.label).toBe('Nearby drivers')
    expect(nearby.qps).toBeCloseTo((ride.workload.dau * kb.reference.ridesPerUser * Number(value(ride, 'traffic.peakFactor'))) / kb.reference.secondsPerDay)
    expect(ride.architecture.edges.some((x) => x.from === 'svc-dispatch' && x.to === 'geo-index')).toBe(false)
  })

  it('produces no error findings when every recommendation is accepted', () => {
    for (const s of kb.scenarios) {
      const errors = design(s.answers).findings.filter((x) => x.rule.severity === 'error').map((x) => x.rule.id)
      expect(errors, s.id).toEqual([])
    }
  })
})

describe('recommendation rules', () => {
  const question = (id: string) => kb.questions.find((q) => q.id === id)!
  const pick = (id: string, facts: Facts) => recommend(question(id), facts).optionId

  it('credits PostGIS to PostgreSQL only while the location index can live in the database', () => {
    const postgis = 'PostGIS supports geospatial queries.'
    const reasons = (peakLocationQps: number) => recommend(question('data.primary_db'), { 'product.features': ['geo'], 'cap.peakLocationQps': peakLocationQps }).scores.find((x) => x.optionId === 'postgres')!.reasons
    expect(reasons(100)).toContain(postgis)
    expect(reasons(200_000)).not.toContain(postgis)
    const ride = design(scenario('ride-hailing'))
    expect(value(ride, 'data.geo_index')).toBe('redis_geo')
    expect(ride.questions.find((s) => s.question.id === 'data.primary_db')!.recommendation.reasons).not.toContain(postgis)
  })

  it('flags the connection fleet beside serverless functions for SSE and long polling as for WebSocket', () => {
    const answers: Answers = {
      'product.type': { kind: 'value', value: 'saas' },
      'product.features': { kind: 'value', value: ['accounts', 'notifications'] },
      'traffic.dau': { kind: 'value', value: 20_000 },
      'team.size': { kind: 'value', value: 'tiny' },
      'perf.latency': { kind: 'value', value: 'realtime' },
      'arch.style': { kind: 'value', value: 'serverless' },
    }
    const flagged = (transport: string) => design({ ...answers, 'perf.realtime': { kind: 'value', value: transport } }).findings.some((x) => x.rule.id === 'serverless-websocket')
    expect(['websocket', 'sse', 'long_polling'].filter(flagged)).toEqual(['websocket', 'sse', 'long_polling'])
    // A managed service holds the connections, so no fleet runs beside the functions.
    expect(flagged('managed')).toBe(false)
  })

  it('states a tie with an option whose requirement matched, instead of saying nothing points elsewhere', () => {
    const tied: Question = {
      id: 'test.tie', category: 'reliability', title: 'Tie', prompt: '', kind: 'single', priority: 1, isDecision: true, default: 'plain', sources: [],
      options: [
        { id: 'plain', label: 'Plain', description: '', pros: [], cons: [], complexity: 1 },
        { id: 'fancy', label: 'Fancy', description: '', pros: [], cons: [], complexity: 3, score: [{ when: f.exists('need'), weight: 1, reason: 'The need calls for it.' }] },
      ],
    }
    const r = recommend(tied, { need: true })
    expect(r.optionId).toBe('plain')
    expect(r.reasons).toEqual(['Ties with Fancy (The need calls for it.); the default is kept.'])
  })

  it('never lets the order options are listed in decide a scenario recommendation', () => {
    for (const s of kb.scenarios) {
      const e = design(s.answers)
      for (const state of e.questions.filter((q) => q.active && q.question.kind === 'single')) {
        const { optionId, scores } = state.recommendation
        const option = (id: string) => state.question.options!.find((o) => o.id === id)!
        const best = scores.find((x) => x.optionId === optionId)
        const undecided = scores.filter((x) => x.feasible && x !== best && x.score === best?.score && optionId !== defaultFor(state.question, e.facts) && option(x.optionId).complexity === option(optionId!).complexity)
        expect(undecided.map((x) => x.optionId), `${s.id} ${state.question.id}`).toEqual([])
      }
    }
    const api = design(scenario('social-network')).questions.find((q) => q.question.id === 'arch.api')!.recommendation
    expect(api.optionId).toBe('graphql')
    expect(api.reasons.some((r) => r.includes('federated GraphQL gateway'))).toBe(true)
  })

  it('lets each option win the case its own rule describes', () => {
    expect(pick('security.auth', { 'product.type': 'internal', 'arch.style': 'monolith' })).toBe('sso')
    expect(pick('security.auth', { 'product.type': 'saas', 'arch.style': 'microservices' })).toBe('sso')
    expect(pick('security.auth', { 'product.type': 'ai', 'team.size': 'tiny', 'arch.style': 'monolith' })).toBe('oidc')
    expect(pick('security.auth', { 'product.type': 'social', 'team.size': 'large', 'arch.style': 'microservices' })).toBe('jwt')
    expect(pick('arch.gateway', { 'arch.style': 'microservices', 'team.size': 'large' })).toBe('bff')
    expect(pick('arch.gateway', { 'arch.style': 'microservices', 'team.size': 'large', 'product.features': ['public_api'] })).toBe('gateway')
    expect(pick('data.geo_index', { 'data.sql': true, 'cap.peakLocationQps': 600_000 })).toBe('quadtree')
    expect(pick('data.geo_index', { 'data.sql': true, 'cap.peakLocationQps': 200_000 })).toBe('redis_geo')
    expect(pick('perf.realtime', { 'team.size': 'tiny', 'product.features': ['chat'], 'cap.connections': 5_000 })).toBe('managed')
    expect(pick('perf.realtime', { 'team.size': 'tiny', 'product.features': ['chat'], 'cap.connections': 1_000_000 })).toBe('websocket')
    expect(pick('reliability.dr', { 'product.features': ['payments'], 'payments.design': 'ledger' })).toBe('pilot_light')
    expect(pick('reliability.dr', { 'product.features': ['payments'], 'payments.design': 'psp' })).toBe('backups')
  })

  it('gives penalties as trade-offs, not as reasons for the option', () => {
    const r = recommend(question('infra.compute'), { 'team.size': 'tiny', 'cap.peakQps': 50_000 })
    const paas = r.scores.find((x) => x.optionId === 'paas')!
    expect(r.optionId).toBe('paas')
    expect(r.reasons).toEqual(['A tiny team should not run infrastructure.'])
    expect(paas.penalties).toEqual(['PaaS pricing grows fast at high load.'])
  })

  it('keeps cloud-managed services out of on-premises designs', () => {
    const onprem = { 'infra.cloud': 'onprem', 'team.size': 'tiny' }
    expect(pick('arch.broker', { ...onprem, 'arch.async': 'stream' })).toBe('kafka')
    expect(pick('arch.broker', { ...onprem, 'arch.async': 'queue' })).not.toBe('sqs')
    expect(pick('arch.style', { ...onprem, 'traffic.spiky': true, 'cap.peakQps': 100 })).not.toBe('serverless')
    expect(pick('data.search', { ...onprem, 'data.sql': false })).not.toBe('managed_search')
    expect(pick('arch.style', { 'team.size': 'tiny', 'traffic.spiky': true, 'cap.peakQps': 100 })).toBe('serverless')
  })

  it('picks the analytics pipeline on the data in SQL, not on media in object storage', () => {
    const e = design({ ...scenario('ai-assistant'), 'product.features': { kind: 'value', value: ['accounts', 'ml', 'payments', 'media', 'analytics'] } })
    expect(e.workload.totalStorageGb).toBeGreaterThan(500)
    expect(e.workload.dbStorageGb).toBeLessThan(500)
    expect(value(e, 'data.analytics')).toBe('replica_queries')
  })

  it('runs background work inside the requests when processing is synchronous', () => {
    for (const [id, fleet] of [['social-network', 'svc-core'], ['web-crawler', 'app']]) {
      const queued = design(scenario(id))
      const sync = design({ ...scenario(id), 'arch.async': { kind: 'value', value: 'none' } })
      expect(ids(sync)).not.toContain('workers')
      expect(component(sync, fleet)!.replicas, id).toBeGreaterThan(component(queued, fleet)!.replicas * 2)
      expect(component(sync, fleet)!.sizingNote).toContain('background work done inside requests')
    }
  })
})

describe('reevaluation', () => {
  it('adds and removes components when traffic changes', () => {
    const small = design(scenario('internal-tool'))
    const bigAnswers = { ...autoComplete(kb, scenario('internal-tool')), 'traffic.dau': { kind: 'value' as const, value: 5_000_000 } }
    const big = design(bigAnswers)
    const diff = diffEvaluations(small, big)
    expect(diff.added).toContain('cache')
    expect(diff.newQuestions).toContain('perf.cache')
    expect(diffEvaluations(big, small).removed).toContain('cache')
  })

  it('reports a conflict when the user overrides a recommendation unsafely', () => {
    const answers = { ...autoComplete(kb, scenario('ecommerce')), 'data.replication': { kind: 'value' as const, value: 'single' } }
    expect(evaluate(kb, answers).findings.map((x) => x.rule.id)).toContain('single-db-ha')
  })

  it('raises an error for a picked option the engine rules out, unless an error rule already names that decision', () => {
    const override = (id: string, answer: string, value: string) => evaluate(kb, { ...autoComplete(kb, scenario(id)), [answer]: { kind: 'value', value } })
    const writeBehind = override('ecommerce', 'perf.cache', 'write_behind').findings.find((x) => x.rule.id === 'infeasible-perf.cache')
    expect(writeBehind?.rule.severity).toBe('error')
    expect(writeBehind?.rule.message).toBe('Risk of losing acknowledged writes conflicts with strong consistency.')
    expect(override('ecommerce', 'data.replication', 'multi_primary').findings.map((x) => x.rule.id)).toContain('infeasible-data.replication')
    expect(override('internal-tool', 'arch.broker', 'redis_queue').findings.map((x) => x.rule.id)).toContain('infeasible-arch.broker')
    const single = override('ecommerce', 'data.replication', 'single').findings.map((x) => x.rule.id)
    expect(single).toContain('single-db-ha')
    expect(single).not.toContain('infeasible-data.replication')
  })
})

describe('description parsing', () => {
  it('suggests type and features from free text', () => {
    const s = suggestFromDescription(kb, 'A marketplace where sellers upload photos, buyers search the catalog and pay at checkout. GDPR applies.')
    expect(s['product.type']).toEqual({ kind: 'value', value: 'commerce' })
    const features = (s['product.features'] as { value: string[] }).value
    expect(features).toEqual(expect.arrayContaining(['media', 'search', 'payments']))
    expect(s['security.compliance']).toEqual({ kind: 'value', value: ['gdpr'] })
  })

  it('matches whole keywords, not prefixes of longer words', () => {
    const features = (d: string) => (suggestFromDescription(kb, d)['product.features'] as { value: string[] } | undefined)?.value
    expect(features('An AI chatbot that answers customer support questions')).toEqual(['ml'])
    expect(features('Airline ticket marketplace')).toBeUndefined()
    expect(features('Payroll app')).toBeUndefined()
    expect(features('Team chat with direct messages')).toEqual(['chat'])
    expect(suggestFromDescription(kb, 'Cardiology clinic scheduling')['security.compliance']).toBeUndefined()
  })

  const value = (s: Answers, id: string) => (s[id] as { value?: unknown } | undefined)?.value

  it('lets the origin take crm and erp terms of a migration, and reads the source engine and the cloud', () => {
    const s = suggestFromDescription(kb, 'Migrate our on-prem Oracle CRM to Azure')
    expect(value(s, 'project.origin')).toBe('replace_legacy_app')
    expect(value(s, 'source.rdbms_engine')).toBe('oracle')
    expect(value(s, 'infra.cloud')).toBe('azure')
    expect(value(s, 'product.type')).not.toBe('saas')
    // Without a migration a CRM is still a B2B SaaS, not a legacy replacement.
    expect(value(suggestFromDescription(kb, 'A CRM for dentists'), 'product.type')).toBe('saas')
    expect(value(suggestFromDescription(kb, 'A CRM for dentists'), 'project.origin')).toBeUndefined()
  })

  it('detects the kind, data platform and BI tool of an analytics brief', () => {
    const s = suggestFromDescription(kb, 'Lakehouse on Databricks with Power BI from SAP and Salesforce')
    expect(value(s, 'project.kind')).toBe('data_platform')
    expect(value(s, 'data.platform')).toBe('databricks')
    expect(value(s, 'bi.tool')).toBe('power_bi')
  })

  it('skips options whose negative keywords appear: agents calling APIs are not a public API', () => {
    const s = suggestFromDescription(kb, 'RAG chatbot with agents calling our APIs')
    expect(value(s, 'project.kind')).toBe('ai_app')
    expect(value(s, 'product.features') ?? []).not.toContain('public_api')
    expect(value(s, 'product.features') ?? []).not.toContain('chat')
    expect(value(suggestFromDescription(kb, 'A public API for developers'), 'product.features')).toEqual(['public_api'])
    expect(value(suggestFromDescription(kb, 'An internal tool with a public API'), 'product.features')).toEqual(['public_api'])
    expect(value(suggestFromDescription(kb, 'LLM agent with tool calling and a public API'), 'product.features') ?? []).not.toContain('public_api')
  })

  it('does not read plain chat or a BI tool as an AI assistant or a data platform', () => {
    expect(suggestFromDescription(kb, 'Real-time chat with push notifications')['ai.capabilities']).toBeUndefined()
    expect(value(suggestFromDescription(kb, 'An AI chat over our docs'), 'ai.capabilities')).toEqual(['assistant_chat'])
    expect(suggestFromDescription(kb, 'Customer portal for a company that runs Power BI')['project.kind']).toBeUndefined()
  })

  it('lists known terms that set no answer', () => {
    expect(unmappedTerms(kb, 'Kafka events into Snowflake and Redis')).toEqual(expect.arrayContaining(['Kafka', 'Redis']))
    expect(unmappedTerms(kb, 'Kafka events into Snowflake and Redis')).not.toContain('Snowflake')
    expect(unmappedTerms(kb, 'Migrate our on-prem Oracle CRM to Azure')).toEqual([])
    expect(unmappedTerms(kb, 'A photo sharing app')).toEqual([])
    // Compound catalog names are split on '+', and a cloud prefix does not map the product it names.
    expect(unmappedTerms(kb, 'Monitoring with Prometheus and Grafana')).toEqual(expect.arrayContaining(['Prometheus', 'Grafana']))
    const lambda = 'Web app on AWS with AWS Lambda functions and Grafana dashboards'
    expect(value(suggestFromDescription(kb, lambda), 'arch.style')).toBe('serverless')
    expect(unmappedTerms(kb, lambda)).toEqual(['Grafana'])
  })

  it('drops suggestion values toggled off', () => {
    const s = suggestFromDescription(kb, 'Lakehouse on Databricks with Power BI from SAP and Salesforce')
    const picked = pickSuggestions(kb, s, new Set([suggestionKey('bi.tool', 'power_bi'), suggestionKey('org.existing_platforms', 'sap')]))
    expect(picked['bi.tool']).toBeUndefined()
    expect(value(picked, 'org.existing_platforms')).toEqual(['m365', 'databricks_existing', 'salesforce'])
    expect(value(picked, 'data.platform')).toBe('databricks')
  })
})

describe('foundation', () => {
  const v = (x: string) => ({ kind: 'value' as const, value: x })
  const base: Answers = { ...scenario('ecommerce'), 'infra.cloud': v('aws'), 'ops.observability': v('full') }
  const withKb = (patch: Partial<KnowledgeBase>): KnowledgeBase => ({ ...kb, ...patch })
  const patchComponent = (id: string, patch: Partial<ComponentDef>) => kb.components.map((c) => (c.id === id ? { ...c, ...patch } : c))
  const run = (k: KnowledgeBase, answers: Answers = base) => evaluate(k, autoComplete(k, answers))
  const observability = (e: Evaluation) => component(e, 'observability')!
  // The provider offers bill logs per GB with their own sizing, so they are left out to exercise the component's.
  const sized = (sizing: LinearSizing, extra: Partial<ComponentDef> = {}) => run(withKb({ components: patchComponent('observability', { sizing, ...extra }), services: kb.services.filter((s) => s.component !== 'observability') }))
  const offer = (provider: string, name: string, monthlyCostPerUnit: number, extra: Partial<ServiceOffer> = {}): ServiceOffer => ({ component: 'observability', provider, name, monthlyCostPerUnit, asOf: '2026-10', ...extra })

  it('names and prices a component by the first offer for the chosen provider, ahead of techFrom and pricing rules', () => {
    // Without the provider catalog the technology comes from techFrom.
    const plain = observability(run(withKb({ services: [] })))
    expect(plain.tech).toBe('OpenTelemetry + Prometheus + Grafana + Tempo')
    const k = withKb({ services: [offer('gcp', 'Cloud Monitoring', 1), offer('aws', 'Amazon CloudWatch', 100), offer('any', 'Any provider', 999)] })
    const offered = observability(run(k))
    expect(offered.tech).toBe('Amazon CloudWatch')
    expect(offered.offer).toEqual({ provider: 'aws', name: 'Amazon CloudWatch', asOf: '2026-10' })
    // Same instance class, so the offer's price replaces the pricing rule's 400.
    expect(offered.instanceClass).toBe(plain.instanceClass)
    expect(offered.monthlyCost / plain.monthlyCost).toBeCloseTo(100 / 400)
    expect(offered.units * offered.unitCost).toBeCloseTo(offered.monthlyCost)
    // A custom answer still names the technology.
    expect(observability(run(k, { ...base, 'ops.observability': { kind: 'custom', text: 'Datadog', treatAs: 'full' } })).tech).toBe('Datadog')
    // While the provider is pending, only 'any' offers match.
    const pending = Object.fromEntries(Object.entries(base).filter(([id]) => id !== 'infra.cloud'))
    expect(observability(evaluate(k, pending)).tech).toBe('Any provider')
    // An offer's sizing replaces the component's.
    const billed = observability(run(withKb({ services: [offer('aws', 'Per host', 10, { sizing: { product: [3], per: 1, billed: true, note: '{units} hosts' } })] })))
    expect([billed.units, billed.unitCost, billed.monthlyCost, billed.instanceClass, billed.sizingNote]).toEqual([3, 10, 30, null, '3 hosts'])
  })

  it('bills the smallest capacity tier that covers the demand, as a SKU without instance class or utilization', () => {
    const tiers = [
      { name: 'F8', max: 3, monthly: 1051 },
      { name: 'F4', max: 1, monthly: 526 },
    ]
    const f8 = observability(sized({ product: [2.5], per: 1, tiers, note: '{tier} for {demand} CU' }))
    expect([f8.units, f8.unitCost, f8.monthlyCost, f8.utilization, f8.instanceClass, f8.sizingNote]).toEqual([1, 1051, 1051, 0, null, 'F8 for 2.5 CU'])
    const above = observability(sized({ product: [7], per: 1, tiers, note: '{tier}' }))
    expect([above.units, above.monthlyCost, above.sizingNote]).toEqual([3, 3 * 1051, '3 x F8'])
  })

  it('bills ceil(demand / per) units at the unit price, with a minimum', () => {
    const e = sized({ product: ['traffic.dau', 0.001], per: 10, billed: true, min: 2, note: '{units} blocks' })
    const units = Math.max(2, Math.ceil(Number(e.facts['traffic.dau']) * 0.001 / 10))
    const c = observability(e)
    expect([c.units, c.replicas, c.utilization, c.instanceClass, c.monthlyCost]).toEqual([units, 1, 0, null, units * 400])
    expect(observability(sized({ product: ['no.such.fact', 5], per: 1, billed: true, note: '' })).units).toBe(0)
  })

  it('sizes a linear fleet at the target utilization with an N+1 spare, and rescales utilization to fixed replicas', () => {
    const e = sized({ product: [2.5], per: 1, spare: true, note: '{units} nodes for {demand}' })
    expect(Number(e.facts['reliability.nines'])).toBeGreaterThanOrEqual(99.9)
    const c = observability(e)
    expect([c.replicas, c.units, c.instanceClass, c.sizingNote, c.monthlyCost]).toEqual([4, 4, 'large', '4 nodes for 2.5', 4 * 400])
    expect(c.utilization).toBeCloseTo(2.5 / 4)
    const fixed = observability(sized({ product: [2.5], per: 1, spare: true, note: '' }, { fixedReplicas: 5 }))
    expect(fixed.replicas).toBe(5)
    expect(fixed.utilization).toBeCloseTo(0.5)
  })

  const option = (id: string): QuestionOption => ({ id, label: id, description: id, pros: ['p'], cons: [], complexity: 1 })
  const probe: Question = {
    id: 'test.derived',
    category: 'product',
    title: 'Probe',
    prompt: 'Probe',
    kind: 'single',
    options: [option('a'), option('b')],
    askWhen: f.eq('profile.test', true),
    priority: 99,
    isDecision: false,
    default: 'a',
    defaultWhen: [{ when: f.eq('product.type', 'social'), value: 'b' }],
    sources: [],
  }

  it('applies derived facts after the answers, never over an answer, and tracks them as dependencies', () => {
    const k = withKb({
      questions: [...kb.questions, probe],
      derived: [
        { fact: 'profile.test', value: true, when: f.eq('product.type', 'social') },
        { fact: 'profile.test', value: false, when: f.exists('product.type') },
        { fact: 'product.type', value: 'ai', when: f.exists('product.type') },
      ],
    })
    const e = evaluate(k, { 'product.type': v('social') })
    expect(e.facts['profile.test']).toBe(true)
    expect(e.facts['product.type']).toBe('social')
    const state = e.questions.find((s) => s.question.id === 'test.derived')!
    expect(state.active).toBe(true)
    expect(state.dependsOn).toContain('product.type')
    // defaultWhen replaces the stated default as the tie-break of a single-choice question.
    expect(state.recommendation.optionId).toBe('b')
    expect(evaluate(k, { 'product.type': v('saas') }).questions.find((s) => s.question.id === 'test.derived')!.active).toBe(false)
  })

  it('pre-selects the defaultWhen value of a multi-choice question', () => {
    const k = withKb({ questions: kb.questions.map((q) => (q.id === 'product.features' ? { ...q, defaultWhen: [{ when: f.eq('product.type', 'ai'), value: ['accounts', 'ml'] }] } : q)) })
    const e = evaluate(k, { 'product.type': v('ai'), 'product.features': { kind: 'unknown' } })
    const state = e.questions.find((s) => s.question.id === 'product.features')!
    expect(state.recommendation.value).toEqual(['accounts', 'ml'])
    expect(e.facts['product.features']).toEqual(['accounts', 'ml'])
    expect(evaluate(k, { 'product.type': v('social') }).questions.find((s) => s.question.id === 'product.features')!.recommendation.value).toEqual(kb.questions.find((q) => q.id === 'product.features')!.default)
  })

  it('splits cost by kind and phase, and keeps monthlyCost equal to the run total', () => {
    expect(evaluate(kb, {}).cost.monthly).toBe(evaluate(kb, {}).monthlyCost)
    // Staging and support shares split into tiers too, so the tiers add up to the monthly total with them.
    const shared = run(kb)
    expect(shared.cost.byKind.nonprod! * shared.cost.byKind.support!).toBeGreaterThan(0)
    expect(Object.values(shared.cost.byTier).reduce((a, b) => a + b, 0)).toBeCloseTo(shared.monthlyCost)
    // Without them, every line is a component's.
    const pinned: Answers = { ...base, 'ops.environments': { kind: 'value', value: 'prod_only' }, 'ops.support': { kind: 'value', value: 'none' } }
    const plain = run(kb, pinned)
    expect(plain.cost.monthly).toBe(plain.monthlyCost)
    expect(Object.values(plain.cost.byTier).reduce((a, b) => a + b, 0)).toBeCloseTo(plain.monthlyCost)
    // A decided provider carries the platform team's baseline as a people line.
    const staff = component(plain, 'platform-ops')!.monthlyCost
    expect(staff).toBeGreaterThan(0)
    expect([plain.cost.people, plain.cost.oneTime, plain.cost.transitionMonthly, plain.cost.transitionTotal, plain.cost.paybackMonths]).toEqual([staff, 0, 0, 0, null])
    const k = withKb({
      components: kb.components.map((c) => (c.id === 'observability' ? { ...c, costKind: 'people' as const } : c.id === 'cicd' ? { ...c, phase: 'transition' as const } : c)),
      derived: [
        { fact: 'migration.coexistMonths', value: 6, when: f.exists('product.type') },
        { fact: 'source.legacy_monthly_usd', value: 1_000_000, when: f.exists('product.type') },
        // Only a retiring old system pays back.
        { fact: 'profile.retire', value: true, when: f.exists('product.type') },
        // Fleets bill as in the plain design.
        ...kb.derived!.filter((d) => d.fact === 'compute.autoscaled'),
      ],
    })
    const e = run(k, pinned)
    const people = observability(e).monthlyCost + staff
    const transition = component(e, 'cicd')!.monthlyCost
    expect(e.cost.people).toBe(people)
    expect(e.cost.transitionMonthly).toBe(transition)
    expect(e.cost.monthly).toBeCloseTo(plain.monthlyCost - observability(e).monthlyCost - transition)
    // Internet transfer is its own kind, inside the monthly total.
    expect(Object.keys(e.cost.byKind).sort()).toEqual(['people', 'run', 'transfer'])
    expect(e.cost.byKind.run + e.cost.byKind.transfer).toBeCloseTo(e.cost.monthly)
    expect(e.cost.byKind.transfer).toBeCloseTo((component(e, 'internet-egress')?.monthlyCost ?? 0) + (component(e, 'nat-gateway')?.monthlyCost ?? 0))
    expect(e.cost.byKind.people).toBe(people)
    expect(e.cost.transitionTotal).toBeCloseTo(6 * (e.cost.monthly + transition))
    expect(e.cost.paybackMonths).toBeCloseTo(e.cost.transitionTotal / (1_000_000 - e.cost.monthly))
    expect([e.facts['cost.people'], e.facts['cost.transitionMonthly'], e.facts['cost.transitionTotal'], e.facts['cost.oneTime']]).toEqual([people, transition, e.cost.transitionTotal, 0])
  })
})

describe('cloud decision and constraints', () => {
  const v = (x: unknown) => ({ kind: 'value' as const, value: x as string })
  const cloud = kb.questions.find((q) => q.id === 'infra.cloud')!
  const findings = (e: Evaluation) => e.findings.map((x) => x.rule.id)

  it('asks the provider within the first nine questions of a new project', () => {
    // The product category asks the kind of task, the type, the starting point (new build or existing system), the add-ons, the capabilities and the consistency first.
    const answers: Answers = {}
    const asked: string[] = []
    for (let e = evaluate(kb, answers); e.next && asked.length < 9; e = evaluate(kb, answers)) {
      asked.push(e.next.question.id)
      answers[e.next.question.id] = { kind: 'unknown' }
    }
    expect(asked.slice(0, 2)).toEqual(['project.kind', 'product.type'])
    expect(asked).toContain('infra.cloud')
    expect(asked.indexOf('security.residency')).toBeLessThan(asked.indexOf('infra.cloud'))
  })

  it('reads the existing sources: SQL Server and Dynamics point to Azure, a source already in a cloud to that cloud', () => {
    const pick = (facts: Facts) => recommend(cloud, facts).optionId
    expect(pick({})).toBe('aws')
    // Only a migration carries the SQL Server licences over; a data platform reading a SQL Server source moves no licence.
    expect(pick({ 'profile.migration': true, 'source.rdbms_engine': 'sqlserver' })).toBe('azure')
    expect(pick({ 'source.rdbms_engine': 'sqlserver' })).toBe('aws')
    expect(pick({ 'source.crm_product': 'dynamics' })).toBe('azure')
    expect(pick({ 'source.location': 'gcp' })).toBe('gcp')
    // Data already on Google Cloud outweighs carrying SQL Server licences to Azure.
    expect(pick({ 'source.location': 'gcp', 'profile.migration': true, 'source.rdbms_engine': 'sqlserver' })).toBe('gcp')
    // Google Workspace counts for more once BigQuery is to read its Sheets and Drive.
    expect(pick({ 'org.existing_platforms': ['google_workspace', 'm365'] })).toBe('azure')
    expect(pick({ 'org.existing_platforms': ['google_workspace', 'm365'], 'profile.dataPlatform': true })).toBe('gcp')
    // Leaving the cloud the source runs in bills egress; staying in it copies inside the provider's network.
    const moved = (location: string, target: string) => design({ 'project.origin': v('migrate_database'), 'source.location': v(location), 'infra.cloud': v(target) })
    expect(ids(moved('gcp', 'aws'))).toContain('source-egress')
    const stay = moved('gcp', 'gcp')
    expect(ids(stay)).not.toContain('source-egress')
    expect(value(stay, 'migration.link')).toBe('same_cloud')
  })

  it('recommends the provider the organisation already uses', () => {
    const azure = recommend(cloud, { 'org.existing_platforms': ['m365'] })
    expect(azure.optionId).toBe('azure')
    expect(azure.reasons).toContain('Staff already sign in with Entra ID through Microsoft 365, so Azure needs no second directory; Fabric and Azure capacity are bought separately.')
    expect(recommend(cloud, { 'org.existing_platforms': ['gcp_commit'] }).optionId).toBe('gcp')
    expect(recommend(cloud, { 'org.existing_platforms': ['google_workspace'] }).optionId).toBe('gcp')
    expect(recommend(cloud, { 'org.existing_platforms': ['datacenter'] }).optionId).toBe('onprem')
    // A commitment outweighs the free data center: the hardware still needs a platform team.
    expect(recommend(cloud, { 'org.existing_platforms': ['datacenter', 'aws_commit'] }).optionId).toBe('aws')
    expect(recommend(cloud, {}).optionId).toBe('aws')
  })

  it('rules out the public clouds when data must stay on own hardware', () => {
    for (const residency of ['onprem_required', 'air_gapped']) {
      const r = recommend(cloud, { 'security.residency': residency, 'org.existing_platforms': ['aws_commit'] })
      expect(r.optionId, residency).toBe('onprem')
      for (const id of ['aws', 'azure', 'gcp']) {
        const score = r.scores.find((s) => s.optionId === id)!
        expect([score.feasible, score.infeasibleReason], `${residency} ${id}`).toEqual([false, 'Data must stay on your hardware.'])
      }
    }
    expect(recommend(cloud, { 'security.residency': 'region' }).scores.every((s) => s.feasible)).toBe(true)
  })

  it('replaces the region SLA with the data center sites on premises', () => {
    const onprem = { ...scenario('onprem-regulated-ai'), 'reliability.availability': v('three_half') }
    const one = design(onprem)
    expect(value(one, 'reliability.nines')).toBe(99.95)
    expect(findings(one)).toContain('single-site-onprem')
    expect(one.availability).toBeLessThanOrEqual(kb.reference.onpremSiteAvailability.one)
    const two = design({ ...onprem, 'onprem.sites': v('two') })
    expect(findings(two)).not.toContain('single-site-onprem')
    expect(two.availability).toBeGreaterThan(one.availability)
    // Every further site carries its own copy of the stack and links: a warm second site, or two full copies for three sites.
    expect(component(one, 'extra-sites')).toBeUndefined()
    const second = component(two, 'extra-sites')!
    expect(second.monthlyCost).toBeGreaterThan(kb.reference.onpremSiteLinkMonthly)
    expect(two.monthlyCost - one.monthlyCost).toBeCloseTo(second.monthlyCost, 0)
    const three = design({ ...onprem, 'onprem.sites': v('three') })
    expect(component(three, 'extra-sites')!.monthlyCost).toBeGreaterThan(second.monthlyCost)
    // A standby site chosen through the regional topology is the same second site, so it is not priced twice.
    const standby = design({ ...onprem, 'onprem.sites': v('two'), 'reliability.multi_region': v('active_passive') })
    expect(component(standby, 'standby-region')!.monthlyCost + component(standby, 'extra-sites')!.monthlyCost).toBeCloseTo(second.monthlyCost, 0)
    // The sites count only on premises.
    const cloudDesign = design({ ...onprem, 'security.residency': v('anywhere'), 'org.existing_platforms': v([]), 'infra.cloud': v('aws'), 'onprem.sites': v('one') })
    expect(cloudDesign.questions.find((q) => q.question.id === 'onprem.sites')!.active).toBe(false)
  })

  it('flags hosted services and thin teams on premises', () => {
    // On premises the model runs on own GPUs (ai.model_hosting), so no hosted model API is left to warn about.
    const onprem = design(scenario('onprem-regulated-ai'))
    // The on-prem edge is self-run (HAProxy + Coraza, Varnish), so no hosted CDN or WAF is left to warn about.
    expect(component(onprem, 'waf')!.tech).toBe('HAProxy + Coraza')
    expect(findings(onprem)).not.toContain('residency-saas-dependency')
    expect(findings(onprem)).not.toContain('hosted-llm-residency')
    expect(onprem.architecture.components.map((c) => c.def.id)).toEqual(expect.arrayContaining(['llm-serving']))
    expect(onprem.architecture.components.map((c) => c.def.id)).not.toContain('llm-api')
    // Residency keeps the prompts inside by default, so the model runs on own GPUs.
    const pinned = design({ ...scenario('ai-assistant'), 'security.residency': v('onprem_required'), 'infra.cloud': v('aws') })
    expect(value(pinned, 'ai.data_policy')).toBe('no_external')
    expect(findings(pinned)).not.toContain('hosted-llm-residency')
    // A hosted model the user allows anyway raises the warning, even with a cloud provider chosen.
    expect(findings(design({ ...scenario('ai-assistant'), 'security.residency': v('onprem_required'), 'infra.cloud': v('aws'), 'ai.data_policy': v('public_ok') }))).toContain('hosted-llm-residency')
    // A cloud edge with on-premises residency still terminates TLS outside the organisation's hardware.
    expect(findings(design({ ...scenario('onprem-regulated-ai'), 'infra.cloud': v('aws') }))).toContain('residency-saas-dependency')
    const idp = design({ ...scenario('onprem-regulated-ai'), 'security.auth': v('oidc'), 'team.size': v('tiny') })
    expect(component(idp, 'auth')!.tech).toBe('Keycloak')
    // The on-prem catalog already picks a self-hosted IdP, so no finding tells the user to replace it.
    expect(findings(idp)).toContain('onprem-small-team')
    expect(findings(idp).filter((id) => /idp|identity/.test(id))).toEqual([])
    expect(findings(design(scenario('ai-assistant')))).not.toEqual(expect.arrayContaining(['hosted-llm-residency']))
  })

  it('reaches every scenario expectation after auto-completion', () => {
    for (const s of kb.scenarios) {
      const e = design(s.answers)
      for (const [id, optionId] of Object.entries(s.expect ?? {})) expect(value(e, id), `${s.id} ${id}`).toBe(optionId)
      for (const id of s.expectComponents ?? []) expect(ids(e), `${s.id} ${id}`).toContain(id)
    }
  })

  it('detects existing platforms in a description', () => {
    const platforms = (d: string) => (suggestFromDescription(kb, d)['org.existing_platforms'] as { value: string[] } | undefined)?.value
    expect(platforms('Portal for a company on Microsoft 365 with Power BI reports')).toEqual(['m365'])
    expect(platforms('Scheduling app for sales teams')).toBeUndefined()
    // The shorthand and the E5 tier both mean Microsoft 365, which the Azure and Fabric scores read.
    expect(platforms('We are an M365 shop; staff use SharePoint and Teams.')).toEqual(['m365'])
    expect(platforms('We have M365 E5 licences')).toEqual(expect.arrayContaining(['m365', 'm365_e5']))
    expect(platforms('Microsoft 365 E5 for every employee')).toEqual(expect.arrayContaining(['m365', 'm365_e5']))
    expect(platforms('A weather outlook dashboard')).toBeUndefined()
  })

  it('waits for a question that another pending answer could still make relevant', () => {
    // Reports may query a read replica only once the replication question, which waits on the database choice, is settled.
    const answers: Answers = { ...scenario('azure-m365-saas'), 'data.model': v('relational') }
    expect(evaluateCondition(f.all(f.eq('data.sql', true), f.exists('reliability.nines')), { facts: evaluate(kb, answers).facts })).toBe(false)
    const asked: string[] = []
    for (let e = evaluate(kb, answers); e.next; e = evaluate(kb, answers)) {
      asked.push(e.next.question.id)
      answers[e.next.question.id] = e.next.recommendation.optionId ? v(e.next.recommendation.optionId) : { kind: 'unknown' }
    }
    expect(asked.indexOf('data.replication')).toBeLessThan(asked.indexOf('data.analytics'))
  })
})

describe('data platform', () => {
  const v = (x: unknown) => ({ kind: 'value' as const, value: x as string })
  const question = (id: string) => kb.questions.find((q) => q.id === id)!
  const platform = (facts: Facts) => recommend(question('data.platform'), facts)
  const findings = (e: Evaluation) => e.findings.map((x) => x.rule.id)
  const ANALYTICS_LINES = ['lake-storage', 'ingestion', 'orchestrator', 'catalog', 'bi']

  it('sizes the stream, stream processor and batch jobs of a data platform on its own lake changes, not on a request rate it does not have', () => {
    const streaming = (tb: number, sources: number, extra: Answers = {}) =>
      design({ 'project.kind': v('data_platform'), 'infra.cloud': v('aws'), 'data.platform': v('snowflake'), 'data.analytics': v('streaming'), 'data.source_count': { kind: 'value', value: sources }, 'data.history_tb': { kind: 'value', value: tb }, ...extra })
    const cost = (e: Evaluation, id: string) => component(e, id)!.monthlyCost
    const small = streaming(5, 2)
    const big = streaming(500, 2)
    const many = streaming(5, 40)
    expect(small.workload.peakIngestQps).toBeGreaterThan(0)
    expect(big.workload.peakIngestQps).toBeCloseTo(small.workload.peakIngestQps * 100)
    expect(cost(big, 'stream')).toBeGreaterThan(cost(small, 'stream'))
    expect(cost(big, 'stream-processor')).toBeGreaterThan(cost(small, 'stream-processor'))
    // Each source writes its own topic, so more sources need more partitions.
    expect(cost(many, 'stream')).toBeGreaterThan(cost(small, 'stream'))
    expect(component(small, 'stream')!.sizingNote).not.toMatch(/^0\.0 events/)
    // The flows into and out of the stream carry the ingest rate.
    for (const edge of small.architecture.edges.filter((x) => (x.from === 'sources' && x.to === 'stream') || (x.from === 'stream' && x.to === 'stream-processor'))) expect(edge.qps, edge.id).toBeGreaterThan(0)
    // A batch job on a lake of 500 TB runs a larger class than on 5 TB.
    const ml = { 'product.features': v(['ml']), 'ml.serving': v('batch') } as Answers
    expect(cost(streaming(500, 2, ml), 'ml-batch')).toBeGreaterThan(cost(streaming(5, 2, ml), 'ml-batch'))
  })

  it('recommends the platform the provider, licences and workload point to', () => {
    expect(platform({ 'infra.cloud': 'azure', 'org.existing_platforms': ['m365'], 'data.analytics': 'warehouse', 'team.size': 'small' }).optionId).toBe('fabric')
    expect(platform({ 'infra.cloud': 'onprem', 'security.residency': 'onprem_required', 'team.size': 'multi', 'cap.lakeStorageTb': 5 }).optionId).toBe('oss_lakehouse')
    expect(platform({ 'infra.cloud': 'aws', 'ml.serving': 'batch', 'team.size': 'small', 'product.features': ['ml'], 'cap.lakeStorageTb': 1 }).optionId).toBe('databricks')
    // A small dataset with no models stays on PostgreSQL + DuckDB; the lake (operational history plus existing data) sets the size.
    expect(platform({ 'infra.cloud': 'aws', 'cap.lakeStorageTb': 0.05, 'product.features': ['analytics'] }).optionId).toBe('small_sql')
  })

  it('rules out the SaaS platforms on premises with their reason, unless analytics may run in a cloud region', () => {
    const scores = platform({ 'infra.cloud': 'onprem' }).scores
    const fabric = scores.find((s) => s.optionId === 'fabric')!
    expect(fabric.feasible).toBe(false)
    expect(fabric.infeasibleReason).toMatch(/on-premises data gateway/)
    expect(scores.find((s) => s.optionId === 'databricks')!.infeasibleReason).toMatch(/no on-prem edition/)
    expect(scores.find((s) => s.optionId === 'native')!.infeasibleReason).toMatch(/Microsoft Fabric/)
    const hybrid = platform({ 'infra.cloud': 'onprem', 'data.platform_location': 'cloud_analytics_from_onprem' }).scores
    expect(['fabric', 'databricks', 'snowflake'].map((id) => hybrid.find((s) => s.optionId === id)!.feasible)).toEqual([true, true, true])
    // While the provider is pending, provider-bound platforms stay open.
    expect(platform({}).scores.filter((s) => ['native', 'fabric', 'databricks', 'snowflake'].includes(s.optionId) && !s.feasible)).toEqual([])
  })

  it('writes Delta on Fabric and Iceberg with a Polaris catalog on an on-prem lakehouse', () => {
    const format = (facts: Facts) => recommend(question('data.table_format'), facts)
    expect(format({ 'data.platform': 'fabric', 'data.nativeTableFormat': 'delta', 'infra.cloud': 'azure' }).optionId).toBe('delta')
    const iceberg = format({ 'data.platform': 'fabric', 'data.nativeTableFormat': 'delta', 'infra.cloud': 'azure' }).scores.find((s) => s.optionId === 'iceberg')!
    expect(iceberg.feasible).toBe(true)
    expect(iceberg.penalties.join(' ')).toMatch(/metadata virtualization/)
    expect(format({ 'data.platform': 'oss_lakehouse', 'infra.cloud': 'onprem' }).optionId).toBe('iceberg')
    const onprem = design(scenario('onprem-iceberg-lakehouse'))
    expect(component(onprem, 'catalog')!.tech).toContain('Polaris')
    expect(findings(onprem)).toContain('iceberg-needs-catalog')
    // Delta and Hudi on premises need their own catalogs, not an Iceberg REST catalog.
    const delta = design({ ...scenario('onprem-iceberg-lakehouse'), 'data.table_format': v('delta') })
    expect(component(delta, 'catalog')!.tech).toMatch(/Unity Catalog OSS|Hive Metastore/)
    const fabric = design(scenario('fabric-bi-azure'))
    expect(component(fabric, 'lake-storage')!.tech).toBe('OneLake, Delta tables')
    expect(component(fabric, 'catalog')!.tech).toBe('OneLake catalog + Purview')
  })

  it('names the warehouse, batch and stream jobs from the platform', () => {
    const aws = design({ ...scenario('databricks-ml-aws'), 'product.features': v(['accounts', 'ml', 'analytics']) })
    expect(component(aws, 'warehouse')!.tech).toBe('Databricks SQL on AWS')
    expect(component(aws, 'ml-batch')!.tech).toBe('Lakeflow Jobs (Spark on Databricks)')
    expect(component(aws, 'orchestrator')!.tech).toBe('Lakeflow Jobs')
    const native = design(scenario('sales-rank'))
    expect(value(native, 'data.platform')).toBe('native')
    expect(component(native, 'warehouse')!.tech).toBe('Amazon Redshift Serverless + Athena')
  })

  it('keeps the native AWS designs at their previous total outside the analytics lines', () => {
    // Totals before the data-platform decisions, with the old flat $600 warehouse: sales-rank $20,135 and web-crawler $4,084,291 a month.
    // Analytics pricing now bills the warehouse per platform, so it is compared outside the total like the other analytics lines.
    // Per-request, per-user and per-GB billing (gateway, WAF, identity, logs) came later still, so those lines keep their node pricing here.
    const perUse = ['waf', 'api-gateway', 'auth', 'observability']
    // Autoscaled fleets billing their average fleet came later still, so the fleets bill their peak here.
    const nodePriced: KnowledgeBase = {
      ...kb,
      services: kb.services.map((s) => (perUse.includes(s.component) ? { ...s, sizing: undefined, monthlyCostPerUnit: undefined, unit: undefined } : s)),
      derived: kb.derived!.filter((d) => d.fact !== 'compute.autoscaled'),
    }
    for (const [id, previous] of [['sales-rank', 20_135], ['web-crawler', 4_084_291]] as const) {
      // The cold storage class came later still, so every object stays in the standard class here.
      const e = evaluate(nodePriced, autoComplete(nodePriced, { ...scenario(id), 'data.storage_class': { kind: 'value', value: 'standard' } }))
      const added = e.architecture.components.filter((c) => [...ANALYTICS_LINES, 'warehouse'].includes(c.def.id)).reduce((sum, c) => sum + c.monthlyCost, 0)
      // Database and index storage and internet transfer (cost basis) came later still, so they are taken out the same way.
      const basis = e.architecture.components.reduce((sum, c) => sum + (c.storageCost ?? 0) + (c.def.id === 'internet-egress' || c.def.id === 'nat-gateway' ? c.monthlyCost : 0), 0)
      // Vendor support and the staging default for larger teams came later still.
      const shares = (e.cost.byKind.support ?? 0) + (e.cost.byKind.nonprod ?? 0)
      expect(Math.round(e.monthlyCost - added - basis - shares + 600), id).toBe(previous)
    }
    // Redshift Serverless at its 8-RPU base for 8 query hours a day: 8 x 30 x 8 RPU-hours at $0.375.
    expect(component(design(scenario('sales-rank')), 'warehouse')!.monthlyCost).toBeCloseTo(8 * 30 * 8 * 0.375)
  })

  it('keeps an organisation on the analytics platform it already runs, and turns from Fabric past one F64', () => {
    const on = (facts: Facts) => platform({ 'infra.cloud': 'azure', 'cap.lakeStorageTb': 10, ...facts })
    expect(on({ 'org.existing_platforms': ['m365', 'databricks_existing'], 'ml.serving': 'batch', 'data.analytics': 'streaming' }).optionId).toBe('databricks')
    expect(on({ 'org.existing_platforms': ['databricks_existing'], 'team.size': 'small' }).optionId).toBe('databricks')
    expect(on({ 'org.existing_platforms': ['snowflake_existing'], 'team.size': 'small' }).optionId).toBe('snowflake')
    // On Azure, Microsoft 365 is not counted a second time.
    const fabricScore = (facts: Facts) => on(facts).scores.find((s) => s.optionId === 'fabric')!.score
    expect(fabricScore({ 'org.existing_platforms': ['m365'] })).toBe(fabricScore({}))
    // Up to an F8 (about 3 TB) one capacity is the cheapest; from F16 to F64 it costs two to three times the query-hour platforms, which the Azure affinity cannot outweigh.
    expect(on({ 'org.existing_platforms': ['m365'], 'cap.lakeStorageTb': 2 }).optionId).toBe('fabric')
    expect(on({ 'org.existing_platforms': ['m365'] }).optionId).not.toBe('fabric')
    const thirty = design({ 'project.kind': v('data_platform'), 'product.features': v(['analytics']), 'team.size': v('multi'), 'infra.cloud': v('azure'), 'data.history_tb': v(30) })
    expect(value(thirty, 'data.platform')).not.toBe('fabric')
    // 120 TB needs three F64 capacities, while Databricks and Snowflake bill the query hours.
    const large = on({ 'cap.lakeStorageTb': 120 })
    expect(large.optionId).not.toBe('fabric')
    expect(large.scores.find((s) => s.optionId === 'fabric')!.penalties.join(' ')).toMatch(/F64/)
  })

  it('places hybrid analytics in a named cloud and region, and keeps self-run platforms out of the cloud location', () => {
    const hybridFacts = { 'infra.cloud': 'onprem', 'data.platform_location': 'cloud_analytics_from_onprem', 'cap.lakeStorageTb': 1 }
    for (const id of ['oss_lakehouse', 'olap_db', 'small_sql']) {
      const score = platform(hybridFacts).scores.find((s) => s.optionId === id)!
      expect(score.feasible, id).toBe(false)
      expect(score.infeasibleReason, id).toMatch(/cloud region/)
    }
    const iot = design({ 'product.type': v('iot'), 'project.kind': v('data_platform'), 'infra.cloud': v('onprem'), 'data.platform_location': v('cloud_analytics_from_onprem'), 'team.size': v('multi') })
    expect(['fabric', 'databricks', 'snowflake']).toContain(value(iot, 'data.platform'))
    expect(ids(iot)).toContain('hybrid-link')
    const e = design(scenario('onprem-erp-databricks-hybrid'))
    expect(value(e, 'data.analytics_cloud')).toBe('aws')
    expect(component(e, 'warehouse')!.tech).toBe('Databricks SQL on AWS over a private link')
    expect(component(e, 'hybrid-link')!.tech).toBe('AWS Direct Connect (1 Gbps)')
    expect(component(e, 'lake-storage')!.tech).toMatch(/^Amazon S3/)
    const azure = design({ ...scenario('onprem-erp-databricks-hybrid'), 'data.analytics_cloud': v('azure') })
    expect(component(azure, 'hybrid-link')!.tech).toBe('Azure ExpressRoute (1 Gbps)')
    expect(component(azure, 'warehouse')!.tech).toBe('Databricks SQL on Azure over a private link')
    expect(component(azure, 'lake-storage')!.tech).toMatch(/^ADLS Gen2/)
    expect(component(azure, 'lake-storage')!.monthlyCost).toBeLessThan(component(e, 'lake-storage')!.monthlyCost)
    // Fabric runs only on Azure.
    expect(recommend(question('data.analytics_cloud'), { ...hybridFacts, 'data.platform': 'fabric' }).scores.filter((s) => s.feasible).map((s) => s.optionId)).toEqual(['azure'])
    // The analytics region is checked against the residency zone.
    expect(findings(e)).not.toContain('analytics-region-outside-residency')
    expect(findings(design({ ...scenario('onprem-erp-databricks-hybrid'), 'data.analytics_region': v('us_east') }))).toContain('analytics-region-outside-residency')
  })

  it('links a hybrid design to the cloud platform and bills the link, not the inbound loads', () => {
    const e = design(scenario('onprem-erp-databricks-hybrid'))
    expect(ids(e)).toContain('hybrid-link')
    expect(component(e, 'ingestion')!.tech).toContain('gateway')
    expect(e.architecture.edges.some((x) => x.from === 'ingestion' && x.to === 'hybrid-link')).toBe(true)
    // Loads into the cloud are inbound and free, so no per-GB line and no $0.09/GB warning; the info names the link as the fixed cost.
    expect(ids(e)).not.toContain('platform-egress')
    expect(findings(e)).not.toContain('cross-cloud-platform')
    const hybrid = e.findings.find((x) => x.rule.id === 'hybrid-platform-transfer')!
    expect(hybrid.rule.message).toMatch(/inbound/)
    expect(hybrid.rule.message).not.toMatch(/0\.09/)
    // Keeping analytics next to the application drops the link and the open lakehouse comes back.
    const local = design({ ...scenario('onprem-erp-databricks-hybrid'), 'data.platform_location': v('same_as_app') })
    expect(ids(local)).not.toContain('hybrid-link')
    expect(value(local, 'data.platform')).toBe('oss_lakehouse')
  })

  it('flags Fabric outside Azure and a lakehouse for small data', () => {
    const awsFabric = design({ ...scenario('fabric-bi-azure'), 'infra.cloud': v('aws'), 'data.platform': v('fabric') })
    expect(findings(awsFabric)).toContain('cross-cloud-platform')
    expect(component(awsFabric, 'platform-egress')!.offer).toBeUndefined()
    expect(component(awsFabric, 'platform-egress')!.unitCost).toBe(0.09)
    // A data platform has no write rate, so the lake's changes cross each month: its yearly growth spread over the days, or at least the daily
    // change share of the lake (the volume the stream carries), so a lake with no growth answer still bills well above the 1 GB minimum.
    const lake = (tb: number, growth?: number) => design({ 'project.kind': v('data_platform'), 'infra.cloud': v('aws'), 'data.platform': v('fabric'), 'data.history_tb': v(tb), ...(growth !== undefined && { 'data.growth_pct': v(growth) }) })
    const daily = Math.max(0.3 / 365, kb.reference.lakeDailyChangeShare)
    const crossing = component(lake(20, 30), 'platform-egress')!
    expect(crossing.units).toBe(Math.ceil((20 * 1024 * daily * 365) / 12))
    const flat = lake(20)
    const flatDaily = Math.max((Number(flat.facts['data.growth_pct']) / 100) / 365, kb.reference.lakeDailyChangeShare)
    expect(component(flat, 'platform-egress')!.units).toBe(Math.ceil((20 * 1024 * flatDaily * 365) / 12))
    expect(component(flat, 'platform-egress')!.units).toBeGreaterThan(100)
    expect(crossing.monthlyCost).toBeCloseTo(crossing.units * 0.09)
    expect(component(lake(200, 30), 'platform-egress')!.units).toBeGreaterThan(9 * crossing.units)
    expect(findings(design(scenario('fabric-bi-azure')))).toContain('lakehouse-small-data')
    expect(findings(design(scenario('fabric-bi-azure')))).not.toContain('cross-cloud-platform')
  })

  it('asks for an existing Snowflake account\'s region instead of warning about and billing a cross-cloud transfer', () => {
    const e = design({ ...scenario('sales-rank'), 'org.existing_platforms': v(['snowflake_existing']) })
    expect(value(e, 'data.platform')).toBe('snowflake')
    expect(findings(e)).not.toContain('cross-cloud-platform')
    expect(ids(e)).not.toContain('platform-egress')
    expect(e.findings.find((x) => x.rule.id === 'snowflake-account-region')?.rule.severity).toBe('info')
  })

  it('places a hybrid design\'s existing Snowflake account by its link, with no per-load egress wording', () => {
    const e = design({ ...scenario('onprem-erp-databricks-hybrid'), 'data.platform': v('snowflake'), 'org.existing_platforms': v(['datacenter', 'snowflake_existing', 'sap']) })
    expect(findings(e)).toContain('snowflake-account-region-hybrid')
    expect(findings(e)).not.toContain('snowflake-account-region')
    expect(e.findings.filter((x) => /0\.09/.test(x.rule.message))).toEqual([])
  })

  it('prices the warehouse on data volume, not on web traffic', () => {
    const crawler = design(scenario('web-crawler'))
    const rank = design(scenario('sales-rank'))
    expect(value(crawler, 'data.platform')).toBe(value(rank, 'data.platform'))
    expect(component(crawler, 'warehouse')!.monthlyCost).toBeGreaterThan(component(rank, 'warehouse')!.monthlyCost)
    expect(component(crawler, 'warehouse')!.instanceClass).toBeNull()
  })

  it('picks the Fabric F-SKU from the lake and bills Power BI Pro seats below F64', () => {
    const fabric = (extra: Answers = {}) => design({ ...scenario('fabric-bi-azure'), ...extra })
    const base = fabric()
    expect(value(base, 'data.platform')).toBe('fabric')
    const tb = Number(value(base, 'cap.lakeStorageTb'))
    expect(tb).toBeLessThan(0.5)
    const warehouse = component(base, 'warehouse')!
    expect(warehouse.sizingNote).toMatch(/^F2: /)
    expect(warehouse.monthlyCost).toBeCloseTo(262.8)
    expect(component(base, 'bi')!.monthlyCost).toBe(Number(value(base, 'cap.analyticsUsers')) * 14)
    expect(component(fabric({ 'data.analytics_users': v(100) }), 'bi')!.monthlyCost).toBe(1_400)
    // 2 TB of existing data fits F8 (up to 3 TB); the jobs on the capacity are priced inside it.
    const f8 = fabric({ 'data.history_tb': v(2) })
    expect(component(f8, 'warehouse')!.sizingNote).toMatch(/^F8: /)
    expect(component(f8, 'warehouse')!.monthlyCost).toBeCloseTo(1_051.2)
    for (const id of ['ingestion', 'orchestrator']) expect(component(f8, id)!.monthlyCost, id).toBe(0)
    // Lake storage bills OneLake per TB of the same lake.
    expect(component(f8, 'lake-storage')!.units).toBe(Math.ceil(Number(value(f8, 'cap.lakeStorageTb'))))
    // At F64 viewers read free, and so do Microsoft 365 E5 users at any size.
    const f64 = fabric({ 'data.history_tb': v(30), 'data.analytics_users': v(1_000), 'data.platform': v('fabric') })
    expect(component(f64, 'warehouse')!.sizingNote).toMatch(/^F64: /)
    expect(component(f64, 'bi')!.monthlyCost).toBe(0)
    expect(component(fabric({ 'org.existing_platforms': v(['m365', 'm365_e5']) }), 'bi')!.monthlyCost).toBe(0)
  })

  it('doubles the Fabric capacity demand for Spark and streaming jobs, which bill nothing of their own', () => {
    const streaming = design({ ...scenario('fabric-bi-azure'), 'data.analytics': v('streaming'), 'data.history_tb': v(2), 'data.platform': v('fabric') })
    expect(value(streaming, 'data.platform')).toBe('fabric')
    // 2 TB grown 30% in a year, doubled: past F8's 3 TB.
    expect(component(streaming, 'warehouse')!.sizingNote).toMatch(/^F16: /)
    expect(component(streaming, 'stream-processor')!.monthlyCost).toBe(0)
  })

  it('prices Power BI on an F64 capacity off Fabric once Pro seats cost more', () => {
    const bi = (n: number) => component(design({ ...scenario('sales-rank'), 'infra.cloud': v('azure'), 'data.platform': v('databricks'), 'bi.tool': v('power_bi'), 'data.analytics_users': v(n) }), 'bi')!
    expect(bi(300).monthlyCost).toBe(300 * 14)
    const capacity = bi(5_000)
    expect(capacity.tech).toBe('Power BI on an F64 capacity')
    expect(capacity.monthlyCost).toBeCloseTo(8_409.6)
  })

  it('allows Delta on both native warehouses, which read it from the lake', () => {
    for (const cloud of ['aws', 'gcp']) {
      const e = design({ ...scenario('sales-rank'), 'infra.cloud': v(cloud), 'data.platform': v('native') })
      expect(e.questions.find((q) => q.question.id === 'data.table_format')!.recommendation.scores.find((x) => x.optionId === 'delta')!.feasible, cloud).toBe(true)
    }
    expect(design({ ...scenario('sales-rank'), 'data.platform': v('snowflake') }).questions.find((q) => q.question.id === 'data.table_format')!.recommendation.scores.find((x) => x.optionId === 'delta')!.feasible).toBe(false)
  })

  it('draws and prices the Kafka cluster that Debezium change capture runs on, on premises', () => {
    const lake = (ingestion: string) => design({ ...scenario('onprem-iceberg-lakehouse'), 'data.freshness': v('minutes'), 'data.ingestion': v(ingestion) })
    const cdc = lake('cdc')
    expect(component(cdc, 'ingestion')!.tech).toBe('Debezium + Kafka Connect')
    expect(component(cdc, 'stream')!.monthlyCost).toBeGreaterThan(0)
    expect(cdc.architecture.edges.map((x) => `${x.from}->${x.to}`)).toContain('ingestion->stream')
    expect(component(lake('batch'), 'stream')).toBeUndefined()
  })

  it('suggests F64 once Pro seats for the viewers cost more than the capacity', () => {
    const viewers = (n: number, extra: Answers = {}) => findings(design({ ...scenario('fabric-bi-azure'), 'data.analytics_users': v(n), ...extra }))
    expect(viewers(500)).not.toContain('fabric-viewer-licenses')
    expect(viewers(700)).toContain('fabric-viewer-licenses')
    expect(viewers(700, { 'org.existing_platforms': v(['m365', 'm365_e5']) })).not.toContain('fabric-viewer-licenses')
    expect(viewers(700, { 'data.history_tb': v(30) })).not.toContain('fabric-viewer-licenses')
  })

  it('bills BigQuery on-demand by the data scanned, which follows the existing data', () => {
    const bigquery = (tb: number) => design({ ...scenario('sales-rank'), 'infra.cloud': v('gcp'), 'data.platform': v('native'), 'data.history_tb': v(tb) })
    const small = bigquery(0)
    const large = bigquery(100)
    expect(component(large, 'warehouse')!.tech).toContain('BigQuery')
    expect(component(large, 'warehouse')!.monthlyCost).toBeGreaterThan(component(small, 'warehouse')!.monthlyCost)
    expect(component(large, 'warehouse')!.monthlyCost).toBe(Math.ceil(Number(value(large, 'cap.scannedTbMonth'))) * 6.25)
    // Storage is billed apart from the queries: BigLake Iceberg or Delta tables in the customer's Cloud Storage bucket, native tables by BigQuery.
    expect(component(large, 'lake-storage')!.tech).toBe('Cloud Storage for BigLake, Iceberg tables')
    expect(component(design({ ...scenario('sales-rank'), 'infra.cloud': v('gcp'), 'data.platform': v('native'), 'data.table_format': v('delta') }), 'lake-storage')!.tech).toBe('Cloud Storage for BigLake, Delta tables')
    expect(component(design({ ...scenario('sales-rank'), 'infra.cloud': v('gcp'), 'data.platform': v('native'), 'data.table_format': v('managed') }), 'lake-storage')!.tech).toContain('BigQuery storage')
  })

  it('bills Databricks SQL and Snowflake by the query hours and their storage apart', () => {
    const hours = (platform: string, h: number) => design({ ...scenario('sales-rank'), 'data.platform': v(platform), 'data.analytics_hours': v(h) })
    expect(component(hours('databricks', 8), 'warehouse')!.monthlyCost).toBeCloseTo(8 * 30 * 12 * 0.7)
    expect(component(hours('databricks', 24), 'warehouse')!.monthlyCost).toBeCloseTo(24 * 30 * 12 * 0.7)
    const snowflake = hours('snowflake', 8)
    expect(component(snowflake, 'warehouse')!.monthlyCost).toBeCloseTo(8 * 30 * 2 * 3)
    // Snowflake Iceberg tables sit in the customer's bucket (an external volume) that the cloud bills; only native tables are Snowflake storage.
    expect(component(snowflake, 'lake-storage')!.tech).toMatch(/external volume for Snowflake, Iceberg tables$/)
    expect(component(design({ ...scenario('sales-rank'), 'data.platform': v('snowflake'), 'data.table_format': v('managed') }), 'lake-storage')!.tech).toMatch(/^Snowflake storage/)
  })

  it('shows a different cost for each feasible analytics platform of the Fabric design', () => {
    const answers = scenario('fabric-bi-azure')
    const options = question('data.platform').options!.map((o) => o.id)
    const costs = options.map((id) => assumedDesign(kb, { ...answers, 'data.platform': v(id) })).filter((e) => !findings(e).includes('infeasible-data.platform')).map((e) => Math.round(e.monthlyCost))
    expect(costs.length).toBeGreaterThan(3)
    expect(new Set(costs).size).toBe(costs.length)
  })

  it('picks the BI tool from the platform and the provider', () => {
    const bi = (facts: Facts) => recommend(question('bi.tool'), facts).optionId
    expect(bi({ 'data.platform': 'fabric', 'infra.cloud': 'azure' })).toBe('power_bi')
    // Looker Studio Pro at $9 a viewer undercuts the Looker platform's flat $3,000 until about 330 viewers.
    expect(bi({ 'data.platform': 'native', 'infra.cloud': 'gcp', 'cap.analyticsUsers': 25 })).toBe('looker_studio')
    expect(bi({ 'data.platform': 'native', 'infra.cloud': 'gcp', 'cap.analyticsUsers': 2_000 })).toBe('looker')
    expect(bi({ 'data.platform': 'native', 'infra.cloud': 'aws', 'team.size': 'small' })).toBe('quicksight')
    expect(bi({ 'data.platform': 'oss_lakehouse', 'infra.cloud': 'onprem' })).toBe('superset_metabase')
  })

  it('keeps the recommended BI tool from making Google Cloud dearer than it is with Power BI', () => {
    for (const id of ['sales-rank', 'onprem-erp-databricks-hybrid', 'crm-to-ai-insights']) {
      const onGcp = { ...autoComplete(kb, scenario(id)), 'infra.cloud': v('gcp') }
      const recommended = assumedDesign(kb, onGcp)
      expect(recommended.facts['bi.tool'], id).toBe('looker_studio')
      expect(runAndPeople(recommended), id).toBeLessThanOrEqual(runAndPeople(assumedDesign(kb, { ...onGcp, 'bi.tool': v('power_bi') })) + 1)
    }
  })
})

describe('AI applications', () => {
  const v = (x: unknown) => ({ kind: 'value' as const, value: x as string })
  const llmCost = (answers: Answers) => component(design(answers), 'llm-api')!.monthlyCost
  const question = (id: string) => kb.questions.find((q) => q.id === id)!

  it('prices the hosted model by tier: frontier costs 15x small', () => {
    const base = scenario('rag-assistant-azure')
    const small = llmCost({ ...base, 'ai.model_tier': v('small') })
    expect(small).toBeGreaterThan(0)
    expect(llmCost({ ...base, 'ai.model_tier': v('frontier') })).toBeCloseTo(15 * small)
  })

  it('bills the token mix: more input tokens per call raise the model cost', () => {
    const base = scenario('rag-assistant-azure')
    expect(llmCost({ ...base, 'ai.tokens_in': v(8_000) })).toBeGreaterThan(llmCost({ ...base, 'ai.tokens_in': v(4_000) }))
  })

  it('runs an air-gapped design on its own GPUs, with no hosted model API', () => {
    const e = design(scenario('airgapped-extraction-onprem'))
    expect(ids(e)).toContain('llm-serving')
    expect(ids(e)).not.toContain('llm-api')
    expect(e.findings.map((x) => x.rule.id)).not.toContain('hosted-llm-residency')
    // GPU nodes come in one size, so each costs the full node price (on premises through the provider price factor), and output tokens add nodes.
    const gpu = component(e, 'llm-serving')!
    expect(gpu.unitCost).toBeCloseTo(600 * kb.reference.providerPriceFactor.onprem)
    // Extraction calls the model once per changed page, so a larger corpus adds nodes and more users do not.
    const busy = component(design({ ...scenario('airgapped-extraction-onprem'), 'ai.corpus_gb': v(5_000), 'ai.tokens_out': v(4_000) }), 'llm-serving')!
    expect(busy.replicas).toBeGreaterThan(gpu.replicas)
    expect(component(design({ ...scenario('airgapped-extraction-onprem'), 'traffic.dau': v(200_000) }), 'llm-serving')!.replicas).toBe(gpu.replicas)
  })

  it('flags agents that write with basic guardrails and no human in the loop', () => {
    const unguarded = design({ ...scenario('agent-support-copilot-aws'), 'ai.guardrails': v('basic'), 'ai.human_in_loop': v('none') })
    expect(unguarded.findings.map((x) => x.rule.id)).toContain('ai-agent-writes-unguarded')
    const guarded = design(scenario('agent-support-copilot-aws'))
    expect(guarded.findings.map((x) => x.rule.id)).not.toContain('ai-agent-writes-unguarded')
    expect(ids(guarded)).toEqual(expect.arrayContaining(['agent-runtime', 'tool-gateway', 'llm-gateway', 'guardrails']))
  })

  it('names the Azure AI platform and managed vector search for the Azure RAG assistant', () => {
    const e = design({ ...scenario('rag-assistant-azure'), 'ai.vector_store': v('managed') })
    expect(component(e, 'llm-api')!.tech).toBe('Azure OpenAI in AI Foundry')
    expect(component(e, 'vector-db')!.tech).toBe('Azure AI Search vectors')
  })

  it('embeds the corpus once and its changes every month', () => {
    const base = scenario('rag-assistant-azure')
    const small = design({ ...base, 'ai.corpus_gb': v(10) })
    const large = design({ ...base, 'ai.corpus_gb': v(100) })
    expect(large.workload.vectors).toBeCloseTo(10 * small.workload.vectors)
    expect(component(small, 'embeddings-backfill')!.costKind).toBe('one_time')
    expect(large.cost.oneTime).toBeGreaterThan(small.cost.oneTime)
    expect(component(large, 'embeddings')!.monthlyCost).toBeGreaterThan(component(small, 'embeddings')!.monthlyCost)
    expect(component(large, 'doc-ingestion')!.monthlyCost).toBeGreaterThan(component(small, 'doc-ingestion')!.monthlyCost)
    // The one-time embedding stays out of the monthly run cost.
    expect(large.cost.monthly).toBe(large.monthlyCost)
  })

  it('sizes no vectors for extraction alone and keeps corpus embeddings out of a non-PostgreSQL primary', () => {
    const extraction = (gb: number) => design({ ...scenario('airgapped-extraction-onprem'), 'ai.corpus_gb': v(gb) })
    expect(extraction(1_000).workload.vectors).toBe(0)
    expect(extraction(1_000).workload.dbStorageGb).toBeCloseTo(extraction(1).workload.dbStorageGb)
    const mongo = (gb: number) => design({ ...scenario('rag-assistant-azure'), 'data.primary_db': v('mongodb'), 'ai.vector_store': v('pgvector'), 'ai.corpus_gb': v(gb) })
    expect(mongo(1_000).workload.vectors).toBeGreaterThan(mongo(1).workload.vectors)
    expect(mongo(1_000).workload.dbStorageGb).toBeCloseTo(mongo(1).workload.dbStorageGb)
  })

  it('keeps the vendor API open while the data policy is pending', () => {
    const facts: Facts = { 'ml.serving': 'llm_api', 'team.size': 'tiny', 'infra.cloud': 'aws' }
    expect(recommend(question('ai.model_hosting'), facts).optionId).toBe('direct_api')
    expect(recommend(question('ai.model_hosting'), { ...facts, 'ai.data_policy': 'cloud_tenant_only' }).optionId).toBe('cloud_managed')
  })

  it('parses and embeds documents while the capabilities are pending, as the vector store does', () => {
    const e = evaluate(kb, { ...scenario('ai-assistant'), 'ml.serving': v('llm_api') })
    expect(value(e, 'ai.capabilities')).toBeUndefined()
    expect(ids(e)).toEqual(expect.arrayContaining(['vector-db', 'doc-ingestion', 'embeddings']))
  })

  it('warns about missing evals and long prompts in an AI product', () => {
    const e = design({ ...scenario('rag-assistant-azure'), 'ai.evaluation': v('none'), 'ai.tokens_in': v(20_000) })
    expect(e.findings.map((x) => x.rule.id)).toEqual(expect.arrayContaining(['ai-no-eval', 'ai-long-context-cost']))
    expect(ids(e)).not.toContain('eval-tracing')
  })
})

describe('cost and compare', () => {
  const pick = (value: string) => ({ kind: 'value' as const, value })

  it('compares every provider as a completed design', () => {
    const results = compareOver(kb, scenario('ecommerce'), 'infra.cloud')
    expect(results.map((r) => r.option.id)).toEqual(['aws', 'gcp', 'azure', 'onprem'])
    expect(results.every((r) => r.feasible && r.evaluation.architecture.components.length > 0)).toBe(true)
    expect(results.filter((r) => r.recommended).map((r) => r.option.id)).toEqual(['aws'])
    const total = (id: string) => runAndPeople(results.find((r) => r.option.id === id)!.evaluation)
    expect(total('onprem')).not.toBeCloseTo(total('aws'), 0)
    // Each column is the same design as answering the provider and accepting the rest.
    expect(total('azure')).toBeCloseTo(runAndPeople(design({ ...scenario('ecommerce'), 'infra.cloud': pick('azure') })))
  })

  it('prices the managed database and load balancer per cloud, and calls near-equal totals a tie', () => {
    const results = compareOver(kb, scenario('ecommerce'), 'infra.cloud')
    const unit = (provider: string, id: string) => component(results.find((r) => r.option.id === provider)!.evaluation, id)!.listPrice
    expect(unit('aws', 'db-primary')).toBe(500)
    expect(unit('gcp', 'db-primary')).toBeLessThan(unit('azure', 'db-primary'))
    expect(unit('azure', 'db-primary')).toBeLessThan(unit('aws', 'db-primary'))
    expect(unit('gcp', 'db-replica')).toBeLessThan(unit('aws', 'db-replica'))
    expect(unit('azure', 'lb')).toBeGreaterThan(unit('aws', 'lb') * 5)
    const totals = new Set(results.filter((r) => r.option.id !== 'onprem').map((r) => Math.round(runAndPeople(r.evaluation))))
    expect(totals.size).toBe(3)
    // A gap under 2% is no basis for 'Cheapest'.
    const [aws, gcp] = results
    const priced = (r: (typeof results)[number], total: number) => ({ ...r, evaluation: { ...r.evaluation, monthlyCost: total, cost: { ...r.evaluation.cost, people: 0 } } })
    expect(cheapestOption([priced(aws, 1_000), priced(gcp, 1_015)])).toBeNull()
    expect(cheapestOption([priced(aws, 1_000), priced(gcp, 1_100)])).toBe('aws')
    expect(cheapestOption([priced(aws, 1_000), { ...priced(gcp, 900), feasible: false }])).toBe('aws')
  })

  it('names provider services and prices an option that rules out an answered decision with that answer back at its recommendation', () => {
    const answers = { ...scenario('fabric-bi-azure'), 'data.platform': pick('fabric'), 'data.platform_location': pick('same_as_app') }
    const results = compareOver(kb, answers, 'infra.cloud')
    const azure = results.find((r) => r.option.id === 'azure')!
    expect(azure.recommended).toBe(true)
    expect(azure.resets).toEqual([])
    expect(component(azure.evaluation, 'bi')!.tech).toBe('Power BI')
    expect(component(azure.evaluation, 'observability')!.tech).toBe('Azure Monitor + Log Analytics')
    // Fabric does not run on own hardware, so the on-premises column re-decides the platform instead of showing a broken design.
    const onprem = results.find((r) => r.option.id === 'onprem')!
    expect(onprem.resets).toContain('data.platform')
    expect(onprem.feasible).toBe(true)
    expect(value(onprem.evaluation, 'data.platform')).not.toBe('fabric')
  })

  it('keeps the alternatives feasible once the follow-ups are answered at their recommendation', () => {
    // The guided walk: Fabric on Azure, then the recommended ingestion (Fabric Mirroring) and table format (Delta) clicked as answers.
    const walked: Answers = {
      'project.kind': pick('data_platform'),
      'infra.cloud': pick('azure'),
      'org.existing_platforms': { kind: 'value', value: ['m365'] },
      'data.platform': pick('fabric'),
      'data.ingestion': pick('zero_etl'),
      'data.table_format': pick('delta'),
      'data.history_tb': { kind: 'value', value: 120 },
    }
    const assumed: Answers = { ...walked, 'data.ingestion': { kind: 'unknown' }, 'data.table_format': { kind: 'unknown' } }
    const feasible = (a: Answers) => compareOver(kb, a, 'data.platform').filter((r) => r.feasible).map((r) => r.option.id)
    expect(feasible(walked)).toEqual(feasible(assumed))
    for (const id of ['databricks', 'snowflake', 'oss_lakehouse']) expect(feasible(walked), id).toContain(id)
    const databricks = compareOver(kb, walked, 'data.platform').find((r) => r.option.id === 'databricks')!
    expect(databricks.resets).toContain('data.ingestion')
    expect(databricks.evaluation.findings.filter((x) => x.rule.severity === 'error')).toEqual([])
    // 'Cheapest' is chosen over the re-resolved designs, so it is no longer the only platform left feasible.
    expect(cheapestOption(compareOver(kb, walked, 'data.platform'))).not.toBe('fabric')
    // Applying the column (the option plus its resets, one change) gives the design the column priced.
    const applied = evaluate(kb, autoComplete(kb, { ...walked, ...optionChange('data.platform', 'databricks', databricks.resets) }))
    expect(runAndPeople(applied)).toBeCloseTo(runAndPeople(databricks.evaluation))
    // The platform switch is a cost lever again, with the same resets.
    const lever = costLevers(kb, walked).find((l) => l.question.id === 'data.platform')!
    expect(lever).toBeDefined()
    expect(lever.resets).toContain('data.ingestion')
    // On a web app, compute clicked at its recommendation no longer rules out own hardware.
    const web = { ...autoComplete(kb, scenario('ecommerce')), 'infra.compute': pick('managed_containers') }
    const onprem = compareOver(kb, web, 'infra.cloud').find((r) => r.option.id === 'onprem')!
    expect(onprem.feasible).toBe(true)
    expect(onprem.resets).toEqual(['infra.compute'])
  })

  it('lists the cheapest feasible switch per answered decision, largest saving first', () => {
    const answers = { ...autoComplete(kb, scenario('video-streaming')), 'perf.cdn': pick('pull') }
    const levers = costLevers(kb, answers)
    expect(levers[0].question.id).toBe('perf.cdn')
    expect([levers[0].from.id, levers[0].to.id]).toEqual(['pull', 'push'])
    expect(levers.every((l, i) => l.delta < 0 && (i === 0 || levers[i - 1].delta <= l.delta))).toBe(true)
    const base = evaluate(kb, answers)
    expect(levers[0].delta).toBeCloseTo(runAndPeople(levers[0].evaluation) - runAndPeople(base))
    // Only answered decisions count: a bare scenario has none.
    expect(costLevers(kb, scenario('video-streaming'))).toEqual([])
  })

  it('prices each lever as the completed design compareOver shows for that option', () => {
    for (const id of ['chat-app', 'rag-assistant-azure']) {
      const answers = autoComplete(kb, scenario(id))
      const levers = costLevers(kb, answers)
      expect(levers.length, id).toBeGreaterThan(0)
      for (const l of levers) {
        const shown = compareOver(kb, answers, l.question.id).find((r) => r.option.id === l.to.id)!
        expect(runAndPeople(l.evaluation), `${id} ${l.question.id}`).toBeCloseTo(runAndPeople(shown.evaluation))
        expect(l.evaluation.questions.some((s) => s.active && s.status === 'pending'), `${id} ${l.question.id}`).toBe(false)
      }
    }
  })

  it('reports the list price a unit-price override replaces', () => {
    const answers = autoComplete(kb, scenario('ecommerce'))
    const fleet = evaluate(kb, answers).architecture.components.find((c) => c.instanceClass !== null && c.listPrice > 0 && !c.storageCost)!
    const id = fleet.def.id
    const priced = component(evaluate(withOverrides(kb, { unitPrice: { [fleet.priceKey]: fleet.listPrice * 2 } }), answers), id)!
    expect(priced.listPrice).toBe(fleet.listPrice * 2)
    expect(priced.monthlyCost).toBeCloseTo(fleet.monthlyCost * 2)
    // A second region's cost follows the stack it copies, so it has no unit price to override.
    const regions = design({ ...scenario('ecommerce'), 'reliability.multi_region': pick('active_active') })
    expect(component(regions, 'peer-region')!.listPrice).toBe(0)
  })
})

describe('navigation and safety', () => {
  const question = (id: string) => kb.questions.find((q) => q.id === id)!

  it('explains why a question is asked with question titles and option labels', () => {
    const chat = evaluate(kb, { 'product.type': { kind: 'value', value: 'social' }, 'product.features': { kind: 'value', value: ['accounts', 'chat'] } })
    expect(chat.questions.find((s) => s.question.id === 'perf.realtime')!.active).toBe(true)
    const lines = explainCondition(question('perf.realtime').askWhen, chat.facts, kb)
    const chatLabel = question('product.features').options!.find((o) => o.id === 'chat')!.label
    expect(lines).toContainEqual(`Core capabilities includes ${chatLabel}`)
    // Leaves that do not hold (collaboration, live tracking) are not reasons.
    expect(lines.join(' ')).not.toMatch(/Collaborative/)
    // A threshold names the measured value and the bound.
    const busy = evaluate(kb, autoComplete(kb, scenario('social-network')))
    expect(explainCondition(f.gt('cap.peakQps', 2_000), busy.facts, kb)[0]).toMatch(/^peak load is [\d.]+[kM] req\/s, above 2\.0k req\/s$/)
    // Two bounds on one fact keep the tighter, and 'is set' drops beside another line on the same fact.
    expect(explainCondition(f.any(f.gt('cap.peakQps', 200), f.gt('cap.peakQps', 2_000)), busy.facts, kb)).toEqual([explainCondition(f.gt('cap.peakQps', 2_000), busy.facts, kb)[0]])
    expect(explainCondition(f.all(f.exists('traffic.dau'), f.gt('traffic.dau', 1)), busy.facts, kb)).toHaveLength(1)
    // Negated, it says why a question is off.
    expect(explainCondition(f.not(question('perf.realtime').askWhen!), evaluate(kb, {}).facts, kb).join(' ')).toMatch(/does not include/)
  })

  it('says an answered question that turned inactive no longer applies, and gives only the positive reasons a question is asked', () => {
    // The kind switched from a data platform to an app: the answered platform is kept but inactive, so it emits no fact.
    const answers: Answers = { 'project.kind': { kind: 'value', value: 'transactional_app' }, 'data.platform': { kind: 'value', value: 'fabric' }, 'infra.cloud': { kind: 'value', value: 'azure' } }
    const facts = evaluate(kb, answers).facts
    const off = f.not(question('data.ingestion').askWhen!)
    expect(explainCondition(off, facts, kb, { answers })).toEqual([`${question('data.platform').title} no longer applies`])
    expect(explainCondition(off, facts, kb).join(' ')).not.toMatch(/not decided yet/)
    const migration = evaluate(kb, autoComplete(kb, scenario('oracle-orders-to-aws'))).facts
    const asked = explainCondition(question('migration.link').askWhen, migration, kb, { positiveOnly: true })
    expect(asked).toContain('the project moves an existing system')
    expect(asked.join(' ')).not.toMatch(/does not include| is not /)
    // Without the option the negated clauses still explain why a question is off.
    expect(explainCondition(question('migration.link').askWhen, migration, kb).join(' ')).toMatch(/does not include/)
  })

  it('says an inactive question that sets a fact no longer applies, not that it is not decided yet', () => {
    // A url shortener turned into a data platform: the answered read:write ratio and latency target are off, so they set no fact.
    const answers: Answers = { ...autoComplete(kb, scenario('url-shortener')), 'project.kind': { kind: 'value', value: 'data_platform' } }
    const lines = explainCondition(f.not(question('perf.cache').askWhen!), evaluate(kb, answers).facts, kb, { answers }).join(' ')
    expect(lines).not.toMatch(/Read:write ratio is not decided yet|Latency target is not decided yet/)
  })

  it('names the value a design has when an in-set condition holds, and the set only when it does not', () => {
    const facts = evaluate(kb, autoComplete(kb, scenario('onprem-iceberg-lakehouse'))).facts
    expect(facts['data.platform']).toBe('oss_lakehouse')
    const label = (id: string) => question('data.platform').options!.find((o) => o.id === id)!.label
    expect(explainCondition(f.in('data.platform', ['fabric', 'databricks', 'oss_lakehouse']), facts, kb)).toEqual([`${question('data.platform').title} is ${label('oss_lakehouse')}`])
    expect(explainCondition(f.not(f.in('data.platform', ['fabric', 'databricks'])), facts, kb)).toEqual([`${question('data.platform').title} is not ${label('fabric')} or ${label('databricks')}`])
  })

  it('maps a finding to the questions that resolve it', () => {
    const targets = (id: string) => questionsForRule(kb.validations.find((r) => r.id === id)!, kb)
    expect(targets('over-budget')).toContain('infra.budget')
    // Facts evaluate() computes map back to their inputs: the availability target, the questions that add a component, those that size a cost kind.
    expect(targets('availability-gap').slice(0, 2)).toEqual(['reliability.availability', 'reliability.multi_region'])
    expect(targets('queue-idempotent')).toContain('arch.async')
    expect(targets('egress-dominates')[0]).toBe('perf.cdn')
    expect(targets('license-dominates')).toContain('source.crm_users')
    // Every rule has a route to an answer, except the one on pinned instance counts, which the cost panel sets.
    expect(kb.validations.filter((r) => targets(r.id).length === 0).map((r) => r.id)).toEqual(['pinned-replicas-overloaded'])
  })

  it('ranks the assumptions that move the design most first', () => {
    const answers: Answers = { ...scenario('social-network'), 'traffic.dau': { kind: 'unknown' }, 'data.object_kb': { kind: 'unknown' } }
    const impacts = assumptionSensitivity(kb, answers)
    const rank = (id: string) => impacts.findIndex((i) => i.question.id === id)
    expect(rank('traffic.dau')).toBeGreaterThanOrEqual(0)
    expect(rank('traffic.dau')).toBeLessThan(rank('data.object_kb'))
    const dau = impacts[rank('traffic.dau')]
    expect(dau.maxCost).toBeGreaterThan(dau.minCost)
    // Memoized on the answers object.
    expect(assumptionSensitivity(kb, answers)).toBe(impacts)
  })

  it('tries the presets of a number assumed at 0, so no existing data still shows its cost spread', () => {
    const impacts = assumptionSensitivity(kb, { ...scenario('fabric-bi-azure'), 'data.history_tb': { kind: 'unknown' } })
    const history = impacts.find((i) => i.question.id === 'data.history_tb')!
    expect(history.value).toBe(0)
    expect(history.maxCost - history.minCost).toBeGreaterThan(100)
    expect(impacts.indexOf(history)).toBeLessThan(impacts.filter((i) => i.maxCost - i.minCost >= 1).length)
  })
})

describe('data platform guidance', () => {
  const v = (x: number | string) => ({ kind: 'value' as const, value: x })
  const infeasible = (e: Evaluation) => e.findings.find((x) => x.rule.id === 'infeasible-data.platform')?.rule.message ?? ''

  it('points SaaS platforms on own hardware to the open lakehouse when residency hides the hybrid choice', () => {
    for (const [residency, platform] of [['onprem_required', 'fabric'], ['sovereign', 'fabric'], ['air_gapped', 'snowflake']]) {
      const e = design({ ...scenario('onprem-iceberg-lakehouse'), 'security.residency': v(residency), 'data.platform': v(platform) })
      expect(e.facts['data.platform_location'], residency).toBeUndefined()
      expect(infeasible(e), residency).toMatch(/open lakehouse \(Iceberg or Delta\)/)
    }
  })

  it('shows no raw fact ids in question help', () => {
    for (const q of kb.questions) expect(q.help ?? '', q.id).not.toMatch(/\b[a-z]+\.[a-z_]+ = /)
  })

  it('bills Azure Data Factory, Data Transfer Service and self-hosted Airbyte in their own units', () => {
    const azure = design({ ...scenario('web-crawler'), 'infra.cloud': v('azure'), 'data.platform': v('snowflake') })
    expect([component(azure, 'ingestion')!.tech, component(azure, 'ingestion')!.sizingNote]).toEqual(['Azure Data Factory', expect.stringMatching(/DIU-hours/)])
    expect(component(azure, 'orchestrator')!.tech).toBe('Azure Data Factory pipelines')
    expect(component(azure, 'orchestrator')!.sizingNote).toMatch(/activity runs/)
    expect(component(azure, 'orchestrator')!.monthlyCost).toBeLessThan(50)
    const gcp = design({ ...scenario('web-crawler'), 'infra.cloud': v('gcp'), 'data.platform': v('native') })
    expect([component(gcp, 'ingestion')!.tech, component(gcp, 'ingestion')!.monthlyCost]).toEqual(['BigQuery Data Transfer Service', 0])
    const onprem = design({ ...scenario('web-crawler'), 'infra.cloud': v('onprem'), 'data.platform': v('oss_lakehouse') })
    expect(component(onprem, 'ingestion')!.tech).toBe('Airbyte on Kubernetes')
    expect(component(onprem, 'ingestion')!.sizingNote).not.toMatch(/DPU/)
  })

  it('names the F64 multiple and drops the Pro seat clause at F64 and above', () => {
    // Pinned: past one F64 the platform recommendation itself turns away from Fabric.
    const at = (tb: number) => component(design({ ...scenario('fabric-bi-azure'), 'data.platform': v('fabric'), 'data.history_tb': v(tb) }), 'warehouse')!
    const large = at(100)
    expect(large.monthlyCost).toBeCloseTo(3 * 8_409.6)
    expect(large.sizingNote).toMatch(/^3 x F64: /)
    expect(large.sizingNote).not.toMatch(/below F64/)
    expect(at(1).sizingNote).toMatch(/below F64 every viewer needs a Power BI Pro seat/)
  })

  it('describes the pending BI line by the tools that would price it', () => {
    expect(kb.components.find((c) => c.id === 'bi')!.sizing).toMatchObject({ note: expect.stringMatching(/Power BI Pro \$14/) })
  })

  it('adds the transfer line exactly when the cross-cloud warning fires', () => {
    expect(kb.components.find((c) => c.id === 'platform-egress')!.when).toBe(crossCloudPlatform)
    expect(kb.validations.find((r) => r.id === 'cross-cloud-platform')!.when).toBe(crossCloudPlatform)
  })

  it('offers data levers instead of traffic levers on a data platform', () => {
    const labels = (answers: Answers) => whatIfLevers(kb, answers).map((l) => l.label)
    // Once the platform is decided (auto-design), the data levers appear; traffic levers and a move to the current cloud never do.
    const platform = labels(autoComplete(kb, scenario('fabric-bi-azure')))
    expect(platform).toEqual(expect.arrayContaining(['Existing data x10', 'Move to on-prem']))
    for (const inert of ['Traffic x10', 'Global users', 'Spiky traffic', 'Data x10', 'Retention 7 years', 'Move to Azure']) expect(platform).not.toContain(inert)
    expect(labels(scenario('url-shortener'))).toContain('Traffic x10')
    // Every lever shown changes the design on the path the preview takes: evaluate(answers + lever) against evaluate(answers),
    // for freshly opened scenarios and auto-designed ones alike.
    for (const answers of ['fabric-bi-azure', 'onprem-iceberg-lakehouse', 'url-shortener'].flatMap((id) => [scenario(id), autoComplete(kb, scenario(id))])) {
      const base = evaluate(kb, answers)
      for (const l of whatIfLevers(kb, answers)) {
        const d = diffEvaluations(base, evaluate(kb, { ...answers, ...l.overrides }))
        const moved = Math.abs(d.costDelta) >= 0.5 || d.added.length + d.removed.length + d.rescaled.length + d.retech.length + d.findingsAdded.length + d.findingsResolved.length > 0
        expect(moved, l.label).toBe(true)
      }
    }
  })
})

describe('task add-ons and AI pricing (review findings)', () => {
  const v = (x: unknown) => ({ kind: 'value' as const, value: x as string })
  const app = (extra: Answers = {}) => design({ 'project.kind': v('transactional_app'), 'infra.cloud': v('aws'), ...extra })
  const active = (e: Evaluation, id: string) => e.questions.find((q) => q.question.id === id)?.active ?? false

  it('gives the integration add-on its questions, a priced hub and the connected systems', () => {
    const base = app()
    const integration = app({ 'project.addons': v(['integration']) })
    for (const id of ['integration.systems', 'integration.direction', 'integration.approach']) {
      expect(active(base, id), id).toBe(false)
      expect(active(integration, id), id).toBe(true)
    }
    expect(ids(integration)).toEqual(expect.arrayContaining(['integration-hub', 'connected-systems']))
    expect(integration.monthlyCost).toBeGreaterThan(base.monthlyCost)
    // Many systems synced both ways recommend an iPaaS; AppFlow bills flow runs for each connected system.
    const many = app({ 'project.addons': v(['integration']), 'integration.systems': v(12), 'integration.direction': v('two_way') })
    expect(value(many, 'integration.approach')).toBe('ipaas')
    expect(component(many, 'integration-hub')!.units).toBe(12 * 5_840)
    expect(component(many, 'integration-hub')!.monthlyCost).toBeCloseTo(12 * 5_840 * 0.001)
  })

  it('gives the event-ingestion add-on its questions and an event stream sized by rate and replay window', () => {
    const base = app()
    const events = app({ 'project.addons': v(['event_ingest']) })
    for (const id of ['events.rate', 'events.payload_kb', 'events.retention_days']) expect(active(events, id), id).toBe(true)
    expect(ids(base)).not.toContain('stream')
    expect(ids(events)).toEqual(expect.arrayContaining(['stream', 'stream-processor']))
    expect(events.architecture.edges.some((x) => x.from === 'client' && x.to === 'stream')).toBe(true)
    const heavy = app({ 'project.addons': v(['event_ingest']), 'events.rate': v(50_000), 'events.retention_days': v(30) })
    expect(component(heavy, 'stream')!.replicas).toBeGreaterThan(component(events, 'stream')!.replicas)
    expect(heavy.monthlyCost).toBeGreaterThan(events.monthlyCost)
  })

  it('prices the vector store by the vectors it holds', () => {
    const rag = scenario('rag-assistant-azure')
    const small = component(design(rag), 'vector-db')!
    const large = component(design({ ...rag, 'ai.corpus_gb': v(1_200) }), 'vector-db')!
    expect(small.tech).toBe('Azure AI Search vectors')
    expect(large.monthlyCost).toBeGreaterThan(small.monthlyCost * 5)
    // OpenSearch Serverless bills at least 2 OCUs even for a tiny index.
    const tiny = component(design({ ...scenario('ai-assistant'), 'ai.vector_store': v('managed'), 'traffic.dau': v(10) }), 'vector-db')!
    expect(tiny.units).toBeGreaterThanOrEqual(2)
  })

  it('keeps the gateway, guardrails, agents and parsing inside when the model is self-hosted or nothing may leave', () => {
    const agent = { 'project.kind': v('ai_app'), 'infra.cloud': v('aws'), 'ai.capabilities': v(['rag_documents', 'agent_actions']) }
    const selfHosted = design({ ...agent, 'ai.model_hosting': v('self_hosted_open') })
    expect(component(selfHosted, 'llm-gateway')!.tech).toBe('LiteLLM proxy (vLLM routing)')
    expect(component(selfHosted, 'guardrails')!.tech).toBe('Llama Guard on the GPU nodes')
    expect(component(selfHosted, 'agent-runtime')!.tech).toBe('LangGraph on EKS')
    expect(component(selfHosted, 'doc-ingestion')!.tech).toBe('Unstructured / Apache Tika workers')
    const noExternal = design({ 'project.kind': v('ai_app'), 'infra.cloud': v('gcp'), 'ai.data_policy': v('no_external') })
    for (const c of noExternal.architecture.components) expect(c.tech, c.def.id).not.toMatch(/Document AI|Vertex|Bedrock|Textract/)
  })

  it('drops the cloud-fallback gateway for a self-hosted model without agents', () => {
    const e = design({ 'project.kind': v('ai_app'), 'infra.cloud': v('aws'), 'ai.model_hosting': v('self_hosted_open'), 'ai.capabilities': v(['assistant_chat', 'rag_documents']) })
    expect(ids(e)).toContain('llm-serving')
    expect(ids(e)).not.toContain('llm-gateway')
    expect(ids(e)).not.toContain('llm-api')
  })

  it('prices the first OCR pass over the existing corpus as a one-off line', () => {
    const e = design(scenario('rag-assistant-azure'))
    const backfill = component(e, 'doc-ingestion-backfill')!
    expect(backfill.costKind).toBe('one_time')
    // 12 GB of parsed text at about 3 KB a page is 4M pages, at $1.50 per 1,000 pages.
    expect(backfill.monthlyCost).toBeCloseTo(6_000, -2)
  })

  it('recommends a mid-tier model for agents', () => {
    expect(value(design({ 'project.kind': v('ai_app'), 'ai.capabilities': v(['agent_actions']) }), 'ai.model_tier')).toBe('mid')
    expect(value(design({ 'project.kind': v('ai_app'), 'ai.capabilities': v(['assistant_chat']) }), 'ai.model_tier')).toBe('small')
  })
})

describe('cost model and task guidance (review round)', () => {
  const v = (x: unknown) => ({ kind: 'value' as const, value: x as string })
  const on = (answers: Answers, cloud: string) => design({ ...answers, 'infra.cloud': v(cloud) })
  const fte = kb.reference.opsFteMonthlyUsd

  it('grows platform staff with the estate the team runs, not a flat headcount per platform', () => {
    const small = on(scenario('internal-tool'), 'onprem')
    const large = on(scenario('social-network'), 'onprem')
    // The base: half an FTE for the hardware plus the Kubernetes platform a cloud cluster needs too.
    expect(small.cost.people).toBeLessThanOrEqual(1.5 * fte)
    expect(large.cost.people).toBeGreaterThan(10 * small.cost.people)
    expect(large.cost.people).toBeLessThanOrEqual(kb.reference.opsFteMax * fte)
    // Cloud clusters add a share per node the team patches; managed containers leave the nodes to the provider.
    const k8s = on({ ...scenario('social-network'), 'ops.environments': v('prod_only') }, 'aws')
    expect(k8s.cost.people).toBeGreaterThan(1.25 * fte)
    expect(component(k8s, 'platform-ops')!.tech).toMatch(/about [\d.]+ FTE/)
    // Own edge cache servers are hardware to run on any provider.
    expect(on(scenario('video-streaming'), 'aws').cost.people).toBeGreaterThan(5 * fte)
    // Staging and dev run more nodes.
    const chat = (environments: string) => on({ ...scenario('chat-app'), 'infra.compute': v('kubernetes'), 'ops.environments': v(environments) }, 'aws').cost.people
    expect(chat('prod_staging_dev')).toBeGreaterThan(chat('prod_only'))
  })

  it('counts workers and WebSocket servers on the cluster, staffs own hardware at least like a cloud cluster, and lets nodes win at scale', () => {
    const at = (id: string, cloud: string, compute: string) => on({ ...scenario(id), 'infra.compute': v(compute) }, cloud)
    // Workers and WebSocket servers run on the team's own cluster, so they add staff beyond the 1 FTE base.
    const chat = at('chat-app', 'aws', 'kubernetes')
    expect(chat.cost.people).toBeGreaterThan(1.5 * fte)
    expect(component(chat, 'platform-ops')!.sizingNote).toMatch(/cluster node/)
    // Racks and network come on top of the Kubernetes platform the cloud needs too.
    expect(at('internal-tool', 'onprem', 'kubernetes').cost.people).toBeGreaterThanOrEqual(at('internal-tool', 'aws', 'kubernetes').cost.people)
    // A compute-heavy design at scale pays less on cloud nodes than on managed containers, people included.
    for (const compute of ['kubernetes', 'vms']) expect(runAndPeople(at('chat-app', 'aws', compute)), compute).toBeLessThan(runAndPeople(at('chat-app', 'aws', 'managed_containers')))
    // A small design still pays more for running its own cluster.
    expect(runAndPeople(at('internal-tool', 'aws', 'kubernetes'))).toBeGreaterThan(runAndPeople(at('internal-tool', 'aws', 'managed_containers')))
  })

  it('keeps the license of a commercial engine at full price on own hardware', () => {
    const answers = { ...scenario('oracle-orders-to-aws'), 'migration.approach': v('replatform') }
    const aws = component(on(answers, 'aws'), 'db-primary')!
    const onprem = component(on(answers, 'onprem'), 'db-primary')!
    expect(aws.costKind).toBe('license')
    // $2,000 license-included: $500 of hardware at the 0.6 factor, $1,500 of license at full price.
    expect(onprem.unitCost / aws.unitCost).toBeCloseTo((500 * kb.reference.providerPriceFactor.onprem + 1_500) / 2_000)
    expect(onprem.tech).not.toMatch(/RAC/)
  })

  it('sizes ClickHouse on compressed data and bills ClickHouse Cloud compute hours plus storage', () => {
    const fabric = { ...scenario('fabric-bi-azure'), 'data.history_tb': v(20) }
    const total = (e: Evaluation) => (component(e, 'warehouse')?.monthlyCost ?? 0) + (component(e, 'lake-storage')?.monthlyCost ?? 0)
    const clickhouse = design({ ...fabric, 'data.platform': v('olap_db') })
    const snowflake = design({ ...fabric, 'data.platform': v('snowflake') })
    expect(component(clickhouse, 'warehouse')!.sizingNote).toMatch(/compute unit-hours/)
    expect(component(clickhouse, 'lake-storage')!.tech).toBe('ClickHouse Cloud storage')
    expect(total(clickhouse)).toBeLessThan(2 * total(snowflake))
    const cluster = design({ ...scenario('onprem-iceberg-lakehouse'), 'data.platform': v('olap_db') })
    const lake = cluster.workload.lakeStorageTb
    // Two replicas of 7x-compressed columns at about 4 TB a node, at the target utilization.
    expect(component(cluster, 'warehouse')!.replicas).toBe(Math.max(2, Math.ceil((lake * 2) / 7 / (4 * kb.reference.targetUtilization))))
    expect(ids(cluster)).not.toContain('lake-storage')
  })

  it('sizes model calls from AI usage, not the database read:write ratio', () => {
    const app = { 'project.kind': v('ai_app'), 'traffic.dau': v(10_000) }
    const llm = (answers: Answers) => design(answers).workload.llmCallsMonth
    expect(llm({ ...app, 'traffic.read_write': v('balanced') })).toBeCloseTo(llm({ ...app, 'traffic.read_write': v('read_heavy') }))
    expect(llm({ ...app, 'ai.messages_per_user': v(10) })).toBeCloseTo(2 * llm({ ...app, 'ai.messages_per_user': v(5) }))
    // A SaaS app with the AI add-on and the same users and messages costs the same model bill as an AI app.
    const saas = component(design({ 'project.kind': v('transactional_app'), 'project.addons': v(['ai']), 'traffic.dau': v(10_000), 'infra.cloud': v('aws') }), 'llm-api')!
    expect(saas.monthlyCost).toBeCloseTo(component(design({ ...app, 'infra.cloud': v('aws') }), 'llm-api')!.monthlyCost)
    // Extraction calls the model once per changed page it parses.
    const extraction = design({ ...app, 'ai.capabilities': v(['extraction_batch']), 'ai.corpus_gb': v(50) })
    expect(extraction.workload.llmCallsMonth).toBeCloseTo(component(extraction, 'doc-ingestion')!.units * 1_000, -4)
    // Each runtime's flow to the model carries the calls it makes: extraction its pages, agents every reasoning step.
    const month = 86_400 * (365 / 12)
    const toModel = (e: Evaluation, from: string) => e.architecture.edges.filter((x) => x.from === from && ['llm-gateway', 'llm-serving', 'llm-api'].includes(x.to)).reduce((t, x) => t + x.qps, 0)
    expect(toModel(extraction, 'doc-ingestion')).toBeCloseTo(extraction.workload.llmCallsMonth / month)
    const chat = design({ ...app, 'ai.capabilities': v(['assistant_chat']) })
    const agents = design({ ...app, 'ai.capabilities': v(['assistant_chat', 'agent_actions']) })
    expect(agents.workload.llmCallsMonth).toBeCloseTo(chat.workload.llmCallsMonth * kb.reference.agentStepsPerTask)
    expect(component(agents, 'llm-api')!.monthlyCost).toBeGreaterThan(5 * component(chat, 'llm-api')!.monthlyCost)
    expect(toModel(agents, 'agent-runtime')).toBeCloseTo(agents.workload.peakLlmQps)
    expect(toModel(agents, 'agent-runtime')).toBeGreaterThan(0)
    expect(agents.architecture.edges.find((x) => x.to === 'agent-runtime')!.qps).toBeCloseTo(agents.workload.peakLlmQps / kb.reference.agentStepsPerTask)
    expect(toModel(chat, 'app')).toBeCloseTo(chat.workload.peakLlmQps)
    // A data platform bills the rows its SQL AI functions enrich.
    const platform = design({ 'project.kind': v('data_platform'), 'project.addons': v(['ai']), 'ai.rows_month': v(2_000_000) })
    expect(platform.workload.llmCallsMonth).toBe(2_000_000)
    expect(component(platform, 'llm-api')!.monthlyCost).toBeGreaterThan(500)
  })

  it('keeps the CRM data in the new platform when the CRM is rebuilt as an analytical or AI app', () => {
    const crm = { 'project.origin': v('replace_legacy_app'), 'source.kinds': v(['crm']), 'source.crm_product': v('custom'), 'source.volume_gb': v(300) }
    for (const kind of ['data_platform', 'ai_app']) {
      const e = design({ ...crm, 'project.kind': v(kind) })
      expect(value(e, 'migration.approach'), kind).not.toBe('repurchase')
      expect(ids(e), kind).not.toContain('crm-target')
    }
    expect(value(design({ ...crm, 'project.kind': v('transactional_app') }), 'migration.approach')).toBe('repurchase')
    // A bought CRM stays a source the platform ingests, so its history still reaches the lake.
    const bought = design({ ...crm, 'project.kind': v('data_platform'), 'migration.approach': v('repurchase') })
    expect(bought.workload.lakeStorageTb).toBeGreaterThan(0.25)
    expect(bought.architecture.edges.some((x) => x.from === 'crm-target' && x.to === 'ingestion')).toBe(true)
  })

  it('gives a data platform its own AI options and builds what they ask for', () => {
    const platform = { 'project.kind': v('data_platform'), 'project.addons': v(['ai']) }
    const e = design(platform)
    expect(value(e, 'ai.capabilities')).toEqual(['sql_ai_functions'])
    expect(e.questions.find((s) => s.question.id === 'ai.guardrails')!.active).toBe(false)
    expect(ids(e)).toEqual(expect.arrayContaining(['llm-api', 'eval-tracing']))
    expect(ids(e)).not.toContain('vector-db')
    // A RAG index over the lake's documents builds parsing, embeddings and a vector store.
    const rag = design({ ...platform, 'ai.capabilities': v(['rag_documents']), 'ai.corpus_gb': v(200) })
    expect(ids(rag)).toEqual(expect.arrayContaining(['vector-db', 'doc-ingestion', 'embeddings']))
    // An assistant needs an application in front, so choosing one on a data platform is a finding.
    const chat = design({ ...platform, 'ai.capabilities': v(['assistant_chat']) })
    expect(chat.findings.map((x) => x.rule.id)).toContain('infeasible-ai.capabilities')
  })

  it('keeps an AI app that retrieves with pgvector on one PostgreSQL database', () => {
    const e = design({ 'project.kind': v('ai_app') })
    expect(value(e, 'data.primary_db')).toBe('postgres')
    expect(value(e, 'ai.vector_store')).toBe('pgvector')
    expect(ids(e)).not.toContain('vector-db')
  })

  it('reads model training from ml.serving, not the AI feature flag', () => {
    const e = design({ 'project.kind': v('ai_app'), 'project.addons': v(['analytics']) })
    expect(value(e, 'ml.serving')).toBe('llm_api')
    expect(value(e, 'data.platform')).toBe('small_sql')
    const lakehouse = design({ 'project.kind': v('ai_app'), 'project.addons': v(['analytics']), 'data.platform': v('databricks') })
    expect(lakehouse.findings.map((x) => x.rule.id)).toContain('lakehouse-small-data')
  })
})

describe('provider and analytics location from existing licences', () => {
  const v = (x: number | string | string[]) => ({ kind: 'value' as const, value: x })
  const platform = (answers: Answers) => design({ 'project.kind': v('data_platform'), 'team.size': v('multi'), 'data.history_tb': v(30), ...answers })

  it('keeps an owned data center ahead of a Microsoft 365 tenant', () => {
    const e = platform({ 'org.existing_platforms': v(['datacenter', 'm365']) })
    expect(value(e, 'infra.cloud')).toBe('onprem')
    const azure = e.questions.find((q) => q.question.id === 'infra.cloud')!.recommendation.scores.find((s) => s.optionId === 'azure')!
    expect(azure.reasons.join(' ')).not.toMatch(/Fabric (are|is) already licensed/)
  })

  it('keeps on-premises analytics on site for a Microsoft 365 tenant, which licenses no Fabric capacity', () => {
    const e = platform({ 'infra.cloud': v('onprem'), 'org.existing_platforms': v(['datacenter', 'm365']) })
    expect(value(e, 'data.platform_location')).toBe('same_as_app')
    expect(value(e, 'data.platform')).toBe('oss_lakehouse')
    const databricks = platform({ 'infra.cloud': v('onprem'), 'org.existing_platforms': v(['datacenter', 'databricks_existing']) })
    expect(value(databricks, 'data.platform_location')).toBe('cloud_analytics_from_onprem')
  })
})

describe('ingestion offers per platform', () => {
  const v = (x: number | string | string[]) => ({ kind: 'value' as const, value: x })
  it('names BigQuery loaders on Google Cloud only for BigQuery', () => {
    for (const [platform, ingestion, tech] of [
      ['snowflake', 'batch', 'Snowpipe (auto-ingest from Cloud Storage)'],
      ['snowflake', 'streaming', 'Snowpipe Streaming'],
      ['olap_db', 'streaming', 'Dataflow streaming from Pub/Sub'],
      ['oss_lakehouse', 'batch', 'Dataproc Serverless (Spark) into Iceberg on Cloud Storage'],
      ['small_sql', 'saas_connectors', 'Fivetran or Airbyte connectors'],
      ['native', 'streaming', 'Pub/Sub subscriptions to BigQuery'],
    ]) {
      const e = design({ ...scenario('gcp-bigquery-marketing'), 'data.platform': v(platform), 'data.ingestion': v(ingestion) })
      const name = component(e, 'ingestion')!.tech
      expect(name, `${platform} ${ingestion}`).toBe(tech)
      if (platform !== 'native') expect(name, platform).not.toMatch(/BigQuery/)
    }
  })

  it('mirrors only databases into Fabric; SaaS, files and mainframes come through connectors or pipelines', () => {
    const saas = design({ 'project.kind': v('data_platform'), 'infra.cloud': v('azure'), 'data.platform': v('fabric'), 'org.existing_platforms': v(['salesforce', 'sap']) })
    // Salesforce and SAP come out through connectors, the main path here, with the databases mirrored on a path of their own.
    expect(value(saas, 'source.kinds')).toEqual(['rdbms', 'saas_api'])
    expect(component(saas, 'ingestion')!.tech).toBe('Fabric Dataflow Gen2 connectors')
    expect(component(saas, 'ingestion-db')!.tech).toBe('Fabric Mirroring')
    const files = design({ 'project.kind': v('data_platform'), 'project.origin': v('migrate_database'), 'infra.cloud': v('azure'), 'data.platform': v('fabric'), 'source.kinds': v(['mainframe', 'files']) })
    const zeroEtl = files.questions.find((q) => q.question.id === 'data.ingestion')!.recommendation.scores.find((s) => s.optionId === 'zero_etl')!
    expect(zeroEtl.feasible).toBe(false)
    expect(component(files, 'ingestion')!.tech).not.toBe('Fabric Mirroring')
    const database = design({ 'project.kind': v('data_platform'), 'project.origin': v('migrate_database'), 'infra.cloud': v('azure'), 'data.platform': v('fabric'), 'source.kinds': v(['rdbms']) })
    expect(database.questions.find((q) => q.question.id === 'data.ingestion')!.recommendation.scores.find((s) => s.optionId === 'zero_etl')!.feasible).toBe(true)
  })
})

describe('cost model and task guidance (review round 3)', () => {
  const v = (x: unknown) => ({ kind: 'value' as const, value: x as string })
  const llmServing = (answers: Answers) => component(design(answers), 'llm-serving')!

  it('sizes self-hosted GPUs on the model class: one L4 for small, 2 or 8 80 GB GPUs per replica above it', () => {
    const self = { ...scenario('onprem-regulated-ai'), 'ai.model_hosting': v('self_hosted_open') }
    const [small, mid, frontier] = ['small', 'mid', 'frontier'].map((tier) => llmServing({ ...self, 'ai.model_tier': v(tier) }))
    expect(small.tech).toMatch(/GPU servers$/)
    expect(mid.tech).toContain('2x 80 GB per replica')
    expect(frontier.tech).toContain('8x 80 GB per replica')
    expect(mid.monthlyCost).toBeGreaterThan(5 * small.monthlyCost)
    expect(frontier.monthlyCost).toBeGreaterThan(3 * mid.monthlyCost)
    // Frontier weights are not released, so own GPUs run the largest open-weight class and say so.
    const e = design({ ...self, 'ai.model_tier': v('frontier') })
    expect(e.findings.map((x) => x.rule.id)).toContain('infeasible-ai.model_tier')
    expect(design({ ...scenario('rag-assistant-azure'), 'ai.model_tier': v('frontier') }).findings.map((x) => x.rule.id)).not.toContain('infeasible-ai.model_tier')
  })

  it('prices ingestion per source on every platform, so a comparison differs only on real prices', () => {
    const base = { ...scenario('fabric-bi-azure'), 'infra.cloud': v('aws'), 'data.ingestion': v('batch') }
    const ingestion = (platform: string, sources: number) => component(design({ ...base, 'data.platform': v(platform), 'data.source_count': { kind: 'value' as const, value: sources } }), 'ingestion')!
    for (const platform of ['native', 'snowflake', 'databricks', 'oss_lakehouse']) {
      expect(ingestion(platform, 20).monthlyCost, platform).toBeGreaterThan(10 * ingestion(platform, 1).monthlyCost)
    }
    // Lakeflow Connect bills DBUs per pipeline instead of the $150-per-source placeholder; Glue bills a job per source.
    expect(ingestion('databricks', 20).monthlyCost / ingestion('snowflake', 20).monthlyCost).toBeGreaterThan(0.8)
    expect(ingestion('databricks', 20).monthlyCost / ingestion('snowflake', 20).monthlyCost).toBeLessThan(1.25)
    expect(ingestion('databricks', 20).monthlyCost).toBeLessThan(20 * 150)
    // SaaS connectors and streams take the same rows on every platform, so Databricks pays what the others pay for them.
    for (const method of ['saas_connectors', 'streaming']) {
      const cost = (platform: string) => component(design({ ...base, 'data.ingestion': v(method), 'data.platform': v(platform), 'data.source_count': { kind: 'value' as const, value: 20 } }), 'ingestion')!
      expect(cost('databricks').tech, method).toBe(cost('snowflake').tech)
      expect(cost('databricks').monthlyCost, method).toBeCloseTo(cost('snowflake').monthlyCost)
    }
    // Google Cloud's batch loaders bill a job per source like Glue, not the $150-per-source placeholder.
    const gcp = (platform: string, sources: number) => component(design({ ...base, 'infra.cloud': v('gcp'), 'bi.tool': v('looker_studio'), 'data.platform': v(platform), 'data.source_count': { kind: 'value' as const, value: sources } }), 'ingestion')!
    for (const platform of ['snowflake', 'oss_lakehouse', 'olap_db']) {
      expect(gcp(platform, 20).monthlyCost, platform).toBeGreaterThan(10 * gcp(platform, 1).monthlyCost)
      expect(gcp(platform, 20).monthlyCost, platform).toBeLessThan(20 * 150 * 0.5)
    }
  })

  it('stages migrations, larger teams and regulated residency by default, and keeps small greenfield designs production-only', () => {
    expect(value(design(scenario('oracle-orders-to-aws')), 'ops.environments')).toBe('prod_staging')
    expect(design(scenario('oracle-orders-to-aws')).cost.byKind.nonprod).toBeGreaterThan(0)
    expect(value(design(scenario('onprem-regulated-ai')), 'ops.environments')).toBe('prod_staging')
    expect(value(design({ ...scenario('internal-tool'), 'team.size': v('large') }), 'ops.environments')).toBe('prod_staging_dev')
    expect(value(design(scenario('internal-tool')), 'ops.environments')).toBe('prod_only')
  })

  it('bills a license-included engine at least its smallest SKU', () => {
    const sqlserver = component(design(scenario('sqlserver-crm-to-azure')), 'db-primary')!
    const postgres = component(design({ ...scenario('sqlserver-crm-to-azure'), 'migration.approach': v('refactor') }), 'db-primary')!
    expect(sqlserver.unitCost).toBeCloseTo(700)
    expect(sqlserver.unitCost - postgres.unitCost).toBeGreaterThan(400)
  })

  it('bills Aurora replicas no storage of their own: they read the cluster volume the primary bills', () => {
    const e = design({ ...scenario('oracle-orders-to-aws'), 'data.partitioning': v('hash_sharding') })
    expect(component(e, 'db-replica')!.tech).toContain('Aurora')
    expect(component(e, 'db-replica')!.storageCost).toBe(0)
    expect(component(e, 'db-primary')!.storageCost).toBeGreaterThan(0)
    // Replicas of an engine with its own volumes (range-sharded PostgreSQL on EC2) still bill a copy each.
    expect(component(design({ ...scenario('url-shortener'), 'data.partitioning': v('range_sharding') }), 'db-replica')!.storageCost).toBeGreaterThan(0)
  })

  it('adds vendor support per provider: tiered cloud plans with minimums, subscriptions and maintenance on own hardware', () => {
    const shop = design(scenario('ecommerce'))
    const bill = shop.cost.monthly - shop.cost.byKind.support!
    expect(shop.facts['ops.support']).toBe('business')
    // AWS Business: 10% of the first $10k, 7% of the rest up to $80k.
    expect(shop.cost.byKind.support).toBeCloseTo(1_000 + 0.07 * (bill - 10_000))
    const none = design({ ...scenario('ecommerce'), 'ops.support': v('none') })
    expect(none.cost.byKind.support).toBeUndefined()
    expect(design({ ...scenario('ecommerce'), 'ops.support': v('enterprise') }).cost.byKind.support).toBe(15_000)
    expect(design({ ...scenario('ecommerce'), 'infra.cloud': v('azure') }).cost.byKind.support).toBe(100)
    const own = design({ ...scenario('ecommerce'), 'infra.cloud': v('onprem') })
    const instances = own.architecture.components.filter((c) => c.costKind === 'run' && c.instanceClass !== null && c.def.shape !== 'region' && c.phase !== 'transition').reduce((sum, c) => sum + c.monthlyCost, 0)
    expect(own.cost.byKind.support).toBeCloseTo(kb.reference.onpremSupportShare * (instances + (own.cost.byKind.nonprod ?? 0)))
  })

  it('asks the LLM question set only with a language model, and lets the AI add-on keep one beside batch recommendations', () => {
    const app = { 'project.kind': v('ai_app'), 'product.features': { kind: 'value' as const, value: ['accounts', 'ml', 'media'] }, 'ml.serving': v('batch') }
    const classic = design({ ...app, 'ai.capabilities': { kind: 'value' as const, value: ['agent_actions'] }, 'ai.tokens_in': { kind: 'value' as const, value: 20_000 } })
    const active = (e: Evaluation) => e.questions.filter((s) => s.active).map((s) => s.question.id)
    expect(active(classic).filter((id) => id.startsWith('ai.'))).toEqual([])
    expect(ids(classic).filter((id) => /llm|agent|tool-gateway|guardrails|doc-ingestion|embeddings|vector/.test(id))).toEqual([])
    expect(classic.findings.map((x) => x.rule.id)).not.toContain('ai-long-context-cost')
    expect(classic.workload.llmCallsMonth).toBe(0)
    const commerce = { 'project.kind': v('transactional_app'), 'product.type': v('commerce'), 'product.features': { kind: 'value' as const, value: ['accounts', 'ml'] }, 'project.addons': { kind: 'value' as const, value: ['ai'] }, 'ml.serving': v('batch') }
    const both = design(commerce)
    expect(ids(both)).toEqual(expect.arrayContaining(['ml-batch', 'llm-api']))
    expect(active(both)).toContain('ai.capabilities')
    // With the serving left to the recommendation, the add-on supplies the model, so batch recommendations stay and both paths are drawn.
    const { 'ml.serving': _serving, ...pending } = commerce
    const recommended = design(pending)
    expect(value(recommended, 'ml.serving')).toBe('batch')
    expect(ids(recommended)).toEqual(expect.arrayContaining(['ml-batch', 'llm-api']))
    // An AI app on classic serving is not told that the add-on calls a hosted model, and gets no pgvector reasons.
    const reasons = (e: Evaluation, id: string) => e.questions.find((q) => q.question.id === id)!.recommendation.scores.flatMap((x) => x.reasons)
    expect(reasons(design({ 'project.kind': v('ai_app') }), 'ml.serving')).not.toContain('The AI add-on calls a hosted model.')
    for (const id of ['data.primary_db', 'data.model']) expect(reasons(classic, id).join(' '), id).not.toMatch(/pgvector/)
    // The add-on alone (no recommendations capability) is not asked how predictions are served.
    expect(active(design({ 'product.type': v('commerce'), 'project.addons': { kind: 'value' as const, value: ['ai'] } }))).not.toContain('ml.serving')
  })

  it('embeds uploaded documents wherever the vectors live, not only in a PostgreSQL primary', () => {
    const app = { 'project.kind': v('ai_app'), 'product.features': { kind: 'value' as const, value: ['accounts', 'ml', 'media'] }, 'ml.serving': v('llm_api') }
    const mongo = design({ ...app, 'data.primary_db': v('mongodb') })
    const postgres = design({ ...app, 'data.primary_db': v('postgres') })
    expect(mongo.questions.find((s) => s.question.id === 'data.media_chunks')!.active).toBe(true)
    expect(mongo.workload.vectors).toBeCloseTo(postgres.workload.vectors)
    expect(mongo.workload.embedTokensMonth).toBeCloseTo(postgres.workload.embedTokensMonth)
    // Only pgvector in a PostgreSQL primary stores the upload vectors in the database.
    expect(mongo.workload.dbStorageGb).toBeLessThan(postgres.workload.dbStorageGb)
  })
})

describe('data platform availability', () => {
  const pick = (value: string) => ({ kind: 'value' as const, value })
  const fourNines = (answers: Answers) => design({ ...answers, 'reliability.availability': pick('four') })

  it('estimates the query path from the platform services and never adds a second region for it', () => {
    const fabric = fourNines(scenario('fabric-bi-azure'))
    // BI, warehouse, catalog and lake at about 99.9% each, in the 99.99% region.
    expect(fabric.availability).toBeCloseTo(99.99 * 0.999 ** 4, 6)
    expect(fabric.questions.find((s) => s.question.id === 'reliability.multi_region')!.active).toBe(false)
    expect(ids(fabric)).not.toContain('standby-region')
    expect(fabric.findings.map((x) => x.rule.id)).toContain('platform-availability-gap')
    expect(fabric.findings.map((x) => x.rule.id)).not.toContain('availability-gap')
    // Self-run services on own hardware count by their nodes, inside the site's availability.
    const onprem = design(scenario('onprem-iceberg-lakehouse'))
    expect(onprem.availability).toBeLessThan(Number(onprem.facts['onprem.siteAvailability']))
    expect(onprem.availability).not.toBeCloseTo(fabric.availability, 2)
  })
})

describe('platform services and recommendations (review round 4)', () => {
  const v = (x: number | string | string[]) => ({ kind: 'value' as const, value: x })
  const rec = (e: Evaluation, id: string) => e.questions.find((q) => q.question.id === id)!.recommendation
  const dataPlatform = { 'project.kind': v('data_platform'), 'infra.cloud': v('aws'), 'data.history_tb': v(0.5), 'team.size': v('multi') }

  it('schedules a single SQL node with the provider cron instead of a managed Airflow environment', () => {
    const e = design(dataPlatform)
    expect(value(e, 'data.platform')).toBe('small_sql')
    expect(component(e, 'orchestrator')!.tech).toBe('EventBridge Scheduler')
    expect(component(e, 'orchestrator')!.monthlyCost).toBeLessThanOrEqual(1)
    // Platforms that ask for Airflow keep it.
    expect(component(design({ ...dataPlatform, 'data.platform': v('oss_lakehouse') }), 'orchestrator')!.tech).toBe('Amazon MWAA')
  })

  it('credits Databricks for models only where the design scores them on the platform', () => {
    const app = { 'product.type': v('social'), 'product.features': v(['accounts', 'ml']), 'team.size': v('multi'), 'infra.cloud': v('aws') }
    const databricks = (e: Evaluation) => rec(e, 'data.platform').scores.find((s) => s.optionId === 'databricks')!.reasons
    const online = design({ ...app, 'ml.serving': v('online') })
    expect(databricks(online)).not.toContain('Models train and score on the same Spark platform as the data.')
    expect(value(online, 'data.platform')).not.toBe('databricks')
    const batch = design({ ...app, 'ml.serving': v('batch') })
    expect(databricks(batch)).toContain('Models train and score on the same Spark platform as the data.')
  })

  it('decides the hybrid SaaS platform on capacity cost, not on list order', () => {
    const hybrid = (tb: number) => design({ 'project.kind': v('data_platform'), 'infra.cloud': v('onprem'), 'data.platform_location': v('cloud_analytics_from_onprem'), 'team.size': v('multi'), 'data.history_tb': v(tb) })
    const large = hybrid(50)
    expect(value(large, 'data.platform')).toBe('snowflake')
    expect(rec(large, 'data.platform').scores.find((s) => s.optionId === 'fabric')!.penalties.join(' ')).toContain('Past an F8')
    const small = hybrid(0.5)
    expect(value(small, 'data.platform')).toBe('fabric')
    expect(rec(small, 'data.platform').reasons.join(' ')).toContain('Up to an F8')
  })

  it('states a tie that only list order breaks, even without a requirement behind either option', () => {
    const tied: Question = {
      id: 'test.order', category: 'reliability', title: 'Order', prompt: '', kind: 'single', priority: 1, isDecision: true, default: 'none', sources: [],
      options: [
        { id: 'first', label: 'First', description: '', pros: [], cons: [], complexity: 2 },
        { id: 'second', label: 'Second', description: '', pros: [], cons: [], complexity: 2 },
      ],
    }
    const r = recommend(tied, {})
    expect(r.optionId).toBe('first')
    expect(r.reasons).toEqual(['Ties with Second; the option listed first is kept.'])
  })

  it('names the analytics platform\'s own SQL AI functions on a data platform', () => {
    const ai = { ...dataPlatform, 'project.addons': v(['ai']) }
    const llm = (platform: string) => component(design({ ...ai, 'data.platform': v(platform) }), 'llm-api')!
    expect(llm('snowflake').tech).toBe('Snowflake Cortex AI functions (billed in credits)')
    expect(llm('databricks').tech).toBe('Databricks Foundation Model APIs via ai_query (billed in DBUs)')
    expect(llm('fabric').tech).toBe('Fabric AI functions (billed as F capacity units)')
    expect(llm('native').tech).toBe('Amazon Bedrock')
  })

  it('recommends a paced connector where the CRM API limits would warn about the bulk API', () => {
    const crm = (gb: number) => design({ 'project.origin': v('replace_legacy_app'), 'source.kinds': v(['crm']), 'source.volume_gb': v(gb) })
    const large = crm(100)
    // A single CRM takes the platform's own connector; several SaaS sources share a managed connector (scenario crm-to-ai-insights).
    expect(value(large, 'source.crm_extract')).toBe('provider_connector')
    expect(large.findings.map((x) => x.rule.id)).not.toContain('crm-api-limits')
    expect(value(crm(20), 'source.crm_extract')).toBe('bulk_api')
  })
})

describe('task-aware guidance and cost levers', () => {
  const v = (x: unknown) => ({ kind: 'value' as const, value: x as never })
  const findingIds = (e: Evaluation) => e.findings.map((x) => x.rule.id)

  it('moves objects older than a year to a cheaper class that bills apart from the standard class', () => {
    const crawler = design(scenario('web-crawler'))
    expect(value(crawler, 'data.storage_class')).toBe('cold')
    const cold = component(crawler, 'cold-storage')!
    expect(cold.tech).toContain('Glacier Instant Retrieval')
    const standard = design({ ...scenario('web-crawler'), 'data.storage_class': v('standard') })
    expect(component(standard, 'cold-storage')).toBeUndefined()
    // About $4 against $23 per TB-month: the cold design costs far less for the same bytes.
    expect(component(crawler, 'object-storage')!.monthlyCost + cold.monthlyCost).toBeLessThan(component(standard, 'object-storage')!.monthlyCost / 2)
    expect(component(design({ ...scenario('web-crawler'), 'data.storage_class': v('archive') }), 'cold-storage')!.monthlyCost).toBeLessThan(cold.monthlyCost / 3)
  })

  it('offers no cost lever that drops the language model from an AI app', () => {
    const levers = costLevers(kb, autoComplete(kb, scenario('rag-assistant-azure')))
    expect(levers.length).toBeGreaterThan(0)
    expect(levers.find((l) => l.question.id === 'ml.serving')).toBeUndefined()
    for (const l of levers) expect(l.evaluation.facts['profile.llm'], l.question.id).toBe(true)
  })

  it('asks report freshness on the analytics capability path and streams telemetry by default', () => {
    const iot = design({ 'project.kind': v('event_streaming') })
    expect(iot.questions.find((s) => s.question.id === 'data.freshness')!.active).toBe(true)
    expect(value(iot, 'data.freshness')).toBe('seconds')
    expect(value(iot, 'data.analytics')).toBe('streaming')
    expect(value(iot, 'data.ingestion')).toBe('streaming')
    // An answered freshness now reaches the pipeline choice.
    expect(value(design({ 'project.kind': v('event_streaming'), 'data.freshness': v('daily') }), 'data.analytics')).toBe('warehouse')
  })

  it('keeps prompts inside the residency zone and flags a vendor API there', () => {
    const eu = design({ 'project.kind': v('ai_app'), 'security.residency': v('region'), 'security.residency_zone': v('eu') })
    expect(value(eu, 'ai.data_policy')).toBe('cloud_tenant_only')
    expect(value(eu, 'ai.model_hosting')).not.toBe('direct_api')
    expect(value(design({ 'project.kind': v('ai_app'), 'infra.cloud': v('onprem'), 'security.residency': v('air_gapped') }), 'ai.data_policy')).toBe('no_external')
    const vendor = design({ 'project.kind': v('ai_app'), 'security.residency': v('region'), 'ai.data_policy': v('public_ok'), 'ai.model_hosting': v('direct_api') })
    expect(findingIds(vendor)).toContain('vendor-llm-residency')
  })

  it('measures an AI app on its streamed answer and flags a request target shorter than a completion', () => {
    const ai = design({ 'project.kind': v('ai_app') })
    expect(value(ai, 'perf.latency')).toBe('streamed')
    expect(findingIds(ai)).not.toContain('llm-latency-target')
    expect(findingIds(design({ 'project.kind': v('ai_app'), 'perf.latency': v('interactive') }))).toContain('llm-latency-target')
  })
})

describe('cost model (review round 7)', () => {
  const v = (x: string | number | string[]) => ({ kind: 'value' as const, value: x })
  const on = (id: string, cloud: string) => design({ ...scenario(id), 'infra.cloud': v(cloud) })

  it('keeps an own push-CDN edge fleet out of the staging share and the staff estate copies', () => {
    const e = design(scenario('video-streaming'))
    const edge = component(e, 'cdn')!
    expect(edge.instanceClass).not.toBeNull()
    const copied = e.architecture.components.filter((c) => c.costKind === 'run' && c.phase !== 'transition' && c.instanceClass !== null && c.def.shape !== 'region' && c.def.id !== 'cdn')
    expect(e.cost.byKind.nonprod).toBeCloseTo(Number(e.facts['cost.nonprodShare']) * copied.reduce((sum, c) => sum + c.monthlyCost, 0))
    expect(e.cost.byKind.nonprod!).toBeLessThan(0.1 * edge.monthlyCost)
    expect(component(e, 'platform-ops')!.sizingNote).toContain(`${fmt(edge.units)} own server(s)`)
  })

  it('copies instances and data into a peer region, not per-request lines the regions split', () => {
    const e = design(scenario('social-network'))
    const perRequest = ['api-gateway', 'queue'].map((id) => component(e, id)!)
    for (const c of perRequest) expect(c.instanceClass, c.def.id).toBeNull()
    const copied = e.architecture.components.filter(
      (c) => ['ingress', 'compute', 'async', 'data'].includes(c.def.tier) && c.def.shape !== 'external' && c.phase !== 'transition' && !c.def.singleRegion && (c.instanceClass !== null || c.def.tier === 'data'),
    )
    expect(copied.map((c) => c.def.id)).not.toContain('api-gateway')
    expect(component(e, 'peer-region')!.monthlyCost).toBeCloseTo(copied.reduce((sum, c) => sum + c.monthlyCost, 0))
  })

  it('prices a cloud support plan on the cloud bill, without SaaS licenses the cloud does not bill', () => {
    expect(on('dynamics-crm-to-d365', 'aws').cost.byKind.support).toBe(kb.reference.supportPlans.aws.business.min)
    expect(on('dynamics-crm-to-d365', 'gcp').cost.byKind.support).toBe(kb.reference.supportPlans.gcp.business.min)
  })

  it('counts the corpus embeddings in total storage, wherever they are kept', () => {
    for (const id of ['agent-support-copilot-aws', 'rag-assistant-azure']) {
      const w = design(scenario(id)).workload
      expect(w.totalStorageGb, id).toBeGreaterThanOrEqual(((w.vectors * kb.reference.embeddingKb) / 1024 / 1024) * kb.reference.replicationFactor)
    }
  })

  it('prices rows AI functions in SQL enrich at a short per-row token mix, not the chat mix', () => {
    const e = design(scenario('gcp-bigquery-marketing'))
    expect(e.workload.weightedTokensPerCall).toBe(kb.reference.sqlRowTokensIn + 5 * kb.reference.sqlRowTokensOut)
    // Chat calls keep the asked mix, weighted by their share of the calls.
    const both = design({ ...scenario('ai-assistant'), 'ai.capabilities': v(['assistant_chat', 'sql_ai_functions']), 'ai.rows_month': v(1_000_000) })
    const chat = both.workload.llmCallsMonth - 1_000_000
    expect(both.workload.weightedTokensPerCall).toBeCloseTo((chat * (2_000 + 5 * 300) + 1_000_000 * (kb.reference.sqlRowTokensIn + 5 * kb.reference.sqlRowTokensOut)) / both.workload.llmCallsMonth)
  })

  it('sizes a PostgreSQL primary holding pgvector embeddings on the memory their index needs', () => {
    const e = design(scenario('crm-to-ai-insights'))
    expect(e.workload.primaryEmbeddingGb).toBeGreaterThan(kb.reference.dbNodeMemoryGb)
    expect(component(e, 'db-primary')!.instanceClass).toBe('large')
    expect(component(e, 'db-primary')!.sizingNote).toContain('pgvector index in memory')
  })
})

describe('recommendations and findings (review round 7)', () => {
  const recommended = (e: Evaluation, id: string) => e.questions.find((q) => q.question.id === id)!.recommendation.optionId
  const findingIds = (e: Evaluation) => e.findings.map((x) => x.rule.id)

  it('keeps a per-user identity provider off a consumer audience past a million daily users', () => {
    const e = design(scenario('social-graph'))
    expect(recommended(e, 'security.auth')).not.toBe('oidc')
    expect(component(e, 'auth')).toBeUndefined()
  })

  it('signs staff of an AI app in through the directory the organisation runs', () => {
    for (const id of ['onprem-regulated-ai', 'rag-assistant-azure']) expect(recommended(design(scenario(id)), 'security.auth'), id).toBe('sso')
  })

  it('shards random short-code lookups by hash, not by range', () => {
    const e = design(scenario('url-shortener'))
    expect(recommended(e, 'data.partitioning')).toBe('hash_sharding')
    expect(findingIds(e)).not.toContain('hot-shard')
  })

  it('does not flag the cutover window when reverse CDC is in place', () => {
    for (const id of ['oracle-orders-to-aws', 'sqlserver-dw-to-fabric']) {
      const e = design(scenario(id))
      expect(value(e, 'migration.rollback'), id).toBe('reverse_cdc')
      expect(findingIds(e), id).not.toContain('cutover-window')
    }
  })

  it('embeds the parsed text of the RAG corpus, not its size on disk', () => {
    const e = design(scenario('rag-assistant-azure'))
    expect(component(e, 'doc-ingestion-backfill')!.monthlyCost).toBeLessThan(10_000)
  })

  it('prices no migration engineering when agents read the kept system live', () => {
    const e = design(scenario('agents-on-kept-sqlserver'))
    expect(value(e, 'profile.keptUncopied')).toBe(true)
    expect(ids(e)).not.toContain('migration-engineering')
    expect(e.cost.oneTime).toBe(0)
  })
})
