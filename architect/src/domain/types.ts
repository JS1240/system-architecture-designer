// Core domain types. The knowledge base is pure JSON-serializable data typed by these interfaces.

export type FactValue = string | number | boolean | string[] | null

export type Facts = Record<string, FactValue>

/** 'general' marks general practice with no repository source: path is a canonical URL (or ''), and there are no lines. */
export type RepoId = 'system-design-primer' | 'system-design-101' | 'system-design-main' | 'general'

export interface SourceRef {
  repo: RepoId
  path: string
  lines?: string
  title: string
}

export type Operator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'includes' | 'exists'

/** Declarative condition over facts (and, in architecture phase, over present components). */
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { fact: string; op: Operator; value?: FactValue }
  | { has: string }

export type CategoryId =
  | 'product'
  | 'traffic'
  | 'data'
  | 'performance'
  | 'reliability'
  | 'security'
  | 'architecture'
  | 'infrastructure'
  | 'operations'
  | 'context'
  | 'migration'
  | 'platform'
  | 'ai'

export interface ScoreRule {
  when: Condition
  weight: number
  reason: string
}

export interface QuestionOption {
  id: string
  label: string
  description: string
  pros: string[]
  cons: string[]
  /** 1 = simplest. Used as a simplicity bias when scoring alternatives. */
  complexity: 1 | 2 | 3 | 4 | 5
  /** Additional facts this option asserts. */
  sets?: Facts
  feasibleWhen?: Condition
  infeasibleReason?: string
  score?: ScoreRule[]
  /** Words in a free-text app description that suggest this option. */
  keywords?: string[]
  /** Words in a free-text description that argue against this option. */
  negativeKeywords?: string[]
  technologies?: string[]
  sources?: SourceRef[]
}

export interface NumberSpec {
  min: number
  max: number
  unit: string
  scale: 'log' | 'linear'
  presets: { label: string; value: number }[]
}

export interface Question {
  id: string
  category: CategoryId
  title: string
  prompt: string
  help?: string
  kind: 'single' | 'multi' | 'number'
  /** Fact the answer writes, when it differs from the id (a number question that replaced bucket options). */
  fact?: string
  options?: QuestionOption[]
  number?: NumberSpec
  /** Question is only relevant when this holds. Omitted = always relevant. */
  askWhen?: Condition
  /** Lower is asked first. */
  priority: number
  /** Architectural decisions produce ADRs. Requirement questions do not. */
  isDecision: boolean
  /** Assumed value when the answer is unknown and no option scores. */
  default: FactValue
  /** Defaults that follow earlier answers; the first matching rule replaces `default`. */
  defaultWhen?: { when: Condition; value: FactValue }[]
  sources: SourceRef[]
}

export type Tier = 'client' | 'edge' | 'ingress' | 'compute' | 'async' | 'data' | 'ops' | 'legacy'

export type ComponentShape =
  | 'client'
  | 'globe'
  | 'shield'
  | 'balancer'
  | 'gateway'
  | 'tower'
  | 'worker'
  | 'queue'
  | 'stream'
  | 'cache'
  | 'database'
  | 'storage'
  | 'search'
  | 'warehouse'
  | 'external'
  | 'monitor'
  | 'region'

export type SizingId =
  | 'single'
  | 'app'
  | 'inference'
  | 'service'
  | 'worker'
  | 'dbPrimary'
  | 'dbReplica'
  | 'cache'
  | 'queue'
  | 'stream'
  | 'search'
  | 'wsGateway'
  | 'connections'
  | 'presence'
  | 'geo'
  | 'location'
  | 'lb'
  | 'gateway'
  | 'primaryStandby'
  | 'functions'
  | 'objects'
  | 'egress'
  | 'completions'

/** Sizing declared as data: demand is the product of numeric facts and constants. */
export interface LinearSizing {
  /** Fact names and constants, multiplied; a missing fact counts as 0. */
  product: (string | number)[]
  /** A floor on the demand, as a product of fact names and constants (a job per source system on a volume-priced line). */
  floor?: (string | number)[]
  /** Demand one unit (or one instance) covers. */
  per: number
  /** Bill ceil(demand / per) units on one replica instead of running instances. */
  billed?: boolean
  /** Demand the provider bills nothing for (a free tier), taken off before billed units are counted. */
  free?: number
  min?: number
  /** Keep an N+1 spare in the fleet when availability matters. */
  spare?: boolean
  /** Capacity SKUs: the smallest tier whose max covers the demand is billed. */
  tiers?: { name: string; max: number; monthly: number }[]
  /** Whole nodes of one size (GPU servers): each costs the full unit price, with no smaller instance class. */
  wholeNodes?: boolean
  /** Sizing note template using {demand} {units} {tier}, and {spare} (', one of them a spare' when the fleet keeps one). */
  note: string
}

export type CostKind = 'run' | 'license' | 'one_time' | 'people' | 'nonprod' | 'transfer'

/** A provider-specific service that names and prices a component (or every '@group' member). */
export interface ServiceOffer {
  /** Component id or '@group'. */
  component: string
  /** An infra.cloud option id, or 'any'. */
  provider: string
  when?: Condition
  name: string
  monthlyCostPerUnit?: number
  unit?: string
  /** Published availability as a fraction (0.9999), used in place of the engine's default for the component. */
  sla?: number
  costKind?: CostKind
  /** Replaces the component's sizing when the offer matches. */
  sizing?: LinearSizing
  /** Price factor per infra.commitment option for a usage-priced line sold under its own reservation or pre-purchase; other billed lines keep the list price. */
  commitment?: Record<string, number>
  /** The usage price follows the region's price level (infra.priceMultiplier). */
  regionPriced?: boolean
  /** Replicas share the primary's cluster volume (Aurora), so the line bills no storage copy of its own. */
  sharedStorage?: boolean
  /**
   * Who bills the line when it is not `provider`: a company ('databricks', 'snowflake') or, for an 'any' offer, the cloud that bills it ('azure' for Fabric).
   * A negotiated cloud discount applies only to lines the chosen cloud bills.
   */
  vendor?: string
  /** Price date, 'YYYY-MM'. */
  asOf: string
  sources?: SourceRef[]
}

/** A fact asserted when a condition holds; answers always win over it. */
export interface DerivedFact {
  fact: string
  value: FactValue
  when: Condition
}

export interface ComponentDef {
  id: string
  label: string
  shape: ComponentShape
  tier: Tier
  /** Optional group so edges can target every member (e.g. '@service'). */
  group?: string
  description: string
  responsibilities: string[]
  when: Condition
  reason: string
  /** Technology chosen from a decision fact; falls back to `tech`. */
  techFrom?: { fact: string; map: Record<string, string> }
  tech?: string
  /** Optional qualifier appended to the technology, e.g. the partitioning strategy. */
  techSuffixFrom?: { fact: string; map: Record<string, string>; when?: Condition }[]
  sizing: SizingId | LinearSizing
  /** Defaults to 'run'. */
  costKind?: CostKind
  /** Transition components run only while old and new systems coexist. */
  phase?: 'transition'
  /** The component is transition-phase only while this holds (a link that stays for analytics but goes with the old system). */
  transitionWhen?: Condition
  /** Runs in one region whatever the application's topology (the analytics platform), so a peer or standby region does not copy it. */
  singleRegion?: boolean
  /** Runs this many replicas whatever the load; utilization is rescaled to them. */
  fixedReplicas?: number
  /** Adds block storage for the database records ('db') or the search index ('search') on every copy the component keeps. */
  storageFrom?: 'db' | 'search'
  /** Rough on-demand monthly cost in USD per instance, or per billed unit of a usage-priced service. Heuristic, not a quote. */
  monthlyCostPerUnit: number
  /**
   * Unit prices that depend on decisions; the first rule whose condition holds replaces monthlyCostPerUnit.
   * licensePerUnit is the software license inside a license-included price: it follows the instance class but not the provider's hardware price level.
   * minUnitCost is the smallest SKU the service sells at that price (license-included engines license at least 4 cores), so a small instance class bills no less.
   */
  pricing?: { when: Condition; monthlyCostPerUnit: number; licensePerUnit?: number; minUnitCost?: number }[]
  scalingNotes: string
  sources: SourceRef[]
}

export type Protocol = 'http' | 'grpc' | 'ws' | 'async' | 'replication' | 'query' | 'cdc' | 'telemetry' | 'dns'

export interface EdgeDef {
  id: string
  /** Component id or '@group'. */
  from: string
  /** Preference list: the first present component (or every member of a '@group') is used. */
  to: string[]
  label: string
  protocol: Protocol
  when?: Condition
  /** Fact holding requests/second that flow over the edge (drives animation density): a `cap.*` workload rate or a `flow.*` rate after the cache and read routing. */
  trafficFact?: string
}

export type Severity = 'error' | 'warning' | 'info'

export interface ValidationRule {
  id: string
  severity: Severity
  when: Condition
  title: string
  message: string
  fix: string
  sources: SourceRef[]
}

export interface Technology {
  id: string
  name: string
  category: string
  strengths: string[]
  weaknesses: string[]
  useCases: string[]
  sources: SourceRef[]
}

export interface Pattern {
  id: string
  name: string
  summary: string
  whenToUse: string[]
  whenNotToUse: string[]
  tradeoffs: string[]
  sources: SourceRef[]
}

/** Reference numbers for capacity math. Heuristics, cited where the repositories give them. */
/** A support plan: the greater of `min` and the bill priced band by band (each band up to `upTo` dollars a month, the last one open). */
export interface SupportPlan {
  min: number
  tiers: { upTo?: number; share: number }[]
}

export interface ReferenceNumbers {
  secondsPerDay: number
  appInstanceQps: number
  dbPrimaryWriteQps: number
  dbReplicaReadQps: number
  dbNodeStorageGb: number
  dbMaxNodeStorageGb: number
  cacheNodeMemoryGb: number
  /** Memory of one full-price database node, which a pgvector index in the primary must fit. */
  dbNodeMemoryGb: number
  cacheNodeOps: number
  queueNodeMsgs: number
  streamPartitionMsgs: number
  /** Share of a data platform's lake that changes a day when it grows slower than that (updated rows, late facts): what its stream and processors carry. */
  lakeDailyChangeShare: number
  searchNodeQps: number
  wsConnectionsPerNode: number
  lbNodeQps: number
  /** Media one cache server of an own edge (push CDN) serves at peak. */
  edgeServerGbps: number
  hotDataFraction: number
  /** Records larger than this (KB) are stored as blobs in object storage. */
  blobThresholdKb: number
  metadataRowKb: number
  /** A crawler re-fetches each page about this often; the index keeps only the latest version. */
  pageRefreshDays: number
  /** Extracted text and postings the index keeps per crawled page (KB). */
  pageTextKb: number
  /** One stored embedding (KB). */
  embeddingKb: number
  /** Rides requested per daily user per day in ride hailing. */
  ridesPerUser: number
  /** Input tokens plus 5x output tokens (output is priced about 5x input) of the default completion: 2,000 in, 300 out. */
  llmDefaultWeightedTokens: number
  /** Input and output tokens of one row AI functions in SQL enrich; the asked token mix (ai.tokens_in, ai.tokens_out) applies to the other model calls. */
  sqlRowTokensIn: number
  sqlRowTokensOut: number
  /** Model calls one agent task makes (plan, tool calls, reflection, answer). */
  agentStepsPerTask: number
  /** Support plans by provider (infra.cloud option id) and ops.support level: the greater of a monthly minimum and a tiered share of the month's bill. */
  supportPlans: Record<string, Record<string, SupportPlan>>
  /** Own hardware: OS, virtualisation, Kubernetes and storage subscriptions plus hardware maintenance, as a share of the instance lines, by support level. */
  onpremSupportShare: number
  onpremSupportSharePremium: number
  /** Price of 1,000 default completions by ai.model_tier option id. */
  llmPrice1kCalls: Record<string, number>
  /** Output tokens per second one GPU node serves for an open-weight model. */
  gpuTokensPerSecond: number
  /** Tokens in 1 GB of document text, and tokens per retrieval chunk (one embedding each). */
  corpusTokensPerGb: number
  chunkTokens: number
  /** Share of a kept system's volume that is record text an AI app embeds (notes, descriptions); the rest is keys, numbers and indexes. */
  keptRecordTextShare: number
  /** Size fleets so peak load uses at most this share of capacity. */
  targetUtilization: number
  replicationFactor: number
  /** Share of the lake 8 hours of analytics queries scan; the scans grow with the query hours. */
  analyticsScanShare: number
  /** Database and index volumes per GB-month (gp3-class SSD), and backups of the primary per GB-month. */
  blockStoragePerGbMonth: number
  backupPerGbMonth: number
  /** Multiplies instance-priced lines by provider (infra.cloud option id); missing providers count as 1. */
  providerPriceFactor: Record<string, number>
  /** Base platform engineers an on-premises deployment needs, and the loaded monthly cost of one. */
  onpremOpsFte: number
  opsFteMonthlyUsd: number
  /** Platform staff grow with the estate: one more FTE per this many own servers (own hardware, own edge) or cloud cluster nodes the team patches, up to opsFteMax. */
  ownNodesPerOpsFte: number
  clusterNodesPerOpsFte: number
  opsFteMax: number
  /** Own object storage per TB-month: disks with replication or erasure coding, amortized. */
  onpremStoragePerTbMonth: number
  /** Availability in percent of an on-premises deployment by data center count (onprem.sites option id); replaces the cloud region SLA. */
  onpremSiteAvailability: Record<string, number>
  /** Monthly price of one dedicated link between two own data center sites (metro wavelength or leased line). */
  onpremSiteLinkMonthly: number
  /** Migration transfer math: share of a link's line rate a bulk copy sustains, a site-to-site VPN's throughput, extra time for validation, an offline device's door-to-door time, a CDC cutover and a cutover that loads the last file drop or API increment. */
  transferEfficiency: number
  /** Bulk copy rate of one loader node, and the bulk-load rate a target database sustains, which caps a copy over any link (MB/s). */
  loaderNodeMBps: number
  bulkLoadMaxMBps: number
  vpnGbps: number
  validationFactor: number
  offlineDeviceHours: number
  cdcCutoverHours: number
  incrementalCutoverHours: number
  saasCrmImportGbPerHour: number
  /** Data one offline transfer device carries (TB). */
  offlineDeviceTb: number
  /** Engineer FTE-months a migration takes by migration.approach ('RefactorHeavy' for heavy database code, 'Default' without an approach); flat numbers, so a project can override each one. */
  migrationFteMonthsRehost: number
  migrationFteMonthsReplatform: number
  migrationFteMonthsRefactor: number
  migrationFteMonthsRefactorHeavy: number
  migrationFteMonthsRetain: number
  migrationFteMonthsRepurchase: number
  migrationFteMonthsDefault: number
  migrationFteMonthsMainframe: number
  migrationFteMonthsMainframeHeavy: number
  migrationFteMonthsWarehouse: number
  migrationFteMonthsWarehouseHeavy: number
  /** Extra engineer FTE-months for mixed or poor source data quality (source.data_quality). */
  dataQualityFteMonthsMixed: number
  dataQualityFteMonthsPoor: number
  /** Engineer FTE-months to rebuild the application when project.origin replaces a legacy one (not when a SaaS product is bought). */
  appRebuildFteMonths: number
  latencyTable: { operation: string; ns: number }[]
  availabilityTable: { nines: string; downtimePerYear: string; downtimePerMonth: string }[]
  sources: SourceRef[]
}

export interface Scenario {
  id: string
  name: string
  description: string
  sources?: SourceRef[]
  /** An interview case study from the source repositories; the Welcome screen lists the other scenarios as starters first. */
  caseStudy?: boolean
  answers: Record<string, AnswerValue>
  /** Option ids the completed design must reach, by question id; checked by a test after autoComplete. */
  expect?: Record<string, string>
  /** Component ids the completed design must contain. */
  expectComponents?: string[]
}

export interface GuideEntry {
  id: string
  title: string
  category: string
  tags: string[]
  relevance: 'high' | 'medium' | 'low'
  /** Knowledge-base entries that cite this guide, e.g. "question:data.primary_db". */
  usedBy: string[]
  source: SourceRef
}

export interface KnowledgeBase {
  version: string
  categories: { id: CategoryId; label: string; order: number }[]
  questions: Question[]
  components: ComponentDef[]
  edges: EdgeDef[]
  validations: ValidationRule[]
  technologies: Technology[]
  patterns: Pattern[]
  reference: ReferenceNumbers
  scenarios: Scenario[]
  services: ServiceOffer[]
  /** Facts asserted from other facts, applied after the answers in every pass. */
  derived?: DerivedFact[]
  /** Project overrides applied by withOverrides (engine/overrides.ts); the engine reads the discount and the extra lines from here. */
  overrides?: Overrides
  /** Index of all system-design-101 guides. Present in the exported knowledge base, omitted from the app bundle. */
  guides?: GuideEntry[]
}


export type AnswerValue =
  | { kind: 'value'; value: FactValue }
  | { kind: 'unknown' }
  | { kind: 'custom'; text: string; treatAs: string }

export type Answers = Record<string, AnswerValue>

export type NumericReferenceKey = { [K in keyof ReferenceNumbers]: ReferenceNumbers[K] extends number ? K : never }[keyof ReferenceNumbers]

/** A cost line the engineer adds for a service or vendor the knowledge base lacks; priced as given, not drawn in the scene. */
export interface ExtraCostLine {
  label: string
  tier: Tier
  monthly: number
  costKind: CostKind
}

/** The engineer's own assumptions for one project: planning numbers, negotiated prices, pinned fleets and left-out components. */
export interface Overrides {
  reference?: Partial<Record<NumericReferenceKey, number>>
  /** Unit price by unitPriceKey (component id, or component|provider|offer name|capacity tier): replaces the list price of that offer and tier only. */
  unitPrice?: Record<string, number>
  /** Pinned replica count by component id. */
  replicas?: Record<string, number>
  /** Component ids left out of the design. */
  exclude?: string[]
  /** Negotiated discount (EDP, MACC, CUD) in percent off the instance and usage lines of discountProvider. */
  discountPct?: number
  /** The cloud the discount was negotiated with (aws, azure, gcp); no other provider gets it. */
  discountProvider?: string
  extraLines?: ExtraCostLine[]
}

export interface Version {
  id: string
  name: string
  createdAt: string
  answers: Answers
  overrides?: Overrides
}

export interface Project {
  id: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
  answers: Answers
  /** Answers detected in the description; the engine ignores them until the user confirms one. */
  suggestions?: Answers
  /** Suggestion keys (suggestionKey) the user ignored or toggled off; re-detection does not offer them again. */
  dismissed?: string[]
  versions: Version[]
  overrides?: Overrides
}


export interface OptionScore {
  optionId: string
  score: number
  feasible: boolean
  infeasibleReason?: string
  /** Matched rules that argue for the option. */
  reasons: string[]
  /** Matched rules with a negative weight: trade-offs that count against the option. */
  penalties: string[]
}

export interface Recommendation {
  optionId: string | null
  value: FactValue
  reasons: string[]
  scores: OptionScore[]
}

export type QuestionStatus = 'answered' | 'unknown' | 'custom' | 'pending' | 'inactive'

export interface QuestionState {
  question: Question
  status: QuestionStatus
  active: boolean
  /** Value in effect (answer, assumption, or null when pending). */
  effectiveValue: FactValue
  recommendation: Recommendation
  /** Answered option differs from what the engine now recommends. */
  divergesFromRecommendation: boolean
  dependsOn: string[]
}

export interface Workload {
  dau: number
  avgQps: number
  peakQps: number
  readQps: number
  writeQps: number
  peakReadQps: number
  peakWriteQps: number
  peakFactor: number
  storagePerYearGb: number
  totalStorageGb: number
  /** Blobs and media in object storage, one copy. */
  objectStorageGb: number
  /** Part of objectStorageGb a lifecycle rule has moved to a colder class (data.storage_class). */
  coldObjectStorageGb: number
  egressMbps: number
  /** Bytes served from the origin to the internet a month: API responses, plus media when no CDN serves it (GB). */
  originEgressGbMonth: number
  originEgressPeakMbps: number
  /** Media read by clients, averaged over the day. */
  avgMediaEgressMbps: number
  cacheMemoryGb: number
  concurrentConnections: number
  /** Presence heartbeats: one per connection every 30 s. */
  heartbeatQps: number
  /** Durable writes that reach the database (includes location rows when the geo index is in the database). */
  peakDbWriteQps: number
  /** Background jobs per second at peak: fan-out deliveries plus media processing. */
  peakJobsQps: number
  /** Events devices or services stream in at peak (event ingestion only). */
  peakEventQps: number
  /** Rows a data platform (no request path) ingests per second at peak: its lake's daily changes, which size its stream, stream processor and batch jobs. */
  peakIngestQps: number
  /** Ingested events the stream keeps for replay, replicated three times, in GB. */
  eventRetainedGb: number
  /** Fan-out deliveries written into followers' cached timelines at peak (feeds only). */
  peakTimelineWriteQps: number
  /** Files put into object storage at peak: media uploads plus records too large for the database. */
  peakUploadQps: number
  peakSearchQps: number
  /** Record lookups behind the reads at peak: graph traversals fetch many adjacency lists per read. */
  peakLookupQps: number
  /** Media processing time needed per second at peak; one worker supplies one. */
  peakMediaWorkSeconds: number
  /** Background work the compute tier does inside requests when there is no queue, in requests/s at peak. */
  peakInlineWorkQps: number
  peakLocationQps: number
  /** Ride requests that dispatch matches to nearby drivers at peak (live-tracking mobility apps only). */
  peakRideQps: number
  /** Messages over persistent connections: writes plus location updates. */
  peakRealtimeQps: number
  /** Peak writes divided by one primary's write capacity. */
  dbWriteLoad: number
  /** Writes plus the cache-miss reads the primary must serve (strong consistency or no replica tier), in units of one node. */
  dbPrimaryLoad: number
  /** Database records only (media lives in object storage), before replication. */
  dbStorageGb: number
  /** Embeddings pgvector keeps in a PostgreSQL primary (part of dbStorageGb); its index wants them in memory. */
  primaryEmbeddingGb: number
  /** Documents the search index holds (one copy): database rows, a media catalog, or the latest text of each crawled page. */
  searchIndexGb: number
  /** Database records divided by one node's comfortable storage. */
  dbStorageLoad: number
  /** Analytics tables in one copy: the database history plus existing data loaded once (TB). */
  lakeStorageTb: number
  /** Data the ingestion copies to the analytics platform a month (GB): the app's writes, or a data platform's lake growth. */
  platformChangesGbMonth: number
  /** Data the analytics queries scan in a month (TB). */
  scannedTbMonth: number
  /** Hours a day analytics compute runs queries. */
  analyticsHours: number
  /** People who read the reports and dashboards. */
  analyticsUsers: number
  /** Source systems the analytics platform ingests from. */
  sourceCount: number
  /** LLM input tokens plus 5x output tokens per call: the billed weight of one completion. */
  weightedTokensPerCall: number
  /** Model calls a month: assistant messages of the daily users, plus extracted pages and rows enriched in SQL. */
  llmCallsMonth: number
  /** Model calls per second at peak: messages follow the traffic peak, batch work runs evenly. */
  peakLlmQps: number
  /** Agent tasks per second at peak (one per message when agents are chosen), and the model calls their reasoning steps make. */
  peakAgentTaskQps: number
  peakAgentLlmQps: number
  /** Model calls per second the document extraction makes, spread evenly over the month. */
  peakExtractLlmQps: number
  /** Output tokens the model generates per second at peak (sizes self-hosted GPUs). */
  peakLlmTokensPerSec: number
  /** Tokens embedded once before launch: the document corpus plus the kept records' text. */
  corpusTokens: number
  /** Embeddings retrieval searches: uploaded document chunks plus the document corpus. */
  vectors: number
  /** Tokens embedded a month: changed corpus documents plus new uploaded chunks. */
  embedTokensMonth: number
}

export interface ComponentInstance {
  def: ComponentDef
  tech: string
  replicas: number
  /** Key slices that are each needed (in-memory stores); replicas beyond them are standbys. */
  shards?: number
  /** 0..1+ estimated utilization of the sized resource at peak. */
  utilization: number
  sizingNote: string
  /** Billed units, or replicas for instance-priced components. */
  units: number
  /** Price of one unit after the instance class factor; monthlyCost = units x unitCost. */
  unitCost: number
  /** List price of one unit before the instance class, provider, region, commitment and discount factors: the value a unit-price override replaces; 0 when the cost follows other components (a second region). */
  listPrice: number
  /** The key of this line's unit-price override (unitPriceKey): the component, offer and capacity tier that price it. */
  priceKey: string
  /** Null for billed and external components. */
  instanceClass: string | null
  /** A billed line its offer sells under a commitment (capacity reservation, pre-purchase), so infra.commitment discounts it like an instance. */
  committable?: boolean
  costKind: CostKind
  /** Resolved from the definition's phase and transitionWhen. */
  phase?: 'transition'
  offer?: { provider: string; name: string; asOf: string; sla?: number }
  /** Who bills the line: an infra.cloud option, another company ('databricks', 'any' for a SaaS vendor), or undefined for a third party without an offer. */
  billedBy?: string
  /** Block storage and backups (storageFrom), included in monthlyCost on top of units x unitCost. */
  storageCost?: number
  monthlyCost: number
}

export interface EdgeInstance {
  id: string
  from: string
  to: string
  label: string
  protocol: Protocol
  qps: number
}

export interface Architecture {
  components: ComponentInstance[]
  edges: EdgeInstance[]
}

export interface Finding {
  rule: ValidationRule
}

export interface Evaluation {
  facts: Facts
  questions: QuestionState[]
  next: QuestionState | null
  workload: Workload
  architecture: Architecture
  findings: Finding[]
  /** Equals cost.monthly, kept for existing callers. */
  monthlyCost: number
  cost: {
    /** Run, license and non-production lines of steady-state components. */
    monthly: number
    people: number
    oneTime: number
    transitionMonthly: number
    /** One-time costs plus every monthly cost while old and new systems coexist. */
    transitionTotal: number
    paybackMonths: number | null
    byTier: Record<string, number>
    byKind: Record<string, number>
    /** The engineer's extra lines (overrides), already counted in the totals above. */
    extraLines: ExtraCostLine[]
  }
  /** Estimated request-path availability in percent. */
  availability: number
  progress: { answered: number; total: number }
}
