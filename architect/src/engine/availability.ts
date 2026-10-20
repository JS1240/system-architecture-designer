import type { Architecture, ComponentInstance, Facts } from '../domain/types'

// Single cloud VM with auto-recovery is about 99.9%; managed edge services publish 99.99% SLAs.
const SELF_HOSTED_INSTANCE = 0.999
const MANAGED_SERVICE = 0.9999
const MANAGED_IDS = new Set(['waf', 'lb', 'api-gateway', 'functions', 'realtime-service'])
const REQUEST_PATH_TIERS = new Set(['edge', 'ingress', 'compute', 'data'])
// Route 53, Cloud DNS and Azure DNS publish a 100% SLA, so DNS adds no downtime. The CDN is counted below where it carries the product.
// The analytics platform (lake, catalog, the private link to it) serves reports, not user requests.
// Model calls, like the hosted model API, degrade the AI answers, not the rest of the request path.
// The existing systems, the raw landing zone and a SaaS CRM bought to replace one serve no request of the new design.
// shortcut: a per-tenant database outage takes down one tenant, not the product, so it is left off the path; model per-tenant availability when tenants buy an SLA.
// Internet transfer is a billing meter, and the NAT gateway carries only the calls to third-party APIs, which sit off the path too.
// A parallel run's request mirror tees copies to the old system without delaying the users' responses.
const OFF_PATH_IDS = new Set(['internet-egress', 'nat-gateway', 'dns', 'cdn', 'search', 'warehouse', 'lake-storage', 'catalog', 'hybrid-link', 'migration-link', 'object-storage', 'cold-storage', 'notify-provider', 'payment-psp', 'llm-api', 'vector-db', 'ml-inference', 'auth', 'db-replica', 'llm-serving', 'llm-gateway', 'guardrails', 'agent-runtime', 'tool-gateway', 'landing-zone', 'crm-target', 'crm-storage', 'legacy-db', 'legacy-crm', 'legacy-app', 'file-source', 'legacy-saas', 'legacy-run', 'tenant-databases', 'request-mirror'])

// A data platform serves reports, not requests: a query crosses the BI tool, the warehouse or query engine, the catalog and the lake,
// or a bought SaaS CRM; ingestion and orchestration failing only delays freshness.
const PLATFORM_PATH_IDS = new Set(['bi', 'warehouse', 'catalog', 'lake-storage', 'crm-target'])
// Managed analytics services publish about 99.9% a month (Fabric, Power BI, Snowflake, Redshift, Databricks SQL, S3 and ADLS standard tiers).
const MANAGED_PLATFORM = 0.999

// AWS, Azure and Google Cloud publish 99.99% for a deployment spread over a region's zones, so the whole region is out about 0.01% of the time.
const REGION = 0.9999

const parallel = (a: number, n: number) => 1 - (1 - a) ** n

function componentAvailability(c: ComponentInstance, architecture: Architecture, facts: Facts): number {
  // A provider's published SLA for the matched service replaces the engine's default.
  if (c.offer?.sla !== undefined) return c.offer.sla
  if (MANAGED_IDS.has(c.def.id)) return MANAGED_SERVICE
  if (c.def.id === 'db-primary') {
    // Read the store from facts: a custom answer replaces the tech label with the user's own words.
    if (facts['data.primary_db'] === 'dynamodb') return 0.9999
    const clustered = typeof facts['data.storeReplicas'] === 'number' && facts['data.storeReplicas'] > 1
    // Cassandra and MongoDB keep their copies inside the cluster; a replica copies one partition, so only that many partitions get a standby.
    const paired = clustered ? c.replicas : Math.min(c.replicas, architecture.components.find((x) => x.def.id === 'db-replica')?.replicas ?? 0)
    // Every shard is needed, so shards are in series; a standby makes its shard a parallel pair.
    return parallel(SELF_HOSTED_INSTANCE, 2) ** paired * SELF_HOSTED_INSTANCE ** (c.replicas - paired)
  }
  // Cache, presence and geo nodes each own a slice of the keys, and the tiers behind a cache are sized for its misses only.
  if (c.shards) return parallel(SELF_HOSTED_INSTANCE, c.replicas / c.shards) ** c.shards
  return parallel(SELF_HOSTED_INSTANCE, c.replicas)
}

// shortcut: a warm standby recovers about 90% of a regional outage, a pilot light about 50%, backups none (restores take hours); measure your real RTO in drills.
const WARM_STANDBY = 0.9
const PILOT_LIGHT = 0.5

/** One region's request path: what a second region can take over (the region and its managed services) and what it cannot (single shards). */
function regionTerms(architecture: Architecture, facts: Facts) {
  // External services sit off the path, except the managed ones that carry requests (a managed real-time service holds every connection).
  const onPath = architecture.components.filter((c) => REQUEST_PATH_TIERS.has(c.def.tier) && !OFF_PATH_IDS.has(c.def.id) && (c.def.shape !== 'external' || MANAGED_IDS.has(c.def.id)))
  const availability = (c: ComponentInstance) => componentAvailability(c, architecture, facts)
  // For microservices a request crosses the gateway and roughly one service, so take the weakest service once.
  const services = onPath.filter((c) => c.def.group === 'service')
  const weakest = services.length ? [services.reduce((a, b) => (availability(a) <= availability(b) ? a : b))] : []
  const path = [...onPath.filter((c) => c.def.group !== 'service'), ...weakest]
  const product = (list: ComponentInstance[]) => list.reduce((acc, c) => acc * availability(c), 1)
  // Managed services publish a per-region SLA, so their outage takes the whole path down and health checks fail over, as for a regional outage.
  // A failed shard fails only its own keys, which health checks do not see, so it stays with the in-region standbys.
  // On premises the data center sites take the place of the cloud region (onprem.sites sets their availability in percent).
  const site = siteAvailability(facts)
  const regional = site * product(path.filter((c) => MANAGED_IDS.has(c.def.id)))
  const local = product(path.filter((c) => !MANAGED_IDS.has(c.def.id)))
  const ids = new Set(architecture.components.map((c) => c.def.id))
  // Video reaches viewers only through the CDN, a global edge service, so it stays in series after the regions combine.
  // An own edge (push, Open Connect style) gives each player more than one edge site to fail over to; one provider counts once.
  const cdn = facts['perf.mediaStreaming'] === true && ids.has('cdn') ? (facts['perf.cdn'] === 'push' ? parallel(MANAGED_SERVICE, 2) : MANAGED_SERVICE) : 1
  const withRecovery = (recovered: number) => local * (regional + (1 - regional) * recovered) * cdn * 100
  return { ids, regional, local, cdn, withRecovery }
}

const siteAvailability = (facts: Facts) => (facts['infra.cloud'] === 'onprem' && typeof facts['onprem.siteAvailability'] === 'number' ? facts['onprem.siteAvailability'] / 100 : REGION)

/** A data platform's query path in one region or site: the platform stays in one region, so a second one recovers none of it. */
function platformAvailability(architecture: Architecture, facts: Facts): number {
  const managed = (c: ComponentInstance) => facts['infra.cloud'] !== 'onprem' && (c.offer !== undefined || c.def.shape === 'external')
  const path = architecture.components.filter((c) => PLATFORM_PATH_IDS.has(c.def.id))
  const product = path.reduce((acc, c) => acc * (c.offer?.sla ?? (managed(c) ? MANAGED_PLATFORM : componentAvailability(c, architecture, facts))), 1)
  return siteAvailability(facts) * product * 100
}

/** Availability of the request path, or of a data platform's query path, in percent. */
export function estimateAvailability(architecture: Architecture, facts: Facts): number {
  if (facts['profile.requestPath'] === false) return platformAvailability(architecture, facts)
  const { ids, regional, local, cdn, withRecovery } = regionTerms(architecture, facts)
  // Peer regions run in parallel only if each one takes writes; the active-active-strong and active-active-single-primary rules flag the rest,
  // whose writes fail over to the primary's region like a warm standby.
  const singleWriter = facts['data.strongConsistency'] === true || (['postgres', 'mysql', 'mongodb', 'sqlserver', 'oracle'].includes(String(facts['data.primary_db'])) && facts['data.replication'] !== 'multi_primary')
  if (ids.has('peer-region')) return singleWriter ? withRecovery(WARM_STANDBY) : parallel(local * regional, 2) * cdn * 100
  // Read the topology from facts, as the standby's cost does: a custom answer replaces the tech label with the user's own words.
  if (ids.has('standby-region')) return withRecovery(facts['reliability.multi_region'] === 'active_passive' ? WARM_STANDBY : PILOT_LIGHT)
  return withRecovery(0)
}

/** Target minus the estimate with each way to recover a regional outage, so the topology and DR decisions can read the gap they close. */
export function recoveryGaps(architecture: Architecture, facts: Facts): Facts {
  const target = facts['reliability.nines']
  // A second region recovers no part of a data platform (platformAvailability), so no recovery gap drives the regional topology there.
  if (typeof target !== 'number' || facts['profile.requestPath'] === false) return {}
  const { withRecovery } = regionTerms(architecture, facts)
  return {
    'availability.singleRegionGap': target - withRecovery(0),
    'availability.pilotLightGap': target - withRecovery(PILOT_LIGHT),
    'availability.warmStandbyGap': target - withRecovery(WARM_STANDBY),
  }
}
