import type { Condition, EdgeDef, Protocol } from '../domain/types'
import { f } from '../engine/conditions'
import { cloudPlatformOnpremSource, debeziumOnKafka, hybridAnalytics, liveLookupsFromCloud } from './questions'

const fromCompute = (id: string, owner: string | null, to: string[], label: string, protocol: Protocol, trafficFact?: string): EdgeDef[] => {
  const sources = owner ? ['app', 'functions', owner] : ['@service']
  return sources.map((from) => ({ id: `${id}:${from}`, from, to, label, protocol, trafficFact }))
}

// Calls between services take gRPC when the API decision says so (REST outside, gRPC inside).
const betweenServices = (id: string, from: string, to: string[], label: string, trafficFact?: string, when?: Condition): EdgeDef[] => {
  const scoped = (api: Condition) => (when ? f.all(api, when) : api)
  return [
    { id, from, to, label, protocol: 'http', trafficFact, when: scoped(f.ne('arch.api', 'rest_grpc')) },
    { id: `${id}-grpc`, from, to, label, protocol: 'grpc', trafficFact, when: scoped(f.eq('arch.api', 'rest_grpc')) },
  ]
}

// The private link to a cloud analytics platform (components.ts), and the link a migration crosses.
const analyticsLink = f.all(hybridAnalytics, f.in('data.platform', ['fabric', 'databricks', 'snowflake']))
const migrationLink = f.in('migration.link', ['vpn', 'dedicated_1g', 'dedicated_10g'])
const linkedChanges = f.any(migrationLink, f.eq('migration.link', 'offline_device'))
const replacing = f.eq('profile.replace', true)
// Retaining keeps the old system as a system of record, so it feeds the new one for good instead of handing its data over once.
const retained = f.eq('migration.approach', 'retain')
const parallelRun = f.eq('migration.strategy', 'parallel_run')

const ingressChain = ['waf', 'lb', 'api-gateway', '@service']
// Only a full-duplex WebSocket carries what clients send; with SSE or long polling they send plain HTTP requests.
const duplex = f.eq('perf.realtime', 'websocket')
// A graph service makes the reads itself (primer: user graph service), so the compute tier reads the stores directly only without one.
const readsDirectly = f.not(f.has('graph-service'))
// Retrieval, or AI capabilities still pending (only an app retrieves before they are chosen, as components.ts reads it).
const retrieval = f.any(f.all(f.ne('profile.requestPath', false), f.not(f.exists('ai.capabilities'))), f.inc('ai.capabilities', 'rag_documents'))
const noApp = f.eq('profile.requestPath', false)

export const edges: EdgeDef[] = [
  { id: 'resolve', from: 'client', to: ['dns'], label: 'DNS lookup', protocol: 'dns' },
  { id: 'static', from: 'client', to: ['cdn'], label: 'Static and media', protocol: 'http', trafficFact: 'cap.peakReadQps' },
  { id: 'api', from: 'client', to: ingressChain, label: 'API requests', protocol: 'http', trafficFact: 'flow.httpQps', when: f.ne('arch.api', 'graphql') },
  // GraphQL sends every query to one endpoint, behind the same edge protection and load balancer.
  { id: 'api-graphql', from: 'client', to: ingressChain, label: 'GraphQL queries (one endpoint)', protocol: 'http', trafficFact: 'flow.httpQps', when: f.eq('arch.api', 'graphql') },
  { id: 'waf-next', from: 'waf', to: ['lb', 'api-gateway', '@service'], label: 'Filtered requests', protocol: 'http', trafficFact: 'flow.httpQps' },
  { id: 'lb-next', from: 'lb', to: ['api-gateway', '@service'], label: 'Balanced requests', protocol: 'http', trafficFact: 'flow.httpQps' },
  { id: 'gw-next', from: 'api-gateway', to: ['@service'], label: 'Routed requests', protocol: 'http', trafficFact: 'flow.httpQps', when: f.ne('arch.api', 'rest_grpc') },
  { id: 'gw-next-grpc', from: 'api-gateway', to: ['@service'], label: 'gRPC calls (protobuf over HTTP/2)', protocol: 'grpc', trafficFact: 'flow.httpQps', when: f.eq('arch.api', 'rest_grpc') },
  // Connections to an own gateway fleet enter through the same edge protection, and the load balancer spreads them over the gateway nodes.
  // They carry client messages only over a WebSocket (flow.realtimeQps); SSE and long-polling clients send theirs on the HTTP flows.
  { id: 'realtime', from: 'client', to: ['waf', 'lb', 'ws-gateway'], label: 'Persistent connection', protocol: 'ws', trafficFact: 'flow.realtimeQps', when: f.has('ws-gateway') },
  { id: 'realtime-waf', from: 'waf', to: ['lb', 'ws-gateway'], label: 'Filtered connections', protocol: 'ws', trafficFact: 'flow.realtimeQps', when: f.has('ws-gateway') },
  { id: 'realtime-lb', from: 'lb', to: ['ws-gateway'], label: 'Balanced connections', protocol: 'ws', trafficFact: 'flow.realtimeQps' },
  { id: 'realtime-managed', from: 'client', to: ['realtime-service'], label: 'Persistent connection', protocol: 'ws', trafficFact: 'cap.peakRealtimeQps' },
  // Over a WebSocket, writes arrive on the connection instead of the HTTP path (flow.httpQps), split over the services like the gateway's requests.
  { id: 'realtime-route', from: 'ws-gateway', to: ['@service'], label: 'Inbound messages', protocol: 'ws', trafficFact: 'cap.peakWriteQps', when: duplex },
  // Without a location service, the application takes the location updates itself.
  { id: 'realtime-location', from: 'ws-gateway', to: ['svc-geo', 'app', 'functions'], label: 'Location updates', protocol: 'ws', trafficFact: 'cap.peakLocationQps', when: f.all(f.gt('cap.peakLocationQps', 0), duplex) },
  // With SSE or long polling, live-tracking clients post their location over HTTP through the same ingress.
  ...['client', 'waf', 'lb', 'api-gateway'].map((from, i, hops): EdgeDef => ({
    id: `location-http:${from}`,
    from,
    to: [...hops.slice(i + 1), 'svc-geo', 'app', 'functions'],
    label: 'Location updates',
    protocol: 'http',
    trafficFact: 'cap.peakLocationQps',
    when: f.all(f.gt('cap.peakLocationQps', 0), f.has('ws-gateway'), f.not(duplex)),
  })),
  { id: 'realtime-pubsub', from: 'ws-gateway', to: ['presence', 'cache'], label: 'Presence and pub/sub', protocol: 'query', trafficFact: 'cap.peakWriteQps' },
  // Heartbeats add to the same drawn flow, which then carries what presence is sized on.
  { id: 'realtime-heartbeat', from: 'ws-gateway', to: ['presence'], label: 'Heartbeats', protocol: 'query', trafficFact: 'cap.heartbeatQps' },
  { id: 'realtime-publish', from: '@service', to: ['realtime-service'], label: 'Publish events', protocol: 'http', trafficFact: 'cap.peakWriteQps' },
  { id: 'cdn-origin', from: 'cdn', to: ['object-storage'], label: 'Origin fetch (misses)', protocol: 'http' },
  // The transfer meters: responses leave the compute tier over the internet link, outbound API calls through the NAT gateway.
  { id: 'internet-out', from: '@service', to: ['internet-egress'], label: 'Responses to the internet (billed per GB)', protocol: 'http' },
  { id: 'nat-out', from: '@service', to: ['nat-gateway'], label: 'Outbound API calls (billed per GB)', protocol: 'http' },

  ...fromCompute('cache', null, ['cache'], 'Cache reads', 'query', 'cap.peakLookupQps').map((x) => ({ ...x, when: readsDirectly })),
  ...fromCompute('db', null, ['db-primary'], 'Reads and writes', 'query', 'cap.peakWriteQps'),
  ...fromCompute('tenant-db', null, ['tenant-databases'], 'Tenant records (routed by the tenant catalog)', 'query'),
  // Cache misses that no replica may serve add to the same drawn flow.
  ...fromCompute('db-read', null, ['db-primary'], 'Reads and writes', 'query', 'flow.primaryReadQps').map((x) => ({ ...x, when: readsDirectly })),
  ...fromCompute('replica', null, ['db-replica'], 'Read queries', 'query', 'flow.replicaReadQps').map((x) => ({ ...x, when: f.all(f.ne('data.strongConsistency', true), readsDirectly) })),
  ...fromCompute('auth', 'svc-users', ['auth'], 'Token validation', 'http'),
  ...fromCompute('search', 'svc-search', ['search'], 'Search queries', 'query', 'flow.searchQps'),
  // The client puts the bytes straight into the bucket with a URL the application signed (system-design-101: upload a large file to S3).
  // Object storage that holds only a replaced system's archived history takes no uploads (components.ts: object-storage).
  { id: 'upload', from: 'client', to: ['object-storage'], label: 'Pre-signed uploads', protocol: 'http', trafficFact: 'cap.peakUploadQps', when: f.any(f.inc('product.features', 'media'), f.has('cdn'), f.inc('product.features', 'jobs'), f.gt('cap.peakUploadQps', 0)) },
  ...fromCompute('geo', 'svc-geo', ['geo-index'], 'Location updates and proximity queries', 'query', 'cap.peakLocationQps'),
  // PostGIS keeps the positions in the primary, so every location update is a database write (workload: peakDbWriteQps).
  ...fromCompute('geo-db', 'svc-geo', ['db-primary'], 'Location updates and proximity queries (PostGIS)', 'query', 'cap.peakLocationQps').map((x) => ({ ...x, when: f.eq('data.geo_index', 'postgis') })),
  ...fromCompute('pay', 'svc-payments', ['payment-psp'], 'Charges (idempotency keys)', 'http'),
  ...fromCompute('ledger', 'svc-payments', ['ledger'], 'Ledger entries', 'query'),
  // Every read is scored and reads split evenly over the services, so each service scores its own share.
  ...fromCompute('ml', null, ['ml-inference'], 'Scoring', 'grpc', 'cap.peakReadQps'),
  // One completion answers each message users send the assistant (ai.messages_per_user); agent steps and extraction reach the model from their own runtimes.
  // A gateway, when present, routes every call to the model, the rate the provider bills.
  ...fromCompute('llm', 'svc-core', ['llm-gateway', 'llm-serving', 'llm-api'], 'Completions', 'http', 'cap.peakServiceLlmQps'),
  { id: 'llm-route', from: 'llm-gateway', to: ['llm-serving', 'llm-api'], label: 'Routed completions (fallback, quotas)', protocol: 'http', trafficFact: 'cap.peakLlmQps' },
  // ChatGPT moderates the prompt before the model and the answer after it.
  ...fromCompute('guard', 'svc-core', ['guardrails'], 'Input and output moderation', 'http'),
  ...fromCompute('ai-trace', 'svc-core', ['eval-tracing'], 'Prompt and answer traces', 'telemetry'),
  // Agents plan with the model and act through the tool gateway, which calls the services' own APIs.
  ...fromCompute('agent', 'svc-core', ['agent-runtime'], 'Agent tasks', 'async', 'cap.peakAgentTaskQps'),
  { id: 'agent-llm', from: 'agent-runtime', to: ['llm-gateway', 'llm-serving', 'llm-api'], label: 'Reasoning steps', protocol: 'http', trafficFact: 'cap.peakAgentLlmQps' },
  { id: 'agent-tools', from: 'agent-runtime', to: ['tool-gateway'], label: 'Tool calls', protocol: 'http' },
  { id: 'tool-calls', from: 'tool-gateway', to: ['@service'], label: 'Authorized tool calls (internal APIs)', protocol: 'http' },
  // Agents built on existing data may read the kept system itself through read-only tools (ai.existing_data).
  // shortcut: the network path from the cloud to a kept on-premises system (VPN or private link) is not drawn or priced here; add it when the source stays on premises.
  // Lookups from the cloud into a system kept in the data center cross the private link.
  { id: 'tool-kept-system', from: 'tool-gateway', to: ['legacy-db', 'legacy-crm', 'legacy-saas'], label: 'Read-only record lookups', protocol: 'query', when: f.all(f.in('ai.existing_data', ['live_tools', 'both']), f.not(f.all(liveLookupsFromCloud, f.has('hybrid-link')))) },
  { id: 'tool-link', from: 'tool-gateway', to: ['hybrid-link'], label: 'Read-only record lookups', protocol: 'query', when: liveLookupsFromCloud },
  { id: 'link-kept-system', from: 'hybrid-link', to: ['legacy-db', 'legacy-crm'], label: 'Lookups over the private link', protocol: 'query', when: liveLookupsFromCloud },
  // Documents are parsed and chunked, then embedded into the vector store (or the PostgreSQL primary with pgvector).
  // With a job queue the workers hand documents to parsing, so OCR and extraction never run inside a request.
  ...fromCompute('docs', 'svc-core', ['doc-ingestion'], 'Documents to parse', 'async').map((e) => ({ ...e, when: f.not(f.has('queue')) })),
  { id: 'worker-docs', from: '@worker', to: ['doc-ingestion'], label: 'Documents to parse', protocol: 'async', when: f.has('queue') },
  { id: 'docs-embed', from: 'doc-ingestion', to: ['embeddings'], label: 'Embed new and changed chunks', protocol: 'http' },
  { id: 'docs-backfill', from: 'doc-ingestion', to: ['embeddings-backfill'], label: 'Embed the corpus once', protocol: 'http' },
  { id: 'docs-parse-backfill', from: 'doc-ingestion', to: ['doc-ingestion-backfill'], label: 'Parse the corpus once', protocol: 'http' },
  { id: 'docs-index', from: 'doc-ingestion', to: ['vector-db', 'db-primary'], label: 'Chunks and vectors', protocol: 'query', when: f.has('embeddings') },
  { id: 'docs-extract', from: 'doc-ingestion', to: ['llm-gateway', 'llm-serving', 'llm-api'], label: 'Extract fields', protocol: 'http', trafficFact: 'cap.peakExtractLlmQps', when: f.inc('ai.capabilities', 'extraction_batch') },
  // Only LLM features retrieve by similarity; with PostgreSQL the embeddings live in the primary.
  ...fromCompute('rag', 'svc-core', ['vector-db', 'db-primary'], 'Similarity search (embeddings)', 'query').map((x) => ({ ...x, when: f.all(f.eq('profile.llm', true), retrieval) })),
  ...fromCompute('enqueue', null, ['queue', 'stream'], 'Enqueue jobs / publish events', 'async', 'cap.peakJobsQps'),
  // Jobs go to the queue, so a stream next to it (streaming analytics) needs its own producer.
  { id: 'publish-stream', from: '@service', to: ['stream'], label: 'Publish events', protocol: 'async', trafficFact: 'cap.peakWriteQps', when: f.has('queue') },

  // Dispatch asks the location service for drivers near each ride request; a monolith queries the geo index itself (the 'geo' flow).
  ...betweenServices('dispatch', 'svc-dispatch', ['svc-geo'], 'Nearby drivers', 'cap.peakRideQps'),
  ...betweenServices('charge-trip', 'svc-dispatch', ['svc-payments'], 'Charge completed trips'),
  ...betweenServices('charge', 'svc-core', ['svc-payments'], 'Charge payments', undefined, f.not(f.has('svc-dispatch'))),
  // Primer Twitter: the timeline service multigets user info from the user service.
  ...betweenServices('user-info', 'svc-feed', ['svc-users'], 'User info multiget'),
  ...fromCompute('graph', null, ['graph-service'], 'Friend traversals', 'grpc', 'cap.peakReadQps'),
  // The traversal reads go where the compute tier's would: the cache first, then whichever database tier takes the misses.
  { id: 'graph-cache', from: 'graph-service', to: ['cache'], label: 'Popular paths', protocol: 'query', trafficFact: 'cap.peakLookupQps' },
  { id: 'graph-store', from: 'graph-service', to: ['db-replica'], label: 'Adjacency lists', protocol: 'query', trafficFact: 'flow.replicaReadQps', when: f.ne('data.strongConsistency', true) },
  { id: 'graph-store-primary', from: 'graph-service', to: ['db-primary'], label: 'Adjacency lists', protocol: 'query', trafficFact: 'flow.primaryReadQps', when: f.any(f.eq('data.strongConsistency', true), f.not(f.has('db-replica'))) },
  { id: 'events-warehouse', from: '@service', to: ['warehouse'], label: 'Access and event logs', protocol: 'async', when: f.eq('data.analytics', 'warehouse') },
  // The database keeps the job's output, so an evicted or restarted cache node can reload it.
  { id: 'ml-batch-write', from: 'ml-batch', to: ['db-primary'], label: 'Precomputed recommendations', protocol: 'query' },
  { id: 'ml-batch-warm', from: 'ml-batch', to: ['cache'], label: 'Warm recommendations cache', protocol: 'query' },
  // Spark training jobs read the lake tables directly when no SQL warehouse is drawn (models with no reporting), through the catalog.
  { id: 'ml-batch-read', from: 'ml-batch', to: ['warehouse', 'lake-storage', 'db-replica', 'db-primary'], label: 'Viewing history', protocol: 'query' },
  { id: 'ml-batch-metadata', from: 'ml-batch', to: ['catalog'], label: 'Table metadata', protocol: 'query', when: f.not(f.has('warehouse')) },
  { id: 'ingest-commits', from: 'ingestion', to: ['catalog'], label: 'Table commits', protocol: 'query', when: f.not(f.has('warehouse')) },
  { id: 'psp-webhook', from: 'payment-psp', to: ['api-gateway', 'lb', '@service'], label: 'Webhooks', protocol: 'async' },
  { id: 'schedule', from: 'scheduler', to: ['queue', 'stream', 'workers'], label: 'Scheduled jobs', protocol: 'async' },
  { id: 'consume-queue', from: 'queue', to: ['@worker'], label: 'Consume jobs', protocol: 'async', trafficFact: 'cap.peakJobsQps' },
  // Next to a job queue the stream feeds only the stream processor.
  { id: 'consume-stream', from: 'stream', to: ['@worker'], label: 'Consume events', protocol: 'async', trafficFact: 'cap.peakJobsQps', when: f.not(f.has('queue')) },
  { id: 'stream-process', from: 'stream', to: ['stream-processor'], label: 'Event stream', protocol: 'async', trafficFact: 'flow.streamQps' },
  { id: 'stream-sink', from: 'stream-processor', to: ['warehouse', 'db-primary'], label: 'Aggregates', protocol: 'async' },
  // Ingested events enter the stream through its own endpoint, not through the request path.
  { id: 'device-events', from: 'client', to: ['stream'], label: 'Device and service events', protocol: 'async', trafficFact: 'cap.peakEventQps', when: f.all(f.eq('profile.events', true), f.not(f.has('device-gateway'))) },
  // Field devices connect to the device gateway, which forwards their readings to the stream.
  { id: 'device-connect', from: 'client', to: ['device-gateway'], label: 'MQTT readings, one certificate per device', protocol: 'async', trafficFact: 'cap.peakEventQps' },
  { id: 'device-forward', from: 'device-gateway', to: ['stream'], label: 'Readings forwarded by rules', protocol: 'async', trafficFact: 'cap.peakEventQps' },
  // The app publishes record changes to the connectors; a data platform syncs its results back out (reverse ETL).
  ...fromCompute('integration-out', null, ['integration-hub'], 'Record changes to sync', 'async'),
  { id: 'integration-reverse-etl', from: 'warehouse', to: ['integration-hub'], label: 'Reverse ETL to outside systems', protocol: 'async', when: f.eq('profile.requestPath', false) },
  { id: 'integration-sync', from: 'integration-hub', to: ['connected-systems'], label: 'Connector sync (APIs, webhooks, files)', protocol: 'http' },
  { id: 'worker-db', from: '@worker', to: ['db-primary'], label: 'Persist results', protocol: 'query' },
  { id: 'worker-media', from: '@worker', to: ['object-storage'], label: 'Thumbnails and exports', protocol: 'http', when: f.has('object-storage') },
  { id: 'worker-notify', from: '@worker', to: ['notify-provider'], label: 'Deliver notifications', protocol: 'http' },
  { id: 'worker-import', from: '@worker', to: ['bank-aggregator'], label: 'Pull transactions', protocol: 'http' },
  // A crawler indexes the text it fetched; the database keeps only a metadata row (primer: Reverse Index Service queue).
  { id: 'worker-index', from: '@worker', to: ['search'], label: 'Index page text', protocol: 'async', trafficFact: 'cap.peakWriteQps', when: f.eq('data.search_corpus', 'pages') },
  // Batch recommendations have their own writer (ml-batch), so only feed fan-out precomputes into the cache here.
  { id: 'worker-cache', from: '@worker', to: ['cache'], label: 'Precomputed results', protocol: 'query', trafficFact: 'cap.peakTimelineWriteQps', when: f.inc('product.features', 'feed') },
  { id: 'worker-realtime', from: '@worker', to: ['ws-gateway'], label: 'Push to online users', protocol: 'ws', when: f.inc('product.features', 'notifications') },
  { id: 'cdc-search', from: 'db-primary', to: ['search'], label: 'Change data capture', protocol: 'cdc', when: f.ne('data.search_corpus', 'pages') },
  { id: 'replicate', from: 'db-primary', to: ['db-replica'], label: 'Replication', protocol: 'replication', trafficFact: 'cap.peakWriteQps', when: f.ne('data.strongConsistency', true) },
  { id: 'replicate-sync', from: 'db-primary', to: ['db-replica'], label: 'Synchronous replication (commit waits for the standby)', protocol: 'replication', trafficFact: 'cap.peakWriteQps', when: f.eq('data.strongConsistency', true) },
  // The ingestion component takes over the copy once the analytics platform is chosen.
  { id: 'etl', from: 'db-primary', to: ['warehouse'], label: 'Change data capture to warehouse', protocol: 'cdc', when: f.all(f.eq('data.analytics', 'warehouse'), f.not(f.has('ingestion'))) },
  { id: 'ingest-source', from: 'db-primary', to: ['ingestion'], label: 'CDC / extract', protocol: 'cdc' },
  // A data platform reads the source systems; events and change logs that must be seconds fresh go through the stream.
  // A cloud platform reads databases in the data center over the private link.
  { id: 'ingest-sources', from: 'sources', to: ['ingestion'], label: 'CDC / extract', protocol: 'cdc', when: f.not(cloudPlatformOnpremSource) },
  { id: 'sources-link', from: 'sources', to: ['hybrid-link'], label: 'CDC / extract', protocol: 'cdc', when: cloudPlatformOnpremSource },
  ...['ingestion', 'ingestion-db'].map((id): EdgeDef => ({ id: `link-extract-${id}`, from: 'hybrid-link', to: [id], label: 'Extracts over the private link', protocol: 'cdc', when: cloudPlatformOnpremSource })),
  { id: 'source-events', from: 'sources', to: ['stream'], label: 'Change events and telemetry', protocol: 'async', trafficFact: 'cap.peakIngestQps' },
  { id: 'cdc-kafka', from: 'ingestion', to: ['stream'], label: 'Change events through Kafka Connect', protocol: 'async', when: debeziumOnKafka },
  // Pipelines hold the source credentials; on a request path the services read the secrets (below).
  { id: 'source-credentials', from: 'ingestion', to: ['secrets'], label: 'Source credentials', protocol: 'telemetry', when: f.eq('profile.requestPath', false) },
  // Without an application, the warehouse calls the model from SQL (Databricks ai_query, Snowflake Cortex, BigQuery ML.GENERATE_TEXT, Fabric AI functions).
  { id: 'warehouse-llm', from: 'warehouse', to: ['llm-serving', 'llm-api'], label: 'AI functions in SQL', protocol: 'http', trafficFact: 'cap.peakLlmQps', when: noApp },
  // A data platform's RAG index: documents in the lake are parsed and embedded, and queries search the vectors; its model calls are traced.
  { id: 'lake-docs', from: 'lake-storage', to: ['doc-ingestion'], label: 'Documents and table text to index', protocol: 'async', when: noApp },
  { id: 'warehouse-rag', from: 'warehouse', to: ['vector-db'], label: 'Similarity search (embeddings)', protocol: 'query', when: noApp },
  { id: 'warehouse-trace', from: 'warehouse', to: ['eval-tracing'], label: 'Model call traces', protocol: 'telemetry', when: noApp },
  // In a hybrid design the loads leave the data center over the private link first; a link that carries only a migration does not take them.
  { id: 'ingest-load', from: 'ingestion', to: ['lake-storage', 'warehouse'], label: 'Loads', protocol: 'async', when: f.not(analyticsLink) },
  // Each per-kind path beside the main ingestion reads its sources and loads the same lake or warehouse.
  ...['ingestion-db', 'ingestion-saas', 'ingestion-files', 'ingestion-events'].flatMap((id): EdgeDef[] => [
    { id: `${id}-extract`, from: 'sources', to: [id], label: id === 'ingestion-db' ? 'Change data capture' : 'Extract', protocol: 'cdc', ...(id === 'ingestion-db' && { when: f.not(cloudPlatformOnpremSource) }) },
    { id: `${id}-load`, from: id, to: ['lake-storage', 'warehouse'], label: 'Loads', protocol: 'async', when: f.not(analyticsLink) },
    { id: `${id}-load-link`, from: id, to: ['hybrid-link'], label: 'Loads', protocol: 'async', when: analyticsLink },
  ]),
  { id: 'ingest-load-link', from: 'ingestion', to: ['hybrid-link'], label: 'Loads', protocol: 'async', when: analyticsLink },
  { id: 'hybrid-load', from: 'hybrid-link', to: ['lake-storage', 'warehouse'], label: 'Loads over the private link', protocol: 'async', when: analyticsLink },
  // Migration: the snapshot and the change stream cross the link, load the new database, and reverse replication keeps the old one current for a rollback.
  // A hybrid design's migration crosses its own link (migration-link), so the analytics link carries it only when that link is excluded.
  { id: 'link-snapshot', from: 'hybrid-link', to: ['bulk-loader'], label: 'Snapshot over the link', protocol: 'async', when: f.all(migrationLink, f.not(f.has('migration-link'))) },
  { id: 'migration-link-snapshot', from: 'migration-link', to: ['bulk-loader'], label: 'Snapshot over the link', protocol: 'async', when: migrationLink },
  // After an offline device load the change stream still crosses a network link (components.ts: hybrid-link).
  { id: 'link-changes', from: 'hybrid-link', to: ['cdc-pipeline'], label: 'Change stream over the link', protocol: 'cdc', when: f.all(linkedChanges, f.not(f.has('migration-link'))) },
  { id: 'migration-link-changes', from: 'migration-link', to: ['cdc-pipeline'], label: 'Change stream over the link', protocol: 'cdc', when: linkedChanges },
  // Replacing a system loads its records into the new database, or into the SaaS CRM bought to replace it; building on existing data loads them into the analytics lake (workload.ts).
  { id: 'bulk-snapshot', from: 'bulk-loader', to: ['crm-target', 'db-primary', 'lake-storage', 'warehouse'], label: 'Initial snapshot', protocol: 'async', when: replacing },
  // A bought SaaS CRM takes records only through its import APIs (bulk-snapshot), so no change stream applies to it.
  { id: 'cdc-apply', from: 'cdc-pipeline', to: ['db-primary', 'lake-storage', 'warehouse'], label: 'Apply changes', protocol: 'cdc', when: f.all(replacing, f.not(retained), f.not(parallelRun)) },
  // A parallel run feeds both systems the same inputs, so the change stream only loads the history and stops when the mirror starts.
  { id: 'cdc-initial-load', from: 'cdc-pipeline', to: ['db-primary', 'lake-storage', 'warehouse'], label: 'History and catch-up, stopped when the mirror starts', protocol: 'cdc', when: f.all(replacing, f.not(retained), parallelRun) },
  { id: 'cdc-feed', from: 'cdc-pipeline', to: ['db-primary', 'lake-storage', 'warehouse'], label: 'Permanent change feed from the retained system', protocol: 'cdc', when: f.all(replacing, retained) },
  // Building on existing data lands the extracts in the raw zone, which feeds the warehouse and the retrieval index.
  { id: 'bulk-snapshot-lake', from: 'bulk-loader', to: ['landing-zone', 'lake-storage', 'warehouse', 'db-primary'], label: 'Initial snapshot', protocol: 'async', when: f.not(replacing) },
  { id: 'cdc-apply-lake', from: 'cdc-pipeline', to: ['landing-zone', 'lake-storage', 'warehouse', 'db-primary'], label: 'Apply changes', protocol: 'cdc', when: f.not(replacing) },
  { id: 'landing-warehouse', from: 'landing-zone', to: ['warehouse', 'lake-storage'], label: 'Curated loads', protocol: 'async', when: f.not(replacing) },
  // Without a platform ingestion the curated tables land in the lake from the raw zone.
  { id: 'landing-lake', from: 'landing-zone', to: ['lake-storage'], label: 'Curated tables', protocol: 'async', when: f.all(f.not(replacing), f.not(f.has('ingestion'))) },
  // The records are chunked and embedded like the documents, then stored wherever the vectors live (docs-index).
  { id: 'landing-vectors', from: 'landing-zone', to: ['doc-ingestion'], label: 'Records to embed for retrieval', protocol: 'async', when: f.all(f.not(replacing), f.has('embeddings')) },
  // Replacing loads the staged files and API extracts into the new database.
  { id: 'landing-load', from: 'landing-zone', to: ['bulk-loader', 'db-primary'], label: 'Staged extracts to load', protocol: 'async', when: replacing },
  // The existing systems: where the snapshot, the changes and the extracts leave from, and the routes a strangler facade still sends back.
  { id: 'legacy-log', from: 'legacy-db', to: ['cdc-pipeline'], label: 'Transaction log', protocol: 'cdc', trafficFact: 'mig.cdcChangesQps' },
  { id: 'legacy-export', from: 'legacy-db', to: ['bulk-loader'], label: 'Export (dump or full load)', protocol: 'async' },
  { id: 'legacy-files', from: 'file-source', to: ['landing-zone'], label: 'DataSync / AzCopy / Storage Transfer', protocol: 'async' },
  { id: 'legacy-crm-extract', from: 'legacy-crm', to: ['api-extractor'], label: 'Bulk API snapshot + change events', protocol: 'async' },
  { id: 'legacy-saas-extract', from: 'legacy-saas', to: ['api-extractor'], label: 'Bulk APIs + change events', protocol: 'async' },
  { id: 'crm-raw', from: 'api-extractor', to: ['landing-zone'], label: 'Raw extracts', protocol: 'async' },
  { id: 'crm-import', from: 'legacy-crm', to: ['crm-target'], label: 'Records imported into the new CRM', protocol: 'async' },
  // A bought CRM is the whole system its users work in, with no request path of the design's own.
  { id: 'crm-users', from: 'client', to: ['crm-target'], label: 'Sales users', protocol: 'http', when: noApp },
  // A bought CRM stays a source: the analytics platform extracts its records, and an AI app indexes them for retrieval.
  { id: 'crm-target-storage', from: 'crm-target', to: ['crm-storage'], label: 'Records beyond the included storage', protocol: 'query' },
  { id: 'crm-target-ingest', from: 'crm-target', to: ['ingestion'], label: 'CRM records (bulk API / connector)', protocol: 'cdc' },
  { id: 'crm-target-docs', from: 'crm-target', to: ['doc-ingestion'], label: 'CRM records and notes to index', protocol: 'async' },
  // A parallel run tees every request at the entry point to the old system, which keeps writing its own store.
  { id: 'mirror-tee', from: 'api-gateway', to: ['request-mirror'], label: 'Copy of every request', protocol: 'http', trafficFact: 'flow.httpQps' },
  { id: 'mirror-tee-lb', from: 'lb', to: ['request-mirror'], label: 'Copy of every request', protocol: 'http', trafficFact: 'flow.httpQps', when: f.not(f.has('api-gateway')) },
  { id: 'mirror-legacy', from: 'request-mirror', to: ['legacy-app', 'legacy-db'], label: 'Mirrored inputs to the old system', protocol: 'http', trafficFact: 'flow.httpQps' },
  { id: 'strangler-legacy', from: 'api-gateway', to: ['legacy-app'], label: 'Routes not yet migrated', protocol: 'http', when: f.eq('migration.strategy', 'strangler') },
  { id: 'legacy-app-db', from: 'legacy-app', to: ['legacy-db'], label: 'Reads and writes', protocol: 'query' },
  // A home-grown CRM is an application on its own database.
  { id: 'legacy-crm-db', from: 'legacy-crm', to: ['legacy-db'], label: 'Reads and writes', protocol: 'query', when: f.eq('source.crmOnDatabase', true) },
  { id: 'reconcile-source', from: 'reconciliation-job', to: ['legacy-db', 'legacy-crm', 'file-source', 'legacy-saas'], label: 'Source row counts and checksums', protocol: 'query' },
  { id: 'legacy-bill', from: 'legacy-run', to: ['legacy-app', 'legacy-db', 'legacy-crm', 'file-source', 'legacy-saas'], label: 'Bills the old system', protocol: 'telemetry' },
  // Moving only recent years archives the older history to object storage ahead of the cutover (workload.ts).
  ...['bulk-loader', 'api-extractor'].map((from): EdgeDef => ({ id: `archive:${from}`, from, to: ['object-storage'], label: 'Older history to the archive', protocol: 'async', when: f.all(f.eq('profile.retire', true), f.eq('source.history', 'recent')) })),
  { id: 'one-off-transfer', from: 'transfer-fees', to: ['bulk-loader'], label: 'Device jobs', protocol: 'async' },
  { id: 'source-egress', from: 'source-egress', to: ['bulk-loader'], label: 'Billed egress', protocol: 'async' },
  { id: 'migration-work', from: 'migration-engineering', to: ['legacy-db', 'legacy-app', 'legacy-crm', 'file-source', 'legacy-saas', 'db-primary'], label: 'Conversion, field mapping and parallel-run tests', protocol: 'telemetry' },
  { id: 'cdc-reverse', from: 'db-primary', to: ['cdc-pipeline'], label: 'Reverse replication for rollback', protocol: 'cdc', when: f.eq('migration.rollback', 'reverse_cdc') },
  // Waves or routes already moved write to the new database while the rest still use the old one, so CDC runs both ways during coexistence.
  { id: 'cdc-back-sync', from: 'db-primary', to: ['cdc-pipeline'], label: 'Writes of migrated waves or routes, back to the old system', protocol: 'cdc', when: f.all(f.in('migration.strategy', ['phased', 'strangler']), f.ne('migration.rollback', 'reverse_cdc')) },
  { id: 'cdc-reverse-apply', from: 'cdc-pipeline', to: ['legacy-db'], label: 'Reverse changes applied to the old system', protocol: 'cdc', when: f.any(f.eq('migration.rollback', 'reverse_cdc'), f.in('migration.strategy', ['phased', 'strangler'])) },
  // The target side of the check is where the records land: the new database (or SaaS CRM) when replacing, the warehouse when building on existing data.
  { id: 'reconcile', from: 'reconciliation-job', to: ['crm-target', 'db-primary', 'lake-storage', 'warehouse'], label: 'Row counts and checksums', protocol: 'query', when: replacing },
  { id: 'reconcile-lake', from: 'reconciliation-job', to: ['warehouse', 'lake-storage', 'landing-zone', 'db-primary'], label: 'Row counts and checksums', protocol: 'query', when: f.not(replacing) },
  { id: 'ingest-transfer', from: 'ingestion', to: ['platform-egress'], label: 'Changes copied across sites (billed per GB)', protocol: 'async' },
  // Without a platform ingestion (the existing system is the only source) the orchestrator schedules that system's feed.
  { id: 'orchestrate', from: 'orchestrator', to: ['ingestion', 'cdc-pipeline', 'bulk-loader', 'api-extractor'], label: 'Schedules', protocol: 'async' },
  // With no application to trigger them, the orchestrator also runs the training and scoring jobs.
  { id: 'orchestrate-ml', from: 'orchestrator', to: ['ml-batch'], label: 'Training and scoring runs', protocol: 'async', when: f.eq('profile.requestPath', false) },
  { id: 'lake-scan', from: 'lake-storage', to: ['warehouse'], label: 'Table scans', protocol: 'query' },
  { id: 'table-metadata', from: 'warehouse', to: ['catalog'], label: 'Table metadata', protocol: 'query' },
  { id: 'dashboards', from: 'warehouse', to: ['bi'], label: 'Dashboards', protocol: 'query' },
  // Without a request path (a data platform) the people in the design are the report readers.
  { id: 'bi-readers', from: 'client', to: ['bi'], label: 'Reports and dashboards', protocol: 'http', when: f.eq('profile.requestPath', false) },
  { id: 'stream-lake', from: 'stream-processor', to: ['lake-storage'], label: 'Streaming writes', protocol: 'async' },
  { id: 'dr-replicate', from: 'db-primary', to: ['standby-region', 'peer-region', 'extra-sites'], label: 'Cross-region replication', protocol: 'replication', trafficFact: 'cap.peakWriteQps' },
  { id: 'dr-ledger', from: 'ledger', to: ['standby-region', 'peer-region', 'extra-sites'], label: 'Cross-region replication', protocol: 'replication' },
  // Blobs and media are most of the stored bytes, so the second region needs its own copy of the bucket.
  { id: 'lifecycle', from: 'object-storage', to: ['cold-storage'], label: 'Lifecycle rule moves objects past a year', protocol: 'async' },
  { id: 'dr-objects', from: 'object-storage', to: ['standby-region', 'peer-region', 'extra-sites'], label: 'Cross-region object replication', protocol: 'replication', trafficFact: 'cap.peakUploadQps' },
  // An active peer serves the users routed to it and replicates the writes it takes back. The drawn rates put the full peak
  // on this region, the load each region is sized for, so these two flows carry no separate share.
  { id: 'peer-users', from: 'client', to: ['peer-region'], label: 'Local users (reads and writes)', protocol: 'http' },
  { id: 'peer-replicate', from: 'peer-region', to: ['db-primary'], label: 'Cross-region replication (writes taken there)', protocol: 'replication' },
  // Every fleet the team runs ships through the pipeline and reports to observability; managed and third-party services do neither.
  ...['@service', '@worker', 'ws-gateway', 'graph-service', 'ml-inference', 'ml-batch', 'stream-processor', 'llm-serving', 'agent-runtime', 'doc-ingestion'].flatMap((fleet): EdgeDef[] => [
    { id: `telemetry:${fleet}`, from: fleet, to: ['observability'], label: 'Logs, metrics, traces', protocol: 'telemetry' },
    { id: `deploy:${fleet}`, from: 'cicd', to: [fleet], label: 'Deploy', protocol: 'telemetry' },
  ]),
  { id: 'mesh', from: 'mesh', to: ['@service'], label: 'Discovery and mTLS', protocol: 'telemetry' },
  { id: 'k8s-schedules', from: 'k8s-control-plane', to: ['@service', 'workers', 'graph-service'], label: 'Schedules pods', protocol: 'telemetry' },
  { id: 'secrets', from: '@service', to: ['secrets'], label: 'Keys and secrets', protocol: 'telemetry' },
  // The platform team watches the dashboards and takes the pages; without observability it still owns the pipeline.
  { id: 'platform-ops', from: 'platform-ops', to: ['observability', 'cicd'], label: 'Dashboards, alerts and on-call', protocol: 'telemetry' },
]
