import type { Facts, ReferenceNumbers, Workload } from '../domain/types'
import { migratedGb } from './migration'

const num = (facts: Facts, key: string, fallback: number): number => {
  const v = facts[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** Data one database node holds: a migrated relational database stays on one instance up to the engine's limit; a new build splits sooner. */
export const dbNodeStorageGb = (facts: Facts, ref: ReferenceNumbers): number => (facts['migration.loadsRelationalDb'] === true ? ref.dbMaxNodeStorageGb : ref.dbNodeStorageGb)

// Back-of-the-envelope math from system-design-primer; storage includes replication.
/** `available` lists the components the project kept (none excluded when omitted): an excluded CDN, cache or replica tier serves nothing, whatever the answers say. */
export function estimateWorkload(facts: Facts, ref: ReferenceNumbers, available?: ReadonlySet<string>): Workload {
  const kept = (id: string) => !available || available.has(id)
  const dau = num(facts, 'traffic.dau', 0)
  const requestsPerUser = num(facts, 'traffic.requests_per_user', 50)
  const readRatio = num(facts, 'traffic.readRatio', 10)
  const peakFactor = num(facts, 'traffic.peakFactor', 3)
  const objectKb = num(facts, 'data.object_kb', 2)
  const retentionYears = num(facts, 'data.retention_years', 3)
  const mediaUploadsPerUser = num(facts, 'data.media_uploads_per_user', 0)
  const mediaMb = num(facts, 'data.media_mb', 0)
  const realtimeShare = num(facts, 'traffic.concurrentShare', 0.1)
  const features = Array.isArray(facts['product.features']) ? facts['product.features'] : []
  // Live tracking apps (a derived fact): each connected client reports its position about every 5 s.
  const liveTracking = facts['traffic.liveTracking'] === true
  const locationQps = liveTracking ? (dau * realtimeShare) / 5 / peakFactor : 0
  const rideQps = liveTracking ? (dau * ref.ridesPerUser) / ref.secondsPerDay : 0
  // Location updates become database rows only when the geo index lives in the database.
  const locationRowsQps = facts['data.geo_index'] === 'postgis' ? locationQps : 0
  const fanout = num(facts, 'traffic.fanout', 1)
  const searchShare = num(facts, 'traffic.searchShare', 0.1)
  const mediaViewsPerUser = num(facts, 'data.media_views_per_user', mediaUploadsPerUser * readRatio)
  // Graph traversals fetch one adjacency list per visited person, so one read touches many records.
  const lookupsPerRead = num(facts, 'traffic.graph_lookups', 1)
  // Retrieval (rag_documents, or capabilities still pending, as components.ts reads them) embeds the uploads and the corpus;
  // extraction only parses them, so it creates no vectors.
  const capabilities = facts['ai.capabilities']
  const requestPath = facts['profile.requestPath'] !== false
  // Pending capabilities count as an assistant with retrieval on the request path; a data platform waits for its own (SQL AI functions).
  // Without a language model in the design (profile.llm) there are no model calls, embeddings or vectors at all.
  const llm = facts['profile.llm'] === true
  const capability = (id: string) => llm && (Array.isArray(capabilities) ? capabilities.includes(id) : requestPath && (id === 'assistant_chat' || id === 'rag_documents'))
  const retrieval = capability('rag_documents')
  // Retrieval splits each uploaded document into chunks with one embedding each.
  const chunksPerUpload = retrieval ? num(facts, 'data.media_chunks', 0) : 0
  const historyTb = num(facts, 'data.history_tb', 0)
  // The analytics platform is sized for the data a year ahead; each source system gets its own connector.
  const growth = 1 + num(facts, 'data.growth_pct', 0) / 100
  // Every kind of existing source needs a connector of its own, so the selected kinds are the least number of source systems.
  const sourceKinds = Array.isArray(facts['source.kinds']) ? facts['source.kinds'].length : 0
  const sourceCount = Math.max(num(facts, 'data.source_count', 1), sourceKinds)
  // LLM calls: output tokens cost about 5x input tokens; the GPUs of a self-hosted model are sized on the output tokens they generate.
  const tokensIn = num(facts, 'ai.tokens_in', 2_000)
  const tokensOut = num(facts, 'ai.tokens_out', 300)
  // The document corpus retrieval searches, split into chunks with one embedding each; a share of it changes every month.
  // Building on existing data embeds the kept records' text next to the documents, unless agents read them live through tools (ai.existing_data).
  const embedsKeptRecords = retrieval && facts['project.origin'] === 'extend_existing' && facts['ai.existing_data'] !== 'live_tools'
  const keptRecordsGb = embedsKeptRecords ? migratedGb(facts).migrated * ref.keptRecordTextShare : 0
  const corpusTokens = retrieval ? (num(facts, 'ai.corpus_gb', 0) + keptRecordsGb) * ref.corpusTokensPerGb : 0
  const corpusVectors = corpusTokens / ref.chunkTokens
  // Embeddings sit in the primary only with pgvector on a PostgreSQL primary; otherwise a vector store, or pgvector in a
  // PostgreSQL of its own beside a non-PostgreSQL primary (services.ts), holds them.
  const vectorsInPrimary = facts['data.primary_db'] === 'postgres' && facts['ai.vector_store'] !== 'managed' && facts['ai.vector_store'] !== 'self_hosted'
  // Replacing a system moves its records into the database and archives older history to object storage;
  // repurchasing moves them into the SaaS product instead, and building on existing data loads them into the analytics lake.
  const source = migratedGb(facts)
  const replacing = facts['profile.replace'] === true
  // Only a CRM has a SaaS target (crm-target) that takes the records; any other repurchase keeps them in the database.
  const kinds = facts['source.kinds']
  const repurchased = facts['migration.approach'] === 'repurchase' && Array.isArray(kinds) && kinds.includes('crm')
  // Retaining keeps the records in the old system, which feeds the new one; nothing is copied in or archived.
  const moved = replacing && facts['migration.approach'] !== 'retain'
  // Each kind lands where it belongs: warehouse and file extracts in the lake (or the raw zone without one), a bought CRM's records in the SaaS product, the rest in the database.
  const hasLake = facts['data.platform'] !== undefined
  const movedFilesGb = moved ? source.files : 0
  const migratedDbGb = moved ? source.main + (repurchased ? 0 : source.crm) : 0
  const archivedGb = (moved ? source.archived : 0) + (hasLake ? 0 : movedFilesGb)
  // A bought CRM keeps the records, and an analytics platform ingests them from it into the lake.
  // Only a design with an analytics platform has a lake to hold them; live tool lookups copy nothing.
  const keptInLake = facts['project.origin'] === 'extend_existing' && facts['ai.existing_data'] !== 'live_tools'
  const migratedLakeGb = keptInLake ? source.migrated : (repurchased && facts['profile.dataPlatform'] === true ? source.crm : 0) + movedFilesGb
  const migratedLakeTb = hasLake ? migratedLakeGb / 1024 : 0
  // Ingested events (profile.events) arrive at a peak rate; the stream keeps them, replicated three times, for the replay window.
  const events = facts['profile.events'] === true
  const peakEventQps = events ? num(facts, 'events.rate', 1_000) : 0
  const eventRetainedGb = events ? ((peakEventQps / peakFactor) * ref.secondsPerDay * num(facts, 'events.retention_days', 7) * num(facts, 'events.payload_kb', 1) * 3) / 1024 / 1024 : 0
  // A measured peak replaces the one derived from daily users; the read:write ratio still splits it.
  const measuredPeakQps = num(facts, 'source.measured_peak_qps', 0)

  // Model calls come from AI usage, not the database write rate: messages users send the assistant (RAG answers count as messages),
  // the reasoning steps of each agent task, one call per changed page an extraction reads, and the rows SQL AI functions enrich.
  const days = 365 / 12
  const messagesMonth = requestPath && ['assistant_chat', 'rag_documents', 'agent_actions'].some(capability) ? dau * num(facts, 'ai.messages_per_user', 5) * days : 0
  // shortcut: with agents chosen every message runs as an agent task, even when plain chat is chosen too; split the messages when both matter.
  const agentTasks = requestPath && capability('agent_actions')
  const chatCallsMonth = messagesMonth * (agentTasks ? ref.agentStepsPerTask : 1)
  const extractedPagesMonth = capability('extraction_batch') ? (num(facts, 'ai.corpus_gb', 0) * num(facts, 'ai.refresh_pct', 0) * 1e4) / 3 : 0
  const enrichedRowsMonth = capability('sql_ai_functions') ? num(facts, 'ai.rows_month', 100_000) : 0
  const batchCallsMonth = extractedPagesMonth + enrichedRowsMonth
  // A row sends a short prompt and gets a label back (reference sqlRowTokens*); the asked token mix applies to messages, agent steps and pages.
  const askedMixCalls = chatCallsMonth + extractedPagesMonth
  const llmCallsMonth = askedMixCalls + enrichedRowsMonth
  const perSecond = (perMonth: number) => perMonth / days / ref.secondsPerDay
  const peakLlmQps = perSecond(chatCallsMonth * peakFactor + batchCallsMonth)

  const avgQps = measuredPeakQps > 0 ? measuredPeakQps / peakFactor : (dau * requestsPerUser) / ref.secondsPerDay
  const writeQps = avgQps / (1 + readRatio)
  const readQps = avgQps - writeQps
  const peakQps = avgQps * peakFactor

  // Large records (pages, documents) live in object storage; the database keeps a metadata row.
  const isBlob = objectKb > ref.blobThresholdKb
  const coldClass = facts['data.storage_class'] === 'cold' || facts['data.storage_class'] === 'archive'
  const rowKb = isBlob ? ref.metadataRowKb : objectKb
  const dbWriteQps = writeQps + locationRowsQps
  // A ping overwrites its client's current-position row: it loads the primary but adds no retained rows or background jobs.
  const writesPerYear = writeQps * ref.secondsPerDay * 365
  const recordGbPerYear = (writesPerYear * rowKb) / 1024 / 1024
  const blobGbPerYear = isBlob ? (writesPerYear * objectKb) / 1024 / 1024 : 0
  const mediaGbPerYear = (dau * mediaUploadsPerUser * 365 * mediaMb) / 1024
  const embeddingGbPerYear = (dau * mediaUploadsPerUser * 365 * chunksPerUpload * ref.embeddingKb) / 1024 / 1024
  const storagePerYearGb = recordGbPerYear + blobGbPerYear + mediaGbPerYear + embeddingGbPerYear
  // The corpus embeddings are stored wherever they live: in the primary or a vector store.
  const corpusEmbeddingGb = (corpusVectors * ref.embeddingKb) / 1024 / 1024
  const totalStorageGb = (storagePerYearGb * retentionYears + corpusEmbeddingGb + migratedDbGb + archivedGb) * ref.replicationFactor
  const primaryEmbeddingGb = vectorsInPrimary ? embeddingGbPerYear * retentionYears + corpusEmbeddingGb : 0
  const dbStorageGb = recordGbPerYear * retentionYears + primaryEmbeddingGb + migratedDbGb
  // A catalog index holds one metadata document per title, not the activity rows; a crawl index keeps only the latest text of each page.
  const corpus = facts['data.search_corpus']
  const searchIndexGb =
    corpus === 'catalog'
      ? (dau * mediaUploadsPerUser * 365 * retentionYears * ref.metadataRowKb) / 1024 / 1024
      : corpus === 'pages'
        ? (writeQps * ref.secondsPerDay * ref.pageRefreshDays * (rowKb + ref.pageTextKb)) / 1024 / 1024
        : dbStorageGb

  const mediaReadMbps = mediaMb > 0 ? ((dau * mediaViewsPerUser * mediaMb) / ref.secondsPerDay) * 8 : 0
  // API responses carry the record row; large blobs are served from object storage or media paths.
  const egressMbps = ((readQps * peakFactor * rowKb) / 1024) * 8 + mediaReadMbps * peakFactor
  // The origin sends API responses to the internet, and media too unless a CDN serves it; billed on the monthly average.
  const cdn = kept('cdn') && (facts['perf.cdn'] === 'pull' || facts['perf.cdn'] === 'push')
  const originAvgMbps = ((readQps * rowKb) / 1024) * 8 + (cdn ? 0 : mediaReadMbps)
  // Background work: fan-out deliveries per write, plus media processing (about 1 job-second per 10 MB).
  const mediaJobsQps = (dau * mediaUploadsPerUser) / ref.secondsPerDay
  const blobWorkSeconds = isBlob ? writeQps * (objectKb / 1024 / 10) : 0
  const mediaWorkSeconds = mediaJobsQps * (mediaMb / 10) + blobWorkSeconds
  const asyncJobsQps = writeQps * fanout + mediaJobsQps
  // Fan-out on write stores each delivery in a follower's cached timeline.
  const timelineWritesQps = features.includes('feed') ? writeQps * fanout : 0

  // 80/20 rule: cache the hot fraction of one day of distinct reads.
  const dailyReadGb = (readQps * ref.secondsPerDay * rowKb) / 1024 / 1024
  const cacheMemoryGb = dailyReadGb * ref.hotDataFraction

  const dbWriteLoad = (dbWriteQps * peakFactor) / (ref.dbPrimaryWriteQps * num(facts, 'data.nodeWriteFactor', 1))
  // Cache misses stay on the primary under strong consistency or without a replica tier, as architecture.ts routes them.
  const replicaTier = kept('db-replica') && (facts['data.replication'] === 'primary_replicas' || facts['data.replication'] === 'multi_primary')
  const cacheHit = kept('cache') && facts['perf.cache'] !== undefined && facts['perf.cache'] !== 'none' ? num(facts, 'perf.cacheHitRatio', 0.8) : 0
  const primaryReadQps = facts['data.strongConsistency'] === true || !replicaTier ? readQps * peakFactor * lookupsPerRead * (1 - cacheHit) : 0
  const analyticsHours = num(facts, 'data.analytics_hours', 8)

  return {
    dau,
    avgQps,
    peakQps,
    readQps,
    writeQps,
    peakReadQps: readQps * peakFactor,
    peakWriteQps: writeQps * peakFactor,
    peakFactor,
    storagePerYearGb,
    totalStorageGb,
    objectStorageGb: (blobGbPerYear + mediaGbPerYear) * retentionYears + archivedGb,
    // shortcut: the lifecycle rule keeps the newest year in the standard class and moves older objects and all archived history; tune it to the read pattern.
    coldObjectStorageGb: coldClass ? (blobGbPerYear + mediaGbPerYear) * Math.max(0, retentionYears - 1) + archivedGb : 0,
    egressMbps,
    originEgressGbMonth: ((originAvgMbps / 8) * ref.secondsPerDay * 365) / 12 / 1024,
    originEgressPeakMbps: originAvgMbps * peakFactor,
    avgMediaEgressMbps: mediaReadMbps,
    cacheMemoryGb,
    concurrentConnections: dau * realtimeShare,
    heartbeatQps: (dau * realtimeShare) / 30,
    peakDbWriteQps: dbWriteQps * peakFactor,
    peakJobsQps: asyncJobsQps * peakFactor,
    peakEventQps,
    eventRetainedGb,
    peakTimelineWriteQps: timelineWritesQps * peakFactor,
    peakUploadQps: (mediaJobsQps + (isBlob ? writeQps : 0)) * peakFactor,
    peakMediaWorkSeconds: mediaWorkSeconds * peakFactor,
    // Without a queue each job costs what a worker spends on it (2 requests), media processing a whole instance per worker-second.
    peakInlineWorkQps: facts['arch.async'] === 'none' ? (asyncJobsQps * 2 + mediaWorkSeconds * ref.appInstanceQps) * peakFactor : 0,
    // Each connected client in a live-location app reports about every 5 s.
    peakLocationQps: locationQps * peakFactor,
    peakRideQps: rideQps * peakFactor,
    peakRealtimeQps: (writeQps + locationQps) * peakFactor,
    peakSearchQps: readQps * peakFactor * searchShare,
    peakLookupQps: readQps * peakFactor * lookupsPerRead,
    dbWriteLoad,
    dbPrimaryLoad: dbWriteLoad + primaryReadQps / ref.dbReplicaReadQps,
    dbStorageGb,
    primaryEmbeddingGb,
    searchIndexGb,
    dbStorageLoad: (dbStorageGb * num(facts, 'data.storeReplicas', 1)) / dbNodeStorageGb(facts, ref),
    lakeStorageTb: (dbStorageGb / 1024 + historyTb + migratedLakeTb) * growth,
    // An app's writes are the changes ingestion copies; a data platform has no request path, so its lake's yearly growth arrives over the months.
    // shortcut: no measured change volume; replace with the sources' real log or extract volume.
    // A data platform has no request path, so its stream and processors carry the lake's own changes: the yearly growth spread over the days,
    // or a daily change share of the lake when it grows slower, in rows of the record size.
    peakIngestQps: requestPath
      ? 0
      : (((dbStorageGb / 1024 + historyTb + migratedLakeTb) * 1_048_576 * 1024 * Math.max((growth - 1) / 365, ref.lakeDailyChangeShare)) / objectKb / ref.secondsPerDay) * peakFactor,
    // The same change volume the stream carries (peakIngestQps), so a flat lake still copies its daily changes across.
    platformChangesGbMonth: requestPath
      ? (writeQps * objectKb * ref.secondsPerDay * days) / 1_048_576
      : ((dbStorageGb / 1024 + historyTb + migratedLakeTb) * 1024 * Math.max((growth - 1) / 365, ref.lakeDailyChangeShare) * 365) / 12,
    // Queries scan as the hourly warehouses bill: in proportion to the hours a day they run.
    scannedTbMonth: (dbStorageGb / 1024 + historyTb + migratedLakeTb) * growth * ref.analyticsScanShare * (analyticsHours / 8) * 30,
    analyticsHours,
    analyticsUsers: num(facts, 'data.analytics_users', 25),
    sourceCount,
    weightedTokensPerCall: llmCallsMonth > 0 ? (askedMixCalls * (tokensIn + 5 * tokensOut) + enrichedRowsMonth * (ref.sqlRowTokensIn + 5 * ref.sqlRowTokensOut)) / llmCallsMonth : tokensIn + 5 * tokensOut,
    llmCallsMonth,
    peakLlmQps,
    peakAgentTaskQps: agentTasks ? perSecond(messagesMonth * peakFactor) : 0,
    peakAgentLlmQps: agentTasks ? perSecond(chatCallsMonth * peakFactor) : 0,
    peakExtractLlmQps: perSecond(extractedPagesMonth),
    peakLlmTokensPerSec: perSecond((chatCallsMonth * peakFactor + extractedPagesMonth) * tokensOut + enrichedRowsMonth * ref.sqlRowTokensOut),
    corpusTokens,
    vectors: dau * mediaUploadsPerUser * 365 * retentionYears * chunksPerUpload + corpusVectors,
    embedTokensMonth: (corpusTokens * num(facts, 'ai.refresh_pct', 0)) / 100 + dau * mediaUploadsPerUser * 30 * chunksPerUpload * ref.chunkTokens,
  }
}

/** Workload metrics exposed to conditions as `cap.*` facts. */
export function workloadFacts(w: Workload, ref: ReferenceNumbers): Facts {
  const computeQps = w.peakQps + w.peakLocationQps + w.peakInlineWorkQps
  return {
    'cap.dau': w.dau,
    'cap.peakQps': w.peakQps,
    // Requests a month at the average rate: what per-request services (API gateways, WAFs, log ingestion) bill.
    'cap.requestsMonth': (w.avgQps * 86_400 * 365) / 12,
    // What the application fleet is sized on: requests, location updates and background work done inside requests.
    'cap.computeQps': computeQps,
    // Above 1 the application needs a second instance at the target utilization (architecture.ts fleet), so a balancer spreads the requests.
    'cap.appFleetLoad': computeQps / (ref.appInstanceQps * ref.targetUtilization),
    // Records above ref.blobThresholdKb, media and archived history: what object storage holds.
    'cap.objectStorageGb': w.objectStorageGb,
    'cap.coldObjectStorageGb': w.coldObjectStorageGb,
    'cap.readQps': w.readQps,
    'cap.writeQps': w.writeQps,
    'cap.peakReadQps': w.peakReadQps,
    'cap.peakWriteQps': w.peakWriteQps,
    'cap.storageGb': w.totalStorageGb,
    'cap.dbStorageGb': w.dbStorageGb,
    'cap.egressMbps': w.egressMbps,
    'cap.originEgressGbMonth': w.originEgressGbMonth,
    'cap.originEgressPeakMbps': w.originEgressPeakMbps,
    'cap.cacheGb': w.cacheMemoryGb,
    'cap.connections': w.concurrentConnections,
    'cap.dbWriteLoad': w.dbWriteLoad,
    'cap.dbPrimaryLoad': w.dbPrimaryLoad,
    'cap.peakJobsQps': w.peakJobsQps,
    'cap.peakTimelineWriteQps': w.peakTimelineWriteQps,
    'cap.peakUploadQps': w.peakUploadQps,
    'cap.heartbeatQps': w.heartbeatQps,
    'cap.peakEventQps': w.peakEventQps,
    'cap.peakIngestQps': w.peakIngestQps,
    'cap.peakSearchQps': w.peakSearchQps,
    'cap.peakLookupQps': w.peakLookupQps,
    'cap.peakLocationQps': w.peakLocationQps,
    'cap.peakRideQps': w.peakRideQps,
    'cap.peakRealtimeQps': w.peakRealtimeQps,
    'cap.dbStorageLoad': w.dbStorageLoad,
    'cap.lakeStorageTb': w.lakeStorageTb,
    'cap.platformChangesGbMonth': w.platformChangesGbMonth,
    'cap.scannedTbMonth': w.scannedTbMonth,
    'cap.analyticsHours': w.analyticsHours,
    'cap.analyticsUsers': w.analyticsUsers,
    'cap.sourceCount': w.sourceCount,
    'cap.weightedTokensPerCall': w.weightedTokensPerCall,
    'cap.llmCallsMonth': w.llmCallsMonth,
    'cap.peakLlmQps': w.peakLlmQps,
    'cap.peakAgentTaskQps': w.peakAgentTaskQps,
    'cap.peakAgentLlmQps': w.peakAgentLlmQps,
    'cap.peakExtractLlmQps': w.peakExtractLlmQps,
    // Calls the services make to the model themselves: everything but agent steps and extraction, which their own runtimes send.
    'cap.peakServiceLlmQps': Math.max(0, w.peakLlmQps - w.peakAgentLlmQps - w.peakExtractLlmQps),
    'cap.peakLlmTokensPerSec': w.peakLlmTokensPerSec,
    'cap.corpusTokens': w.corpusTokens,
    'cap.vectors': w.vectors,
    'cap.embedTokensMonth': w.embedTokensMonth,
  }
}
