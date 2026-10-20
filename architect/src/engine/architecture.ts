import type {
  Answers,
  Architecture,
  ComponentDef,
  ComponentInstance,
  EdgeInstance,
  Facts,
  KnowledgeBase,
  LinearSizing,
  ReferenceNumbers,
  ServiceOffer,
  SizingId,
  Workload,
} from '../domain/types'
import { evaluateCondition } from './conditions'
import { dbNodeStorageGb } from './workload'

const MAX_ITERATIONS = 6

interface Sized {
  replicas: number
  shards?: number
  utilization: number
  note: string
  /** Peak load in units of one node's capacity; the instance class follows it. */
  demand?: number
  /** Units a usage-priced service bills (TB, million requests, 1,000 calls), priced without an instance class. */
  billed?: number
  /** Price of one billed unit set by the sizing itself (a capacity tier), ahead of offers and pricing rules. */
  unitPrice?: number
  /** The capacity tier that sets unitPrice. */
  tier?: string
  /** Full copies of the stored data the component keeps across its nodes (priced with storageFrom). */
  copies?: number
  /** Servers that come in one size (own edge cache servers), so no smaller instance class applies. */
  wholeNodes?: boolean
  /** Instances an autoscaled cloud fleet runs on average (average load plus headroom, at least the availability floor): what it bills. */
  average?: number
}

const num = (facts: Facts, key: string, fallback: number): number => {
  const v = facts[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

const ceil = (value: number, min = 1) => Math.max(min, Math.ceil(value - 1e-9))

function haMinimum(facts: Facts): number {
  return num(facts, 'reliability.nines', 99) >= 99.9 ? 2 : 1
}

/** Only a full-duplex WebSocket carries what clients send; SSE and long polling only push, so clients send over HTTP. */
const duplex = (facts: Facts, present: Set<string>) => present.has('ws-gateway') && facts['perf.realtime'] === 'websocket'

/** Requests on the HTTP path; over a WebSocket the writes arrive on the persistent connections instead. */
const httpQps = (w: Workload, facts: Facts, present: Set<string>) => w.peakQps - (duplex(facts, present) ? w.peakWriteQps : 0)

/** Reads each data tier receives after the cache and the read routing; sizing and the drawn data flows share them. */
function routedReads(w: Workload, facts: Facts, present: Set<string>) {
  const cacheHit = present.has('cache') ? num(facts, 'perf.cacheHitRatio', 0.8) : 0
  const misses = w.peakLookupQps * (1 - cacheHit)
  // Cache misses land on the primary unless asynchronous replicas may serve them; Cassandra and MongoDB have no replica tier.
  const onPrimary = facts['data.strongConsistency'] === true || !present.has('db-replica')
  // Only a cache that stores query results answers searches; write-through and write-behind hold the records the application wrote.
  const searchHit = facts['perf.cachesQueryResults'] === true ? cacheHit : 0
  return { cacheHit, misses, primaryReads: onPrimary ? misses : 0, replicaReads: onPrimary ? 0 : misses, searchQueries: w.peakSearchQps * (1 - searchHit) }
}

/** Messages per second the stream carries at peak. */
const streamQps = (w: Workload, present: Set<string>) => (present.has('queue') ? w.peakWriteQps : w.peakJobsQps) + w.peakEventQps + w.peakIngestQps

function size(sizing: SizingId | LinearSizing, w: Workload, facts: Facts, ref: ReferenceNumbers, serviceCount: number, present: Set<string>, primary?: Sized, group?: string): Sized {
  const ha = haMinimum(facts)
  const h = ref.targetUtilization
  const routed = routedReads(w, facts, present)
  // Each '@service' member takes an even share of the requests and of the background work done inside them.
  const perService = (w.peakQps + w.peakInlineWorkQps) / Math.max(1, serviceCount)
  // Usage-priced services bill the month's total, so peak rates are averaged over the day first.
  const perMonth = (peakPerSecond: number) => ((peakPerSecond / w.peakFactor) * ref.secondsPerDay * 365) / 12
  // A second instance adds availability only if the survivor carries the peak, so request-path fleets keep a spare (N+1).
  const fleet = (load: number, perNode: number) => Math.max(ceil(load / (perNode * h), ha), ha > 1 ? ceil(load / perNode) + 1 : 1)
  // A cloud fleet that autoscales runs its peak size only during the peak, so it bills the fleet the average load needs, with the same headroom and floor.
  const autoscaled = facts['compute.autoscaled'] === true
  const average = (peakLoad: number, perNode: number) => (autoscaled ? fleet(peakLoad / w.peakFactor, perNode) : undefined)
  // Each in-memory node owns a slice of the keys, so losing it loses that slice; at the availability minimum every slice gets a standby.
  const slices = (load: number, perNode: number) => {
    const shards = ceil(load / (perNode * h))
    return { shards, replicas: shards * ha, utilization: load / (shards * perNode), demand: load / perNode, standby: ha > 1 ? ', each with a standby' : '' }
  }
  if (typeof sizing === 'object') return linear(sizing, facts, fleet, h, ha)
  switch (sizing) {
    case 'single':
      return { replicas: 1, utilization: 0, note: 'Managed or single instance.' }
    case 'primaryStandby':
      return { replicas: ha, copies: ha, utilization: 0, note: ha > 1 ? `A primary and a synchronous standby with automatic failover (minimum ${ha} for availability).` : 'One primary with point-in-time backups.' }
    case 'lb':
    case 'gateway': {
      // The load balancer also carries the messages clients send over a WebSocket; the API gateway sees only the HTTP requests,
      // which include the location updates of live-tracking clients without a WebSocket (SSE and long polling only push).
      const http = httpQps(w, facts, present) + (present.has('ws-gateway') && !duplex(facts, present) ? w.peakLocationQps : 0)
      const realtime = sizing === 'lb' && duplex(facts, present) ? w.peakRealtimeQps : 0
      const load = http + realtime
      const replicas = ceil(load / (ref.lbNodeQps * h), ha)
      return {
        replicas,
        utilization: load / (replicas * ref.lbNodeQps),
        demand: load / ref.lbNodeQps,
        note: `${fmt(http)} peak req/s${realtime > 0 ? ` plus ${fmt(realtime)} real-time messages/s` : ''} across ${replicas} node(s).`,
      }
    }
    case 'app':
    case 'functions': {
      // Without a location service, the application itself receives the location updates (realtime-location flow).
      const location = group === 'service' && !present.has('svc-geo') ? w.peakLocationQps : 0
      const inline = group === 'service' ? w.peakInlineWorkQps : 0
      const load = w.peakQps + location + inline
      const replicas = fleet(load, ref.appInstanceQps)
      // Functions bill each request instead of running instances, so the same peak costs more when traffic stays high all day.
      const requests = sizing === 'functions' ? perMonth(load) : 0
      const avg = sizing === 'functions' ? undefined : average(load, ref.appInstanceQps)
      return {
        replicas,
        average: avg,
        utilization: load / (replicas * ref.appInstanceQps),
        demand: load / ref.appInstanceQps,
        billed: sizing === 'functions' ? ceil(requests / 1e6) : undefined,
        note: `${fmt(w.peakQps)} peak req/s${location > 0 ? ` plus ${fmt(location)} location updates/s` : ''}${inline > 0 ? ` plus background work done inside requests worth ${fmt(inline)} req/s` : ''} / ${fmt(ref.appInstanceQps)} per instance${ha > 1 ? ', at least one spare so the survivors carry the peak' : ''}${sizing === 'functions' ? `; billed per million requests (${fmt(requests)} a month)` : ''}.`,
      }
    }
    case 'inference': {
      // Ranking scores what users read; posting a write needs no prediction. Reads wait on the score, so the fleet keeps a spare like the app.
      const replicas = fleet(w.peakReadQps, ref.appInstanceQps)
      const avg = average(w.peakReadQps, ref.appInstanceQps)
      return {
        replicas,
        average: avg,
        utilization: w.peakReadQps / (replicas * ref.appInstanceQps),
        demand: w.peakReadQps / ref.appInstanceQps,
        note: `${fmt(w.peakReadQps)} peak reads/s scored / ${fmt(ref.appInstanceQps)} per instance${ha > 1 ? ', at least one spare so the survivors carry the peak' : ''}.`,
      }
    }
    case 'location': {
      // The location service is an '@service' member, so it also takes its share of the routed requests, plus dispatch's nearby-driver queries.
      const requests = perService + (present.has('svc-dispatch') ? w.peakRideQps : 0)
      const load = w.peakLocationQps + requests
      const replicas = fleet(load, ref.appInstanceQps)
      const avg = average(load, ref.appInstanceQps)
      return {
        replicas,
        average: avg,
        utilization: load / (replicas * ref.appInstanceQps),
        demand: load / ref.appInstanceQps,
        note: `${fmt(w.peakLocationQps)} location updates/s at peak${requests > 0 ? ` plus ${fmt(requests)} requests/s routed to the service` : ''}.`,
      }
    }
    case 'service': {
      const inline = w.peakInlineWorkQps
      const replicas = fleet(perService, ref.appInstanceQps)
      const avg = average(perService, ref.appInstanceQps)
      return {
        replicas,
        average: avg,
        utilization: perService / (replicas * ref.appInstanceQps),
        demand: perService / ref.appInstanceQps,
        note: `About ${fmt(perService)} peak req/s per service (even split assumption)${inline > 0 ? `, including background work done inside requests worth ${fmt(inline)} req/s in total` : ''}.`,
      }
    }
    case 'worker': {
      const perWorker = ref.appInstanceQps / 2
      const load = w.peakJobsQps / perWorker + w.peakMediaWorkSeconds
      const replicas = ceil(load / h, ha)
      // Workers drain a queue, so they need no spare: the average fleet is the average load with the same headroom.
      const avg = autoscaled ? ceil(load / w.peakFactor / h, ha) : undefined
      return {
        replicas,
        average: avg,
        utilization: load / replicas,
        demand: load,
        note: `${fmt(w.peakJobsQps)} peak jobs/s at ${fmt(perWorker)} per worker, plus ${fmt(w.peakMediaWorkSeconds)} worker-seconds/s of media processing.`,
      }
    }
    case 'dbPrimary': {
      const writeCap = ref.dbPrimaryWriteQps * num(facts, 'data.nodeWriteFactor', 1)
      const byWrites = w.peakDbWriteQps / writeCap
      const reads = routed.primaryReads
      const primaryReads = reads / ref.dbReplicaReadQps
      const copies = num(facts, 'data.storeReplicas', 1)
      // A replica set has one write primary and full copies on the other members, so writes and one copy of the data size the sets.
      const replicaSets = facts['data.replicaSets'] === true
      // Leaderless stores spread every row over several nodes, so the node count covers the replication factor.
      const byStorage = (w.dbStorageGb * (replicaSets ? 1 : copies)) / ref.dbNodeStorageGb
      const load = Math.max(byWrites + primaryReads, byStorage)
      // A migrated relational database holds data on one instance up to the engine's limit: storage sizes the instance, but splits it only past that limit.
      const splitLoad = Math.max(byWrites + primaryReads, (byStorage * ref.dbNodeStorageGb) / dbNodeStorageGb(facts, ref))
      // Choosing to scale up keeps one (larger) primary; the load ring then shows any overload.
      const scaleUp = facts['data.partitioning'] === 'vertical'
      // A leaderless cluster needs at least one node per copy of a row.
      const floor = replicaSets ? 1 : copies
      const needed = scaleUp ? 1 : ceil(splitLoad / h, floor)
      // A pinned node count (project overrides, size.db-primary.pinned) sets the partitions here, so the replica tier keeps a standby for each of them.
      const pinned = num(facts, 'size.db-primary.pinned', 0)
      const shards = pinned > 0 ? ceil(pinned / (replicaSets ? copies : 1)) : needed
      const nodes = replicaSets ? shards * copies : shards
      const reason =
        pinned > 0 ? `a pinned count; the load needs ${needed}` : ceil(load / h) < floor ? `${copies} copies of every row` : byWrites + primaryReads >= byStorage ? (primaryReads > 0 ? 'reads and writes on the primary' : 'write throughput') : 'storage'
      const readsNote = reads > 0 ? `, ${fmt(reads)} reads/s` : ''
      const leaderless = !replicaSets && copies > 1
      const unit = replicaSets ? `replica set(s) of ${copies} nodes, one primary each` : leaderless ? 'nodes' : 'partitions'
      const stored = leaderless ? `${fmtGb(w.dbStorageGb)} x ${copies} copies` : fmtGb(w.dbStorageGb)
      // A pgvector index answers fast only in memory, so the embeddings in the primary set its instance class, not its partitions.
      const byVectorMemory = w.primaryEmbeddingGb / ref.dbNodeMemoryGb
      const vectorNote = byVectorMemory > load ? ` The instance holds the ${fmtGb(w.primaryEmbeddingGb)} pgvector index in memory.` : ''
      return {
        replicas: nodes,
        copies,
        utilization: splitLoad / shards,
        demand: Math.max(load, byVectorMemory),
        note:
          (nodes > 1
            ? `${shards} ${unit}, driven by ${reason} (${fmt(w.peakDbWriteQps)} durable writes/s${readsNote}, ${stored})${facts['data.partitioning'] === 'federation' ? '; split by domain first, then by key where a domain outgrows one node' : ''}.`
            : `One primary handles ${fmt(w.peakDbWriteQps)} durable writes/s${readsNote} and ${fmtGb(w.dbStorageGb)}.`) + vectorNote,
      }
    }
    case 'dbReplica': {
      // Strong consistency keeps reads on the primary; replicas are failover standbys only.
      const strong = facts['data.strongConsistency'] === true
      const { misses, replicaReads: reads } = routed
      const dbShards = primary?.replicas ?? 1
      // A replica copies one partition, so each partition needs replicas for its share of reads, and at least one standby.
      const perPartition = ceil(reads / dbShards / (ref.dbReplicaReadQps * h), 1)
      const replicas = ceil(perPartition * dbShards, 1)
      const afterCache = present.has('cache') ? `after a ${Math.round(routed.cacheHit * 100)}% cache hit ratio` : 'with no cache'
      const split = ha > 1 ? `; at least one standby for each of ${dbShards} partition(s)` : dbShards > 1 ? `; ${perPartition} for each of ${dbShards} partitions` : ''
      return {
        replicas,
        copies: replicas / dbShards,
        utilization: reads / (replicas * ref.dbReplicaReadQps),
        // A failover standby takes over its primary's load, so it runs the primary's instance class even with no reads.
        demand: Math.max(reads / ref.dbReplicaReadQps, primary?.demand ?? 0),
        note: strong
          ? `Reads stay on the primary (${fmt(misses)}/s ${afterCache}); replicas are synchronous failover standbys${ha > 1 || dbShards > 1 ? ` for each of ${dbShards} partition(s)` : ''}.`
          : `${fmt(reads)} reads/s reach the database ${afterCache}${split}.`,
      }
    }
    case 'cache': {
      const byMemory = w.cacheMemoryGb / ref.cacheNodeMemoryGb
      const byOps = (w.peakLookupQps + w.peakTimelineWriteQps) / ref.cacheNodeOps
      // The tiers behind the cache are sized for its misses, so a lost shard sends them more reads than they carry.
      const { shards, replicas, utilization, demand, standby } = slices(Math.max(byMemory, byOps), 1)
      return {
        replicas,
        shards,
        utilization,
        demand,
        note: `${fmtGb(w.cacheMemoryGb)} hot set (20% of daily reads), ${fmt(w.peakLookupQps)} reads/s${w.peakTimelineWriteQps > 0 ? ` plus ${fmt(w.peakTimelineWriteQps)} timeline writes/s` : ''} on ${shards} shard(s)${standby}.`,
      }
    }
    case 'queue': {
      // A managed queue bills every send, receive and delete call instead of running brokers; each call carries a batch of up to 10 messages.
      if (facts['arch.broker'] === 'sqs') {
        const requests = (perMonth(w.peakJobsQps) * 3) / 10
        return { replicas: 1, utilization: 0, billed: ceil(requests / 1e6), note: `${fmt(w.peakJobsQps)} messages/s at peak, sent, received and deleted in batches of 10: ${fmt(requests)} requests a month, billed per million.` }
      }
      const replicas = ceil(w.peakJobsQps / (ref.queueNodeMsgs * h), ha)
      return { replicas, utilization: w.peakJobsQps / (replicas * ref.queueNodeMsgs), demand: w.peakJobsQps / ref.queueNodeMsgs, note: `${fmt(w.peakJobsQps)} messages/s at peak.` }
    }
    case 'stream': {
      // Next to a job queue the stream carries only the published events, one per write; ingested events and a data platform's lake changes come on top.
      const msgs = streamQps(w, present)
      // A data platform's sources each write their own topic, so every source gets a partition at least.
      const partitions = Math.max(ceil(msgs / (ref.streamPartitionMsgs * h), 3), w.peakIngestQps > 0 ? w.sourceCount : 0)
      // A broker's disk holds about what a data node's does, so a long replay window adds brokers.
      const brokers = Math.max(ceil(partitions / 10, 3), ceil(w.eventRetainedGb / (ref.dbNodeStorageGb * h)))
      const retained = w.eventRetainedGb > 0 ? `, ${fmtGb(w.eventRetainedGb)} of ingested events kept for replay (3 copies)` : ''
      return { replicas: brokers, utilization: msgs / (partitions * ref.streamPartitionMsgs), demand: msgs / (ref.streamPartitionMsgs * 10), note: `${fmt(msgs)} events/s at peak in ${partitions} partitions on ${brokers} brokers${retained}.` }
    }
    case 'search': {
      const queries = routed.searchQueries
      // Every query reads one copy of every shard (scatter-gather), so shards cover the index size and copies (at least two) the query load.
      const shards = ceil(w.searchIndexGb / (ref.dbNodeStorageGb * h))
      const copies = ceil(queries / (ref.searchNodeQps * h), 2)
      return {
        replicas: shards * copies,
        copies,
        utilization: Math.max(queries / (copies * ref.searchNodeQps), w.searchIndexGb / (shards * ref.dbNodeStorageGb)),
        demand: Math.max(queries / ref.searchNodeQps, w.searchIndexGb / ref.dbNodeStorageGb),
        note: `${shards} shard(s) for ${fmtGb(w.searchIndexGb)} of index, each in ${copies} copies for ${fmt(queries)} search queries/s after the cache (every query reads one copy of each shard).`,
      }
    }
    case 'geo': {
      const pings = w.peakLocationQps
      const { shards, replicas, utilization, demand, standby } = slices(pings, ref.cacheNodeOps)
      return { replicas, shards, utilization, demand, note: `${fmt(pings)} location updates/s from ${fmt(w.concurrentConnections)} connected clients on ${shards} geohash shard(s)${standby}.` }
    }
    case 'presence': {
      // Heartbeats plus one publish per message to the channel of the node that holds the recipient, on in-memory nodes.
      const heartbeats = w.heartbeatQps
      const ops = heartbeats + w.peakWriteQps
      const { shards, replicas, utilization, demand, standby } = slices(ops, ref.cacheNodeOps)
      return {
        replicas,
        shards,
        utilization,
        demand,
        note: `${fmt(heartbeats)} heartbeat updates/s from ${fmt(w.concurrentConnections)} connections, plus ${fmt(w.peakWriteQps)} messages/s routed between nodes, on ${shards} user-id shard(s)${standby}.`,
      }
    }
    case 'connections': {
      // A managed real-time service bills per connection, so it is priced in blocks of 1,000 concurrent connections.
      const replicas = ceil(w.concurrentConnections / 1_000, 1)
      return { replicas, utilization: 0, billed: replicas, note: `${fmt(w.concurrentConnections)} concurrent connections, billed per 1,000.` }
    }
    case 'wsGateway': {
      const replicas = fleet(w.concurrentConnections, ref.wsConnectionsPerNode)
      return {
        replicas,
        utilization: w.concurrentConnections / (replicas * ref.wsConnectionsPerNode),
        demand: w.concurrentConnections / ref.wsConnectionsPerNode,
        note: `${fmt(w.concurrentConnections)} concurrent connections, ${fmt(ref.wsConnectionsPerNode)} per node.`,
      }
    }
    case 'objects': {
      // Managed object stores keep their own redundant copies, so one copy of the data is billed.
      // Objects a lifecycle rule moved to a colder class bill on the cold-storage line instead.
      const hotGb = w.objectStorageGb - w.coldObjectStorageGb
      const moved = w.coldObjectStorageGb > 0 ? `; ${fmtGb(w.coldObjectStorageGb)} older than a year sits in the cold class` : ''
      return { replicas: 1, utilization: 0, billed: ceil(hotGb / 1024, hotGb > 0 || w.coldObjectStorageGb === 0 ? 1 : 0), note: `${fmtGb(hotGb)} of blobs, media and archived history in one copy (the service replicates it internally), billed per TB-month${moved}.` }
    }
    case 'egress': {
      // A pull CDN bills the bytes it serves; an own edge (push) pays for whole cache servers sized on the peak instead.
      const gbps = (w.avgMediaEgressMbps * w.peakFactor) / 1000
      if (facts['perf.cdn'] === 'push') {
        const replicas = ceil(gbps / (ref.edgeServerGbps * h), 2)
        return { replicas, wholeNodes: true, utilization: gbps / (replicas * ref.edgeServerGbps), demand: gbps / ref.edgeServerGbps, note: `${fmt(gbps)} Gbps of media at peak on ${replicas} edge cache servers of ${ref.edgeServerGbps} Gbps, in at least two sites.` }
      }
      const tb = (perMonth(w.avgMediaEgressMbps * w.peakFactor) / 8) / 1024 / 1024
      return { replicas: 1, utilization: 0, billed: ceil(tb), note: `${fmt(tb)} TB of media served a month (${fmt(gbps)} Gbps at peak), billed per TB.` }
    }
    case 'completions': {
      // Calls come from AI usage (workload.ts); hosted models bill tokens, priced per 1,000 calls of the default token mix and scaled by the real mix.
      const calls = w.llmCallsMonth
      const weight = w.weightedTokensPerCall / ref.llmDefaultWeightedTokens
      return {
        replicas: 1,
        utilization: 0,
        billed: ceil((calls / 1_000) * weight),
        note: `${fmt(calls)} model calls a month (assistant messages, agent reasoning steps, extracted pages and rows enriched in SQL; ${fmt(w.peakLlmQps)}/s at peak) at ${fmt(w.weightedTokensPerCall)} weighted tokens each (input + 5x output; ${weight.toFixed(2)}x the default mix), billed per 1,000 default calls.`,
      }
    }
  }
}

/** Declarative sizing: capacity tiers and billed units are priced as SKUs (no instance class, utilization 0); otherwise a fleet. */
function linear(sizing: LinearSizing, facts: Facts, fleet: (load: number, perNode: number) => number, h: number, ha: number): Sized {
  const multiply = (terms: (string | number)[]) => terms.reduce<number>((total, x) => total * (typeof x === 'number' ? x : num(facts, x, 0)), 1)
  const demand = Math.max(multiply(sizing.product), sizing.floor ? multiply(sizing.floor) : 0)
  // fleet() keeps an N+1 spare only at the availability minimum.
  const spare = sizing.spare && ha > 1 ? ', one of them a spare' : ''
  const note = (units: number, tier = '') => sizing.note.replaceAll('{demand}', fmt(demand)).replaceAll('{units}', String(units)).replaceAll('{tier}', tier).replaceAll('{spare}', spare)
  const tiers = [...(sizing.tiers ?? [])].sort((a, b) => a.max - b.max)
  if (tiers.length > 0) {
    const last = tiers[tiers.length - 1]
    const tier = tiers.find((t) => t.max >= demand)
    // Above the largest SKU, several units of it are billed.
    const units = tier ? 1 : ceil(demand / last.max)
    return { replicas: 1, utilization: 0, billed: units, unitPrice: (tier ?? last).monthly, tier: (tier ?? last).name, note: note(units, units > 1 ? `${units} x ${last.name}` : (tier ?? last).name) }
  }
  if (sizing.billed) {
    const units = Math.max(sizing.min ?? 0, Math.ceil(Math.max(0, demand - (sizing.free ?? 0)) / sizing.per - 1e-9))
    return { replicas: 1, utilization: 0, billed: units, note: note(units) }
  }
  const replicas = Math.max(sizing.min ?? 1, sizing.spare ? fleet(demand, sizing.per) : ceil(demand / (sizing.per * h)))
  return { replicas, utilization: demand / (replicas * sizing.per), demand: demand / sizing.per, note: note(replicas) }
}

export function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  // Below 0.05 one decimal would print 0.0, so small amounts (a few GB as TB) keep one significant digit.
  if (n > 0 && n < 0.05) return n.toPrecision(1)
  return n >= 10 ? Math.round(n).toString() : n.toFixed(1)
}

export const money = (n: number): string => `$${fmt(n)}`
/** A unit price: two significant digits below $10 ($0.09, $0.023, $2), so units x price multiplies out; totals keep money. */
export const unitMoney = (n: number): string => (n < 10 ? `$${Number(n.toPrecision(2))}` : money(n))
/** A unit count: whole numbers below 1,000 without a decimal ('2', not '2.0'). */
export const fmtUnits = (n: number): string => (Number.isInteger(n) && n < 1e3 ? String(n) : fmt(n))

/** A cost change as '+$1.2k', '-$300', or 'same' below a dollar. */
export const signedMoney = (n: number): string => (Math.abs(n) < 1 ? 'same' : `${n > 0 ? '+' : '-'}${money(Math.abs(n))}`)

export function formatAvailability(a: number): string {
  if (a >= 99.9999) return '>99.9999%'
  const digits = a >= 99.99 ? 4 : 3
  // Truncate, so an estimate just below its target never prints as the target; the epsilon absorbs float error in the scaling.
  return `${(Math.floor(a * 10 ** digits + 1e-6) / 10 ** digits).toFixed(digits)}%`
}

export function fmtGb(gb: number): string {
  if (gb >= 1024 * 1024) return `${(gb / 1024 / 1024).toFixed(1)} PB`
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`
  return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`
}

// shortcut: three coarse instance classes instead of per-provider pricing; replace with a pricing API for real quotes.
/** A fleet whose peak needs less than one full node (demand < 1) runs smaller instances. */
export function instanceClass(demand: number): { name: string; factor: number } {
  if (demand < 0.05) return { name: 'small', factor: 0.15 }
  if (demand < 1) return { name: 'medium', factor: 0.4 }
  return { name: 'large', factor: 1 }
}

function presentComponents(kb: KnowledgeBase, facts: Facts): ComponentDef[] {
  let present = new Set<string>()
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const next = new Set(kb.components.filter((c) => evaluateCondition(c.when, { facts, components: present })).map((c) => c.id))
    const stable = next.size === present.size && [...next].every((id) => present.has(id))
    present = next
    if (stable) break
  }
  return kb.components.filter((c) => present.has(c.id))
}

/** The first service offer for this component (or its group) on the chosen provider; a pending provider matches only 'any'. */
export function offerFor(kb: KnowledgeBase, def: ComponentDef, facts: Facts): ServiceOffer | undefined {
  return kb.services.find(
    (o) => (o.component === def.id || o.component === `@${def.group}`) && (o.provider === 'any' || o.provider === facts['infra.cloud']) && evaluateCondition(o.when, { facts }),
  )
}

/** The key a unit-price override is stored under: the component, plus the offer and capacity tier that price it ('warehouse|any|Fabric F-SKU capacity|F2'). */
export function unitPriceKey(componentId: string, offer?: Pick<ServiceOffer, 'provider' | 'name'>, tier?: string): string {
  return [componentId, ...(offer ? [offer.provider, offer.name] : []), ...(tier ? [tier] : [])].join('|')
}

/** The offer this component takes on each other provider with every other fact kept (e.g. BigQuery for the native warehouse); null where that provider has none. */
export function providerAlternatives(kb: KnowledgeBase, def: ComponentDef, facts: Facts): { provider: string; name: string | null }[] {
  const providers = kb.questions.find((q) => q.id === 'infra.cloud')?.options?.map((o) => o.id) ?? []
  return providers.filter((p) => p !== facts['infra.cloud']).map((provider) => ({ provider, name: offerFor(kb, def, { ...facts, 'infra.cloud': provider })?.name ?? null }))
}

function techFor(def: ComponentDef, facts: Facts, answers: Answers, offer: ServiceOffer | undefined, components: Set<string>): string {
  const base = baseTech(def, facts, answers, offer)
  const suffixes = (def.techSuffixFrom ?? [])
    .filter((s) => evaluateCondition(s.when, { facts, components }))
    // A list fact (source.kinds) names each of its values.
    .map((s) => {
      const value = facts[s.fact]
      return Array.isArray(value) ? value.map((v) => s.map[String(v)]).filter(Boolean).join(', ') : s.map[String(value)]
    })
    .filter(Boolean)
  return [base, ...suffixes].join(', ')
}

function baseTech(def: ComponentDef, facts: Facts, answers: Answers, offer: ServiceOffer | undefined): string {
  const answer = def.techFrom ? answers[def.techFrom.fact] : undefined
  if (answer?.kind === 'custom') return answer.text
  if (offer) return offer.name
  if (def.techFrom) {
    const value = facts[def.techFrom.fact]
    if (typeof value === 'string' && def.techFrom.map[value]) return def.techFrom.map[value]
    if (!def.tech) return 'Undecided'
  }
  return def.tech ?? 'Generic'
}

export function deriveArchitecture(kb: KnowledgeBase, facts: Facts, answers: Answers, workload: Workload): Architecture {
  const defs = presentComponents(kb, facts)
  const present = new Set(defs.map((d) => d.id))
  // Gateway edges split traffic over every '@service' member, so the even split counts the same members.
  const serviceCount = defs.filter((d) => d.group === 'service').length
  const primary = present.has('db-primary') ? size('dbPrimary', workload, facts, kb.reference, serviceCount, present) : undefined
  // Managed services without a load of their own pick their tier from the request rate, in application instances;
  // with no request path (a data platform) from the rows ingested, in stream brokers of 10 partitions as the stream counts them.
  const requestDemand = facts['profile.requestPath'] === false ? workload.peakIngestQps / (kb.reference.streamPartitionMsgs * 10) : workload.peakQps / kb.reference.appInstanceQps
  const ref = kb.reference
  // Instances also follow the provider's price level (own hardware is cheaper per instance), the region and the purchase commitment;
  // usage prices come from the offers at the US list price, unless the offer follows the region or sells under a commitment of its own.
  const providerFactor = ref.providerPriceFactor[String(facts['infra.cloud'])] ?? 1
  const regionFactor = num(facts, 'infra.priceMultiplier', 1)
  const instanceFactor = providerFactor * regionFactor * num(facts, 'infra.priceFactor', 1)
  const commitment = String(facts['infra.commitment'])
  // A negotiated discount (project overrides) is a contract with one cloud (EDP, MACC, CUD): it comes off that cloud's own lines only, so the
  // provider comparison prices the other clouds, third-party services and own hardware at list.
  const discount = kb.overrides?.discountProvider === facts['infra.cloud'] ? 1 - (kb.overrides?.discountPct ?? 0) / 100 : 1
  const routed = routedReads(workload, facts, present)
  const traffic: Facts = {
    ...facts,
    'flow.httpQps': httpQps(workload, facts, present),
    'flow.realtimeQps': duplex(facts, present) ? workload.peakRealtimeQps : 0,
    'flow.primaryReadQps': routed.primaryReads,
    'flow.replicaReadQps': routed.replicaReads,
    'flow.searchQps': routed.searchQueries,
    'flow.streamQps': present.has('stream') ? streamQps(workload, present) : 0,
  }
  const components: ComponentInstance[] = defs.map((def) => {
    const offer = offerFor(kb, def, facts)
    const sizing = offer?.sizing ?? def.sizing
    // Offer sizing may read the drawn flows (flow.streamQps for a usage-priced stream).
    const load = size(sizing, workload, traffic, kb.reference, serviceCount, present, primary, def.group)
    // A fixed fleet carries the same load on its own replica count.
    const sized = def.fixedReplicas ? { ...load, replicas: def.fixedReplicas, average: undefined, utilization: (load.utilization * load.replicas) / def.fixedReplicas } : load
    // A unit-price override names the offer and capacity tier it was set on, so another provider, platform or tier keeps its own list price.
    const priceKey = unitPriceKey(def.id, offer, sized.tier)
    const override = kb.overrides?.unitPrice?.[priceKey]
    const priced = override !== undefined || sized.unitPrice !== undefined || offer?.monthlyCostPerUnit !== undefined
    const rule = priced ? undefined : def.pricing?.find((p) => evaluateCondition(p.when, { facts, components: present }))
    const unit = override ?? sized.unitPrice ?? offer?.monthlyCostPerUnit ?? rule?.monthlyCostPerUnit ?? def.monthlyCostPerUnit
    // A license costs the same on any hardware, so own hardware's lower price level applies only to the rest of a license-included price.
    const license = rule?.licensePerUnit ?? 0
    // Usage-priced and third-party services are not instances, so no instance class scales their price.
    // Whole nodes (GPU servers) come in one size, so they always cost the full unit price.
    const wholeNodes = (typeof sizing === 'object' && sizing.wholeNodes === true) || sized.wholeNodes === true
    const cls = sized.billed !== undefined || def.shape === 'external' ? null : instanceClass(wholeNodes ? 1 : (sized.demand ?? requestDemand))
    const costKind = offer?.costKind ?? def.costKind ?? 'run'
    // Who bills the line decides, not how it is drawn: the provider's own offers (Bedrock, QuickSight, Cognito) unless another company bills them
    // (Databricks on AWS, Snowflake), and 'any' offers only when they name the cloud as vendor (Fabric on Azure). Lines without an offer are the cloud's
    // instances and data transfer; other external lines and licenses without an offer (Dataverse capacity) are third parties.
    const billedBy = offer ? (offer.vendor ?? offer.provider) : (def.shape !== 'external' && costKind !== 'license') || costKind === 'transfer' ? facts['infra.cloud'] : undefined
    const own = billedBy === facts['infra.cloud'] && (costKind === 'run' || costKind === 'transfer') ? discount : 1
    const billedFactor = (offer?.commitment?.[commitment] ?? 1) * (offer?.regionPriced ? regionFactor : 1)
    const factor = (cls ? cls.factor * instanceFactor : billedFactor) * own
    const licenseFactor = cls && providerFactor > 0 ? factor / providerFactor : factor
    // The smallest SKU a license-included engine sells: its list price follows the region and commitment, as the license does, but no smaller instance class.
    const skuFloor = cls && rule?.minUnitCost ? (rule.minUnitCost * licenseFactor) / cls.factor : 0
    const unitCost = Math.max((unit - license) * factor + license * licenseFactor, skuFloor)
    const units = sized.billed ?? sized.average ?? sized.replicas
    const phase = def.phase ?? (def.transitionWhen && evaluateCondition(def.transitionWhen, { facts }) ? 'transition' : undefined)
    // Volumes are billed per GB on every copy; the primary's point-in-time backups add one more copy at the backup rate.
    const storedGb = def.storageFrom === 'db' ? workload.dbStorageGb : def.storageFrom === 'search' ? workload.searchIndexGb : 0
    // Replicas on a shared cluster volume (Aurora) add no copy of their own.
    const copies = offer?.sharedStorage ? 0 : (sized.copies ?? 1)
    const backups = def.storageFrom === 'db' && sizing === 'dbPrimary' ? workload.dbStorageGb * ref.backupPerGbMonth : 0
    const storageCost = def.storageFrom ? (storedGb * copies * ref.blockStoragePerGbMonth + backups) * providerFactor * own : 0
    const storageNote = offer?.sharedStorage
      ? ' Storage: the shared cluster volume the primary bills; replicas add no copy.'
      : def.storageFrom
      ? ` Storage: ${fmtGb(storedGb)} x ${fmt(copies)} cop${copies === 1 ? 'y' : 'ies'} at $${ref.blockStoragePerGbMonth}/GB-month${backups > 0 ? ` plus backups at $${ref.backupPerGbMonth}/GB-month` : ''}, $${fmt(storageCost)} a month.`
      : ''
    return {
      def,
      tech: techFor(def, facts, answers, offer, present),
      replicas: sized.replicas,
      shards: sized.shards,
      utilization: sized.utilization,
      sizingNote:
        sized.note +
        (sized.average !== undefined ? ` Autoscaled: billed on about ${sized.average} instance(s), the fleet the average load needs; the peak fleet runs only at peak.` : '') +
        (skuFloor > 0 && unitCost === skuFloor ? ` Billed at the smallest license-included SKU, about $${fmt(skuFloor)} a node.` : '') + storageNote,
      units,
      unitCost,
      listPrice: unit,
      priceKey,
      instanceClass: cls?.name ?? null,
      ...(!cls && offer?.commitment && { committable: true }),
      costKind,
      ...(phase && { phase }),
      ...(billedBy !== undefined && { billedBy: String(billedBy) }),
      offer: offer && { provider: offer.provider, name: offer.name, asOf: offer.asOf, ...(offer.sla !== undefined && { sla: offer.sla }) },
      ...(def.storageFrom && { storageCost }),
      monthlyCost: units * unitCost + storageCost,
    }
  })

  const expand = (ref: string): string[] =>
    ref.startsWith('@') ? defs.filter((d) => d.group === ref.slice(1)).map((d) => d.id) : present.has(ref) ? [ref] : []

  const ctx = { facts, components: present }
  const edges: EdgeInstance[] = []
  const seen = new Map<string, EdgeInstance>()
  for (const def of kb.edges) {
    if (!evaluateCondition(def.when, ctx)) continue
    const sources = expand(def.from)
    const targetRef = def.to.find((ref) => expand(ref).length > 0)
    if (sources.length === 0 || !targetRef) continue
    const targets = expand(targetRef)
    const total = def.trafficFact ? num(traffic, def.trafficFact, 0) : 0
    const qps = total / (sources.length * targets.length)
    for (const from of sources) {
      for (const to of targets) {
        const key = `${from}->${to}:${def.protocol}`
        if (from === to) continue
        // A second flow between the same pair is drawn as the first one, so it adds its traffic there.
        const drawn = seen.get(key)
        if (drawn) {
          drawn.qps += qps
          // The shared edge names both purposes, so a flow such as retrieval on the primary stays visible.
          if (!drawn.label.includes(def.label)) drawn.label = `${drawn.label}, ${def.label}`
          continue
        }
        const edge = { id: `${def.id}:${from}->${to}`, from, to, label: def.label, protocol: def.protocol, qps }
        seen.set(key, edge)
        edges.push(edge)
      }
    }
  }
  // A second region costs what it runs: a peer copies the whole regional stack; a standby keeps a full copy of the data
  // replicated to it plus a warm share of the rest. Third-party services bill per use, so they are not copied.
  const sum = (list: ComponentInstance[]) => list.reduce((total, c) => total + c.monthlyCost, 0)
  // Migration tooling runs only until cutover and the analytics platform in one region, so a second region copies neither.
  // Request-billed lines (an API gateway, a queue, functions) split their traffic between the regions, so only instances and stored data are copied.
  const regional = components.filter(
    (c) => ['ingress', 'compute', 'async', 'data'].includes(c.def.tier) && c.def.shape !== 'external' && c.phase !== 'transition' && !c.def.singleRegion && (c.instanceClass !== null || c.def.tier === 'data'),
  )
  const replicatedTo = (target: string) => {
    const ids = new Set(edges.filter((e) => e.to === target && e.protocol === 'replication').map((e) => e.from))
    return regional.filter((c) => ids.has(c.def.id))
  }
  const replicated = replicatedTo('standby-region')
  // Read the topology from facts: a custom answer replaces the tech label with the user's own words.
  const warm = facts['reliability.multi_region'] === 'active_passive'
  const share = warm ? 0.5 : 0.15
  for (const c of components) {
    if (c.def.id === 'peer-region') {
      c.monthlyCost = sum(regional)
      c.sizingNote = 'A full copy of the regional stack: ingress, compute, async and data tiers, without the analytics platform, which stays in one region, and without per-request services, whose traffic the regions split.'
    }
    if (c.def.id === 'standby-region') {
      c.monthlyCost = sum(replicated) + share * (sum(regional) - sum(replicated))
      c.sizingNote = `A full copy of the replicated data (${replicated.map((x) => x.def.label).join(', ')}) plus ${Math.round(share * 100)}% of the rest of the regional stack (${warm ? 'warm standby' : 'pilot light: compute stays off until failover'}).`
    }
    if (c.def.id === 'peer-region' || c.def.id === 'standby-region') {
      c.unitCost = c.monthlyCost / Math.max(1, c.units)
      // The copy's cost follows the stack it copies, so no unit price of its own applies.
      c.listPrice = 0
    }
  }
  // Own sites copy the stack as a standby (two sites) or a full peer each (three), less what a standby or peer region already prices, plus their links.
  const sites = components.find((c) => c.def.id === 'extra-sites')
  if (sites) {
    const three = facts['onprem.sites'] === 'three'
    const siteData = replicatedTo('extra-sites')
    const copies = three ? 2 * sum(regional) : sum(siteData) + 0.5 * (sum(regional) - sum(siteData))
    const priced = sum(components.filter((c) => c.def.id === 'standby-region' || c.def.id === 'peer-region'))
    const links = three ? 3 : 1
    sites.monthlyCost = Math.max(0, copies - priced) + links * ref.onpremSiteLinkMonthly
    sites.unitCost = sites.monthlyCost
    sites.listPrice = 0
    sites.sizingNote = `${three ? 'Two full copies of the regional stack' : `A full copy of the replicated data (${siteData.map((x) => x.def.label).join(', ')}) plus 50% of the rest of the regional stack`}${priced > 0 ? ', less the standby or peer region priced separately' : ''}, and ${links} inter-site link(s) at $${fmt(ref.onpremSiteLinkMonthly)} a month.`
  }
  const ops = components.find((c) => c.def.id === 'platform-ops')
  if (ops) staffEstate(ops, components, regional, facts, ref)
  return { components, edges }
}

/**
 * Platform staff grow with the estate the team runs itself: the base share (platform-ops pricing) plus one FTE per
 * ref.ownNodesPerOpsFte own servers (everything on own hardware, and the cache servers of an own edge anywhere) and per ref.clusterNodesPerOpsFte
 * cloud cluster nodes (compute on Kubernetes or VMs). A second region and non-production environments run more nodes.
 */
// shortcut: managed cloud data services (RDS, Atlas) count as run by the provider even when an offer runs the engine on VMs; count those nodes by hand for a staffing plan.
/** Fleets that run on the team's own Kubernetes or VM platform: the application tier, workers and WebSocket servers, not provider endpoints (SageMaker, Azure ML, Vertex). */
const clusterFleet = (c: ComponentInstance) => (c.def.tier === 'compute' || c.def.id === 'workers' || c.def.id === 'ws-gateway') && c.def.id !== 'ml-inference'
function staffEstate(ops: ComponentInstance, components: ComponentInstance[], regional: ComponentInstance[], facts: Facts, ref: ReferenceNumbers) {
  const ownHardware = facts['infra.cloud'] === 'onprem'
  const cluster = facts['infra.compute'] === 'kubernetes' || facts['infra.compute'] === 'vms'
  const regionCopies = Math.max(
    components.some((c) => c.def.id === 'peer-region') ? 2 : components.some((c) => c.def.id === 'standby-region') ? (facts['reliability.multi_region'] === 'active_passive' ? 1.5 : 1.15) : 1,
    // Own sites beyond the first: a warm second site, or two full copies.
    components.some((c) => c.def.id === 'extra-sites') ? (facts['onprem.sites'] === 'three' ? 3 : 1.5) : 1,
  )
  const environments = 1 + num(facts, 'cost.nonprodShare', 0)
  const isRegional = new Set(regional.map((c) => c.def.id))
  let own = 0
  let clusterNodes = 0
  for (const c of components) {
    if (c.instanceClass === null || c.phase === 'transition' || c.def.shape === 'region') continue
    // An autoscaled fleet runs its average size most of the time, so the nodes to patch are the ones it bills (units).
    // Staging shares the production edge fleet (evaluate.ts costBreakdown), so the edge servers have no non-production copies.
    const nodes = c.units * (isRegional.has(c.def.id) ? regionCopies : 1) * (c.def.id === 'cdn' ? 1 : environments)
    if (ownHardware || (c.def.id === 'cdn' && facts['perf.cdn'] === 'push')) own += nodes
    else if (cluster && clusterFleet(c)) clusterNodes += nodes
  }
  const base = ops.monthlyCost / ref.opsFteMonthlyUsd
  const estate = own / ref.ownNodesPerOpsFte + clusterNodes / ref.clusterNodesPerOpsFte
  // Nearest quarter FTE, never below the base and at most opsFteMax.
  const fte = Math.max(base, Math.min(ref.opsFteMax, Math.round((base + estate) * 4) / 4))
  ops.units = fte
  ops.unitCost = ref.opsFteMonthlyUsd
  ops.listPrice = ref.opsFteMonthlyUsd
  ops.monthlyCost = fte * ref.opsFteMonthlyUsd
  ops.tech = `${ops.tech}, about ${fte} FTE`
  const counted = [own > 0 && `${fmt(own)} own server(s) at ${ref.ownNodesPerOpsFte} per FTE`, clusterNodes > 0 && `${fmt(clusterNodes)} cluster node(s) at ${ref.clusterNodesPerOpsFte} per FTE`].filter(Boolean)
  ops.sizingNote = `${ops.sizingNote} The estate adds ${counted.length > 0 ? counted.join(' and ') : 'nothing the team patches itself'}${environments > 1 ? ' (non-production environments included)' : ''}: about ${fte} FTE${fte >= ref.opsFteMax ? `, capped at ${ref.opsFteMax}` : ''}.`
}

/** Facts about the sized architecture, available to validation rules as `size.<component>.*`. */
export function architectureFacts(architecture: Architecture, ref: ReferenceNumbers): Facts {
  const facts: Facts = {}
  for (const c of architecture.components) {
    facts[`size.${c.def.id}.replicas`] = c.replicas
    facts[`size.${c.def.id}.util`] = c.utilization
  }
  // The busiest fleet whose replica count is pinned (fixedReplicas, e.g. a project override), so a pin below the need shows up.
  const pinned = architecture.components.filter((c) => c.def.fixedReplicas).sort((a, b) => b.utilization - a.utilization)[0]
  if (pinned) {
    facts['size.pinnedMaxUtil'] = pinned.utilization
    facts['size.pinnedMaxUtilLabel'] = pinned.def.label
    facts['size.pinnedOverTarget'] = pinned.utilization / ref.targetUtilization
  }
  return facts
}
