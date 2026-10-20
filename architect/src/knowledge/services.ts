import type { Condition, LinearSizing, ReferenceNumbers, ServiceOffer, SourceRef } from '../domain/types'
import { f } from '../engine/conditions'
import { MAU_PER_DAU, vectorIndexFor } from './components'
import { hybridAnalytics, hybridCloudPlatform } from './questions'
import { reference as baseReference } from './reference'
import { S } from './sources'

// Each provider's own service for a component. The first matching row wins, so specific conditions come first.
// Names follow the 101 cheat sheets where they cover a service; the rest, and every non-AWS price, are general knowledge.
const PROVIDERS = ['aws', 'azure', 'gcp', 'onprem'] as const
type Provider = (typeof PROVIDERS)[number]
/** One name per provider in PROVIDERS order; null = the provider has no such service. */
type Names = [aws: string | null, azure: string | null, gcp: string | null, onprem: string | null]
const AS_OF = '2025-07'
const GENERAL: Record<Provider, SourceRef> = { aws: S.generalAws, azure: S.generalAzure, gcp: S.generalGcp, onprem: S.generalOnprem }

interface Extra {
  prices?: (number | undefined)[]
  sla?: (number | undefined)[]
  unit?: string
  sizing?: LinearSizing
  sources?: SourceRef[]
  commitment?: Record<string, number>
  regionPriced?: boolean
  /** ServiceOffer.vendor per provider (index into Names), for rows another company bills. */
  vendors?: (string | undefined)[]
  /** ServiceOffer.sharedStorage per provider (index into Names). */
  sharedStorage?: (boolean | undefined)[]
}

function offers(component: string, when: Condition | undefined, names: Names, extra: Extra = {}): ServiceOffer[] {
  return PROVIDERS.flatMap((provider, i) => {
    const name = names[i]
    if (!name) return []
    const offer: ServiceOffer = { component, provider, name, asOf: AS_OF, sources: [...(extra.sources ?? []), GENERAL[provider]] }
    if (when) offer.when = when
    if (extra.prices?.[i] !== undefined) offer.monthlyCostPerUnit = extra.prices[i]
    if (extra.unit && offer.monthlyCostPerUnit !== undefined) offer.unit = extra.unit
    if (extra.sla?.[i] !== undefined) offer.sla = extra.sla[i]
    if (extra.sizing) offer.sizing = extra.sizing
    if (extra.commitment) offer.commitment = extra.commitment
    if (extra.regionPriced) offer.regionPriced = true
    if (extra.vendors?.[i]) offer.vendor = extra.vendors[i]
    if (extra.sharedStorage?.[i]) offer.sharedStorage = true
    return [offer]
  })
}

// The model runs on own GPUs, or the data policy allows no external model service: the AI rows below stay inside as well.
/** Residency keeps the data on hardware the organisation owns, or off every network. */
const ownHardwareOnly = f.in('security.residency', ['onprem_required', 'air_gapped'])
const privateAi = f.any(f.eq('ai.model_hosting', 'self_hosted_open'), f.eq('ai.data_policy', 'no_external'))

// Change capture lands in the lake, not in a new database: building on existing data, or a data platform with no operational database.
const cdcIntoLake = f.any(f.ne('profile.replace', true), f.eq('profile.requestPath', false))

const suffixed = (names: Names, suffix: string): Names => names.map((n) => (n ? `${n}${suffix}` : null)) as Names

const COMPUTE: Record<string, Names> = {
  managed_containers: ['ECS on Fargate', 'Azure Container Apps', 'Cloud Run', null],
  paas: ['App Runner', 'App Service', 'App Engine', null],
  kubernetes: ['EKS', 'AKS', 'GKE', 'RKE2'],
  vms: ['EC2 Auto Scaling', 'VM Scale Sets', 'Managed Instance Groups', 'KVM/Proxmox'],
}
const onCompute = (component: string, prefix = ''): ServiceOffer[] =>
  Object.entries(COMPUTE).flatMap(([compute, names]) => offers(component, f.eq('infra.compute', compute), prefix ? (names.map((n) => (n ? `${prefix} on ${n}` : null)) as Names) : names))

const VALKEY: Names = ['ElastiCache for Valkey', 'Azure Managed Redis', 'Memorystore for Valkey', 'Valkey + Sentinel']
const SELF_MANAGED_PG: Names = ['PostgreSQL on EC2', 'PostgreSQL on Azure VMs', 'PostgreSQL on Compute Engine', 'PostgreSQL on own servers']
const MANAGED_PG: Names = ['RDS for PostgreSQL', 'Azure Database for PostgreSQL Flexible Server', 'Cloud SQL for PostgreSQL', 'PostgreSQL + Patroni']
const SELF_MANAGED_MYSQL: Names = ['MySQL on EC2', 'MySQL on Azure VMs', 'MySQL on Compute Engine', 'MySQL on own servers']
const MANAGED_MYSQL: Names = ['RDS for MySQL', 'Azure Database for MySQL Flexible Server', 'Cloud SQL for MySQL', 'MySQL InnoDB Cluster']

// Managed PostgreSQL and MySQL run one write primary and do not shard, so multi-primary and sharded designs run the engine on VMs,
// except where the provider sells a sharded PostgreSQL (Aurora Limitless, Citus on Azure).
const pg = f.eq('data.primary_db', 'postgres')
const mysql = f.eq('data.primary_db', 'mysql')
const multiPrimary = f.eq('data.replication', 'multi_primary')
const sharded = f.in('data.partitioning', ['hash_sharding', 'range_sharding'])
/** One write primary, unsharded: what managed PostgreSQL and MySQL run. */
const singleWriter = f.not(f.any(multiPrimary, sharded))
const DB = [S.g101CloudDb]
const platform = (id: string) => f.eq('data.platform', id)
// shortcut: the component's node price ($500 primary, $400 replica) on AWS, scaled by the 2 vCPU / 8 GB list rate (us-east, general knowledge, mid-2025):
// RDS db.m6i.large about $0.178/h, Azure Flexible Server D2ds_v5 about $0.171/h (0.96), Cloud SQL Enterprise about $0.139/h (0.78); own hardware keeps the default. Quote real SKUs.
const managedDbPrices = (component: 'db-primary' | 'db-replica') => [1, 0.96, 0.78].map((share) => share * (component === 'db-primary' ? 500 : 400))
const relational = (component: 'db-primary' | 'db-replica', replica: (names: Names) => Names): ServiceOffer[] => [
  ...offers(component, f.all(pg, multiPrimary), replica(SELF_MANAGED_PG), { sources: DB }),
  ...offers(
    component,
    f.all(pg, f.eq('data.partitioning', 'hash_sharding')),
    component === 'db-primary'
      ? ['Aurora PostgreSQL Limitless Database', 'Azure Database for PostgreSQL elastic clusters (Citus)', 'PostgreSQL + Citus on Compute Engine', 'PostgreSQL + Citus']
      : ['Aurora PostgreSQL Limitless Database standbys', 'Azure Database for PostgreSQL elastic clusters (Citus) replicas', 'PostgreSQL + Citus replicas on Compute Engine', 'PostgreSQL + Citus replicas'],
    // Aurora replicas read the cluster's shared volume, which the primary already bills.
    { sources: DB, ...(component === 'db-replica' && { sharedStorage: [true] }) },
  ),
  ...offers(component, f.all(pg, sharded), replica(['PostgreSQL on EC2', 'PostgreSQL on Azure VMs', 'PostgreSQL on Compute Engine', 'PostgreSQL + Patroni']), { sources: DB }),
  // Rehosting keeps the engine on virtual machines, as for SQL Server and Oracle.
  ...offers(component, f.all(pg, f.eq('migration.approach', 'rehost')), replica(['PostgreSQL on EC2', 'PostgreSQL on Azure VMs', 'PostgreSQL on Compute Engine', 'PostgreSQL + Patroni']), { sources: DB }),
  ...offers(component, f.all(pg, singleWriter), replica(MANAGED_PG), { sources: DB, prices: managedDbPrices(component) }),
  ...offers(component, f.all(mysql, f.any(multiPrimary, sharded)), replica(SELF_MANAGED_MYSQL), { sources: DB }),
  ...offers(component, f.all(mysql, f.eq('migration.approach', 'rehost')), replica(SELF_MANAGED_MYSQL), { sources: DB }),
  ...offers(component, f.all(mysql, singleWriter), replica(MANAGED_MYSQL), { sources: DB, prices: managedDbPrices(component) }),
]

const LINKS: Record<'vpn' | 'dedicated_1g' | 'dedicated_10g', Names> = {
  vpn: ['AWS Site-to-Site VPN', 'Azure VPN Gateway', 'Cloud VPN (HA VPN)', 'IPsec site-to-site VPN (strongSwan)'],
  dedicated_1g: ['AWS Direct Connect (1 Gbps)', 'Azure ExpressRoute (1 Gbps)', 'Cloud Interconnect (Partner, 1 Gbps)', 'Dedicated 1 Gbps WAN circuit'],
  dedicated_10g: ['AWS Direct Connect (10 Gbps)', 'Azure ExpressRoute (10 Gbps)', 'Cloud Interconnect (Dedicated, 10 Gbps)', 'Dedicated 10 Gbps WAN circuit'],
}
// A hybrid design runs its analytics in one cloud while the app stays on premises: its rows are on-prem rows named after that cloud.
const HYBRID_CLOUDS = [['aws', 'AWS'], ['azure', 'Azure'], ['gcp', 'Google Cloud']] as const
const analyticsIn = (cloud: string) => f.all(hybridCloudPlatform, f.eq('data.analytics_cloud', cloud))
/** One on-prem row per analytics cloud, named and priced after the cloud's own row (index into Names and prices). */
const hybridRows = (component: string, when: Condition, name: (cloud: string, i: number) => string, extra: Extra = {}): ServiceOffer[] =>
  HYBRID_CLOUDS.flatMap(([cloud, label], i) =>
    offers(component, f.all(analyticsIn(cloud), when), [null, null, null, name(label, i)], { ...extra, prices: extra.prices && [undefined, undefined, undefined, extra.prices[i]] }),
  )

/** A Databricks row on every provider: Microsoft bills Azure Databricks (first party, it counts toward a MACC), Databricks bills it on AWS, Google Cloud and over a private link. */
const databricksBilled = (o: ServiceOffer): ServiceOffer[] => PROVIDERS.map((provider) => ({ ...o, provider, ...(provider !== 'azure' && { vendor: 'databricks' }) }))

const L7_BALANCER: Names = ['an Application Load Balancer', 'Application Gateway', 'an External Application Load Balancer', 'HAProxy']
// PaaS and serverless draw no lb (the platform routes), so those designs keep the plain techFrom label with no balancer named.
const realtime = (transport: string, label: string, behind: Names): ServiceOffer[] =>
  offers('ws-gateway', f.all(f.eq('perf.realtime', transport), f.ne('infra.compute', 'paas'), f.ne('arch.style', 'serverless')), behind.map((lb) => `${label} behind ${lb}`) as Names, { sources: [S.g101CloudLb] })

// Analytics pricing: list prices, general knowledge mid-2025 (reference.ts lists every rate); none of them is a quote.
const all4 = (price: number) => [price, price, price, price]
// Platforms sold under their own reservation or pre-purchase: the share of list price paid per infra.commitment option (list terms, general knowledge mid-2025; negotiated contracts differ).
// shortcut: Fabric and Redshift Serverless reserve for one year only, so the 3-year option keeps the 1-year rate; BigQuery on-demand scans have no commitment (editions slots bill another way).
const FABRIC_RESERVED = { commit_1y: 0.59, commit_3y: 0.59 }
const DATABRICKS_DBCU = { commit_1y: 0.85, commit_3y: 0.75 }
const SNOWFLAKE_CAPACITY = { commit_1y: 0.9, commit_3y: 0.8 }
const REDSHIFT_RESERVED = { commit_1y: 0.8, commit_3y: 0.8 }
const flatLine = (note: string): LinearSizing => ({ product: [1], per: 1, billed: true, note })
// shortcut: a daily incremental load per source system of about one compute-unit-hour (DPU, DIU or DBU), 30 a month (general knowledge, mid-2025); time your real jobs.
const BATCH_LOAD_HOURS_PER_SOURCE = 30
// shortcut: Google Cloud's batch loaders on the same basis as Glue and ADF, per hour of a 4-vCPU worker: Dataflow about $0.28 (4 vCPU + 16 GB), Dataproc Serverless
// $0.06 per DCU (x4), ClickPipes about $0.20 a replica-hour and Snowpipe's serverless compute about $0.25 (general knowledge, mid-2025); time your real jobs.
const batchJob = (price: number, unit: string) => ({
  prices: all4(price),
  unit,
  sizing: { product: ['cap.lakeStorageTb', 2], floor: ['cap.sourceCount', BATCH_LOAD_HOURS_PER_SOURCE], per: 1, billed: true, min: 1, note: `{units} ${unit}s a month: a job per source, about 1 a day each, or 2 per TB of lake when the volume needs more.` } satisfies LinearSizing,
})
// shortcut: one 80 GB H100/A100-class GPU about $3,000 a month on demand (general knowledge, mid-2025); a multi-GPU replica of a large model batches fewer
// requests per GPU, so it serves about half the output tokens/s of the small model's L4 node (reference.gpuTokensPerSecond). Benchmark your model.
const GPU_80GB_MONTHLY = 3_000
const gpuReplicas = (reference: ReferenceNumbers, gpus: number): LinearSizing => ({
  product: ['cap.peakLlmTokensPerSec'],
  per: reference.gpuTokensPerSecond / 2,
  spare: true,
  wholeNodes: true,
  note: `{demand} output tokens/s at peak on {units} replica(s) of ${gpus} GPUs, about ${(reference.gpuTokensPerSecond / 2).toLocaleString('en-US')} tokens/s each{spare}.`,
})
/** Fabric runs Spark, pipelines, Eventstream and mirroring on the F capacity, so those lines bill nothing of their own. */
const onCapacity = flatLine('Consumes F capacity: priced in the warehouse line.')
// shortcut: lake TB stand in for CU demand, and Spark or streaming jobs double it; size on the Fabric Capacity Metrics app once workloads run.
const FABRIC_TIERS = [
  { name: 'F2', max: 0.5, monthly: 262.8 },
  { name: 'F4', max: 1, monthly: 525.6 },
  { name: 'F8', max: 3, monthly: 1_051.2 },
  { name: 'F16', max: 8, monthly: 2_102.4 },
  { name: 'F32', max: 20, monthly: 4_204.8 },
  { name: 'F64', max: 50, monthly: 8_409.6 },
]
const F64_MONTHLY = FABRIC_TIERS.find((t) => t.name === 'F64')!.monthly
const POWER_BI_PRO = 14
const FABRIC_JOBS_FACTOR = 2
const fabricJobs = f.any(f.eq('ml.serving', 'batch'), f.eq('data.analytics', 'streaming'))
const belowF64Tb = FABRIC_TIERS.find((t) => t.name === 'F32')!.max
/** The capacity reaches F64, which lets every viewer read Power BI content without a Pro seat. */
export const fabricF64 = f.all(f.eq('data.platform', 'fabric'), f.any(f.gt('cap.lakeStorageTb', belowF64Tb), f.all(fabricJobs, f.gt('cap.lakeStorageTb', belowF64Tb / FABRIC_JOBS_FACTOR))))
const FABRIC_NOTE = 'pay-as-you-go, about 41% less reserved, and pausable outside the query hours'
/** The capacity line, split at F64 so only smaller capacities say that viewers need Pro seats. */
function fabricCapacity(when: Condition, product: (string | number)[], lead: string): ServiceOffer[] {
  const offer = (w: Condition, seats: string): ServiceOffer => ({ component: 'warehouse', provider: 'any', when: w, name: 'Fabric F-SKU capacity: OneLake + Lakehouse/Warehouse + Power BI', vendor: 'azure', asOf: AS_OF, commitment: FABRIC_RESERVED, regionPriced: true, sizing: { product, per: 1, tiers: FABRIC_TIERS, note: `${lead}; ${FABRIC_NOTE}${seats}` }, sources: [S.generalFabric] })
  return [offer(f.all(when, fabricF64), '; from F64 viewers read Power BI content without a Pro seat.'), offer(when, '; below F64 every viewer needs a Power BI Pro seat.')]
}
// shortcut: hourly warehouses keep their base size up to 32 TB and grow linearly with the lake past it; size on your own query history.
const BASE_TB = 32
// shortcut: ClickHouse compresses columnar event data about 5-10x, so 7x; an own node holds about 4 TB of compressed columns (general knowledge, mid-2025); measure your own tables.
export const CLICKHOUSE_COMPRESSION = 7
const CLICKHOUSE_NODE_TB = 4
// ClickHouse Cloud Scale, about $0.30 per compute unit-hour and $25.30 per compressed TB-month (general knowledge, mid-2025): two replicas of 2 units (16 GiB) during the query hours, growing past BASE_TB with the lake.
const CLICKHOUSE_UNITS = 4
const CLICKHOUSE_CLOUD: [Condition, (string | number)[], string][] = [
  [f.gt('cap.lakeStorageTb', BASE_TB), ['cap.analyticsHours', 30, CLICKHOUSE_UNITS / BASE_TB, 'cap.lakeStorageTb'], '{units} compute unit-hours a month: past 32 TB the two replicas grow with the lake, during the query hours.'],
  [f.not(f.gt('cap.lakeStorageTb', BASE_TB)), ['cap.analyticsHours', 30, CLICKHOUSE_UNITS], `Two replicas of 16 GiB (${CLICKHOUSE_UNITS} compute units) during the query hours, idle otherwise: {units} compute unit-hours a month.`],
]
/** A warehouse billed per compute unit-hour while queries run: `perHour` units an hour at the base size, more past BASE_TB of lake. */
function hourly(when: Condition, names: Names, perHour: number, price: number, unit: string, size: string, sources: SourceRef[], commitment: Record<string, number>, vendors?: (string | undefined)[]): ServiceOffer[] {
  const billed = (product: (string | number)[], note: string) => ({ prices: all4(price), unit, sources, commitment, regionPriced: true, vendors, sizing: { product, per: 1, billed: true, note } })
  return [
      ...offers('warehouse', f.all(when, f.gt('cap.lakeStorageTb', BASE_TB)), names, billed(['cap.analyticsHours', 30, perHour / BASE_TB, 'cap.lakeStorageTb'], `{units} ${unit}s a month: past ${BASE_TB} TB the ${size} grows with the lake, during the query hours.`)),
      ...offers('warehouse', when, names, billed(['cap.analyticsHours', 30, perHour], `${size} (${perHour} ${unit}s an hour) during the query hours: {units} ${unit}s a month.`)),
    ]
  }
  const seats = (note: string): LinearSizing => ({ product: ['cap.analyticsUsers'], per: 1, billed: true, note })

// Per-use services bill what they serve (list prices, general knowledge mid-2025); the self-hosted row keeps the component's node pricing.
const millionRequests = (note: string, min = 0): LinearSizing => ({ product: ['cap.requestsMonth', 1e-6], per: 1, billed: true, min, note })
/** Millions a month of an average per-second rate (cap.readQps, cap.writeQps), as cap.requestsMonth counts them. */
const MILLIONS_PER_QPS_MONTH = (86_400 * 365) / 12 / 1e6
const API_GATEWAYS: Names = ['Amazon API Gateway', 'Azure API Management', 'Google Cloud API Gateway', null]
const notBff = f.ne('arch.gateway', 'bff')
// shortcut: a read-heavy monolith whose users sign in serves its reads (redirects, pages) from the app behind the load balancer, and its gateway fronts only
// the public API, taken as the writes (the links a URL shortener's API creates); size the gateway on the real API call mix when known.
const apiOnlyGateway = f.all(f.in('arch.style', ['monolith', 'modular_monolith']), f.eq('traffic.read_write', 'read_heavy'), f.inc('product.features', 'accounts'), f.inc('product.features', 'public_api'))
const WAFS: Names = ['AWS WAF', 'Azure WAF on Front Door', 'Cloud Armor', null]
const WAF_PRICES = [0.6, 0.6, 0.75]
/** The balancer holds the real-time connections when it fronts the real-time servers (the ws-gateway rows below). */
const heldConnections = f.all(f.in('perf.realtime', ['websocket', 'sse', 'long_polling']), f.ne('infra.compute', 'paas'), f.ne('arch.style', 'serverless'))
/** One row per cloud provider (index into Names), each with its own price and sizing. */
const perCloud = (component: string, when: Condition | undefined, names: Names, row: (i: number) => Extra): ServiceOffer[] =>
  [0, 1, 2].flatMap((i) => offers(component, when, names.map((n, j) => (j === i ? n : null)) as Names, row(i)))
const only = (i: number, value: number) => Array.from({ length: 4 }, (_, j) => (j === i ? value : undefined))
// Customer identity bills monthly active users past a free tier: Cognito Lite past 10,000 and Identity Platform past 50,000 at $0.0055 falling to $0.0025
// (about $0.005 below a million MAU, $0.003 blended above), Entra External ID past 50,000 at about $0.00325 (the Azure AD B2C P1 rate).
const IDENTITY: [free: number, price: number, pastMillion: number][] = [[10_000, 0.005, 0.003], [50_000, 0.00325, 0.00325], [50_000, 0.005, 0.003]]
const pastMillionMau = f.gt('cap.dau', 1e6 / MAU_PER_DAU)
// shortcut: about 1 KB of logs per request (2 KB with traces), and a small floor for metrics, alarms and dashboards; size on your own log volume.
// Ingestion per GB: CloudWatch Logs $0.50, Azure Monitor Analytics Logs about $2.30, Cloud Logging $0.50.
const LOG_GB_PRICE = [0.5, 2.3, 0.5]
const logs = (level: string, kbPerRequest: number, floorUsd: number, names: Names): ServiceOffer[] => [
  ...perCloud('observability', f.eq('ops.observability', level), names, (i) => ({
    prices: only(i, LOG_GB_PRICE[i]),
    unit: 'GB of logs',
    sizing: { product: ['cap.requestsMonth', kbPerRequest / 1e6], per: 1, billed: true, min: Math.round(floorUsd / LOG_GB_PRICE[i]), note: `{demand} GB of logs a month (about ${kbPerRequest} KB per request), billed per GB ingested: {units} GB, at least ${Math.round(floorUsd / LOG_GB_PRICE[i])} GB (about $${floorUsd}) for metrics, alarms and dashboards.` },
    sources: [S.g101CloudMonitoring],
  })),
  ...offers('observability', f.eq('ops.observability', level), [null, null, null, names[3]], { sources: [S.g101CloudMonitoring] }),
]

  /** The provider offers, built from the reference numbers their prices and sizing bake in, so an overridden reference rebuilds them (engine/overrides.ts). */
  export function buildServices(reference: ReferenceNumbers): ServiceOffer[] {
    const vectorIndex = vectorIndexFor(reference)
    return [
    // Edge and ingress
    ...offers('dns', undefined, ['Route 53', 'Azure DNS', 'Cloud DNS', 'PowerDNS'], { sources: [S.g101CloudComparison] }),
    ...offers('cdn', f.eq('perf.cdn', 'pull'), ['CloudFront', 'Azure Front Door', 'Cloud CDN', 'Varnish'], { sources: [S.g101CloudComparison] }),
    // An own edge fleet is the organisation's hardware in ISP sites, not a cloud service: the cloud bills none of it (support plan, negotiated discount).
    { component: 'cdn', provider: 'any', when: f.eq('perf.cdn', 'push'), name: 'Push CDN / own edge (Open Connect style)', vendor: 'own', asOf: AS_OF, sources: [S.g101Cdn, S.generalOnprem] },
    // AWS WAF and Front Door WAF bill $0.60 per million requests, Cloud Armor Standard $0.75, on top of about $15 a month for the policy and rules (the minimum).
    // Over a WebSocket the writes travel on the open connections past the WAF, which inspects only the HTTP requests (the upgrade among them): the reads.
    ...offers('waf', f.eq('perf.realtime', 'websocket'), WAFS, { prices: WAF_PRICES, unit: 'million requests', sizing: { product: ['cap.readQps', MILLIONS_PER_QPS_MONTH], per: 1, billed: true, min: 25, note: '{demand} million HTTP requests a month inspected (messages on the WebSockets pass uninspected), billed per million, at least the policy and its rules.' } }),
    ...offers('waf', undefined, WAFS, { prices: WAF_PRICES, unit: 'million requests', sizing: millionRequests('{demand} million requests a month inspected, billed per million, at least the policy and its rules.', 25) }),
    ...offers('waf', undefined, [null, null, null, 'HAProxy + Coraza']),
    // No published SLA here (Application Gateway v2 is 99.95%, the others 99.99%): one service's SLA alone would add a standby region on one provider only.
    // Record SLAs for the whole request path (compute, database, cache) on every provider at once, or not at all.
    // shortcut: the component's $30 on AWS, scaled by the fixed hourly list rate (us-east, general knowledge, mid-2025): ALB about $0.0225/h,
    // Application Gateway Standard_v2 about $0.246/h, a Google Cloud forwarding rule about $0.025/h; capacity units and LCUs bill on top. HAProxy keeps the default.
    // Held real-time connections bill on the balancer: an ALB LCU covers 3,000 active connections, an Application Gateway v2 capacity unit 2,500, each $0.008
    // an hour ($5.84 a month), at least the fixed hourly charge (ALB about $16, Standard_v2 about $180 a month). Google's balancer bills no connections.
    ...perCloud('lb', heldConnections, ['Application Load Balancer', 'Application Gateway (L7)', null, null], (i) => ({
      prices: only(i, 5.84),
      unit: ['LCU', 'capacity unit'][i],
      sizing: { product: ['cap.connections'], per: [3_000, 2_500][i], billed: true, min: [3, 31][i], note: `{demand} concurrent connections held, ${['3,000 per LCU', '2,500 per capacity unit'][i]}: {units} ${['LCUs', 'capacity units'][i]}, at least the fixed hourly charge.` },
      sources: [S.g101CloudLb],
    })),
    ...offers('lb', undefined, ['Application Load Balancer', 'Application Gateway (L7)', 'External Application Load Balancer', 'HAProxy + keepalived'], { sources: [S.g101CloudLb], prices: [30, 330, 33] }),
    // The gateway product also fronts a strangler migration that asked no gateway question; a backend-for-frontend is its own service.
    // Billed per million requests: Amazon API Gateway REST APIs $3.50, API Management Consumption $3.50, Google Cloud API Gateway $3.00.
    // Past a billion a month the volume tiers apply: REST APIs fall to $2.38, API Management moves to Premium units, Google's gateway to $1.50.
    // REST APIs bill $1.51 past 20 billion: blended with the earlier tiers about $1.90 at 50 billion and $1.60 from 100 billion ($1.57 at 300 billion).
    ...offers('api-gateway', f.all(notBff, apiOnlyGateway), API_GATEWAYS, { prices: [3.5, 3.5, 3], unit: 'million requests', sizing: { product: ['cap.writeQps', MILLIONS_PER_QPS_MONTH], per: 1, billed: true, note: '{demand} million API calls a month (the writes; reads reach the app through the load balancer), billed per million.' } }),
    ...offers('api-gateway', f.all(notBff, f.gt('cap.requestsMonth', 1e11)), API_GATEWAYS, { prices: [1.6, 2.5, 1.5], unit: 'million requests', sizing: millionRequests('{demand} million requests a month at the volume-tier rate.') }),
    ...offers('api-gateway', f.all(notBff, f.gt('cap.requestsMonth', 2e10)), API_GATEWAYS, { prices: [1.9, 2.5, 1.5], unit: 'million requests', sizing: millionRequests('{demand} million requests a month at the volume-tier rate.') }),
    ...offers('api-gateway', f.all(notBff, f.gt('cap.requestsMonth', 1e9)), API_GATEWAYS, { prices: [2.5, 2.5, 1.5], unit: 'million requests', sizing: millionRequests('{demand} million requests a month at the volume-tier rate.') }),
    ...offers('api-gateway', notBff, API_GATEWAYS, { prices: [3.5, 3.5, 3], unit: 'million requests', sizing: millionRequests('{demand} million requests a month, billed per million.') }),
    ...offers('api-gateway', notBff, [null, null, null, 'Kong']),
    // Migration: the link to the old system, the change capture and the bulk copy (prices on the components; general knowledge, mid-2025).
    // After an offline device load, a VPN carries the CDC change stream (components.ts: hybrid-link).
    // A hybrid design's analytics link is the analytics cloud's product (data.analytics_cloud), a dedicated 1 Gbps port whatever the migration crosses;
    // the migration's own link there (migration-link) is the one migration.link chose.
    ...hybridRows('hybrid-link', f.all(), (_, i) => LINKS.dedicated_1g[i]!, { sources: [S.generalMigration], sizing: flatLine('A dedicated 1 Gbps port and circuit for the loads to the analytics cloud.') }),
    // While the analytics cloud is pending the link is still the analytics port, never the migration's link below.
    ...offers('hybrid-link', hybridCloudPlatform, [null, null, null, 'Dedicated 1 Gbps interconnect'], { sources: [S.generalMigration], sizing: flatLine('A dedicated 1 Gbps port and circuit for the loads to the analytics cloud.') }),
    // Live tool lookups into a kept system (nothing copied) cross a VPN; a cloud platform's daily extracts from the data center a dedicated port, like the hybrid analytics link.
    ...offers('hybrid-link', f.eq('profile.keptUncopied', true), LINKS.vpn, { sources: [S.generalMigration], sizing: flatLine('A site-to-site VPN for the live record lookups: IPsec tunnels over the internet, about 0.5 Gbps.') }),
    ...offers('hybrid-link', f.not(f.exists('migration.link')), LINKS.dedicated_1g, { sources: [S.generalMigration], sizing: flatLine('A dedicated 1 Gbps port and circuit for the extracts from the data center.') }),
    ...([
      [f.in('migration.link', ['vpn', 'offline_device']), 'vpn', 'A site-to-site VPN: IPsec tunnels over the internet, about 0.5 Gbps.'],
      [f.eq('migration.link', 'dedicated_1g'), 'dedicated_1g', 'A dedicated 1 Gbps port and circuit.'],
      [f.eq('migration.link', 'dedicated_10g'), 'dedicated_10g', 'A dedicated 10 Gbps port and circuit.'],
    ] as const).flatMap(([link, kind, note]) => [
      ...hybridRows('migration-link', link, (_, i) => LINKS[kind][i]!, { sources: [S.generalMigration], sizing: flatLine(note) }),
      ...offers('hybrid-link', link, LINKS[kind], { sources: [S.generalMigration], sizing: flatLine(note) }),
    ]),
    // The CDC tool must read the source engine and write the target: mainframes (Db2 for z/OS, IMS, VSAM) and Db2 need IBM or partner
    // replication everywhere but AWS DMS (Db2 LUW) and Debezium (Db2 connector); a lake target takes the provider's lake-side CDC.
    // Azure DMS reads SQL Server, MySQL and PostgreSQL, so Oracle on Azure goes through GoldenGate or Qlik. Names only, general knowledge, mid-2025.
    // The CRM extraction through the platform's own connector. shortcut: AppFlow about $0.001 a flow run plus $0.02 per GB, a Data Factory copy about $0.25 a DIU-hour
    // run hourly, Data Fusion Developer about $0.35 an hour, Airbyte on one worker node (list prices, general knowledge mid-2025); price your object count and schedule.
    ...offers('api-extractor', f.all(f.eq('source.crm_extract', 'provider_connector'), f.eq('data.platform', 'fabric')), [null, 'Fabric Data Factory pipeline (Salesforce, Dynamics and HubSpot connectors, on F capacity)', null, null], { prices: [undefined, 0], sources: [S.generalCrm] }),
    ...offers('api-extractor', f.eq('source.crm_extract', 'provider_connector'), ['Amazon AppFlow (Salesforce and HubSpot connectors)', 'Azure Data Factory copy (Salesforce, Dynamics and HubSpot connectors)', 'BigQuery Data Transfer Service for Salesforce, or Cloud Data Fusion', 'Airbyte (self-hosted) on own servers'], { prices: [25, 100, 250, 70], sources: [S.generalCrm] }),
    ...offers('cdc-pipeline', f.inc('source.kinds', 'mainframe'), ['IBM Data Replication (IIDR) or Precisely Connect CDC', 'IBM Data Replication (IIDR) or Precisely Connect CDC', 'IBM Data Replication (IIDR) or Precisely Connect CDC', 'IBM Data Replication (IIDR) or Precisely Connect CDC'], { sources: [S.g101Cdc, S.generalMigration] }),
    ...offers('cdc-pipeline', f.eq('source.rdbms_engine', 'db2'), ['AWS DMS (Db2 LUW source, full load + CDC)', 'IBM Data Replication (IIDR) or Qlik Replicate', 'IBM Data Replication (IIDR) or Qlik Replicate', 'Debezium Db2 connector on Kafka Connect'], { sources: [S.g101Cdc, S.generalMigration] }),
    ...offers('cdc-pipeline', cdcIntoLake, ['AWS DMS (full load + CDC) to S3', 'Fabric Mirroring or Azure Data Factory CDC into OneLake / ADLS', 'Datastream to BigQuery / Cloud Storage', 'Debezium on Kafka Connect, sunk to the lake tables'], { sources: [S.g101Cdc, S.generalMigration] }),
    ...offers('cdc-pipeline', f.eq('source.rdbms_engine', 'oracle'), [null, 'Oracle GoldenGate or Qlik Replicate', null, null], { sources: [S.g101Cdc, S.generalMigration] }),
    ...offers('cdc-pipeline', undefined, ['AWS DMS (full load + CDC)', 'Azure Database Migration Service', 'Datastream / Database Migration Service', 'Debezium on Kafka Connect'], { sources: [S.g101Cdc, S.generalMigration] }),
    // A home-grown or packaged on-premises CRM bought out by a SaaS CRM is loaded through the product's import path, never a database dump (reference.saasCrmImportGbPerHour paces the copy);
    // a relational database next to it is taken as the CRM's own (as questions.ts importsIntoSaasCrm does); with a mainframe the loader keeps its mainframe name.
    ...([['salesforce', 'Salesforce Bulk API 2.0 / Data Loader import'], ['dynamics', 'Dataverse Web API bulk import (ExecuteMultiple) or a Dataverse connector'], ['hubspot', 'HubSpot imports and CRM batch APIs']] as const).map(
      ([target, name]): ServiceOffer => ({
        component: 'bulk-loader',
        provider: 'any',
        when: f.all(f.eq('migration.approach', 'repurchase'), f.inc('source.kinds', 'crm'), f.eq('source.crmOnDatabase', true), f.not(f.inc('source.kinds', 'mainframe')), f.eq('migration.crm_target', target)),
        name,
        asOf: AS_OF,
        sources: [S.generalCrm],
      }),
    ),
    ...offers('bulk-loader', f.eq('migration.link', 'offline_device'), ['AWS Snowball Edge', 'Azure Data Box', 'Transfer Appliance', null], { sources: [S.generalMigration] }),
    // A warehouse exports through its parallel unload tools to the provider's storage, where the provider's loader picks it up; a mainframe ships unloads with copybooks.
    ...offers('bulk-loader', f.inc('source.kinds', 'warehouse'), ['Teradata TPT / FastExport or Netezza unload to S3, loaded by AWS Glue', 'Teradata TPT / FastExport or Netezza unload to ADLS, loaded by Azure Data Factory', 'Teradata TPT / FastExport or Netezza unload to Cloud Storage, loaded by BigQuery Data Transfer Service', 'Teradata TPT / FastExport or Netezza unload, loaded by Spark'], { sources: [S.generalMigration] }),
    ...offers('bulk-loader', f.inc('source.kinds', 'mainframe'), ['AWS Mainframe Modernization file transfer (copybook conversion)', 'Mainframe unloads over SFTP to ADLS, converted by copybook in Azure Data Factory', 'Google Cloud Mainframe Connector (copybook conversion)', 'Mainframe unloads over Connect:Direct or SFTP, converted by copybook'], { sources: [S.generalMigration] }),
    // One-off transfer: one device job per 80 TB at about $300 plus shipping, or egress at about $0.09/GB out of the source cloud (general knowledge, mid-2025; providers waive egress for leaving customers on request).
    { component: 'transfer-fees', provider: 'any', when: f.eq('migration.link', 'offline_device'), name: 'Offline device jobs', asOf: AS_OF, monthlyCostPerUnit: 300, unit: 'device', costKind: 'one_time', sizing: { product: ['mig.transferGb', 1 / 1024 / reference.offlineDeviceTb], per: 1, billed: true, note: `{units} device job(s), one per ${reference.offlineDeviceTb} TB of the copy plus any archived history, paid once.` }, sources: [S.generalMigration] },
    { component: 'source-egress', provider: 'any', when: f.eq('source.leavesCloud', true), name: 'Egress from the source cloud', asOf: AS_OF, monthlyCostPerUnit: 0.09, unit: 'GB', costKind: 'one_time', sizing: { product: ['mig.transferGb'], per: 1, billed: true, note: '{demand} GB (the copy, plus any history archived out of the database) leave the source cloud once, billed per GB.' }, sources: [S.g101HiddenCloudCosts, S.generalMigration] },
    // Every transport sits behind the drawn and priced layer-7 balancer (the lb row): all four pass the WebSocket upgrade and hold long-lived connections.
    ...realtime('websocket', 'WebSocket servers', L7_BALANCER),
    ...realtime('sse', 'SSE servers', L7_BALANCER),
    ...realtime('long_polling', 'Long-polling endpoints', L7_BALANCER),
    ...offers('realtime-service', undefined, ['API Gateway WebSocket APIs', 'Azure Web PubSub', 'Firebase Realtime Database', 'Ably (hosted)']),
    ...([[pastMillionMau, 2], [undefined, 1]] as const).flatMap(([when, price]) =>
      perCloud('auth', f.all(f.eq('security.auth', 'oidc'), ...(when ? [when] : [])), ['Amazon Cognito', 'Entra External ID', 'Identity Platform', null], (i) => ({
        prices: only(i, IDENTITY[i][price]),
        unit: 'MAU',
        sizing: { product: ['cap.dau', MAU_PER_DAU], per: 1, billed: true, free: IDENTITY[i][0], note: `{demand} monthly active users (about ${MAU_PER_DAU} per daily user); the first ${IDENTITY[i][0].toLocaleString('en-US')} are free, {units} billed.` },
      })),
    ),
    ...offers('auth', f.eq('security.auth', 'oidc'), [null, null, null, 'Keycloak']),
    // SAML/OIDC federation bills each federated monthly user past 50 free at about $0.015 on Cognito and Identity Platform (general knowledge, mid-2025);
    // Entra ID workforce sign-in comes with the tenant, and Keycloak keeps node pricing.
    ...[0, 2].flatMap((i) =>
      offers('auth', f.eq('security.auth', 'sso'), ['Cognito SAML federation', null, 'Identity Platform SAML', null].map((n, j) => (j === i ? n : null)) as Names, {
        prices: only(i, 0.015),
        unit: 'MAU',
        sizing: { product: ['cap.dau', MAU_PER_DAU], per: 1, billed: true, free: 50, note: `{demand} federated monthly users (about ${MAU_PER_DAU} per daily user); the first 50 are free, {units} billed.` },
      }),
    ),
    ...offers('auth', f.eq('security.auth', 'sso'), [null, 'Entra ID', null, 'Keycloak federation']),

    // Compute: functions are '@service' members too, so their rows come first.
    ...offers('functions', undefined, ['AWS Lambda', 'Azure Functions', 'Cloud Run functions', null]),
    ...onCompute('@service'),
    ...onCompute('workers'),
    ...onCompute('graph-service', 'BFS traversal service'),
    // iPaaS per provider; custom connectors run on the workers' compute and keep the component's name.
    // AppFlow bills $0.001 a flow run (data processed at $0.02/GB on top); one Logic Apps Standard plan hosts every workflow, two WS1 instances (1 vCPU, 3.5 GB)
    // about $175 a month each, with built-in connectors free; Google's Application Integration and the self-hosted row keep the component's price per connection.
    // shortcut: a flow each way every 15 minutes per system (5,840 runs a month); count your real flow schedules.
    ...offers('integration-hub', f.eq('integration.approach', 'ipaas'), ['Amazon AppFlow + EventBridge', null, null, null], { prices: [0.001], unit: 'flow run', sizing: { product: ['integration.systems', 5_840], per: 1, billed: true, min: 1, note: '{demand} flow runs a month (a flow each way every 15 minutes per connected system), billed per run.' } }),
    ...offers('integration-hub', f.eq('integration.approach', 'ipaas'), [null, 'Azure Logic Apps (Standard)', null, null], { prices: [undefined, 350], sizing: flatLine('One Standard plan of two WS1 instances hosts the workflows of every connected system.') }),
    ...offers('integration-hub', f.eq('integration.approach', 'ipaas'), [null, null, 'Google Cloud Application Integration', 'Apache Camel K / WSO2 Micro Integrator']),
    ...offers('scheduler', undefined, ['EventBridge Scheduler', 'Logic Apps recurrence', 'Cloud Scheduler', 'Kubernetes CronJob']),
    ...offers('ml-inference', undefined, ['SageMaker endpoints', 'Azure ML online endpoints', 'Vertex AI endpoints', 'KServe']),
    // A hosted model API sends prompts and retrieved context off premises, so on-premises has no offer (validation hosted-llm-residency).
    { component: 'llm-api', provider: 'any', when: f.eq('ai.model_hosting', 'direct_api'), name: 'Model vendor API (OpenAI, Anthropic, Mistral)', asOf: AS_OF, sources: [S.generalAi] },
    // A data platform without an app calls the model from SQL, on the platform's own hosted models and bill (edge warehouse-llm).
    ...([
      ['snowflake', 'Snowflake Cortex AI functions (billed in credits)', 'snowflake', S.generalSnowflake],
      ['databricks', 'Databricks Foundation Model APIs via ai_query (billed in DBUs)', 'databricks', S.generalDatabricks],
      ['fabric', 'Fabric AI functions (billed as F capacity units)', 'azure', S.generalFabric],
    ] as const).map(([id, name, vendor, source]): ServiceOffer => ({ component: 'llm-api', provider: 'any', when: f.all(f.eq('profile.requestPath', false), platform(id)), name, vendor, asOf: AS_OF, sources: [source] })),
    ...offers('llm-api', undefined, ['Amazon Bedrock', 'Azure OpenAI in AI Foundry', 'Vertex AI (Gemini)', null], { sources: [S.g101OpenSourceAi] }),
    // AI pack: GPU nodes are priced on the component (about $600 a month, L4 class); names and prices below are general knowledge, mid-2025.
    // Larger open-weight models need several 80 GB GPUs per replica (FP8 weights plus KV cache): a 70B class on 2, the largest open-weight class
    // (DeepSeek-V3, Llama 3.1 405B; frontier models are not released as open weights) on 8. Each 80 GB GPU about $3,000 a month on demand.
    ...offers('llm-serving', f.eq('ai.model_tier', 'mid'), ['vLLM on EKS (p5, 2x H100 80 GB per replica)', 'vLLM on AKS (ND H100 v5, 2x H100 80 GB per replica)', 'vLLM on GKE (A3, 2x H100 80 GB per replica)', 'vLLM on own GPU servers (2x 80 GB per replica)'], { prices: all4(2 * GPU_80GB_MONTHLY), unit: 'replica', sizing: gpuReplicas(reference, 2), sources: [S.g101OpenSourceAi, S.generalAi] }),
    ...offers('llm-serving', f.eq('ai.model_tier', 'frontier'), ['vLLM on EKS (p5, 8x H100 80 GB per replica, largest open-weight class)', 'vLLM on AKS (ND H100 v5, 8x H100 80 GB per replica, largest open-weight class)', 'vLLM on GKE (A3, 8x H100 80 GB per replica, largest open-weight class)', 'vLLM on own GPU servers (8x 80 GB per replica, largest open-weight class)'], { prices: all4(8 * GPU_80GB_MONTHLY), unit: 'replica', sizing: gpuReplicas(reference, 8), sources: [S.g101OpenSourceAi, S.generalAi] }),
    ...offers('llm-serving', undefined, ['vLLM on EKS GPU nodes (L4)', 'vLLM on AKS GPU nodes (L4 / A10)', 'vLLM on GKE GPU nodes (L4)', 'vLLM / TGI on own GPU servers'], { sources: [S.g101OpenSourceAi] }),
    // A self-hosted model or a no-external-service policy keeps the gateway, guardrails, agents and parsing inside too, so these rows come before the provider-model ones.
    { component: 'llm-gateway', provider: 'any', when: privateAi, name: 'LiteLLM proxy (vLLM routing)', asOf: AS_OF, sources: [S.g101OpenSourceAi] },
    { component: 'guardrails', provider: 'any', when: privateAi, name: 'Llama Guard on the GPU nodes', asOf: AS_OF, monthlyCostPerUnit: 0, unit: '1,000 calls', sources: [S.generalAi] },
    ...offers('agent-runtime', privateAi, ['LangGraph on EKS', 'LangGraph on AKS', 'LangGraph on GKE', 'LangGraph']),
    // On premises, or with the model kept inside, documents are parsed by Unstructured or Tika in one worker node, not billed per page.
    { component: 'doc-ingestion', provider: 'any', when: f.any(privateAi, f.eq('infra.cloud', 'onprem')), name: 'Unstructured / Apache Tika workers', asOf: AS_OF, monthlyCostPerUnit: 70, sizing: { product: [1], per: 1, billed: true, note: 'One worker node parses the documents (no per-page fee).' }, sources: [S.generalOnprem] },
    { component: 'doc-ingestion-backfill', provider: 'any', when: f.any(privateAi, f.eq('infra.cloud', 'onprem')), name: 'Unstructured / Apache Tika workers (first pass)', asOf: AS_OF, monthlyCostPerUnit: 70, unit: 'worker-month', sizing: { product: ['ai.corpus_gb', 1e6 / 3], per: 1e6, billed: true, min: 1, note: '{demand} corpus pages parsed once by own workers, about 1 million pages per worker-month ({units} worker-months, no per-page fee).' }, sources: [S.generalOnprem] },
    ...offers('doc-ingestion-backfill', undefined, ['Amazon Textract (batch)', 'Azure AI Document Intelligence (batch)', 'Document AI (batch)', null]),
    ...offers('llm-gateway', undefined, ['LiteLLM proxy (Bedrock routing)', 'Azure API Management AI gateway', 'LiteLLM proxy (Vertex AI)', 'LiteLLM proxy']),
    ...offers('guardrails', undefined, ['Bedrock Guardrails', 'Azure AI Content Safety', 'Model Armor', 'Llama Guard on the GPU nodes'], { prices: [undefined, undefined, undefined, 0], unit: '1,000 calls' }),
    ...offers('agent-runtime', undefined, ['Bedrock Agents', 'Foundry Agent Service', 'Vertex AI Agent Engine', 'LangGraph']),
    ...offers('doc-ingestion', undefined, ['Amazon Textract', 'Azure AI Document Intelligence', 'Document AI', null]),
    // A self-hosted model embeds on its own GPUs, so prompts and documents stay inside.
    ...(['embeddings', 'embeddings-backfill'] as const).flatMap((component): ServiceOffer[] => [
      { component, provider: 'any', when: f.eq('ai.model_hosting', 'self_hosted_open'), name: 'Open embedding model on the GPU nodes (BGE, E5)', asOf: AS_OF, monthlyCostPerUnit: 0, sources: [S.g101OpenSourceAi] },
      ...offers(component, undefined, ['Titan Text Embeddings V2', 'Azure OpenAI text-embedding-3-small', 'Vertex AI text embeddings', null], { sources: [S.generalAi] }),
    ]),
    // Card networks are reached through a PSP whatever the cloud.
    { component: 'payment-psp', provider: 'any', name: 'Stripe / Adyen', asOf: AS_OF, sources: [S.g101Payments] },

    // Messaging
    ...offers('queue', f.eq('arch.broker', 'sqs'), ['Amazon SQS', 'Azure Service Bus', 'Cloud Tasks', null]),
    ...offers('queue', f.eq('arch.broker', 'rabbitmq'), ['Amazon MQ for RabbitMQ', 'RabbitMQ on AKS', 'RabbitMQ on GKE', 'RabbitMQ']),
    // Per 1,000 events/s at peak: a shard $10.95 + 7-day retention $14.60 + PUT units, a Standard TU $21.90 + ingress events, Pub/Sub $40/TiB in and out (mid-2025).
    // A unit also takes 1 MB/s (the floor in KB/s for sized events), and each data-platform source writes its own stream.
    // shortcut: message charges assume each unit runs half full (about 1.3 billion events a month); past 7 days of replay the component's broker sizing stands in for long-term retention.
    ...([
      [f.exists('events.payload_kb'), ['flow.streamQps', 'events.payload_kb']],
      [undefined, ['cap.sourceCount', 1_000]],
    ] as const).flatMap(([when, floor]) =>
      perCloud('stream', f.all(f.eq('arch.broker', 'kinesis'), f.not(f.gt('events.retention_days', 7)), ...(when ? [when] : [])), ['Kinesis Data Streams', 'Event Hubs', 'Pub/Sub', null], (i) => ({
        prices: only(i, [44, 59, 98][i]),
        unit: ['shard', 'throughput unit', '1,000 events/s'][i],
        sizing: { product: ['flow.streamQps'], floor: [...floor], per: 1_000, billed: true, min: 1, note: `{demand} events/s at peak, 1,000 per ${['shard', 'throughput unit', 'unit of publish and delivery'][i]}: {units} billed with ${['7-day retention and PUT units', 'ingress events', 'one subscription'][i]}.` },
        sources: [S.g101BigDataPipeline],
      })),
    ),
    ...offers('stream', f.eq('arch.broker', 'kinesis'), ['Kinesis Data Streams', 'Event Hubs', 'Pub/Sub', null], { sources: [S.g101BigDataPipeline] }),
    // Device gateways (mid-2025 list prices): AWS IoT Core Basic Ingest skips the $1.00-per-million messaging charge and bills the rule ($0.15 per million)
    // and its action ($0.15 per million) that forward each reading; Azure IoT Hub units S1 $25 (400,000 messages a day), S2 $250 (6 million) and S3 $2,500
    // (300 million); Google retired Cloud IoT Core in 2023, so Google Cloud runs a broker on GKE.
    // shortcut: IoT Core connection minutes ($0.08 per million) are left out, and messages count in 5 KB (IoT Core) or 4 KB (IoT Hub) blocks; price your device count and payloads.
    ...offers('device-gateway', undefined, ['AWS IoT Core (Basic Ingest)', null, null, null], { prices: [0.3], unit: 'million messages', sizing: { product: ['cap.peakEventQps', MILLIONS_PER_QPS_MONTH], per: 1, billed: true, note: '{demand} million device messages a month, each one rule and one action.' }, sources: [S.generalIot] }),
    // An IoT Hub unit covers its daily messages; S3 is the cheapest past 10 S2 units (60 million a day), S2 past 10 S1 units (4 million a day).
    ...([
      [f.gt('cap.peakEventQps', 60e6 / 86_400), 'S3', 2_500, 300e6],
      [f.gt('cap.peakEventQps', 4e6 / 86_400), 'S2', 250, 6e6],
      [undefined, 'S1', 25, 400_000],
    ] as const).flatMap(([when, tier, price, perDay]) =>
      offers('device-gateway', when, [null, `Azure IoT Hub ${tier}`, null, null], { prices: [undefined, price], unit: `${tier} unit`, sizing: { product: ['cap.peakEventQps', 86_400], per: perDay, billed: true, min: 1, note: `{demand} device messages a day, ${perDay.toLocaleString('en-US')} per ${tier} unit: {units} units.` }, sources: [S.generalIot] }),
    ),
    ...offers('device-gateway', undefined, [null, null, 'EMQX on GKE', 'EMQX or HiveMQ cluster'], { sources: [S.generalIot] }),
    // Any other broker leaves the stream on Kafka (the component's default).
    ...offers('stream', undefined, ['Amazon MSK', 'Event Hubs (Kafka endpoint)', 'Managed Service for Apache Kafka', 'Kafka on Strimzi']),
    // Batch and stream jobs run on the analytics platform when it has its own engines; otherwise on the provider's Spark and Flink.
    // Databricks jobs compute: $0.15/DBU plus about $0.30 of VMs per DBU on classic compute.
    ...databricksBilled({ component: 'ml-batch', provider: 'any', when: f.eq('data.platform', 'databricks'), name: 'Lakeflow Jobs (Spark on Databricks)', asOf: AS_OF, commitment: DATABRICKS_DBCU, regionPriced: true, monthlyCostPerUnit: 0.45, unit: 'DBU', sizing: { product: [30, 2, 8], per: 1, billed: true, note: 'One nightly 2-hour job on an 8-DBU classic cluster: {units} DBUs a month.' }, sources: [S.generalDatabricks] }),
    { component: 'ml-batch', provider: 'any', when: f.eq('data.platform', 'fabric'), name: 'Fabric Spark notebooks', asOf: AS_OF, monthlyCostPerUnit: 0, sizing: onCapacity, sources: [S.generalFabric] },
    ...offers('ml-batch', f.eq('data.platform', 'oss_lakehouse'), ['Spark operator on EKS', 'Spark operator on AKS', 'Spark operator on GKE', 'Spark operator on Kubernetes'], { sources: [S.generalLakehouse] }),
    ...databricksBilled({ component: 'stream-processor', provider: 'any', when: f.eq('data.platform', 'databricks'), name: 'Structured Streaming on Databricks (Lakeflow)', asOf: AS_OF, commitment: DATABRICKS_DBCU, regionPriced: true, monthlyCostPerUnit: 0.45, unit: 'DBU', sizing: { product: [730, 4], per: 1, billed: true, note: 'An always-on 4-DBU classic job cluster: {units} DBUs a month.' }, sources: [S.generalDatabricks] }),
    { component: 'stream-processor', provider: 'any', when: f.eq('data.platform', 'fabric'), name: 'Fabric Eventstream', asOf: AS_OF, monthlyCostPerUnit: 0, sizing: onCapacity, sources: [S.generalFabric] },
    ...offers('stream-processor', f.eq('data.platform', 'oss_lakehouse'), ['Flink operator on EKS', 'Flink operator on AKS', 'Flink operator on GKE', 'Flink operator on Kubernetes'], { sources: [S.generalLakehouse] }),
    ...offers('ml-batch', undefined, ['EMR Serverless', 'Azure Databricks', 'Dataproc Serverless', 'Spark on Kubernetes'], { sources: [S.g101BigDataPipeline] }),
    ...offers('stream-processor', undefined, ['Managed Service for Apache Flink', 'Azure Stream Analytics', 'Dataflow', 'Apache Flink (Kubernetes operator)'], { sources: [S.g101BigDataPipeline] }),
    ...offers('presence', undefined, suffixed(VALKEY, ' (pub/sub + presence keys)')),

    // Storage and data
    ...offers('cache', f.eq('perf.cache_tech', 'memcached'), ['ElastiCache for Memcached', 'Memcached on Azure VMs', 'Memorystore for Memcached', 'Memcached + mcrouter']),
    ...offers('cache', f.eq('perf.cache_tech', 'redis'), VALKEY),
    ...offers('geo-index', f.eq('data.geo_index', 'redis_geo'), suffixed(VALKEY, ' (GEO commands)')),
    // Priced on the component ($0.10 an hour each); the names say which control plane bills it.
    ...offers('k8s-control-plane', undefined, ['EKS control plane', 'AKS Standard tier control plane', 'GKE cluster management fee', null], { sources: [S.g101K8s] }),
    ...relational('db-primary', (names) => names),
    ...relational('db-replica', (names) => suffixed(names, ' replicas')),
    ...offers('db-primary', f.eq('data.primary_db', 'mongodb'), ['MongoDB Atlas on AWS', 'Azure Cosmos DB for MongoDB vCore', 'MongoDB Atlas on Google Cloud', 'Percona Server for MongoDB'], { sources: DB, vendors: ['mongodb', undefined, 'mongodb'] }),
    ...offers('db-primary', f.eq('data.primary_db', 'cassandra'), ['Amazon Keyspaces', 'Azure Managed Instance for Apache Cassandra', 'Cassandra on GKE', 'K8ssandra'], { sources: DB }),
    // Commercial engines a migration keeps: on VMs when rehosting, managed otherwise; prices are the license-included rules on the components.
    ...(['db-primary', 'db-replica'] as const).flatMap((component) => {
      const named = (names: Names) => (component === 'db-primary' ? names : suffixed(names, ' replicas'))
      const rehost = f.eq('migration.approach', 'rehost')
      const extra = { sources: [...DB, S.generalTargetEngine] }
      const license = (list: ServiceOffer[]) => list.map((o): ServiceOffer => ({ ...o, costKind: 'license' }))
      // Own licences (BYOL, Azure Hybrid Benefit) go on VMs or on the managed services that accept them; RDS for Oracle includes a licence only for Standard Edition 2,
      // and RDS for SQL Server and Cloud SQL for SQL Server only license-included, so their BYOL rows are RDS Custom and Compute Engine VMs.
      const ownLicenses = f.inc('org.existing_platforms', 'db_licenses')
      return license([
        ...offers(component, f.all(f.eq('data.primary_db', 'sqlserver'), ownLicenses, rehost), named(['SQL Server on EC2 (BYOL)', 'SQL Server on Azure VMs (Azure Hybrid Benefit)', 'SQL Server on Compute Engine (BYOL)', 'SQL Server on own servers']), extra),
        ...offers(component, f.all(f.eq('data.primary_db', 'sqlserver'), ownLicenses), named(['RDS Custom for SQL Server (BYOL)', 'Azure SQL Managed Instance (Azure Hybrid Benefit)', 'SQL Server on Compute Engine (BYOL)', 'SQL Server Always On']), extra),
        ...offers(component, f.all(f.eq('data.primary_db', 'oracle'), ownLicenses, rehost), named(['Oracle Database on EC2 (BYOL)', 'Oracle Database on Azure VMs (BYOL)', 'Oracle Database on Compute Engine (BYOL)', 'Oracle Database on own servers']), extra),
        ...offers(component, f.all(f.eq('data.primary_db', 'oracle'), ownLicenses), named(['RDS for Oracle (BYOL)', 'Oracle Database@Azure (BYOL)', 'Oracle Database@Google Cloud (BYOL)', 'Oracle Database with Data Guard']), extra),
        ...offers(component, f.all(f.eq('data.primary_db', 'sqlserver'), rehost), named(['SQL Server on EC2', 'SQL Server on Azure VMs', 'SQL Server on Compute Engine', 'SQL Server on own servers']), extra),
        ...offers(component, f.eq('data.primary_db', 'sqlserver'), named(['RDS for SQL Server', 'Azure SQL Managed Instance', 'Cloud SQL for SQL Server', 'SQL Server Always On']), extra),
        ...offers(component, f.all(f.eq('data.primary_db', 'oracle'), rehost), named(['Oracle Database on EC2', 'Oracle Database on Azure VMs', 'Oracle Database on Compute Engine', 'Oracle Database on own servers']), extra),
        ...offers(component, f.eq('data.primary_db', 'oracle'), named(['RDS for Oracle SE2 (license-included)', 'Oracle Database@Azure', 'Oracle Database@Google Cloud', 'Oracle Database with Data Guard']), extra),
      ])
    }),
    // DynamoDB exists only on AWS; the dynamodb-cloud rule flags it elsewhere.
    ...offers('db-primary', f.eq('data.primary_db', 'dynamodb'), ['Amazon DynamoDB', null, null, null], { sources: DB }),
    // Priced on the component (about $15 a month per tenant); the names say where the per-tenant databases live.
    ...offers('tenant-databases', undefined, ['RDS for PostgreSQL db.t4g.micro per tenant', 'Azure SQL Database elastic pool', 'Cloud SQL shared-core per tenant', 'Databases per tenant on shared PostgreSQL servers'], { sources: [S.generalTenancy] }),
    ...offers('ledger', undefined, suffixed(MANAGED_PG, ' (serializable, append-only)'), { sources: DB }),
    // Azure AI Search is another engine with its own API, so the Elasticsearch-compatible choice is Elastic's Azure Native ISV Service.
    // An Azure Native ISV service is billed on the Azure invoice (and counts toward a MACC); Elastic Cloud on Google Cloud bills through Elastic.
    ...offers('search', f.eq('data.search', 'elasticsearch'), ['Amazon OpenSearch Service', 'Elastic Cloud on Azure (Azure Native ISV Service)', 'Elastic Cloud on Google Cloud', 'OpenSearch'], { vendors: [undefined, undefined, 'elastic'] }),
    // Vector stores bill what holds the index, so the vector count sizes them (vectorIndex). General knowledge, mid-2025:
    // Qdrant on a 64 GB memory-optimized node about $370 a month in a cloud and $220 on own servers, about 45 GB of vectors with the HNSW graph.
    ...offers('vector-db', f.eq('ai.vector_store', 'self_hosted'), ['Qdrant on EKS', 'Qdrant on AKS', 'Qdrant on GKE', 'Qdrant / Milvus'], { prices: [370, 370, 370, 220], unit: 'node', sizing: vectorIndex(45, 'memory-optimized node(s)') }),
    // OpenSearch Serverless: $0.24 per OCU-hour (about $175 a month), about 5 GB of vectors per OCU counting indexing, at least 2 OCUs.
    ...offers('vector-db', f.eq('ai.vector_store', 'managed'), ['Amazon OpenSearch Serverless vectors', null, null, null], { prices: all4(175), unit: 'OCU', sizing: vectorIndex(5, 'OCU(s)', 2), sources: [S.generalAi] }),
    // Azure AI Search S1: about $245 per search unit, 35 GB of vector index per partition.
    ...offers('vector-db', f.eq('ai.vector_store', 'managed'), [null, 'Azure AI Search vectors', null, null], { prices: all4(245), unit: 'search unit', sizing: vectorIndex(35, 'S1 search unit(s)'), sources: [S.generalAi] }),
    // Vertex AI Vector Search: an e2-standard-16 serving node about $550 a month per 20 GB medium shard.
    ...offers('vector-db', f.eq('ai.vector_store', 'managed'), [null, null, 'Vertex AI Vector Search', null], { prices: all4(550), unit: 'node', sizing: vectorIndex(20, 'serving node(s)'), sources: [S.generalAi] }),
    // pgvector beside a non-PostgreSQL primary runs in a managed PostgreSQL of its own: a 32 GB memory-optimized instance about $350 a month holds about 20 GB of vectors.
    ...offers('vector-db', f.eq('ai.vector_store', 'pgvector'), suffixed(MANAGED_PG, ' with pgvector'), { prices: [350, 350, 350, 210], unit: 'instance', sizing: vectorIndex(20, 'memory-optimized instance(s)'), sources: [S.g101Postgres] }),
    ...offers('vector-db', undefined, ['Amazon OpenSearch Service (k-NN)', 'Azure AI Search (vector search)', 'Vertex AI Vector Search', 'Qdrant']),
    // Per TB-month: S3 Standard $23 for the first 50 TB, Azure Blob Hot LRS and Cloud Storage Standard about $20.
    ...offers('object-storage', undefined, ['Amazon S3', 'Azure Blob Storage', 'Cloud Storage', 'Ceph RGW'], { prices: [23, 20, 20, reference.onpremStoragePerTbMonth], unit: 'TB-month', sources: [S.g101BigDataPipeline] }),
    // Per TB-month after a lifecycle rule (mid-2025 list prices): S3 Glacier Instant Retrieval $4, Azure Blob Cold $3.6, Cloud Storage Coldline $4;
    // S3 Glacier Deep Archive $0.99, Azure Blob Archive about $1, Cloud Storage Archive $1.2. Retrieval fees and minimum storage durations are not priced.
    ...offers('cold-storage', f.eq('data.storage_class', 'archive'), ['Amazon S3 Glacier Deep Archive', 'Azure Blob Storage Archive tier', 'Cloud Storage Archive class', null], { prices: [0.99, 1, 1.2], unit: 'TB-month', sources: [S.g101CloudCostReduction] }),
    ...offers('cold-storage', undefined, ['Amazon S3 Glacier Instant Retrieval', 'Azure Blob Storage Cold tier', 'Cloud Storage Coldline', null], { prices: [4, 3.6, 4], unit: 'TB-month', sources: [S.g101CloudCostReduction] }),
    ...offers('landing-zone', undefined, ['S3 raw zone + Glue Data Catalog', 'ADLS Gen2 raw zone', 'Cloud Storage raw zone', 'Ceph raw zone'], { prices: [23, 20, 20, reference.onpremStoragePerTbMonth], unit: 'TB-month', sources: [S.g101BigDataPipeline] }),
    // Analytics platform (data.platform x provider). On premises the SaaS platforms appear only in a hybrid design, in a cloud region over a private link.
    // Billing models differ: Redshift Serverless bills RPU-hours, BigQuery on-demand the TiB scanned, Fabric a capacity SKU, Databricks and Snowflake compute-hours.
    ...hourly(platform('native'), ['Amazon Redshift Serverless + Athena', null, null, null], 8, 0.375, 'RPU-hour', '8-RPU base capacity', [S.g101BigDataPipeline], REDSHIFT_RESERVED),
    ...offers('warehouse', platform('native'), [null, null, 'BigQuery + BigLake', null], { prices: all4(6.25), unit: 'TiB scanned', regionPriced: true, sizing: { product: ['cap.scannedTbMonth'], per: 1, billed: true, note: 'On-demand queries scan {demand} TB a month (10% of the lake per 8 query hours a day), billed per TiB.' }, sources: [S.g101BigDataPipeline] }),
    ...fabricCapacity(f.all(platform('fabric'), fabricJobs), ['cap.lakeStorageTb', FABRIC_JOBS_FACTOR], '{tier}: {demand} TB-equivalents, the lake doubled for the Spark or streaming jobs on the capacity'),
    ...fabricCapacity(platform('fabric'), ['cap.lakeStorageTb'], '{tier}: {demand} TB to query'),
    ...HYBRID_CLOUDS.flatMap(([cloud, label]) => hourly(f.all(platform('databricks'), analyticsIn(cloud)), [null, null, null, `Databricks SQL on ${label} over a private link`], 12, 0.7, 'DBU', 'serverless SQL warehouse Small (Premium)', [S.generalDatabricks], DATABRICKS_DBCU)),
    ...HYBRID_CLOUDS.flatMap(([cloud, label]) => hourly(f.all(platform('snowflake'), analyticsIn(cloud)), [null, null, null, `Snowflake on ${label} over a private link`], 2, 3, 'credit', 'Small warehouse (Enterprise)', [S.generalSnowflake], SNOWFLAKE_CAPACITY)),
    ...hourly(platform('databricks'), ['Databricks SQL on AWS', 'Azure Databricks SQL', 'Databricks SQL on Google Cloud', 'Databricks SQL in a cloud workspace over a private link'], 12, 0.7, 'DBU', 'serverless SQL warehouse Small (Premium)', [S.generalDatabricks], DATABRICKS_DBCU, ['databricks', undefined, 'databricks']),
    ...hourly(platform('snowflake'), ['Snowflake on AWS, same region as the app', 'Snowflake on Azure, same region as the app', 'Snowflake on Google Cloud, same region as the app', 'Snowflake in a cloud region over a private link'], 2, 3, 'credit', 'Small warehouse (Enterprise)', [S.generalSnowflake], SNOWFLAKE_CAPACITY, ['snowflake', 'snowflake', 'snowflake']),
    // Self-run engines are instances: priced per node with the instance class and the provider's price level.
    ...offers('warehouse', platform('oss_lakehouse'), ['Trino + Spark on EKS', 'Trino + Spark on AKS', 'Trino + Spark on GKE', 'Trino + Spark on Kubernetes'], { prices: all4(400), unit: 'node', sizing: { product: ['cap.lakeStorageTb'], per: 20, spare: true, note: '{units} Trino worker(s) for {demand} TB at about 20 TB a worker, with a spare when availability matters.' }, sources: [S.generalLakehouse] }),
    // ClickHouse Cloud separates compute from object storage: compute units (8 GiB, 2 vCPU) billed per hour while queries run, compressed data per TB-month (lake-storage).
    ...CLICKHOUSE_CLOUD.flatMap(([when, product, note]) =>
      offers('warehouse', f.all(platform('olap_db'), when), ['ClickHouse Cloud on AWS', 'ClickHouse Cloud on Azure', 'ClickHouse Cloud on Google Cloud', null], { prices: all4(0.3), unit: 'compute unit-hour', regionPriced: true, vendors: ['clickhouse', 'clickhouse', 'clickhouse'], sizing: { product, per: 1, billed: true, note }, sources: [S.g101UberStack] }),
    ),
    // A self-run cluster keeps the compressed columns on its nodes, in two replicas.
    ...offers('warehouse', platform('olap_db'), [null, null, null, 'ClickHouse cluster'], { prices: all4(600), unit: 'node', sizing: { product: ['cap.lakeStorageTb', 2 / CLICKHOUSE_COMPRESSION], per: CLICKHOUSE_NODE_TB, min: 2, note: `{units} ClickHouse nodes for {demand} TB of compressed columns in two replicas (about ${CLICKHOUSE_COMPRESSION}x compression), about ${CLICKHOUSE_NODE_TB} TB a node.` }, sources: [S.g101UberStack] }),
    // At the database node price (db-primary).
    ...offers('warehouse', platform('small_sql'), suffixed(MANAGED_PG, ' + DuckDB'), { prices: all4(500), unit: 'node', sizing: { product: ['cap.lakeStorageTb'], per: 4, note: '{units} SQL node(s) for {demand} TB of history, about 4 TB a node.' }, sources: DB }),
    // Placeholder while the platform is still pending.
    ...offers('warehouse', f.not(f.exists('data.platform')), ['Amazon Redshift', 'Fabric Warehouse', 'BigQuery', 'ClickHouse'], { sources: [S.g101BigDataPipeline] }),
    // Lake storage per TB-month, as object storage. ClickHouse Cloud bills the compressed data.
    ...offers('lake-storage', platform('olap_db'), ['ClickHouse Cloud storage', 'ClickHouse Cloud storage', 'ClickHouse Cloud storage', null], { prices: all4(25.3), unit: 'TB-month', regionPriced: true, vendors: ['clickhouse', 'clickhouse', 'clickhouse'], sizing: { product: ['cap.lakeStorageTb', 1 / CLICKHOUSE_COMPRESSION], per: 1, billed: true, min: 1, note: `{demand} TB of compressed columns (about ${CLICKHOUSE_COMPRESSION}x), billed per TB-month ({units} TB).` }, sources: [S.g101UberStack] }),
    { component: 'lake-storage', provider: 'any', when: platform('fabric'), name: 'OneLake', vendor: 'azure', asOf: AS_OF, regionPriced: true, monthlyCostPerUnit: 23, unit: 'TB-month', sources: [S.generalFabric] },
    // Snowflake and BigLake Iceberg (or BigLake Delta) tables live in the customer's own bucket, which the cloud bills.
    ...offers('lake-storage', f.all(platform('snowflake'), f.eq('data.table_format', 'iceberg')), ['Amazon S3 external volume for Snowflake', 'ADLS Gen2 external volume for Snowflake', 'Cloud Storage external volume for Snowflake', null], { prices: [23, 20, 20], unit: 'TB-month', regionPriced: true, sources: [S.generalSnowflake, S.g101ObjectStoreUses] }),
    ...hybridRows('lake-storage', f.all(platform('snowflake'), f.eq('data.table_format', 'iceberg')), (_, i) => `${['Amazon S3', 'ADLS Gen2', 'Cloud Storage'][i]} external volume for Snowflake`, { prices: [23, 20, 20], unit: 'TB-month', regionPriced: true, sources: [S.generalSnowflake, S.g101ObjectStoreUses] }),
    ...offers('lake-storage', f.all(platform('native'), f.in('data.table_format', ['iceberg', 'delta'])), [null, null, 'Cloud Storage for BigLake', null], { prices: all4(20), unit: 'TB-month', regionPriced: true, sources: [S.g101ObjectStoreUses] }),
    { component: 'lake-storage', provider: 'any', when: platform('snowflake'), name: 'Snowflake storage', asOf: AS_OF, regionPriced: true, monthlyCostPerUnit: 23, unit: 'TB-month', sources: [S.generalSnowflake] },
    ...offers('lake-storage', platform('native'), [null, null, 'BigQuery storage (active logical)', null], { prices: all4(20), unit: 'TB-month', regionPriced: true, sources: [S.g101BigDataPipeline] }),
    ...offers('lake-storage', platform('oss_lakehouse'), ['Amazon S3', 'ADLS Gen2', 'Cloud Storage', 'MinIO or Ceph RGW'], { prices: [23, 20, 20, reference.onpremStoragePerTbMonth], unit: 'TB-month', regionPriced: true, sources: [S.g101ObjectStoreUses] }),
    ...hybridRows('lake-storage', platform('databricks'), (_, i) => `${['Amazon S3', 'ADLS Gen2', 'Cloud Storage'][i]} of the Databricks workspace`, { prices: [23, 20, 20], unit: 'TB-month', regionPriced: true, sources: [S.g101ObjectStoreUses] }),
    ...offers('lake-storage', hybridAnalytics, [null, null, null, 'Object storage of the cloud workspace'], { prices: [undefined, undefined, undefined, 23], unit: 'TB-month', regionPriced: true, sources: [S.g101ObjectStoreUses] }),
    ...offers('lake-storage', undefined, ['Amazon S3', 'ADLS Gen2', 'Cloud Storage', 'MinIO or Ceph RGW'], { prices: [23, 20, 20, reference.onpremStoragePerTbMonth], unit: 'TB-month', regionPriced: true, sources: [S.g101ObjectStoreUses] }),
    // Ingestion: hybrid designs leave the data center through a self-hosted gateway; platforms with their own connectors come next.
    ...offers('ingestion', f.all(hybridAnalytics, platform('fabric')), [null, null, null, 'On-premises data gateway + Fabric Mirroring and Data Factory'], { sources: [S.generalFabric] }),
    ...offers('ingestion', f.all(hybridAnalytics, platform('databricks')), [null, null, null, 'Lakeflow Connect through a self-hosted gateway'], { sources: [S.generalDatabricks] }),
    ...offers('ingestion', f.all(hybridAnalytics, platform('snowflake')), [null, null, null, 'Self-hosted connector gateway (Snowflake Openflow or Airbyte)'], { sources: [S.generalSnowflake] }),
    { component: 'ingestion', provider: 'any', when: f.all(platform('fabric'), f.in('data.ingestion', ['cdc', 'zero_etl'])), name: 'Fabric Mirroring', asOf: AS_OF, monthlyCostPerUnit: 0, sizing: onCapacity, sources: [S.generalFabric] },
    { component: 'ingestion', provider: 'any', when: f.all(platform('fabric'), f.eq('data.ingestion', 'saas_connectors')), name: 'Fabric Dataflow Gen2 connectors', asOf: AS_OF, monthlyCostPerUnit: 0, sizing: onCapacity, sources: [S.generalFabric] },
    { component: 'ingestion', provider: 'any', when: f.all(platform('fabric'), f.eq('data.ingestion', 'streaming')), name: 'Fabric Eventstream', asOf: AS_OF, monthlyCostPerUnit: 0, sizing: onCapacity, sources: [S.generalFabric] },
    { component: 'ingestion', provider: 'any', when: platform('fabric'), name: 'Fabric Data Factory', asOf: AS_OF, monthlyCostPerUnit: 0, sizing: onCapacity, sources: [S.generalFabric] },
    // Lakeflow Connect bills DBUs at the jobs rate ($0.15/DBU plus about $0.30 of VMs): a database source runs an ingestion gateway all month (about 0.5 DBU an hour,
    // close to a DMS instance per source); other sources run a pipeline per source, about 1 DBU-hour a day, or 2 DBU-hours per TB of lake when the volume is larger.
    ...databricksBilled({ component: 'ingestion', provider: 'any', when: f.all(platform('databricks'), f.eq('data.ingestion', 'cdc')), name: 'Lakeflow Connect (ingestion gateway per database)', asOf: AS_OF, commitment: DATABRICKS_DBCU, regionPriced: true, monthlyCostPerUnit: 0.45, unit: 'DBU', sizing: { product: [730, 0.5, 'cap.sourceCount'], per: 1, billed: true, note: 'An ingestion gateway per source database running all month at about 0.5 DBU an hour: {units} DBUs.' }, sources: [S.generalDatabricks, S.g101Cdc] }),
    // Only batch loads run as Lakeflow pipelines here; SaaS connectors and streams go through the same rows as every other platform below.
    ...databricksBilled({ component: 'ingestion', provider: 'any', when: f.all(platform('databricks'), f.eq('data.ingestion', 'batch')), name: 'Lakeflow Connect', asOf: AS_OF, commitment: DATABRICKS_DBCU, regionPriced: true, monthlyCostPerUnit: 0.45, unit: 'DBU', sizing: { product: ['cap.lakeStorageTb', 2], floor: ['cap.sourceCount', BATCH_LOAD_HOURS_PER_SOURCE], per: 1, billed: true, min: 1, note: '{units} DBUs a month: a pipeline per source, about 1 DBU-hour a day each, or 2 per TB of lake when the volume needs more.' }, sources: [S.generalDatabricks] }),
    ...offers('ingestion', f.eq('data.ingestion', 'cdc'), ['AWS DMS', 'Azure Data Factory change data capture', 'Datastream', 'Debezium + Kafka Connect'], { prices: all4(0.25), unit: 'instance-hour', sizing: { product: [730, 'cap.sourceCount'], per: 1, billed: true, note: 'A replication instance per source running all month: {units} hours.' }, sources: [S.g101Cdc] }),
    // AWS lists no separate charge for zero-ETL: the source database and Redshift bill the replication they do.
    ...offers('ingestion', f.eq('data.ingestion', 'zero_etl'), ['Zero-ETL integration into Redshift (Aurora, RDS or DynamoDB)', null, null, null], { prices: all4(0), sizing: flatLine('No separate charge; the source database and Redshift bill the replication.'), sources: [S.generalAws] }),
    // Each provider bills batch loads its own way: Glue $0.44/DPU-hour, ADF copy activity $0.25/DIU-hour, Data Transfer Service nothing for Google, Cloud Storage and S3 sources, self-hosted Airbyte only its nodes.
    // Each source runs its own scheduled job, about one compute-unit-hour a day, so the source count sets a floor under the volume-based hours.
    ...offers('ingestion', f.eq('data.ingestion', 'batch'), ['AWS Glue', null, null, null], { prices: all4(0.44), unit: 'DPU-hour', sizing: { product: ['cap.lakeStorageTb', 2], floor: ['cap.sourceCount', BATCH_LOAD_HOURS_PER_SOURCE], per: 1, billed: true, min: 1, note: '{units} DPU-hours a month: a job per source, about 1 DPU-hour a day each, or 2 per TB of lake when the volume needs more.' }, sources: [S.g101BigDataPipeline] }),
    ...offers('ingestion', f.eq('data.ingestion', 'batch'), [null, 'Azure Data Factory', null, null], { prices: all4(0.25), unit: 'DIU-hour', sizing: { product: ['cap.lakeStorageTb', 2], floor: ['cap.sourceCount', BATCH_LOAD_HOURS_PER_SOURCE], per: 1, billed: true, min: 1, note: '{units} DIU-hours of copy activity a month: a copy per source, about 1 DIU-hour a day each, or 2 per TB of lake when the volume needs more.' }, sources: [S.g101BigDataPipeline] }),
    // BigQuery's loaders write only into BigQuery; other platforms on Google Cloud load with their own tools or Dataflow (rows below).
    // Data Transfer Service reads Google sources, Cloud Storage, S3 and SaaS apps for free; database sources fall through to the provider's paid loaders below.
    ...offers('ingestion', f.all(f.eq('data.ingestion', 'batch'), platform('native'), f.ne('source.database', true)), [null, null, 'BigQuery Data Transfer Service', null], { prices: all4(0), sizing: flatLine('No charge for Google, Cloud Storage and Amazon S3 sources; BigQuery bills the storage and queries.'), sources: [S.g101BigDataPipeline] }),
    ...offers('ingestion', f.eq('data.ingestion', 'batch'), [null, null, null, 'Airbyte on Kubernetes'], { prices: all4(70), unit: 'node', sizing: { product: ['cap.sourceCount'], per: 10, billed: true, min: 2, note: '{units} small nodes for the Airbyte workers, about 10 source connectors a node and at least two; self-hosted, no per-row billing.' }, sources: [S.g101BigDataPipeline] }),
    ...offers('ingestion', f.all(f.eq('data.ingestion', 'saas_connectors'), platform('native')), [null, null, 'BigQuery Data Transfer Service connectors', null]),
    ...offers('ingestion', f.all(f.eq('data.ingestion', 'streaming'), platform('native')), [null, null, 'Pub/Sub subscriptions to BigQuery', null], { sources: [S.g101BigDataPipeline] }),
    ...offers('ingestion', f.all(f.eq('data.ingestion', 'batch'), platform('snowflake')), [null, null, 'Snowpipe (auto-ingest from Cloud Storage)', null], { ...batchJob(0.25, 'compute-hour'), sources: [S.generalSnowflake], vendors: [undefined, undefined, 'snowflake'] }),
    ...offers('ingestion', f.all(f.eq('data.ingestion', 'streaming'), platform('snowflake')), [null, null, 'Snowpipe Streaming', null], { sources: [S.generalSnowflake], vendors: [undefined, undefined, 'snowflake'] }),
    ...offers('ingestion', f.all(f.eq('data.ingestion', 'batch'), platform('oss_lakehouse')), [null, null, 'Dataproc Serverless (Spark) into Iceberg on Cloud Storage', null], { ...batchJob(0.24, '4-DCU-hour'), sources: [S.generalLakehouse] }),
    ...offers('ingestion', f.all(f.eq('data.ingestion', 'batch'), platform('olap_db')), [null, null, 'ClickPipes from Cloud Storage', null], { ...batchJob(0.2, 'replica-hour'), sources: [S.g101UberStack], vendors: [undefined, undefined, 'clickhouse'] }),
    ...offers('ingestion', f.eq('data.ingestion', 'batch'), [null, null, 'Dataflow batch pipelines', null], { ...batchJob(0.28, 'worker-hour'), sources: [S.g101BigDataPipeline] }),
    ...offers('ingestion', f.eq('data.ingestion', 'saas_connectors'), ['Amazon AppFlow', 'Azure Data Factory connectors', 'Fivetran or Airbyte connectors', 'Airbyte connectors'], { vendors: [undefined, undefined, 'fivetran'] }),
    ...offers('ingestion', f.eq('data.ingestion', 'streaming'), ['Amazon Data Firehose', 'Event Hubs Capture', 'Dataflow streaming from Pub/Sub', 'Kafka Connect sinks'], { sources: [S.g101BigDataPipeline] }),
    // Paths beside the main ingestion for the inventory's other kinds (components.ts ingestion-*): Fabric runs them on its capacity, the clouds on their own services.
    ...([['ingestion-db', 'Fabric Mirroring'], ['ingestion-saas', 'Fabric Dataflow Gen2 connectors'], ['ingestion-files', 'Fabric Data Factory'], ['ingestion-events', 'Fabric Eventstream']] as const).map(
      ([component, name]): ServiceOffer => ({ component, provider: 'any', when: platform('fabric'), name, asOf: AS_OF, monthlyCostPerUnit: 0, sizing: onCapacity, sources: [S.generalFabric] }),
    ),
    ...offers('ingestion-db', undefined, ['AWS DMS', 'Azure Data Factory change data capture', 'Datastream', 'Debezium + Kafka Connect'], { prices: all4(0.25), unit: 'instance-hour', sizing: { product: [730], per: 1, billed: true, note: 'A replication instance running all month: {units} hours.' }, sources: [S.g101Cdc] }),
    ...offers('ingestion-saas', undefined, ['Amazon AppFlow', 'Azure Data Factory connectors', 'Fivetran or Airbyte connectors', 'Airbyte connectors'], { vendors: [undefined, undefined, 'fivetran'] }),
    ...offers('ingestion-files', undefined, ['AWS Glue', 'Azure Data Factory', 'Dataflow batch pipelines', 'Airbyte on Kubernetes'], { prices: [0.44, 0.25, 0.28], unit: 'job-hour', sizing: { product: [BATCH_LOAD_HOURS_PER_SOURCE], per: 1, billed: true, note: 'About one job-hour a day for the file drops: {units} hours a month.' }, sources: [S.g101BigDataPipeline] }),
    ...offers('ingestion-events', undefined, ['Amazon Data Firehose', 'Event Hubs Capture', 'Dataflow streaming from Pub/Sub', 'Kafka Connect sinks'], { sources: [S.g101BigDataPipeline] }),
    // Orchestration: the platform's own scheduler first, then managed or self-hosted Airflow.
    // The ETL jobs Lakeflow schedules run on jobs compute: $0.15/DBU plus about $0.30 of VMs per DBU on classic compute.
    ...databricksBilled({ component: 'orchestrator', provider: 'any', when: platform('databricks'), name: 'Lakeflow Jobs', asOf: AS_OF, commitment: DATABRICKS_DBCU, regionPriced: true, monthlyCostPerUnit: 0.45, unit: 'DBU', sizing: { product: ['cap.lakeStorageTb', 2, 4], per: 1, billed: true, min: 120, note: 'ETL jobs on a 4-DBU classic cluster, 2 job-hours per TB of lake and at least an hour a day: {units} DBUs a month.' }, sources: [S.generalDatabricks] }),
    { component: 'orchestrator', provider: 'any', when: platform('fabric'), name: 'Fabric Data Factory pipelines', asOf: AS_OF, monthlyCostPerUnit: 0, sizing: onCapacity, sources: [S.generalFabric] },
    // A single SQL node or OLAP store runs a few scheduled loads, which the provider's cron covers without an Airflow environment.
    // EventBridge Scheduler $1 per million invocations after 14 million free, Cloud Scheduler $0.10 a job, Logic Apps Consumption about $0.000125 an action (general knowledge, mid-2025).
    ...offers('orchestrator', f.in('data.platform', ['small_sql', 'olap_db']), ['EventBridge Scheduler', 'Logic Apps recurrence', 'Cloud Scheduler', 'cron jobs on own servers'], { prices: [1, 1, 1, 0], sizing: flatLine('A few dozen scheduled loads a day: about a dollar a month at most; retries and dependencies live in the job scripts.') }),
    ...offers('orchestrator', undefined, ['Amazon MWAA', null, 'Cloud Composer', null], { prices: [360, undefined, 400], sizing: flatLine('The smallest managed Airflow environment.') }),
    // ADF orchestration bills $1 per 1,000 activity runs; data movement is the ingestion line's DIU-hours.
    ...offers('orchestrator', undefined, [null, 'Azure Data Factory pipelines', null, null], { prices: all4(1), unit: '1,000 activity runs', sizing: { product: ['cap.sourceCount', 2.16], per: 1, billed: true, min: 1, note: '{units} thousand activity runs a month: about 3 activities per source run hourly.' } }),
    ...offers('orchestrator', undefined, [null, null, null, 'Airflow on Kubernetes'], { prices: [undefined, undefined, undefined, 70], unit: 'node', sizing: { product: [1], per: 1, billed: true, min: 2, note: 'Two small nodes for the scheduler, web server and workers.' } }),
    // Catalogs: platform catalogs first, then table format x provider. Polaris and Nessie are Iceberg REST catalogs; Delta and Hudi use their own.
    { component: 'catalog', provider: 'any', when: platform('databricks'), name: 'Unity Catalog', asOf: AS_OF, sources: [S.generalDatabricks] },
    { component: 'catalog', provider: 'any', when: platform('fabric'), name: 'OneLake catalog + Purview', asOf: AS_OF, sources: [S.generalFabric] },
    { component: 'catalog', provider: 'any', when: platform('snowflake'), name: 'Snowflake Open Catalog (Apache Polaris)', asOf: AS_OF, sources: [S.generalSnowflake] },
    ...offers('catalog', platform('native'), ['Glue Data Catalog + Lake Formation', null, 'BigLake metastore + Dataplex', null], { sources: [S.generalLakehouse] }),
    ...offers('catalog', f.eq('data.table_format', 'iceberg'), ['Glue Data Catalog (Iceberg REST endpoint)', 'Apache Polaris on AKS', 'BigLake metastore (Iceberg REST)', null], { sources: [S.generalLakehouse] }),
    ...offers('catalog', f.eq('data.table_format', 'delta'), ['Unity Catalog OSS on EKS', 'Unity Catalog OSS on AKS', 'Unity Catalog OSS on GKE', null], { sources: [S.generalLakehouse] }),
    ...offers('catalog', f.eq('data.table_format', 'hudi'), ['Glue Data Catalog (Hive-compatible)', 'Hive Metastore on AKS', 'Dataproc Metastore (Hive)', null], { sources: [S.generalLakehouse] }),
    // On premises the catalog runs as two small nodes (active and standby).
    ...(
      [
        ['iceberg', 'Apache Polaris or Project Nessie (Iceberg REST catalog)'],
        ['delta', 'Unity Catalog OSS or Hive Metastore'],
        ['hudi', 'Hive Metastore'],
      ] as const
    ).map(([format, name]): ServiceOffer => ({
      component: 'catalog',
      provider: 'onprem',
      when: f.eq('data.table_format', format),
      name,
      asOf: AS_OF,
      monthlyCostPerUnit: 25,
      unit: 'node',
      sizing: { product: [1], per: 1, billed: true, min: 2, note: 'Two small catalog nodes, active and standby.' },
      sources: [S.generalLakehouse, S.generalOnprem],
    })),
    // BI: SaaS tools are the same everywhere; QuickSight exists only on AWS.
    // Data that must stay on own hardware gets the self-hosted editions; Looker and Looker Studio have none (bi.tool feasibility).
    // Power BI Report Server comes with SQL Server Enterprise + Software Assurance: a 4-core minimum, about $30,000 list amortized over 3 years plus SA.
    { component: 'bi', provider: 'any', when: f.all(f.eq('bi.tool', 'power_bi'), ownHardwareOnly), name: 'Power BI Report Server', asOf: AS_OF, monthlyCostPerUnit: 1_470, costKind: 'license', sizing: flatLine('SQL Server Enterprise 4-core licence with Software Assurance, about $1,470 a month over 3 years; authors use the free Power BI Desktop for Report Server.'), sources: [S.generalBi, S.generalOnprem] },
    { component: 'bi', provider: 'any', when: f.all(f.eq('bi.tool', 'tableau'), ownHardwareOnly), name: 'Tableau Server (self-hosted)', asOf: AS_OF, monthlyCostPerUnit: 15, unit: 'viewer', sizing: seats('{demand} Tableau Server viewers at $15 a month, on your own servers.'), sources: [S.generalBi, S.generalOnprem] },
    // shortcut: Microsoft 365 E5 covers every viewer, not a counted licence pool; add licensed seats as an input when tenants mix E3 and E5.
    { component: 'bi', provider: 'any', when: f.all(f.eq('bi.tool', 'power_bi'), f.inc('org.existing_platforms', 'm365_e5')), name: 'Power BI', asOf: AS_OF, monthlyCostPerUnit: 0, unit: 'viewer', sizing: seats('{demand} viewers already hold Power BI Pro through Microsoft 365 E5: no new seats.'), sources: [S.generalBi] },
    { component: 'bi', provider: 'any', when: f.all(f.eq('bi.tool', 'power_bi'), fabricF64), name: 'Power BI', asOf: AS_OF, monthlyCostPerUnit: 0, unit: 'viewer', sizing: seats('{demand} viewers read free under the F64 capacity; report authors still need Pro.'), sources: [S.generalBi, S.generalFabric] },
    // Off Fabric, past F64 / $14 viewers an F64 bought for Power BI alone costs less than the Pro seats; on Fabric the fabric-viewer-licenses hint sizes the platform capacity up instead.
    { component: 'bi', provider: 'any', when: f.all(f.eq('bi.tool', 'power_bi'), f.ne('data.platform', 'fabric'), f.gt('cap.analyticsUsers', F64_MONTHLY / POWER_BI_PRO)), name: 'Power BI on an F64 capacity', vendor: 'azure', asOf: AS_OF, monthlyCostPerUnit: F64_MONTHLY, costKind: 'license', commitment: FABRIC_RESERVED, regionPriced: true, sizing: flatLine(`One F64 capacity for Power BI only: every viewer reads free, which costs less than a $${POWER_BI_PRO} Pro seat each past about ${Math.round(F64_MONTHLY / POWER_BI_PRO)} viewers; report authors still need Pro.`), sources: [S.generalBi, S.generalFabric] },
    { component: 'bi', provider: 'any', when: f.eq('bi.tool', 'power_bi'), name: 'Power BI', asOf: AS_OF, monthlyCostPerUnit: POWER_BI_PRO, unit: 'seat', sizing: seats('Power BI Pro for {demand} viewers at $14 a seat.'), sources: [S.generalBi] },
    { component: 'bi', provider: 'any', when: f.eq('bi.tool', 'looker_studio'), name: 'Looker Studio Pro', asOf: AS_OF, monthlyCostPerUnit: 9, unit: 'user', sizing: seats('Looker Studio Pro for {demand} viewers at $9 a user.'), sources: [S.generalBi] },
    { component: 'bi', provider: 'any', when: f.eq('bi.tool', 'looker'), name: 'Looker', asOf: AS_OF, monthlyCostPerUnit: 3_000, sizing: flatLine('Looker is quote-based; about $3,000 a month for a platform edition and a few seats (heuristic).'), sources: [S.generalBi] },
    ...offers('bi', f.eq('bi.tool', 'quicksight'), ['Amazon QuickSight', null, null, null], { prices: [3], unit: 'reader', sizing: seats('{demand} QuickSight readers at $3 a month.'), sources: [S.g101BigDataPipeline] }),
    { component: 'bi', provider: 'any', when: f.eq('bi.tool', 'tableau'), name: 'Tableau Cloud', asOf: AS_OF, monthlyCostPerUnit: 15, unit: 'viewer', sizing: seats('{demand} Tableau viewers at $15 a month.'), sources: [S.generalBi] },
    // Built-in dashboards have no viewer licence; their queries run on the SQL warehouse, which the warehouse line already bills by the query hours.
    { component: 'bi', provider: 'any', when: f.all(f.eq('bi.tool', 'platform_dashboards'), platform('databricks')), name: 'Databricks AI/BI dashboards', asOf: AS_OF, monthlyCostPerUnit: 0, unit: 'viewer', sizing: seats('{demand} viewers read AI/BI dashboards with no licence; their queries bill on the SQL warehouse.'), sources: [S.generalBi, S.generalLakehouse] },
    { component: 'bi', provider: 'any', when: f.all(f.eq('bi.tool', 'platform_dashboards'), platform('snowflake')), name: 'Snowsight dashboards', asOf: AS_OF, monthlyCostPerUnit: 0, unit: 'viewer', sizing: seats('{demand} viewers read Snowsight dashboards with no licence; their queries bill on the virtual warehouse.'), sources: [S.generalBi, S.generalLakehouse] },
    { component: 'bi', provider: 'any', when: f.eq('bi.tool', 'superset_metabase'), name: 'Apache Superset / Metabase (self-hosted)', asOf: AS_OF, monthlyCostPerUnit: 60, sizing: flatLine('One small node; no seat licences.'), sources: [S.generalBi] },
    ...offers('secrets', undefined, ['AWS Secrets Manager + KMS', 'Azure Key Vault', 'Secret Manager + Cloud KMS', 'HashiCorp Vault']),

    // Operations
    ...logs('full', 2, 100, ['Amazon CloudWatch + X-Ray', 'Azure Monitor + Application Insights', 'Cloud Logging + Cloud Monitoring + Cloud Trace', 'Prometheus + Grafana + Loki + Tempo']),
    ...logs('basic', 1, 50, ['Amazon CloudWatch', 'Azure Monitor + Log Analytics', 'Cloud Logging + Cloud Monitoring', 'Prometheus + Grafana + Loki']),
    // Transfer: first-tier internet egress per GB; own hardware pays for transit by the peak Mbps (general knowledge, mid-2025).
    ...offers('internet-egress', undefined, ['AWS data transfer out', 'Azure bandwidth (internet egress)', 'Google Cloud internet egress', null], { prices: [0.09, 0.087, 0.085], unit: 'GB', sources: [S.generalEgress] }),
    // shortcut: committed IP transit at about $1 per Mbps a month at the 95th percentile (general knowledge, mid-2025); quote with your carriers.
    { component: 'internet-egress', provider: 'onprem', name: 'IP transit', asOf: AS_OF, monthlyCostPerUnit: 1, unit: 'Mbps', sources: [S.generalEgress, S.generalOnprem], sizing: { product: ['cap.originEgressPeakMbps'], per: 1, billed: true, min: 1, note: '{demand} Mbps from the origin at peak, billed per Mbps of committed transit.' } },
    ...offers('nat-gateway', undefined, ['NAT Gateway', 'Azure NAT Gateway', 'Cloud NAT', null], { prices: [0.045, 0.045, 0.045], unit: 'GB', sources: [S.generalEgress] }),
    ...offers('cicd', undefined, ['AWS CodePipeline', 'Azure DevOps Pipelines', 'Cloud Build + Cloud Deploy', 'GitLab CI + Argo CD']),
    ...offers('notify-provider', undefined, ['Amazon SNS + SES', 'Notification Hubs + Azure Communication Services', 'Firebase Cloud Messaging + SendGrid', 'APNs/FCM direct + Postal']),
    ...offers('mesh', undefined, ['Istio on EKS', 'Istio add-on for AKS', 'Cloud Service Mesh', 'Istio']),
    ...offers('standby-region', f.eq('reliability.multi_region', 'active_passive'), ['Warm standby in a second AWS Region', 'Warm standby in a second Azure region', 'Warm standby in a second Google Cloud region', 'Warm standby in a second data center']),
    ...offers('standby-region', undefined, ['Pilot light in a second AWS Region', 'Pilot light in a second Azure region', 'Pilot light in a second Google Cloud region', 'Pilot light in a second data center']),
    ...offers('peer-region', undefined, ['Full stack in a second AWS Region', 'Full stack in a second Azure region', 'Full stack in a second Google Cloud region', 'Full stack in a second data center']),
  ]
}

export const services = buildServices(baseReference)
