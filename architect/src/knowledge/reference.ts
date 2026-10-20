import type { NumericReferenceKey, ReferenceNumbers } from '../domain/types'
import { S } from './sources'

// Per-node throughput figures are conservative planning heuristics, not benchmarks. Replace them with your own load tests.
export const reference: ReferenceNumbers = {
  secondsPerDay: 86_400,
  appInstanceQps: 1_000,
  dbPrimaryWriteQps: 5_000,
  dbReplicaReadQps: 10_000,
  dbNodeStorageGb: 4_096,
  // shortcut: the smallest single-instance limit of the managed relational engines a migration loads, Azure SQL Managed Instance at 16 TB (RDS and Cloud SQL reach 64 TB, Aurora 128 TB; general knowledge, mid-2025); check the chosen offer's limit.
  dbMaxNodeStorageGb: 16_384,
  cacheNodeMemoryGb: 64,
  // shortcut: a large (full-price) database node has about 64 GB of memory, a memory-optimized 8-vCPU class such as db.r6g.2xlarge (general knowledge, mid-2025);
  // an HNSW index (pgvector) answers fast only while it fits in memory, so the embeddings in the primary size its instance.
  dbNodeMemoryGb: 64,
  cacheNodeOps: 100_000,
  queueNodeMsgs: 10_000,
  streamPartitionMsgs: 5_000,
  // shortcut: about 1% of a lake's rows change a day (corrections, late facts, slowly changing dimensions), general knowledge; measure the sources' change logs.
  lakeDailyChangeShare: 0.01,
  searchNodeQps: 2_000,
  wsConnectionsPerNode: 50_000,
  lbNodeQps: 50_000,
  // shortcut: about 100 Gbps of media per flash cache server of an own edge; measure your own hardware.
  edgeServerGbps: 100,
  hotDataFraction: 0.2,
  targetUtilization: 0.7,
  blobThresholdKb: 64,
  metadataRowKb: 1,
  // Primer web crawler: pages are re-crawled about once a week.
  pageRefreshDays: 7,
  // shortcut: a flat 10 KB of indexed text per page, not a measurement; sample your own corpus before sizing a real cluster.
  pageTextKb: 10,
  // 1,536 float32 dimensions, the size of common hosted embedding models.
  embeddingKb: 6,
  // Uber case study: 10M rides a day for 100M daily users.
  ridesPerUser: 0.1,
  replicationFactor: 3,
  // shortcut: one completion of 2,000 input and 300 output tokens, output weighted 5x as model price lists do; measure real token counts per feature.
  llmDefaultWeightedTokens: 2_000 + 5 * 300,
  // shortcut: a row AI functions in SQL classify or enrich sends a short prompt and one cell of text (about 300 tokens) and gets a label back (about 20),
  // general knowledge; count the tokens of your own prompt and column.
  sqlRowTokensIn: 300,
  sqlRowTokensOut: 20,
  // shortcut: about 8 model calls per agent task (plan, a few tool calls with their observations, the answer), general knowledge; trace real tasks.
  agentStepsPerTask: 8,
  // shortcut: support plan list prices (general knowledge, mid-2025), the greater of the minimum and the tiered share of the month's bill:
  // AWS Business 10% of the first $10k, 7% to $80k, 5% to $250k, 3% above, at least $100; AWS Enterprise 10% to $150k, 7% to $500k, 5% to $1M, 3% above, at least $15k;
  // Azure Standard $100 flat; Azure Unified Enterprise about 10% of the bill, at least about $4,200 a month ($50k a year);
  // Google Cloud Enhanced at least $500 and Premium at least $15k, both 10% to $150k, 7% to $500k, 5% to $1M, 3% above. Check the provider's support page before quoting.
  supportPlans: {
    aws: {
      business: { min: 100, tiers: [{ upTo: 10_000, share: 0.1 }, { upTo: 80_000, share: 0.07 }, { upTo: 250_000, share: 0.05 }, { share: 0.03 }] },
      enterprise: { min: 15_000, tiers: [{ upTo: 150_000, share: 0.1 }, { upTo: 500_000, share: 0.07 }, { upTo: 1_000_000, share: 0.05 }, { share: 0.03 }] },
    },
    azure: {
      business: { min: 100, tiers: [] },
      enterprise: { min: 4_200, tiers: [{ share: 0.1 }] },
    },
    gcp: {
      business: { min: 500, tiers: [{ upTo: 150_000, share: 0.1 }, { upTo: 500_000, share: 0.07 }, { upTo: 1_000_000, share: 0.05 }, { share: 0.03 }] },
      enterprise: { min: 15_000, tiers: [{ upTo: 150_000, share: 0.1 }, { upTo: 500_000, share: 0.07 }, { upTo: 1_000_000, share: 0.05 }, { share: 0.03 }] },
    },
  },
  // shortcut: on own hardware, OS, virtualisation, Kubernetes and storage subscriptions plus next-business-day hardware maintenance add about 20% to the
  // amortised server cost, 24x7 subscriptions with 4-hour parts about 30% (general knowledge, mid-2025); use your vendor quotes.
  onpremSupportShare: 0.2,
  onpremSupportSharePremium: 0.3,
  // shortcut: list prices per million input / output tokens (general knowledge, mid-2025, USD): small $1 / $5, mid $3 / $15, frontier $15 / $75,
  // at the default 2,000 in / 300 out; check the model's price page before quoting.
  llmPrice1kCalls: { small: 3.5, mid: 10.5, frontier: 52.5 },
  // shortcut: one L4/L40S-class GPU running a 7-8B model with vLLM batching serves about 1,000 output tokens/s (general knowledge); benchmark your model and GPU.
  gpuTokensPerSecond: 1_000,
  // shortcut: about 4 bytes of text per token and 500-token chunks (general knowledge); sample your own corpus and chunker.
  corpusTokensPerGb: 250_000_000,
  chunkTokens: 500,
  // shortcut: about a tenth of a database's bytes is free text worth embedding (notes, descriptions, comments); measure the text columns of the kept system.
  keptRecordTextShare: 0.1,
  // shortcut: a working day of queries (8 query hours) scans 10% of the lake, and scans grow with the query hours (general knowledge); measure query history before sizing a scan-billed warehouse.
  analyticsScanShare: 0.1,
  // shortcut: analytics list prices, general knowledge mid-2025 (USD), priced in services.ts; check the vendor pages before quoting.
  // Fabric F2 $262.80, F4 $525.60, F8 $1,051.20, F16 $2,102.40, F32 $4,204.80, F64 $8,409.60 a month pay-as-you-go ($0.18/CU-hour, about 41% less reserved);
  // Databricks SQL serverless $0.70/DBU (Small = 12 DBU/h), Jobs $0.15/DBU plus about $0.30 of VMs per DBU on classic compute;
  // Snowflake Enterprise $3/credit (Small = 2 credits/h); Redshift Serverless $0.375/RPU-hour (8 RPU base); BigQuery on-demand $6.25/TiB scanned;
  // storage per TB-month S3 and Snowflake $23, ADLS, Cloud Storage and BigQuery active $20, OneLake $23; Power BI Pro $14, QuickSight reader $3, Tableau viewer $15 per user;
  // Looker about $3,000 flat, Looker Studio Pro $9 a user; DMS-class replication instance $0.25/h; Glue $0.44/DPU-hour; MWAA small $360, Cloud Composer $400 a month.
  // shortcut: RDS gp3-class block storage $0.115/GB-month and backup storage beyond the free allowance $0.095/GB-month (general knowledge, mid-2025);
  // IOPS, provisioned throughput and snapshot retention are not priced, so use the provider's calculator for a quote.
  blockStoragePerGbMonth: 0.115,
  backupPerGbMonth: 0.095,
  // shortcut: a $18k server over 48 months plus $200/month colocation, packed; equal vCPU prices within about 10% across clouds. Price real hardware and per-provider SKUs for a quote.
  providerPriceFactor: { aws: 1, azure: 1, gcp: 1, onprem: 0.6 },
  // shortcut: half a platform engineer as the base for own hardware (racks, network, storage, backups), at $12.5k a month loaded (general knowledge); staff to your own on-call rota.
  onpremOpsFte: 0.5,
  opsFteMonthlyUsd: 12_500,
  // shortcut: about 100 own servers, or 1,500 cloud cluster instances (a few hundred nodes of several pods each, the provider runs the control plane and the
  // hardware), per platform engineer with automation, at most 50 FTE (general knowledge); staff to your own fleet.
  ownNodesPerOpsFte: 100,
  clusterNodesPerOpsFte: 1_500,
  opsFteMax: 50,
  // shortcut: HDD capacity with 3x replication or 8+3 erasure coding, amortized (general knowledge); use your storage quotes.
  onpremStoragePerTbMonth: 6,
  // shortcut: an Uptime Institute Tier III data center is designed for about 99.982%, and independent sites fail over as active-passive pairs (general knowledge); use your facilities' measured uptime.
  onpremSiteAvailability: { one: 99.982, two: 99.995, three: 99.999 },
  // shortcut: a 10 Gbps metro wavelength or leased line between two own sites, about $1,000 a month (general knowledge, mid-2025); use your carrier's quote.
  onpremSiteLinkMonthly: 1_000,
  // shortcut: a bulk copy sustains about 70% of the line rate (general knowledge); measure a trial transfer on the real link.
  transferEfficiency: 0.7,
  // shortcut: one loader node copies about 100 MB/s with parallel table streams (bcp, pg_dump -j, Data Pump, a DMS full-load task), and a target database takes
  // about 400 MB/s of bulk inserts with secondary indexes dropped (general knowledge, mid-2025); time a trial load of the largest tables.
  loaderNodeMBps: 100,
  bulkLoadMaxMBps: 400,
  // shortcut: an IPsec site-to-site VPN delivers about 0.5 Gbps (AWS lists 1.25 Gbps per tunnel; internet paths deliver less); measure your tunnel.
  vpnGbps: 0.5,
  // shortcut: validation (row counts, checksums, smoke tests) adds 50% to a bulk copy (general knowledge); time a full trial migration on a production copy.
  validationFactor: 0.5,
  // shortcut: about 10 days to order, fill, ship and load an offline device (Snowball Edge, Data Box, Transfer Appliance), flat; check the provider's lead time.
  offlineDeviceHours: 240,
  // shortcut: draining CDC lag and switching connections takes about 15 minutes (general knowledge); rehearse the cutover to measure it.
  cdcCutoverHours: 0.25,
  // shortcut: loading the last increment (a scheduled file drop or a batch of API change events) and switching takes about an hour (general knowledge); time one real increment.
  incrementalCutoverHours: 1,
  // shortcut: a SaaS CRM's import APIs (Salesforce Bulk API 2.0, the Dataverse Web API or the ADF Dataverse connector, HubSpot imports) take about 5 GB of records an hour
  // within their daily limits and throttling (general knowledge, mid-2025); time a trial import of one object.
  saasCrmImportGbPerHour: 5,
  // shortcut: one offline device (Snowball Edge, Data Box, Transfer Appliance) carries about 80 TB usable (general knowledge, mid-2025); larger models exist, check the provider's sizes.
  offlineDeviceTb: 80,
  // shortcut: engineer FTE-months by approach for schema and code conversion, field mapping and parallel-run tests (general knowledge, mid-2025);
  // override them per project in the Prices and assumptions tab, or replace them with a sized work breakdown after the assessment.
  migrationFteMonthsRehost: 1,
  migrationFteMonthsReplatform: 3,
  migrationFteMonthsRefactor: 6,
  migrationFteMonthsRefactorHeavy: 12,
  migrationFteMonthsRetain: 1,
  migrationFteMonthsRepurchase: 4,
  migrationFteMonthsDefault: 2,
  // shortcut: converting COBOL or PL/I programs and copybook data, and BTEQ scripts, macros and ETL jobs of a warehouse (general knowledge, mid-2025); size them from a code inventory.
  migrationFteMonthsMainframe: 12,
  migrationFteMonthsMainframeHeavy: 36,
  migrationFteMonthsWarehouse: 6,
  migrationFteMonthsWarehouseHeavy: 18,
  // shortcut: duplicates and free-text codes add mapping and cleansing work (general knowledge); profile the source data to size it.
  dataQualityFteMonthsMixed: 1,
  dataQualityFteMonthsPoor: 3,
  // shortcut: rebuilding a replaced application's features, about 3 engineers for 6 months (general knowledge); replace with the delivery estimate.
  appRebuildFteMonths: 18,
  latencyTable: [
    { operation: 'L1 cache reference', ns: 0.5 },
    { operation: 'Branch mispredict', ns: 5 },
    { operation: 'L2 cache reference', ns: 7 },
    { operation: 'Mutex lock/unlock', ns: 25 },
    { operation: 'Main memory reference', ns: 100 },
    { operation: 'Compress 1 KB with Zippy', ns: 10_000 },
    { operation: 'Send 1 KB over 1 Gbps network', ns: 10_000 },
    { operation: 'Read 4 KB randomly from SSD', ns: 150_000 },
    { operation: 'Read 1 MB sequentially from memory', ns: 250_000 },
    { operation: 'Round trip within same datacenter', ns: 500_000 },
    { operation: 'Read 1 MB sequentially from SSD', ns: 1_000_000 },
    { operation: 'HDD seek', ns: 10_000_000 },
    { operation: 'Read 1 MB sequentially from 1 Gbps network', ns: 10_000_000 },
    { operation: 'Read 1 MB sequentially from HDD', ns: 30_000_000 },
    { operation: 'Send packet CA -> Netherlands -> CA', ns: 150_000_000 },
  ],
  // Monthly downtime uses a 30.44-day month (365.25 / 12), as the primer does; the main README mixes it with 30 days.
  availabilityTable: [
    { nines: '99%', downtimePerYear: '3.65 days', downtimePerMonth: '7.31 h' },
    { nines: '99.9%', downtimePerYear: '8.77 h', downtimePerMonth: '43.8 min' },
    { nines: '99.95%', downtimePerYear: '4.38 h', downtimePerMonth: '21.9 min' },
    { nines: '99.99%', downtimePerYear: '52.6 min', downtimePerMonth: '4.38 min' },
    { nines: '99.999%', downtimePerYear: '5.25 min', downtimePerMonth: '26.3 s' },
  ],
  sources: [S.latency, S.powersOfTwo, S.availabilityNumbers, S.mainAvailability, S.backOfEnvelope, S.mainUber],
}

const HEURISTIC = 'Planning heuristic, general knowledge; replace with your own load test'
const MIGRATION = 'General knowledge, mid-2025; time a trial migration'
const EFFORT = 'General knowledge, mid-2025; replace with a sized work breakdown'

/** What each editable reference number means, its unit and where it comes from. `positive` numbers divide or cap capacity, so 0 is not a valid override. */
export const referenceInfo: Record<NumericReferenceKey, { label: string; unit?: string; source: string; positive?: true }> = {
  secondsPerDay: { label: 'Seconds in a day', unit: 's', source: 'Constant (system-design-primer back-of-the-envelope math)', positive: true },
  appInstanceQps: { label: 'Requests one app instance serves', unit: 'QPS', source: HEURISTIC, positive: true },
  dbPrimaryWriteQps: { label: 'Writes one primary database takes', unit: 'QPS', source: HEURISTIC, positive: true },
  dbReplicaReadQps: { label: 'Reads one database replica serves', unit: 'QPS', source: HEURISTIC, positive: true },
  dbNodeStorageGb: { label: 'Storage per database node', unit: 'GB', source: HEURISTIC, positive: true },
  dbMaxNodeStorageGb: { label: 'Storage one instance holds when a migration loads a relational database', unit: 'GB', source: 'Azure SQL Managed Instance 16 TB; RDS and Cloud SQL 64 TB, Aurora 128 TB (general knowledge, mid-2025)', positive: true },
  cacheNodeMemoryGb: { label: 'Memory per cache node', unit: 'GB', source: HEURISTIC, positive: true },
  dbNodeMemoryGb: { label: 'Memory per database node', unit: 'GB', source: 'Memory-optimized 8-vCPU class (db.r6g.2xlarge), general knowledge mid-2025', positive: true },
  cacheNodeOps: { label: 'Operations one cache node serves', unit: 'ops/s', source: HEURISTIC, positive: true },
  queueNodeMsgs: { label: 'Messages one queue node handles', unit: 'msg/s', source: HEURISTIC, positive: true },
  streamPartitionMsgs: { label: 'Messages one stream partition handles', unit: 'msg/s', source: HEURISTIC, positive: true },
  lakeDailyChangeShare: { label: 'Share of a data platform lake that changes a day', unit: 'share', source: HEURISTIC },
  searchNodeQps: { label: 'Queries one search node serves', unit: 'QPS', source: HEURISTIC, positive: true },
  wsConnectionsPerNode: { label: 'WebSocket connections per node', unit: 'connections', source: HEURISTIC, positive: true },
  lbNodeQps: { label: 'Requests one load balancer node handles', unit: 'QPS', source: HEURISTIC, positive: true },
  edgeServerGbps: { label: 'Media one own-edge cache server serves', unit: 'Gbps', source: 'General knowledge (Open Connect style flash servers); measure your hardware', positive: true },
  hotDataFraction: { label: 'Share of a day of reads kept in cache', unit: 'fraction', source: 'General knowledge (80/20 rule)' },
  targetUtilization: { label: 'Target peak utilization of a fleet', unit: 'fraction', source: HEURISTIC, positive: true },
  blobThresholdKb: { label: 'Record size stored as a blob above', unit: 'KB', source: 'General knowledge' },
  metadataRowKb: { label: 'Database row per blob', unit: 'KB', source: 'General knowledge' },
  pageRefreshDays: { label: 'Days between re-crawls of a page', unit: 'days', source: 'system-design-primer web crawler' },
  pageTextKb: { label: 'Indexed text per crawled page', unit: 'KB', source: 'Flat estimate; sample your own corpus' },
  embeddingKb: { label: 'One stored embedding', unit: 'KB', source: '1,536 float32 dimensions of common hosted embedding models' },
  ridesPerUser: { label: 'Rides per daily user per day', source: 'Uber case study (10M rides for 100M daily users)' },
  replicationFactor: { label: 'Copies of stored data', unit: 'copies', source: 'General knowledge' },
  llmDefaultWeightedTokens: { label: 'Weighted tokens of one completion', unit: 'tokens', source: '2,000 in plus 5 x 300 out, general knowledge; measure real token counts', positive: true },
  sqlRowTokensIn: { label: 'Input tokens per row an AI function in SQL enriches', unit: 'tokens', source: 'A short prompt and one cell of text, general knowledge; count your own', positive: true },
  sqlRowTokensOut: { label: 'Output tokens per row an AI function in SQL enriches', unit: 'tokens', source: 'A label or short value, general knowledge; count your own', positive: true },
  agentStepsPerTask: { label: 'Model calls per agent task', unit: 'calls', source: 'Plan, tool calls and answer, general knowledge; trace real tasks', positive: true },
  onpremSupportShare: { label: 'Own hardware subscriptions and maintenance, business support', unit: 'fraction', source: 'OS, virtualisation, Kubernetes and storage subscriptions plus next-business-day maintenance, general knowledge mid-2025; use your vendor quotes' },
  onpremSupportSharePremium: { label: 'Own hardware subscriptions and maintenance, enterprise support', unit: 'fraction', source: '24x7 subscriptions and 4-hour hardware support, general knowledge mid-2025; use your vendor quotes' },
  gpuTokensPerSecond: { label: 'Output tokens one GPU node serves', unit: 'tokens/s', source: 'L4/L40S-class GPU with vLLM, general knowledge; benchmark your model', positive: true },
  corpusTokensPerGb: { label: 'Tokens in 1 GB of document text', unit: 'tokens', source: 'About 4 bytes per token, general knowledge', positive: true },
  chunkTokens: { label: 'Tokens per retrieval chunk', unit: 'tokens', source: 'General knowledge; use your chunker', positive: true },
  keptRecordTextShare: { label: 'Share of a kept database embedded as record text', unit: 'fraction', source: 'Assumption: notes and descriptions next to keys, numbers and indexes; measure the text columns' },
  analyticsScanShare: { label: 'Share of the lake 8 query hours scan', unit: 'fraction', source: 'General knowledge; measure query history' },
  blockStoragePerGbMonth: { label: 'Block storage price', unit: 'USD per GB-month', source: 'RDS gp3-class list price, mid-2025' },
  backupPerGbMonth: { label: 'Backup storage price', unit: 'USD per GB-month', source: 'RDS backup list price, mid-2025' },
  onpremOpsFte: { label: 'Base platform engineers for own hardware', unit: 'FTE', source: 'General knowledge; staff to your on-call rota' },
  opsFteMonthlyUsd: { label: 'Loaded cost of one engineer', unit: 'USD per month', source: 'General knowledge, mid-2025', positive: true },
  ownNodesPerOpsFte: { label: 'Own servers one platform engineer runs', unit: 'nodes', source: 'General knowledge; staff to your own fleet', positive: true },
  clusterNodesPerOpsFte: { label: 'Cloud cluster instances one platform engineer runs', unit: 'instances', source: 'General knowledge; staff to your own fleet', positive: true },
  opsFteMax: { label: 'Most platform engineers the estate adds up to', unit: 'FTE', source: 'General knowledge; staff to your own fleet', positive: true },
  onpremStoragePerTbMonth: { label: 'Own object storage price', unit: 'USD per TB-month', source: 'HDD with replication or erasure coding, amortized; use your quotes' },
  onpremSiteLinkMonthly: { label: 'Link between two own data center sites', unit: 'USD per month', source: '10 Gbps metro wavelength or leased line, general knowledge mid-2025; use your carrier quote' },
  transferEfficiency: { label: 'Share of line rate a bulk copy sustains', unit: 'fraction', source: MIGRATION, positive: true },
  loaderNodeMBps: { label: 'Bulk copy rate of one loader node', unit: 'MB/s', source: MIGRATION, positive: true },
  bulkLoadMaxMBps: { label: 'Bulk-load rate a target database sustains', unit: 'MB/s', source: MIGRATION, positive: true },
  vpnGbps: { label: 'Site-to-site VPN throughput', unit: 'Gbps', source: 'AWS lists 1.25 Gbps per tunnel; internet paths deliver less', positive: true },
  validationFactor: { label: 'Validation time added to a bulk copy', unit: 'fraction', source: MIGRATION },
  offlineDeviceHours: { label: 'Door-to-door time of an offline device', unit: 'h', source: 'General knowledge; check the provider lead time' },
  cdcCutoverHours: { label: 'CDC cutover time', unit: 'h', source: MIGRATION },
  incrementalCutoverHours: { label: 'Incremental cutover time', unit: 'h', source: MIGRATION },
  saasCrmImportGbPerHour: { label: 'SaaS CRM import throughput', unit: 'GB per hour', source: 'Bulk API 2.0, Dataverse Web API and HubSpot import limits, general knowledge mid-2025', positive: true },
  offlineDeviceTb: { label: 'Usable capacity of one offline device', unit: 'TB', source: 'Snowball Edge class, mid-2025', positive: true },
  migrationFteMonthsRehost: { label: 'Migration effort, rehost', unit: 'FTE-months', source: EFFORT },
  migrationFteMonthsReplatform: { label: 'Migration effort, replatform', unit: 'FTE-months', source: EFFORT },
  migrationFteMonthsRefactor: { label: 'Migration effort, refactor', unit: 'FTE-months', source: EFFORT },
  migrationFteMonthsRefactorHeavy: { label: 'Migration effort, refactor with heavy database code', unit: 'FTE-months', source: EFFORT },
  migrationFteMonthsRetain: { label: 'Migration effort, retain', unit: 'FTE-months', source: EFFORT },
  migrationFteMonthsRepurchase: { label: 'Migration effort, repurchase', unit: 'FTE-months', source: EFFORT },
  migrationFteMonthsDefault: { label: 'Migration effort, no approach chosen', unit: 'FTE-months', source: EFFORT },
  migrationFteMonthsMainframe: { label: 'Mainframe code and copybook conversion', unit: 'FTE-months', source: EFFORT },
  migrationFteMonthsMainframeHeavy: { label: 'Mainframe conversion with heavy program logic', unit: 'FTE-months', source: EFFORT },
  migrationFteMonthsWarehouse: { label: 'Warehouse script and ETL conversion', unit: 'FTE-months', source: EFFORT },
  migrationFteMonthsWarehouseHeavy: { label: 'Warehouse conversion with heavy procedures and scripts', unit: 'FTE-months', source: EFFORT },
  dataQualityFteMonthsMixed: { label: 'Data cleansing effort, mixed quality', unit: 'FTE-months', source: 'General knowledge; profile the source data' },
  dataQualityFteMonthsPoor: { label: 'Data cleansing effort, poor quality', unit: 'FTE-months', source: 'General knowledge; profile the source data' },
  appRebuildFteMonths: { label: 'Application rebuild effort, replacing a legacy application', unit: 'FTE-months', source: 'General knowledge; replace with the delivery estimate' },
}
