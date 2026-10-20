import type { Facts, ReferenceNumbers } from '../domain/types'

const num = (facts: Facts, key: string, fallback: number): number => {
  const v = facts[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** Source engines a target database can keep as they are (data.primary_db options with the same id); any other pair converts the schema and code. */
const SAME_ENGINE_TARGETS = new Set(['postgres', 'mysql', 'sqlserver', 'oracle'])

// shortcut: 'recent' keeps about 30% of the history in the database and archives the rest (general knowledge); measure the real split by date.
const HISTORY_SHARE: Record<string, number> = { all: 1, recent: 0.3, none: 0 }

const LAKE_KINDS = ['warehouse', 'files']

// shortcut: a CDC catch-up of about a week and about two days of final increments before cutover (general knowledge); rehearse them on the trial migrations.
const CDC_CATCHUP_DAYS = 7
const FINAL_INCREMENT_DAYS = 2

/**
 * Source data the new system takes over after the history policy, and the older share archived to object storage.
 * `migrated` is the whole move; it splits into the CRM's records (`crm`), the warehouse and file extracts (`files`) and the rest (`main`, the database, mainframe or application).
 * source.volume_gb holds the main source; a SaaS CRM or warehouse and files next to other kinds have volumes of their own (questions.ts).
 */
export function migratedGb(facts: Facts): { migrated: number; archived: number; main: number; crm: number; files: number } {
  const kinds = Array.isArray(facts['source.kinds']) ? facts['source.kinds'].map(String) : []
  const volume = num(facts, 'source.volume_gb', 0)
  const crmKind = kinds.includes('crm')
  // A home-grown or packaged on-premises CRM is its own database (derived source.crmOnDatabase), so the main volume holds its records; a SaaS CRM next to other systems has a volume of its own.
  const crmApart = crmKind && facts['source.crmOnDatabase'] !== true && kinds.some((k) => k !== 'crm' && !LAKE_KINDS.includes(k))
  const volumeIsCrm = crmKind && !crmApart
  const filesApart = kinds.some((k) => LAKE_KINDS.includes(k)) && kinds.some((k) => !LAKE_KINDS.includes(k))
  const filesOnly = kinds.length > 0 && kinds.every((k) => LAKE_KINDS.includes(k))
  const crm = crmApart ? num(facts, 'source.crm_volume_gb', 0) : volumeIsCrm ? volume : 0
  const files = filesApart ? num(facts, 'source.file_volume_gb', 0) : filesOnly ? volume : 0
  const main = volumeIsCrm || filesOnly ? 0 : volume
  const history = String(facts['source.history'] ?? 'all')
  const share = HISTORY_SHARE[history] ?? 1
  const total = main + crm + files
  return { migrated: total * share, archived: history === 'recent' ? total * (1 - share) : 0, main: main * share, crm: crm * share, files: files * share }
}

/** Transfer and cutover estimates (`mig.*`) for a migration: hours of bulk copy on each link, and the cutover against the downtime window. */
export function estimateMigration(facts: Facts, ref: ReferenceNumbers): Facts {
  if (facts['profile.migration'] !== true) return {}
  const { migrated: gb, archived, crm: crmGb, files: filesGb } = migratedGb(facts)
  // Replacing a system moves its archived history out too (workload.ts), ahead of the cutover; it crosses the same link or device and egress.
  const transferGb = gb + (facts['profile.retire'] === true ? archived : 0)
  // A bought SaaS CRM takes its records only through its import APIs, so the copy lasts at least as long as the import, whatever the link.
  const kinds = Array.isArray(facts['source.kinds']) ? facts['source.kinds'] : []
  const repurchasedCrm = facts['migration.approach'] === 'repurchase' && kinds.includes('crm')
  const importHours = repurchasedCrm ? crmGb / ref.saasCrmImportGbPerHour : 0
  // A copy runs at the link's rate up to what the target database takes in bulk; the loader fleet scales to that rate.
  const copyMBps = (gbps: number) => Math.min((gbps * ref.transferEfficiency * 1000) / 8, ref.bulkLoadMaxMBps)
  const hours = (gbps: number) => Math.max(importHours, (gb * 1000) / copyMBps(gbps) / 3600)
  // The same site copies over the local network at about 10 Gbps, like the same cloud.
  const perLink: Record<string, number> = { vpn: hours(ref.vpnGbps), dedicated_1g: hours(1), dedicated_10g: hours(10), offline_device: Math.max(importHours, ref.offlineDeviceHours), same_cloud: hours(10) }
  // A pending link counts as the question's default, a VPN; the same cloud copies inside the provider's network at about 10 Gbps.
  const bulkHours = perLink[String(facts['migration.link'])] ?? perLink.vpn
  const linkGbps: Record<string, number> = { dedicated_1g: 1, dedicated_10g: 10, same_cloud: 10 }
  // A shipped device is read on the target side at the target's own load rate.
  const loaderMBps = facts['migration.link'] === 'offline_device' ? ref.bulkLoadMaxMBps : copyMBps(linkGbps[String(facts['migration.link'])] ?? ref.vpnGbps)
  // The archived share crosses the same link to object storage before cutover (no database load cap); a shipped device carries it in the same jobs.
  const archiveGb = transferGb - gb
  const archiveHours = facts['migration.link'] === 'offline_device' ? 0 : (archiveGb * 1000) / ((((linkGbps[String(facts['migration.link'])] ?? ref.vpnGbps) * ref.transferEfficiency * 1000) / 8) * 3600)
  const window = num(facts, 'migration.downtimeHours', 8)
  // A bulk cutover copies everything and validates it inside the window; CDC has loaded beforehand and only drains its lag,
  // and file drops or API extraction have loaded every earlier increment, so only the last one is left.
  const bulkCutover = (h: number) => h * (1 + ref.validationFactor)
  const sync = facts['migration.sync']
  const cutoverHours = sync === 'cdc' ? ref.cdcCutoverHours : sync === 'file_drop' || sync === 'api_extract' ? ref.incrementalCutoverHours : bulkCutover(bulkHours)
  // Before coexistence starts, two trial migrations on a production copy, the initial load and the catch-up run on the target, the link and the tooling.
  // A fresh start, or an AI app that reads no copy of the kept system (derived profile.keptUncopied), moves no data.
  const movesData = facts['source.history'] !== 'none' && facts['profile.keptUncopied'] !== true
  const loadDays = Math.max(1, Math.ceil(bulkHours / 24))
  const trialDays = 2 * Math.max(1, Math.ceil(bulkCutover(bulkHours) / 24))
  const finalDays = sync === 'cdc' ? CDC_CATCHUP_DAYS : sync === undefined || sync === 'bulk_export' ? loadDays : FINAL_INCREMENT_DAYS
  const archiveDays = archiveHours > 0 ? Math.ceil(archiveHours / 24) : 0
  const preCutoverDays = movesData ? trialDays + archiveDays + loadDays + finalDays : 0
  const answeredMonths = num(facts, 'migration.coexistence_months', 0)
  // Mapping and cleansing duplicated or free-text data keeps both systems running about two months longer than the strategy's typical duration.
  const quality = String(facts['source.data_quality'] ?? 'clean')
  // Keeping the old system live as the rollback path runs it until sign-off after cutover; a parallel run already counts those months.
  const signOff = facts['migration.strategy'] === 'parallel_run' ? 0 : num(facts, 'migration.signOffMonths', 0)
  const defaultMonths = num(facts, 'migration.defaultCoexistMonths', 0) + (quality === 'clean' ? 0 : 2) + signOff
  // Engineering effort by approach; converting heavy database code to another engine dominates it.
  // The target engine decides whether the code is converted: a rehost or replatform onto another engine is a refactor in effort.
  const source = facts['source.rdbms_engine']
  const target = facts['data.primary_db']
  const convertsEngine = facts['source.database'] === true && typeof source === 'string' && typeof target === 'string' && !(source === target && SAME_ENGINE_TARGETS.has(target))
  const answeredApproach = facts['migration.approach']
  const approach = convertsEngine && (answeredApproach === 'rehost' || answeredApproach === 'replatform') ? 'refactor' : answeredApproach
  const byApproach: Record<string, number> = {
    rehost: ref.migrationFteMonthsRehost,
    replatform: ref.migrationFteMonthsReplatform,
    refactor: facts['source.code_in_db'] === 'heavy' ? ref.migrationFteMonthsRefactorHeavy : ref.migrationFteMonthsRefactor,
    retain: ref.migrationFteMonthsRetain,
    repurchase: ref.migrationFteMonthsRepurchase,
  }
  const byQuality: Record<string, number> = { mixed: ref.dataQualityFteMonthsMixed, poor: ref.dataQualityFteMonthsPoor }
  // Replacing a legacy application rebuilds it as well, unless a SaaS product is bought in its place.
  const rebuild = facts['project.origin'] === 'replace_legacy_app' && approach !== 'repurchase' ? ref.appRebuildFteMonths : 0
  // Code the approach question does not cover: mainframe programs and copybooks, warehouse scripts and ETL jobs, and the database code
  // a data platform rebuilds as lake pipelines when it replaces the database (no target engine is chosen there).
  const code = facts['source.code_in_db']
  const byCode = (some: number, heavy: number) => (code === 'heavy' ? heavy : code === 'none' ? ref.migrationFteMonthsDefault : some)
  // Only a replacement converts that code; a kept system (extend_existing) is read where it runs.
  const replaces = facts['profile.replace'] === true
  const intoLake = facts['source.database'] === true && facts['profile.requestPath'] === false && replaces && answeredApproach === undefined
  const sourceCode =
    (replaces && kinds.includes('mainframe') ? byCode(ref.migrationFteMonthsMainframe, ref.migrationFteMonthsMainframeHeavy) : 0) +
    (replaces && kinds.includes('warehouse') ? byCode(ref.migrationFteMonthsWarehouse, ref.migrationFteMonthsWarehouseHeavy) : 0) +
    (intoLake ? byCode(ref.migrationFteMonthsRefactor, ref.migrationFteMonthsRefactorHeavy) : 0)
  const base = byApproach[String(approach)] ?? (sourceCode > 0 ? 0 : ref.migrationFteMonthsDefault)
  const fteMonths = base + sourceCode + (byQuality[quality] ?? 0) + rebuild
  // A bought CRM bills the records beyond the storage its tenant and seats include (migration.crm_target sets the allowance; HubSpot sets none and bills no storage).
  const allowanceGb = facts['migration.crmStorageBaseGb']
  const crmExtraStorageGb = repurchasedCrm && typeof allowanceGb === 'number' ? Math.max(0, crmGb - allowanceGb - num(facts, 'migration.crmStoragePerUserGb', 0) * num(facts, 'source.crm_users', 0)) : 0
  return {
    'mig.sourceGb': gb,
    'mig.crmGb': crmGb,
    'mig.filesGb': filesGb,
    'mig.crmExtraStorageGb': crmExtraStorageGb,
    'mig.transferGb': transferGb,
    'mig.bulkHoursVpn': perLink.vpn,
    'mig.bulkHours1g': perLink.dedicated_1g,
    'mig.bulkHours10g': perLink.dedicated_10g,
    'mig.bulkHours': bulkHours,
    // A shipped device on its own, whatever link is chosen (at least the import floor of a bought CRM).
    'mig.bulkHoursDevice': perLink.offline_device,
    'mig.archiveHours': archiveHours,
    // Everything that crosses the link before cutover: the copy plus the archived history.
    'mig.transferHours': bulkHours + archiveHours,
    'mig.loaderNodes': Math.max(1, Math.ceil(loaderMBps / ref.loaderNodeMBps - 1e-9)),
    'mig.cutoverHours': cutoverHours,
    // Conditions compare a fact with a constant, so each bulk cutover is stated as a share of the window (above 1 = it does not fit).
    'mig.cutoverRatioVpn': bulkCutover(perLink.vpn) / window,
    'mig.cutoverRatio1g': bulkCutover(perLink.dedicated_1g) / window,
    'mig.cutoverRatio10g': bulkCutover(perLink.dedicated_10g) / window,
    'mig.bulkCutoverRatio': bulkCutover(bulkHours) / window,
    // Each faster option against the next slower one (above 1 = it copies sooner); a CRM import floor or a database load cap makes them equal.
    // The fastest link anyone can order is 10 Gbps; a shipped device beats it only when this is above 1.
    'mig.deviceSpeedup10g': perLink.dedicated_10g / perLink.offline_device,
    'mig.speedup10gOver1g': perLink.dedicated_1g / perLink.dedicated_10g,
    'mig.speedup1gOverVpn': perLink.vpn / perLink.dedicated_1g,
    'mig.cutoverRatio': cutoverHours / window,
    // A replaced system takes today the writes the new one will take, so CDC carries the write rate; without an application in front
    // of the new system, or when the old system stays and keeps its own writes, the source's daily change rate sizes it, at the usual peak factor.
    'mig.cdcChangesQps':
      facts['profile.requestPath'] === false || facts['profile.replace'] !== true
        ? (num(facts, 'source.change_rows_day', 0) / ref.secondsPerDay) * num(facts, 'traffic.peakFactor', 3)
        : num(facts, 'cap.peakWriteQps', 0),
    // Building on existing data keeps the old system for good: nothing is retired, so no months of running both.
    'migration.coexistMonths': facts['profile.replace'] !== true ? 0 : answeredMonths > 0 ? answeredMonths : defaultMonths,
    // The plan's trial, load and catch-up durations (docs/generate.ts), and the months they bill both systems before coexistence starts.
    'mig.trialDays': trialDays,
    'mig.loadDays': loadDays,
    'mig.archiveDays': archiveDays,
    'mig.finalDays': finalDays,
    'mig.preCutoverMonths': facts['profile.replace'] !== true ? 0 : preCutoverDays / 30,
    'mig.engineeringFteMonths': fteMonths,
  }
}
