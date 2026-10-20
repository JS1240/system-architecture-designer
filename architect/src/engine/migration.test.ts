import { describe, expect, it } from 'vitest'
import type { Answers, Evaluation, FactValue } from '../domain/types'
import { migrationMarkdown } from '../docs/generate'
import { kb } from '../knowledge'
import { fmt } from './architecture'
import { evaluate } from './evaluate'
import { withOverrides } from './overrides'
import { autoComplete, compareOver, costLevers, horizonCost, LEVER_HORIZON_MONTHS, runAndPeople, suggestFromDescription } from './explore'

const v = (value: FactValue) => ({ kind: 'value' as const, value })
const design = (answers: Answers) => evaluate(kb, autoComplete(kb, answers))
const ids = (e: Evaluation) => e.architecture.components.map((c) => c.def.id)
const findings = (e: Evaluation) => e.findings.map((x) => x.rule.id)
const scenario = (id: string) => kb.scenarios.find((s) => s.id === id)!.answers
const recommendation = (e: Evaluation, id: string) => e.questions.find((q) => q.question.id === id)!.recommendation

// 12 TB of Oracle over a 1 Gbps link with one night of downtime.
const twelveTb: Answers = {
  'product.type': v('commerce'),
  'project.origin': v('migrate_database'),
  'infra.cloud': v('aws'),
  'source.kinds': v(['rdbms']),
  'source.rdbms_engine': v('oracle'),
  'source.volume_gb': v(12 * 1024),
  'migration.downtime': v('overnight'),
  'migration.link': v('dedicated_1g'),
  'traffic.dau': v(100_000),
}

// The same source with the link left to the recommendation.
const linkPending: Answers = Object.fromEntries(Object.entries(twelveTb).filter(([id]) => id !== 'migration.link'))

describe('target cloud in a brief', () => {
  it('does not read an on-premises source being moved to a cloud data platform as an on-premises target', () => {
    const cloud = (d: string) => suggestFromDescription(kb, d)['infra.cloud']
    expect(cloud(kb.scenarios.find((s) => s.id === 'sqlserver-dw-to-fabric')!.description)).toBeUndefined()
    expect(cloud('We migrate our on-premises Oracle warehouse to Snowflake')).toBeUndefined()
    // No move verb: an on-premises app next to a cloud platform, or a self-hosted target, keeps the suggestion.
    expect(cloud('Our on-premises ERP feeds Databricks forecasting')).toEqual({ kind: 'value', value: 'onprem' })
    expect(cloud('We run everything on-premises and must stay self-hosted')).toEqual({ kind: 'value', value: 'onprem' })
  })
})

describe('migration estimates', () => {
  it('copies 12 TB over 1 Gbps in about 39 hours, and over 10 Gbps no faster than the target loads', () => {
    const e = design(twelveTb)
    expect(Number(e.facts['mig.bulkHours1g'])).toBeCloseTo(39, 0)
    // 875 MB/s of line rate, capped at the 400 MB/s a target database takes in bulk.
    expect(Number(e.facts['mig.bulkHours10g'])).toBeCloseTo((12 * 1024 * 1000) / kb.reference.bulkLoadMaxMBps / 3600, 5)
    expect(e.facts['mig.bulkHours']).toBe(e.facts['mig.bulkHours1g'])
  })

  it('recommends CDC, not a bulk export, when the copy does not fit an 8 h window', () => {
    const e = design(twelveTb)
    expect(recommendation(e, 'migration.sync').optionId).toBe('cdc')
    expect(e.facts['migration.sync']).toBe('cdc')
    expect(e.facts['mig.cutoverHours']).toBe(kb.reference.cdcCutoverHours)
    expect(ids(e)).toEqual(expect.arrayContaining(['cdc-pipeline', 'bulk-loader', 'hybrid-link']))
  })

  it('flags a forced bulk export that overruns the window', () => {
    const e = design({ ...twelveTb, 'migration.sync': v('bulk_export') })
    // 39 h of copy plus 50% validation against 8 h.
    expect(Number(e.facts['mig.cutoverHours'])).toBeCloseTo(58.5, 0)
    expect(findings(e)).toContain('bigbang-window')
    expect(ids(e)).not.toContain('cdc-pipeline')
    expect(findings(design(twelveTb))).not.toContain('bigbang-window')
  })

  it('adds no migration facts or components to new builds', () => {
    for (const s of kb.scenarios.filter((x) => !x.answers['project.origin'])) {
      const e = design(s.answers)
      expect(e.facts['project.origin'], s.id).toBe('greenfield')
      expect(Object.keys(e.facts).filter((k) => k.startsWith('mig.')), s.id).toEqual([])
      expect(ids(e).filter((id) => ['cdc-pipeline', 'bulk-loader', 'reconciliation-job'].includes(id)), s.id).toEqual([])
      expect(e.architecture.components.filter((c) => c.phase === 'transition').map((c) => c.def.id), s.id).toEqual([])
      // A data platform's source inventory is asked on a new build too: it reads existing systems without migrating them.
      const inventory = e.facts['profile.dataPlatformOnly'] === true ? ['source.kinds', 'source.rdbms_engine', 'source.location'] : []
      expect(e.questions.filter((q) => q.active && q.question.category === 'migration' && !inventory.includes(q.question.id)).map((q) => q.question.id), s.id).toEqual([])
    }
  })
})

describe('migration inputs and flows', () => {
  it('moves the migrated records into the database and archives older history', () => {
    const all = design(twelveTb)
    const recent = design({ ...twelveTb, 'source.history': v('recent') })
    const none = design({ ...twelveTb, 'source.history': v('none') })
    expect(all.workload.dbStorageGb - none.workload.dbStorageGb).toBeCloseTo(12 * 1024, 0)
    expect(recent.workload.dbStorageGb - none.workload.dbStorageGb).toBeCloseTo(12 * 1024 * 0.3, 0)
    expect(recent.workload.objectStorageGb - none.workload.objectStorageGb).toBeCloseTo(12 * 1024 * 0.7, 0)
    // Building on existing data loads it into the lake, not the operational database.
    const extend = design({ ...twelveTb, 'project.origin': v('extend_existing'), 'project.addons': v(['analytics']) })
    expect(extend.workload.dbStorageGb).toBeCloseTo(none.workload.dbStorageGb, 0)
    expect(extend.workload.lakeStorageTb).toBeGreaterThan(12)
  })

  it('replaces the derived peak with a measured one and keeps the read:write split', () => {
    const derived = design(twelveTb).workload
    const measured = design({ ...twelveTb, 'source.measured_peak_qps': v(9_000) }).workload
    expect(measured.peakQps).toBeCloseTo(9_000)
    expect(measured.peakWriteQps / measured.peakQps).toBeCloseTo(derived.peakWriteQps / derived.peakQps)
  })

  it('bills the migration tooling as transition cost, and keeps the analytics link steady-state', () => {
    const e = design(twelveTb)
    const transition = e.architecture.components.filter((c) => c.phase === 'transition')
    expect(transition.map((c) => c.def.id)).toEqual(expect.arrayContaining(['hybrid-link', 'cdc-pipeline', 'bulk-loader']))
    // One-off transition lines (migration engineering, transfer fees) are paid once, so they stay out of the transition monthly cost.
    expect(e.cost.transitionMonthly).toBeCloseTo(transition.filter((c) => c.costKind !== 'one_time').reduce((sum, c) => sum + c.monthlyCost, 0))
    // A big bang coexists for about two weeks unless the answer says otherwise.
    expect(e.facts['migration.coexistMonths']).toBe(0.5)
    expect(design({ ...twelveTb, 'migration.coexistence_months': v(6) }).facts['migration.coexistMonths']).toBe(6)
    const hybrid = design(scenario('onprem-erp-databricks-hybrid'))
    expect(hybrid.architecture.components.find((c) => c.def.id === 'hybrid-link')!.phase).toBeUndefined()
  })

  it('keeps the analytics link of a hybrid design apart from the link a migration chose', () => {
    const hybrid = scenario('onprem-erp-databricks-hybrid')
    const migrating = (link: string) => design({ ...hybrid, 'project.origin': v('migrate_database'), 'source.kinds': v(['rdbms']), 'source.volume_gb': v(500), 'migration.link': v(link) })
    const alone = design(hybrid)
    expect(ids(alone)).not.toContain('migration-link')
    for (const [link, tech, price] of [['vpn', 'AWS Site-to-Site VPN', 40], ['dedicated_1g', 'AWS Direct Connect (1 Gbps)', 300], ['dedicated_10g', 'AWS Direct Connect (10 Gbps)', 1_700]] as const) {
      const e = migrating(link)
      const analytics = e.architecture.components.find((c) => c.def.id === 'hybrid-link')!
      const copy = e.architecture.components.find((c) => c.def.id === 'migration-link')!
      // The permanent link keeps its 1 Gbps port and price whatever the one-off copy crosses.
      expect(analytics.tech, link).toBe('AWS Direct Connect (1 Gbps)')
      expect(analytics.monthlyCost, link).toBe(300)
      expect(analytics.phase, link).toBeUndefined()
      expect(copy.tech, link).toBe(tech)
      expect(copy.monthlyCost, link).toBe(price)
      expect(copy.phase, link).toBe('transition')
      const flows = e.architecture.edges.map((x) => `${x.from}->${x.to}`)
      expect(flows, link).toEqual(expect.arrayContaining(['ingestion->hybrid-link', 'migration-link->bulk-loader']))
      expect(flows, link).not.toContain('hybrid-link->bulk-loader')
    }
    // With the analytics cloud still pending, the analytics link stays a 1 Gbps port, never named after the migration's VPN or 10 Gbps link.
    for (const link of ['vpn', 'dedicated_10g']) {
      const { 'data.analytics_cloud': _pending, ...answers } = autoComplete(kb, { ...hybrid, 'project.origin': v('migrate_database'), 'source.kinds': v(['rdbms']), 'source.volume_gb': v(500), 'migration.link': v(link) })
      const e = evaluate(kb, answers)
      expect(e.facts['data.analytics_cloud'], link).toBeUndefined()
      const analytics = e.architecture.components.find((c) => c.def.id === 'hybrid-link')!
      expect(analytics.tech, link).toBe('Dedicated 1 Gbps interconnect')
      expect(analytics.monthlyCost, link).toBe(300)
    }
    // Excluding the migration link sends the copy over the analytics link.
    const shared = evaluate(withOverrides(kb, { exclude: ['migration-link'] }), autoComplete(kb, { ...hybrid, 'project.origin': v('migrate_database'), 'source.kinds': v(['rdbms']), 'source.volume_gb': v(500), 'migration.link': v('vpn') }))
    expect(shared.architecture.edges.map((x) => `${x.from}->${x.to}`)).toContain('hybrid-link->bulk-loader')
  })

  it('names and prices the link and the change capture per provider', () => {
    const e = design(twelveTb)
    const component = (id: string) => e.architecture.components.find((c) => c.def.id === id)!
    expect(component('hybrid-link').tech).toBe('AWS Direct Connect (1 Gbps)')
    expect(component('hybrid-link').monthlyCost).toBe(300)
    expect(component('cdc-pipeline').tech).toBe('AWS DMS (full load + CDC), reads the redo log')
    const azure = design({ ...twelveTb, 'infra.cloud': v('azure'), 'migration.link': v('dedicated_10g') })
    expect(azure.architecture.components.find((c) => c.def.id === 'hybrid-link')!.tech).toBe('Azure ExpressRoute (10 Gbps)')
    expect(azure.architecture.components.find((c) => c.def.id === 'hybrid-link')!.monthlyCost).toBe(1_700)
    const device = design({ ...twelveTb, 'migration.link': v('offline_device') })
    expect(device.architecture.components.find((c) => c.def.id === 'bulk-loader')!.tech).toBe('AWS Snowball Edge')
    // The device carries the snapshot; CDC still streams the changes made meanwhile over a VPN.
    expect(device.facts['migration.sync']).toBe('cdc')
    expect(device.architecture.components.find((c) => c.def.id === 'hybrid-link')!.tech).toBe('AWS Site-to-Site VPN')
    expect(device.architecture.components.find((c) => c.def.id === 'hybrid-link')!.monthlyCost).toBe(40)
    expect(device.architecture.edges.map((x) => `${x.from}->${x.to}`)).toContain('hybrid-link->cdc-pipeline')
    // A device bulk load without CDC needs no link.
    expect(ids(design({ ...twelveTb, 'migration.link': v('offline_device'), 'migration.sync': v('bulk_export') }))).not.toContain('hybrid-link')
  })

  it('rules out CDC for SaaS sources and reads them through their APIs', () => {
    const crm = design({ ...twelveTb, 'source.kinds': v(['crm']), 'source.crm_product': v('salesforce') })
    const cdc = recommendation(crm, 'migration.sync').scores.find((x) => x.optionId === 'cdc')!
    expect(cdc.feasible).toBe(false)
    expect(cdc.infeasibleReason).toContain('SaaS CRMs and APIs expose only their APIs')
    expect(crm.facts['migration.sync']).toBe('api_extract')
    expect(findings(crm)).not.toContain('saas-crm-sync')
  })

  it('brings the link only for syncs that copy data over it', () => {
    // A SaaS export leaves through the provider's public API: no link question, no link, cutover on the last increment.
    const crm = design({ ...linkPending, 'source.kinds': v(['crm']), 'source.volume_gb': v(5_000) })
    expect(crm.questions.find((q) => q.question.id === 'migration.link')!.active).toBe(false)
    expect(ids(crm)).not.toContain('hybrid-link')
    expect(crm.facts['mig.cutoverHours']).toBe(kb.reference.incrementalCutoverHours)
    // Mainframe file drops cross the link into the loader.
    const files = design({ ...twelveTb, 'source.kinds': v(['mainframe']), 'migration.sync': v('file_drop') })
    const flows = files.architecture.edges.map((x) => `${x.from}->${x.to}`)
    expect(flows).toEqual(expect.arrayContaining(['hybrid-link->bulk-loader', 'bulk-loader->db-primary']))
    // A mixed source extracted through APIs leaves the link out.
    expect(ids(design({ ...twelveTb, 'source.kinds': v(['rdbms', 'crm']), 'migration.sync': v('api_extract') }))).not.toContain('hybrid-link')
  })

  it('recommends incremental file drops when a source without a change log cannot fit the window', () => {
    const e = design({ ...linkPending, 'source.kinds': v(['warehouse']), 'source.volume_gb': v(300_000) })
    // About 95 h over 10 Gbps, faster than the 10 days a shipped device takes.
    expect(e.facts['migration.link']).toBe('dedicated_10g')
    expect(e.facts['migration.sync']).toBe('file_drop')
    expect(findings(e)).not.toContain('bigbang-window')
  })

  it('flags a CDC cutover that overruns the window, as the generated runbook says', () => {
    // Without reverse CDC the smoke tests run inside the write freeze.
    const e = design({ ...scenario('oracle-orders-to-aws'), 'migration.rollback': v('restore_backup') })
    expect(e.facts['migration.sync']).toBe('cdc')
    expect(e.facts['mig.cutoverRatio']).toBeGreaterThan(1)
    expect(findings(e)).toContain('cutover-window')
    expect(findings(e)).not.toContain('bigbang-window')
    expect(migrationMarkdown(e)).toContain('(overruns)')
    // A window wide enough for the drain and the smoke tests clears it.
    const wide = design({ ...scenario('oracle-orders-to-aws'), 'migration.rollback': v('restore_backup'), 'migration.downtime': v('overnight') })
    expect(wide.facts['mig.cutoverRatio']).toBeLessThanOrEqual(1)
    expect(findings(wide)).not.toContain('cutover-window')
  })

  it('keeps the link and loader of an extension\'s scheduled reloads in the target design and loads the lake', () => {
    const e = design({ ...twelveTb, 'project.origin': v('extend_existing'), 'project.addons': v(['analytics']), 'migration.sync': v('bulk_export') })
    // The kept system reloads on a schedule for good, so the link and the loader are steady-state cost.
    expect(e.architecture.components.find((c) => c.def.id === 'hybrid-link')!.phase).toBeUndefined()
    expect(e.architecture.components.find((c) => c.def.id === 'bulk-loader')!.phase).toBeUndefined()
    // The snapshot lands in the raw zone first, which then loads the lake.
    const target = e.architecture.edges.find((x) => x.from === 'bulk-loader')!.to
    expect(target).toBe('landing-zone')
    expect(e.architecture.edges.some((x) => x.from === 'landing-zone' && ['lake-storage', 'warehouse'].includes(x.to))).toBe(true)
  })

  it('prices a CDC replication instance in full and names a spare only when it keeps one', () => {
    const cdc = (answers: Answers) => design(answers).architecture.components.find((c) => c.def.id === 'cdc-pipeline')!
    const single = cdc({ ...twelveTb, 'reliability.availability': v('two') })
    expect(single.unitCost).toBe(180)
    expect(single.sizingNote).not.toContain('spare')
    const paired = cdc({ ...twelveTb, 'reliability.availability': v('four') })
    expect(paired.replicas).toBeGreaterThan(1)
    expect(paired.sizingNote).toContain('one of them a spare')
  })

  it('routes a strangler migration through a gateway facade and reconciles both stores', () => {
    const e = design({ ...scenario('sqlserver-crm-to-azure'), 'team.size': v('multi') })
    expect(e.facts['migration.strategy']).toBe('strangler')
    expect(ids(e)).toEqual(expect.arrayContaining(['api-gateway', 'reconciliation-job']))
    expect(e.architecture.components.find((c) => c.def.id === 'api-gateway')!.tech).toBe('Azure API Management, strangler facade (routes migrated features)')
  })

  it('keeps reverse replication for a rollback inside a short window', () => {
    const e = design(scenario('oracle-orders-to-aws'))
    expect(e.facts['migration.rollback']).toBe('reverse_cdc')
    const flows = e.architecture.edges.map((x) => `${x.from}->${x.to}:${x.label}`)
    expect(flows).toEqual(expect.arrayContaining(['db-primary->cdc-pipeline:Reverse replication for rollback', 'cdc-pipeline->db-primary:Apply changes', 'bulk-loader->db-primary:Initial snapshot']))
    expect(findings(design({ ...scenario('oracle-orders-to-aws'), 'migration.rollback': v('none') }))).toContain('no-rollback')
    expect(findings(design({ ...scenario('oracle-orders-to-aws'), 'migration.sync': v('dual_write') }))).toContain('dual-write')
  })
})

describe('existing systems and transition cost', () => {
  const component = (e: Evaluation, id: string) => e.architecture.components.find((c) => c.def.id === id)
  const migrations = kb.scenarios.filter((s) => s.answers['project.origin'])

  it('keeps phase-transition components out of the steady-state monthly cost', () => {
    for (const s of migrations) {
      const e = design(s.answers)
      const steady = e.architecture.components.filter((c) => c.phase !== 'transition' && ['run', 'license', 'nonprod', 'transfer'].includes(c.costKind))
      // Staging and vendor support are shares of the steady lines, added on top.
      const shares = (e.cost.byKind.nonprod ?? 0) + (e.cost.byKind.support ?? 0)
      expect(e.cost.monthly, s.id).toBeCloseTo(steady.reduce((sum, c) => sum + c.monthlyCost, 0) + shares)
      // The old system's bill and the months both run change the transition, never the target design's monthly cost.
      const longer = design({ ...s.answers, 'source.legacy_monthly_usd': v(90_000), 'migration.coexistence_months': v(9) })
      expect(longer.cost.monthly, s.id).toBeCloseTo(e.cost.monthly)
    }
  })

  it('prices offline devices once: ceil(TB / 80) x $300', () => {
    const device = (gb: number) => design({ ...scenario('oracle-orders-to-aws'), 'migration.link': v('offline_device'), 'source.volume_gb': v(gb) })
    for (const gb of [12_000, 200_000]) {
      const e = device(gb)
      const fees = component(e, 'transfer-fees')!
      expect(fees.costKind).toBe('one_time')
      expect(fees.monthlyCost, String(gb)).toBe(Math.ceil(gb / 1024 / 80) * 300)
      expect(e.cost.oneTime).toBeCloseTo(fees.monthlyCost + component(e, 'migration-engineering')!.monthlyCost)
    }
    // Leaving another cloud bills egress per GB, also when a device carries the copy.
    const egress = design({ ...scenario('oracle-orders-to-aws'), 'source.location': v('other_cloud') })
    expect(component(egress, 'source-egress')!.monthlyCost).toBeCloseTo(12_000 * 0.09)
    expect(component(egress, 'transfer-fees')).toBeUndefined()
    const both = design({ ...scenario('oracle-orders-to-aws'), 'source.location': v('other_cloud'), 'infra.cloud': v('azure'), 'migration.link': v('offline_device'), 'source.volume_gb': v(100_000) })
    expect(component(both, 'transfer-fees')!.monthlyCost).toBe(Math.ceil(100_000 / 1024 / 80) * 300)
    expect(component(both, 'source-egress')!.monthlyCost).toBeCloseTo(100_000 * 0.09)
    expect(both.cost.oneTime).toBeCloseTo(component(both, 'transfer-fees')!.monthlyCost + component(both, 'source-egress')!.monthlyCost + component(both, 'migration-engineering')!.monthlyCost)
  })

  it('adds the trial, load and coexistence months of both systems to the one-off cost', () => {
    for (const s of migrations) {
      const e = design(s.answers)
      const months = Number(e.facts['migration.coexistMonths']) + Number(e.facts['mig.preCutoverMonths'])
      expect(e.cost.transitionTotal, s.id).toBeCloseTo(e.cost.oneTime + months * (e.cost.monthly + e.cost.transitionMonthly))
    }
    // The old system's bill is a transition line while both run.
    const oracle = design(scenario('oracle-orders-to-aws'))
    expect(component(oracle, 'legacy-run')!.monthlyCost).toBe(40_000)
    expect(component(oracle, 'legacy-run')!.phase).toBe('transition')
    // The old figure counts its staff, so the saving takes off the new people cost as well as the run cost.
    expect(oracle.cost.paybackMonths).toBeCloseTo(oracle.cost.transitionTotal / (40_000 - oracle.cost.monthly - oracle.cost.people))
  })

  it('counts the new people cost in the payback, so own hardware does not pay back faster than a cloud it costs more than', () => {
    const aws = design(scenario('oracle-orders-to-aws'))
    const onprem = design({ ...scenario('oracle-orders-to-aws'), 'infra.cloud': v('onprem') })
    expect(onprem.cost.monthly + onprem.cost.people).toBeGreaterThan(aws.cost.monthly + aws.cost.people)
    expect(onprem.cost.paybackMonths!).toBeGreaterThan(aws.cost.paybackMonths!)
    // Kubernetes adds platform staff, so it pays back later than managed containers.
    const k8s = design({ ...scenario('oracle-orders-to-aws'), 'infra.compute': v('kubernetes') })
    expect(k8s.cost.people).toBeGreaterThan(aws.cost.people)
    expect(k8s.cost.paybackMonths!).toBeGreaterThan(aws.cost.paybackMonths!)
  })

  it('adds the application rebuild to the engineering effort when a legacy application is replaced, not when a SaaS product is bought', () => {
    const base = { ...scenario('oracle-orders-to-aws'), 'migration.approach': v('replatform') }
    const db = design({ ...base, 'project.origin': v('migrate_database') })
    const app = design({ ...base, 'project.origin': v('replace_legacy_app') })
    expect(Number(app.facts['mig.engineeringFteMonths']) - Number(db.facts['mig.engineeringFteMonths'])).toBe(kb.reference.appRebuildFteMonths)
    const bought = design({ ...base, 'project.origin': v('replace_legacy_app'), 'migration.approach': v('repurchase') })
    expect(bought.facts['mig.engineeringFteMonths']).toBe(kb.reference.migrationFteMonthsRepurchase + (Number(db.facts['mig.engineeringFteMonths']) - kb.reference.migrationFteMonthsReplatform))
  })

  it('reports no payback when the cost of the old system is unknown', () => {
    const e = design({ ...scenario('oracle-orders-to-aws'), 'source.legacy_monthly_usd': v(0) })
    expect(e.cost.paybackMonths).toBeNull()
    expect(ids(e)).not.toContain('legacy-run')
  })

  it('reports no payback when the old system stays: extended or retained', () => {
    // Extending keeps the old system, so its running cost is not asked and nothing retires.
    const extend = design({ ...scenario('crm-to-ai-insights'), 'source.legacy_monthly_usd': v(10_000) })
    expect(extend.questions.find((q) => q.question.id === 'source.legacy_monthly_usd')!.active).toBe(false)
    expect(extend.cost.paybackMonths).toBeNull()
    expect(ids(extend)).not.toContain('legacy-run')
    // Retaining keeps the old database for good: its row, the change stream and its bill are permanent.
    const retain = design({ ...scenario('oracle-orders-to-aws'), 'migration.approach': v('retain') })
    expect(retain.facts['migration.approach']).toBe('retain')
    expect(retain.cost.paybackMonths).toBeNull()
    expect(component(retain, 'legacy-run')!.phase).toBeUndefined()
    expect(component(retain, 'legacy-db')!.phase).toBeUndefined()
    expect(component(retain, 'cdc-pipeline')!.phase).toBeUndefined()
  })

  it('keeps the link the permanent change stream runs over in the target design', () => {
    const extendCdc = design({ ...twelveTb, 'project.origin': v('extend_existing'), 'project.addons': v(['analytics']), 'migration.sync': v('cdc') })
    expect(component(extendCdc, 'cdc-pipeline')!.phase).toBeUndefined()
    expect(component(extendCdc, 'hybrid-link')!.phase).toBeUndefined()
    expect(component(design(twelveTb), 'hybrid-link')!.phase).toBe('transition')
  })

  it('reads a home-grown CRM entered on its own from its database and can repurchase it', () => {
    const e = design({ ...scenario('dynamics-crm-to-d365'), 'source.kinds': v(['crm']) })
    expect(e.questions.find((q) => q.question.id === 'migration.approach')!.active).toBe(true)
    expect(e.facts['migration.approach']).toBe('repurchase')
    expect(component(e, 'crm-target')).toBeDefined()
    // Its database is the source: change capture or a bulk copy, never API extraction that nothing implements.
    expect(ids(e)).toContain('legacy-db')
    expect(ids(e)).not.toContain('api-extractor')
    expect(e.facts['migration.sync']).not.toBe('api_extract')
    const data = e.architecture.edges.filter((x) => x.protocol !== 'telemetry').map((x) => `${x.from}->${x.to}`)
    expect(data).toContain('legacy-crm->legacy-db')
    expect(data.some((x) => x.startsWith('legacy-db->'))).toBe(true)
  })

  it('flags active-active regions on a single-primary SQL Server or Oracle', () => {
    for (const engine of ['sqlserver', 'oracle']) {
      const e = design({ ...scenario('video-streaming'), 'reliability.multi_region': v('active_active'), 'data.primary_db': v(engine), 'data.replication': v('primary_replicas') })
      expect(findings(e), engine).toContain('active-active-single-primary')
    }
  })

  it('builds on existing CRM data without loading it into the operational database', () => {
    // A managed vector store keeps the embedded record text (workload corpusTokens) out of the primary, so only the copy is compared.
    const base = { ...scenario('crm-to-ai-insights'), 'ai.vector_store': v('managed') }
    const small = design({ ...base, 'source.volume_gb': v(10) })
    const large = design({ ...base, 'source.volume_gb': v(100_000) })
    expect(large.workload.dbStorageGb).toBeCloseTo(small.workload.dbStorageGb)
    expect(large.workload.lakeStorageTb).toBeGreaterThan(small.workload.lakeStorageTb + 90)
    expect(component(large, 'landing-zone')!.monthlyCost).toBeGreaterThan(component(small, 'landing-zone')!.monthlyCost)
    // The extraction runs for good, so it is steady-state cost, and the existing CRM stays in the target view.
    expect(component(small, 'api-extractor')!.phase).toBeUndefined()
    expect(component(small, 'landing-zone')!.phase).toBeUndefined()
    expect(component(small, 'legacy-crm')!.phase).toBeUndefined()
    const flows = small.architecture.edges.map((x) => `${x.from}->${x.to}`)
    expect(flows).toEqual(expect.arrayContaining(['legacy-crm->api-extractor', 'api-extractor->landing-zone', 'landing-zone->warehouse']))
    // The extracted records land in the warehouse, so reconciliation checks them there, not in the app's own database.
    expect(flows).toContain('reconciliation-job->warehouse')
    expect(flows).not.toContain('reconciliation-job->db-primary')
    // Poor data adds reconciliation; the old CRM stays, so there are no months of running both. Two SaaS sources share a managed connector.
    expect(component(small, 'reconciliation-job')).toBeDefined()
    expect(small.facts['migration.coexistMonths']).toBe(0)
    expect(component(small, 'api-extractor')!.tech).toBe('Fivetran managed connector')
    expect(findings(small)).toEqual(expect.arrayContaining(['crm-duplicates', 'extend-freshness']))
    expect(findings(design({ ...base, 'security.compliance': v(['gdpr']) }))).toContain('pii-staging')
  })

  it('bills a repurchased CRM per seat', () => {
    const e = design(scenario('dynamics-crm-to-d365'))
    expect(e.facts['migration.approach']).toBe('repurchase')
    const crm = component(e, 'crm-target')!
    expect(crm.tech).toBe('Dynamics 365 Sales Enterprise')
    expect(crm.monthlyCost).toBe(200 * 105)
    expect(crm.costKind).toBe('license')
    // The CRM's records move into the SaaS product, not into the new application's database.
    const flows = e.architecture.edges.map((x) => `${x.from}->${x.to}`)
    expect(flows).toContain('bulk-loader->crm-target')
    expect(flows).not.toContain('bulk-loader->db-primary')
    expect(e.workload.dbStorageGb).toBeLessThan(50)
    expect(component(design({ ...scenario('dynamics-crm-to-d365'), 'migration.crm_target': v('salesforce'), 'source.crm_users': v(50) }), 'crm-target')!.monthlyCost).toBe(50 * 165)
  })

  it('keeps the recommended CRM on every provider, so the provider comparison is not a seat-price swap', () => {
    const { 'migration.crm_target': _, ...pending } = scenario('dynamics-crm-to-d365')
    for (const platforms of [[], ['m365']])
      for (const team of ['small', 'multi']) {
        const rows = compareOver(kb, { ...pending, 'org.existing_platforms': v(platforms), 'team.size': v(team) }, 'infra.cloud')
        const crm = new Set(rows.map((r) => r.evaluation.facts['migration.crm_target']))
        const seats = new Set(rows.map((r) => component(r.evaluation, 'crm-target')!.monthlyCost))
        expect([...crm], `${platforms} ${team}`).toHaveLength(1)
        expect([...seats], `${platforms} ${team}`).toHaveLength(1)
      }
  })

  it('keeps the source engine on a replatform and converts it on a refactor', () => {
    const sqlserver = design(scenario('sqlserver-crm-to-azure'))
    expect(sqlserver.facts['migration.approach']).toBe('replatform')
    expect(sqlserver.facts['data.primary_db']).toBe('sqlserver')
    const db = component(sqlserver, 'db-primary')!
    expect(db.tech).toBe('Azure SQL Managed Instance')
    expect(db.costKind).toBe('license')
    // A small source still pays the smallest license-included SKU (SQL MI General Purpose, 4 vCores): about $700, against $1,300 x 0.4 at the medium class.
    expect(db.instanceClass).toBe('medium')
    expect(db.unitCost).toBeCloseTo(700)
    expect(db.sizingNote).toContain('smallest license-included SKU')
    // Above the floor, a full node bills the whole license-included list price.
    const large = component(design({ ...scenario('sqlserver-crm-to-azure'), 'source.measured_peak_qps': v(2_000) }), 'db-primary')!
    expect(large.instanceClass).toBe('large')
    expect(large.unitCost).toBeCloseTo(1_300)
    expect(large.sizingNote).not.toContain('smallest license-included SKU')
    const oracle = design(scenario('oracle-orders-to-aws'))
    expect(oracle.facts['migration.approach']).toBe('refactor')
    expect(oracle.facts['data.primary_db']).toBe('postgres')
    // Converting heavy database code is the largest engineering line: 12 FTE-months at the loaded FTE cost.
    const heavy = design({ ...scenario('oracle-orders-to-aws'), 'source.code_in_db': v('heavy'), 'migration.approach': v('refactor') })
    expect(findings(heavy)).toContain('refactor-heavy-code')
    expect(component(heavy, 'migration-engineering')!.monthlyCost).toBe(12 * kb.reference.opsFteMonthlyUsd)
    expect(component(design({ ...scenario('oracle-orders-to-aws'), 'migration.approach': v('rehost') }), 'migration-engineering')!.monthlyCost).toBe(kb.reference.opsFteMonthlyUsd)
    expect(findings(design({ ...scenario('oracle-orders-to-aws'), 'migration.approach': v('rehost') }))).toEqual(expect.arrayContaining(['license-carryover', 'oracle-license-carry']))
  })

  it('draws the old systems behind the new design and connects them to the migration flows', () => {
    const e = design({ ...scenario('sqlserver-crm-to-azure'), 'team.size': v('multi') })
    for (const id of ['legacy-db', 'legacy-app', 'legacy-crm', 'legacy-run']) {
      expect(component(e, id)!.def.tier, id).toBe('legacy')
      expect(component(e, id)!.phase, id).toBe('transition')
      expect(component(e, id)!.monthlyCost, id).toBe(id === 'legacy-run' ? 8_000 : 0)
    }
    const log = e.architecture.edges.find((x) => x.from === 'legacy-db' && x.to === 'cdc-pipeline')!
    expect([log.label, log.protocol]).toEqual(['Transaction log', 'cdc'])
    expect(log.qps).toBeCloseTo(Number(e.facts['mig.cdcChangesQps']))
    const flows = e.architecture.edges.map((x) => `${x.from}->${x.to}:${x.label}`)
    expect(flows).toEqual(expect.arrayContaining(['api-gateway->legacy-app:Routes not yet migrated', 'legacy-app->legacy-db:Reads and writes', 'legacy-db->bulk-loader:Export (dump or full load)']))
    expect(findings(e)).toEqual(expect.arrayContaining(['transition-over-budget', 'strangler-legacy-availability']))
    expect(findings(design({ ...scenario('oracle-orders-to-aws'), 'migration.coexistence_months': v(18) }))).toContain('coexistence-long')
  })
})

describe('migration review fixes', () => {
  const component = (e: Evaluation, id: string) => e.architecture.components.find((c) => c.def.id === id)
  const active = (e: Evaluation, id: string) => e.questions.find((q) => q.question.id === id)!.active

  it('moves no data on a fresh start: no link, loader or change stream, and a plan without a load', () => {
    const fresh = { ...scenario('oracle-orders-to-aws'), 'source.history': v('none') }
    for (const answers of [fresh, { ...fresh, 'migration.link': v('dedicated_1g'), 'migration.sync': v('cdc') }]) {
      const e = design(answers)
      expect(ids(e).filter((id) => ['hybrid-link', 'bulk-loader', 'cdc-pipeline', 'transfer-fees', 'source-egress'].includes(id))).toEqual([])
      for (const id of ['migration.link', 'migration.sync', 'migration.downtime']) expect(active(e, id), id).toBe(false)
      const plan = migrationMarkdown(e)
      expect(plan).toContain('No data moves; keep the old system read-only until retirement.')
      expect(plan).toContain('none (fresh start)')
      for (const text of ['Export and load the full copy', 'Initial load', 'Two trial migrations']) expect(plan).not.toContain(text)
    }
  })

  it('streams CDC changes over a VPN after an offline device load of a large database', () => {
    // A device wins only past about 740 TB, where even 10 Gbps takes longer than its 10 days door to door.
    for (const gb of [1_000_000, 2_000_000]) {
      const { 'migration.link': _link, ...pending } = scenario('oracle-orders-to-aws')
      const e = design({ ...pending, 'source.volume_gb': v(gb) })
      expect(e.facts['migration.link'], String(gb)).toBe('offline_device')
      expect(e.facts['migration.sync'], String(gb)).toBe('cdc')
      expect(component(e, 'hybrid-link')!.tech, String(gb)).toBe('AWS Site-to-Site VPN')
      expect(component(e, 'hybrid-link')!.monthlyCost).toBe(40)
      expect(component(e, 'hybrid-link')!.phase).toBe('transition')
    }
  })

  it('offers repurchase only where a SaaS target prices it, and keeps the data in the database otherwise', () => {
    const database = { ...twelveTb, 'source.volume_gb': v(2_000) }
    const app = { ...database, 'project.origin': v('replace_legacy_app'), 'source.kinds': v(['legacy_app', 'rdbms']) }
    for (const answers of [database, app]) {
      const option = recommendation(design(answers), 'migration.approach').scores.find((x) => x.optionId === 'repurchase')!
      expect(option.feasible).toBe(false)
      // A repurchase forced anyway keeps the migrated volume, since no SaaS product takes it.
      const forced = design({ ...answers, 'migration.approach': v('repurchase') })
      expect(forced.workload.dbStorageGb).toBeCloseTo(design({ ...answers, 'migration.approach': v('replatform') }).workload.dbStorageGb)
    }
    expect(recommendation(design(scenario('dynamics-crm-to-d365')), 'migration.approach').scores.find((x) => x.optionId === 'repurchase')!.feasible).toBe(true)
  })

  it('has no coexistence or transition budget warning when building on existing data', () => {
    const e = design(scenario('crm-to-ai-insights'))
    for (const id of ['migration.strategy', 'migration.downtime', 'migration.coexistence_months']) expect(active(e, id), id).toBe(false)
    expect(e.facts['migration.coexistMonths']).toBe(0)
    expect(e.cost.transitionTotal).toBeCloseTo(e.cost.oneTime)
    const tight = design({ ...scenario('crm-to-ai-insights'), 'infra.budget': v(Math.max(100, Math.round(e.cost.monthly * 0.9))) })
    expect(findings(tight)).toContain('over-budget')
    expect(findings(tight)).not.toContain('transition-over-budget')
  })

  it('warns about running both systems only when the transition lines push a replacement over budget', () => {
    const tiny = (id: string) => design({ ...scenario(id), 'infra.budget': v(100) })
    for (const id of ['ecommerce', 'chat-app', 'oracle-orders-to-aws']) {
      expect(findings(tiny(id)), id).toContain('over-budget')
      expect(findings(tiny(id)), id).not.toContain('transition-over-budget')
    }
    const e = design(scenario('oracle-orders-to-aws'))
    const between = design({ ...scenario('oracle-orders-to-aws'), 'infra.budget': v(Math.round(e.cost.monthly + e.cost.transitionMonthly / 2)) })
    expect(findings(between)).not.toContain('over-budget')
    const warning = between.findings.find((x) => x.rule.id === 'transition-over-budget')!
    expect(warning.rule.message).toContain(`$${fmt(e.cost.transitionMonthly)}`)
  })

  it('tells a migration that the Oracle license carries forward and a new build that Oracle adds one', () => {
    const kept = design({ ...scenario('oracle-orders-to-aws'), 'migration.approach': v('rehost') })
    expect(kept.facts['data.primary_db']).toBe('oracle')
    expect(findings(kept)).toContain('oracle-license-carry')
    expect(findings(kept)).not.toContain('oracle-license-new')
    const fresh = design({ ...scenario('url-shortener'), 'data.primary_db': v('oracle') })
    expect(fresh.facts['data.primary_db']).toBe('oracle')
    expect(findings(fresh)).not.toContain('oracle-license-carry')
    expect(findings(fresh)).toContain('oracle-license-new')
  })

  it('reads a database move described in plain words as a database migration', () => {
    expect(suggestFromDescription(kb, 'Move our Oracle database to Azure')['project.origin']).toEqual(v('migrate_database'))
    expect(suggestFromDescription(kb, 'Moving the SQL Server db to AWS')['project.origin']).toEqual(v('migrate_database'))
    expect(suggestFromDescription(kb, 'Migrate our old CRM to Dynamics')['project.origin']).toEqual(v('replace_legacy_app'))
    // The verb alone, without a database word, suggests nothing.
    expect(suggestFromDescription(kb, 'Move fast and ship a marketplace')['project.origin']).toBeUndefined()
    expect(suggestFromDescription(kb, 'A new marketplace; we will move fast with a MySQL database')['project.origin']).toBeUndefined()
    // A plain move is a weak signal: an explicit word for another origin outranks it.
    const origin = (t: string) => suggestFromDescription(kb, t)['project.origin']
    expect(origin('Modernize the app and move its Postgres database to AWS')).toEqual(v('modernize_app'))
    expect(origin('Replace the old CRM and move its SQL Server database to Azure')).toEqual(v('replace_legacy_app'))
    expect(origin('Move the legacy mainframe and its DB2 database to AWS')).toEqual(v('replace_legacy_app'))
    expect(origin('Build analytics on our existing Oracle database, moving data to a lake')).toEqual(v('extend_existing'))
    expect(origin('Replatform the ERP and move the Oracle db')).toEqual(v('modernize_app'))
  })
})

describe('cost model review fixes', () => {
  const component = (e: Evaluation, id: string) => e.architecture.components.find((c) => c.def.id === id)!
  const ref = kb.reference

  it('prices a move to another engine as a conversion, whatever the approach answer', () => {
    const base = scenario('sqlserver-crm-to-azure')
    const keep = design(base)
    const convert = design({ ...base, 'data.primary_db': v('postgres') })
    expect(convert.facts['migration.approach']).toBe('replatform')
    expect(convert.facts['source.code_in_db']).toBe('heavy')
    expect(findings(convert)).toContain('db-code-conversion')
    expect(Number(convert.facts['mig.engineeringFteMonths']) - Number(keep.facts['mig.engineeringFteMonths'])).toBe(ref.migrationFteMonthsRefactorHeavy - ref.migrationFteMonthsReplatform)
    expect(convert.facts['mig.engineeringFteMonths']).toBe(design({ ...base, 'data.primary_db': v('postgres'), 'migration.approach': v('refactor') }).facts['mig.engineeringFteMonths'])
  })

  it('discounts platform capacity sold under its own commitment and prices it by region', () => {
    const fabric = (answers: Answers) => design({ ...scenario('fabric-bi-azure'), ...answers })
    const onDemand = fabric({})
    const reserved = fabric({ 'infra.commitment': v('commit_1y') })
    expect(component(reserved, 'warehouse').monthlyCost).toBeCloseTo(0.59 * component(onDemand, 'warehouse').monthlyCost)
    expect(component(fabric({ 'infra.region': v('sa_east') }), 'warehouse').monthlyCost).toBeCloseTo(1.55 * component(onDemand, 'warehouse').monthlyCost)
    expect(component(fabric({ 'infra.region': v('sa_east') }), 'lake-storage').monthlyCost).toBeCloseTo(1.55 * component(onDemand, 'lake-storage').monthlyCost)
    // The capacity counts toward the commitment opportunity.
    expect(Number(onDemand.facts['cost.instanceMonthly'])).toBeGreaterThanOrEqual(component(onDemand, 'warehouse').monthlyCost)
    const reporting = { ...scenario('databricks-ml-aws'), 'product.features': v(['accounts', 'ml', 'analytics']) }
    const databricks = design({ ...reporting, 'infra.commitment': v('commit_3y') })
    expect(component(databricks, 'warehouse').monthlyCost).toBeCloseTo(0.75 * component(design(reporting), 'warehouse').monthlyCost)
  })

  it('charges staff for a self-run lakehouse, and none for a compute platform no process runs on', () => {
    const fabric = (answers: Answers) => design({ ...scenario('fabric-bi-azure'), ...answers })
    const saas = fabric({})
    expect(saas.facts['profile.requestPath']).toBe(false)
    expect(fabric({ 'infra.compute': v('kubernetes') }).cost.people).toBe(saas.cost.people)
    expect(fabric({ 'data.platform': v('oss_lakehouse') }).cost.people - saas.cost.people).toBe(ref.opsFteMonthlyUsd)
    // An application on Kubernetes still carries its cluster's staff.
    const app = scenario('oracle-orders-to-aws')
    expect(design({ ...app, 'infra.compute': v('kubernetes') }).cost.people).toBeGreaterThan(design(app).cost.people)
  })

  it('keeps the analytics platform in one region when the application runs in two', () => {
    const peer = (tb: number) => component(design({ ...scenario('databricks-ml-aws'), 'reliability.multi_region': v('active_active'), 'data.history_tb': v(tb) }), 'peer-region').monthlyCost
    expect(peer(300)).toBeCloseTo(peer(30))
  })

  it('adds the transition months to the headline totals and ranks levers on the 3-year total', () => {
    const strategy = (id: string) => design({ ...scenario('oracle-orders-to-aws'), 'migration.strategy': v(id) })
    const totals = ['big_bang', 'phased', 'strangler'].map((id) => horizonCost(strategy(id), 12))
    expect(totals[0]).toBeLessThan(totals[1])
    expect(totals[1]).toBeLessThan(totals[2])
    const strangler = strategy('strangler')
    expect(horizonCost(strangler, 12)).toBeCloseTo(strangler.cost.oneTime + 12 * runAndPeople(strangler) + 12 * strangler.cost.transitionMonthly)
    const answers = autoComplete(kb, scenario('sqlserver-crm-to-azure'))
    const base = evaluate(kb, answers)
    const levers = costLevers(kb, answers, base)
    expect(levers.length).toBeGreaterThan(0)
    for (const [i, l] of levers.entries()) {
      expect(l.horizonDelta).toBeCloseTo(horizonCost(l.evaluation, LEVER_HORIZON_MONTHS) - horizonCost(base, LEVER_HORIZON_MONTHS))
      expect(l.horizonDelta).toBeLessThan(0)
      expect(l.upfrontDelta).toBeCloseTo(l.horizonDelta - LEVER_HORIZON_MONTHS * l.delta)
      if (i > 0) expect(levers[i - 1].horizonDelta).toBeLessThanOrEqual(l.horizonDelta)
    }
    // A shorter strategy saves transition months without changing the monthly run.
    const strategyLever = levers.find((l) => l.question.id === 'migration.strategy')!
    expect(strategyLever.delta).toBeCloseTo(0)
    expect(strategyLever.upfrontDelta).toBeLessThan(0)
  })

  it('runs the old system until sign-off when it stays live as the rollback path', () => {
    const rollback = (id: string, strategy = 'big_bang') => design({ ...scenario('oracle-orders-to-aws'), 'migration.strategy': v(strategy), 'migration.rollback': v(id) })
    const restore = rollback('restore_backup')
    const live = rollback('keep_parallel')
    expect(Number(live.facts['migration.coexistMonths']) - Number(restore.facts['migration.coexistMonths'])).toBe(1)
    expect(live.cost.transitionTotal - restore.cost.transitionTotal).toBeCloseTo(restore.cost.monthly + restore.cost.transitionMonthly)
    // A parallel run already keeps it live for its months.
    expect(rollback('keep_parallel', 'parallel_run').facts['migration.coexistMonths']).toBe(rollback('restore_backup', 'parallel_run').facts['migration.coexistMonths'])
  })
})

describe('task-type and existing-source review fixes', () => {
  const component = (e: Evaluation, id: string) => e.architecture.components.find((c) => c.def.id === id)
  const active = (e: Evaluation, id: string) => e.questions.find((q) => q.question.id === id)!.active
  const option = (e: Evaluation, question: string, id: string) => recommendation(e, question).scores.find((s) => s.optionId === id)!
  const ref = kb.reference

  it('asks for a compute platform only where application processes run on it', () => {
    const platform = design(scenario('fabric-bi-azure'))
    expect(active(platform, 'infra.compute')).toBe(false)
    expect(platform.facts['infra.compute']).toBeUndefined()
    expect(active(design(scenario('oracle-orders-to-aws')), 'infra.compute')).toBe(true)
  })

  it('sizes a data platform migration on the source change rate, not on a request rate it does not serve', () => {
    const lake = scenario('sqlserver-dw-to-fabric')
    const base = design(lake)
    expect(active(base, 'source.measured_peak_qps')).toBe(false)
    expect(design({ ...lake, 'source.measured_peak_qps': v(5_000) }).workload.lakeStorageTb).toBeCloseTo(base.workload.lakeStorageTb)
    expect(Number(base.facts['mig.cdcChangesQps'])).toBeCloseTo((2_000_000 / 86_400) * 3)
    const busy = design({ ...lake, 'source.change_rows_day': v(1_000_000_000) })
    expect(component(busy, 'cdc-pipeline')!.units).toBeGreaterThan(component(base, 'cdc-pipeline')!.units)
  })

  it('chooses no target engine for a database loaded into the lake, and sizes the work from its code', () => {
    const lake = scenario('sqlserver-dw-to-fabric')
    const e = design({ ...lake, 'migration.approach': v('rehost') })
    expect(active(e, 'migration.approach')).toBe(false)
    expect(findings(e)).not.toContain('license-carryover')
    const effort = (code: string) => design({ ...lake, 'source.code_in_db': v(code) }).facts['mig.engineeringFteMonths']
    expect([effort('none'), effort('some'), effort('heavy')]).toEqual([ref.migrationFteMonthsDefault, ref.migrationFteMonthsRefactor, ref.migrationFteMonthsRefactorHeavy])
  })

  it('bills a retained system for good and feeds it into the new one instead of copying it once', () => {
    const oracle = { ...scenario('oracle-orders-to-aws'), 'source.volume_gb': v(1_000) }
    const retain = design({ ...oracle, 'migration.approach': v('retain') })
    const replatform = design({ ...oracle, 'migration.approach': v('replatform') })
    const bill = component(retain, 'legacy-run')!
    expect(bill.phase).toBeUndefined()
    expect(retain.cost.monthly).toBeGreaterThan(40_000)
    expect(retain.cost.monthly).toBeGreaterThan(replatform.cost.monthly)
    expect(replatform.workload.dbStorageGb - retain.workload.dbStorageGb).toBeCloseTo(1_000, 0)
    expect(ids(retain)).not.toContain('bulk-loader')
    expect(retain.facts['migration.sync']).toBe('cdc')
    expect(option(retain, 'migration.sync', 'bulk_export').feasible).toBe(false)
    expect(retain.architecture.edges.some((x) => x.from === 'cdc-pipeline' && x.to === 'db-primary' && x.label.startsWith('Permanent'))).toBe(true)
    expect(findings(retain)).not.toContain('db-code-conversion')
  })

  it('keeps MySQL and PostgreSQL engines on a rehost or replatform, and rules both out where no target keeps the engine', () => {
    const base = { 'product.type': v('commerce'), 'project.origin': v('migrate_database'), 'infra.cloud': v('aws'), 'source.kinds': v(['rdbms']), 'source.volume_gb': v(500), 'source.code_in_db': v('heavy') }
    const mysql = (approach: string) => design({ ...base, 'source.rdbms_engine': v('mysql'), 'migration.approach': v(approach) })
    expect(mysql('replatform').facts['data.primary_db']).toBe('mysql')
    expect(mysql('replatform').facts['mig.engineeringFteMonths']).toBe(ref.migrationFteMonthsReplatform)
    expect(component(mysql('rehost'), 'db-primary')!.tech).toBe('MySQL on EC2')
    expect(component(design({ ...base, 'source.rdbms_engine': v('postgres'), 'migration.approach': v('rehost') }), 'db-primary')!.tech).toBe('PostgreSQL on EC2')
    for (const engine of ['db2', 'other']) {
      const e = design({ ...base, 'source.rdbms_engine': v(engine) })
      expect(option(e, 'migration.approach', 'replatform').feasible, engine).toBe(false)
      expect(option(e, 'migration.approach', 'rehost').feasible, engine).toBe(false)
      expect(e.facts['migration.approach'], engine).toBe('refactor')
      expect(e.facts['mig.engineeringFteMonths'], engine).toBe(ref.migrationFteMonthsRefactorHeavy)
    }
  })

  it('keeps a migrated relational database on one instance up to the engine limit, whether it keeps or converts the engine', () => {
    // 12 TB fits one RDS or Aurora instance (64 TiB, 128 TiB), so a converted Oracle schema is not hash-sharded into Aurora Limitless.
    for (const approach of ['replatform', 'refactor']) {
      const e = design({ ...scenario('oracle-orders-to-aws'), 'migration.approach': v(approach) })
      expect(e.facts['migration.loadsRelationalDb'], approach).toBe(true)
      expect(e.facts['data.partitioning'], approach).toBe('vertical')
      expect(component(e, 'db-primary')!.replicas, approach).toBe(1)
      expect(findings(e), approach).not.toContain('vertical-insufficient')
    }
    // Past the engine limit the schema still splits.
    const big = design({ ...scenario('oracle-orders-to-aws'), 'migration.approach': v('refactor'), 'source.volume_gb': v(40_000) })
    expect(component(big, 'db-primary')!.replicas).toBeGreaterThan(1)
  })

  it('asks for the code of a mainframe or warehouse and prices its conversion', () => {
    const mainframe = { 'product.type': v('commerce'), 'project.origin': v('replace_legacy_app'), 'infra.cloud': v('aws'), 'source.kinds': v(['mainframe']), 'source.volume_gb': v(20_000), 'source.legacy_monthly_usd': v(150_000) }
    const mf = (code: string) => design({ ...mainframe, 'source.code_in_db': v(code) })
    expect(active(mf('some'), 'source.code_in_db')).toBe(true)
    expect(mf('some').facts['mig.engineeringFteMonths']).toBe(ref.appRebuildFteMonths + ref.migrationFteMonthsMainframe)
    expect(mf('heavy').facts['mig.engineeringFteMonths']).toBe(ref.appRebuildFteMonths + ref.migrationFteMonthsMainframeHeavy)
    const warehouse = design({ 'project.kind': v('data_platform'), 'project.origin': v('migrate_database'), 'infra.cloud': v('azure'), 'data.platform': v('fabric'), 'source.kinds': v(['warehouse']), 'source.volume_gb': v(50_000), 'source.code_in_db': v('heavy') })
    expect(warehouse.facts['mig.engineeringFteMonths']).toBe(ref.migrationFteMonthsWarehouseHeavy)
    expect(component(warehouse, 'bulk-loader')!.tech).toContain('TPT')
    // A kept mainframe or warehouse (build on existing data) converts no code: the default effort, like a kept Oracle database.
    const kept = (kinds: string[]) => design({ 'project.kind': v('data_platform'), 'project.origin': v('extend_existing'), 'infra.cloud': v('aws'), 'source.kinds': v(kinds), 'source.volume_gb': v(20_000) }).facts['mig.engineeringFteMonths']
    expect(kept(['mainframe'])).toBe(ref.migrationFteMonthsDefault)
    expect(kept(['warehouse'])).toBe(ref.migrationFteMonthsDefault)
  })

  it('switches one SaaS CRM for another without building an application', () => {
    const salesforce = { 'product.type': v('saas'), 'project.origin': v('replace_legacy_app'), 'infra.cloud': v('azure'), 'source.kinds': v(['crm']), 'source.crm_product': v('salesforce'), 'source.legacy_monthly_usd': v(33_000) }
    const e = design(salesforce)
    expect(active(e, 'migration.approach')).toBe(true)
    expect(e.facts['migration.approach']).toBe('repurchase')
    expect(option(e, 'migration.crm_target', 'salesforce').feasible).toBe(false)
    expect(e.facts['migration.crm_target']).not.toBe('salesforce')
    expect(ids(e)).toContain('crm-target')
    expect(ids(e)).not.toContain('app')
    expect(ids(e)).not.toContain('db-primary')
    // Rebuilding it keeps an application of its own.
    expect(ids(design({ ...salesforce, 'migration.approach': v('refactor') }))).toContain('app')
  })
})

describe('existing sources and coexistence', () => {
  const component = (e: Evaluation, id: string) => e.architecture.components.find((c) => c.def.id === id)
  const flows = (e: Evaluation) => e.architecture.edges.map((x) => `${x.from}->${x.to}`)
  const oracle: Answers = { ...twelveTb, 'source.volume_gb': v(2_000) }

  it('draws a SaaS API source with its extractor, landing zone and old-system bill', () => {
    const e = design({ 'product.type': v('saas'), 'project.origin': v('replace_legacy_app'), 'infra.cloud': v('aws'), 'source.kinds': v(['saas_api']), 'source.volume_gb': v(300), 'source.legacy_monthly_usd': v(5_000) })
    expect(ids(e)).toEqual(expect.arrayContaining(['legacy-saas', 'api-extractor', 'landing-zone', 'legacy-run']))
    expect(flows(e)).toEqual(expect.arrayContaining(['legacy-saas->api-extractor', 'api-extractor->landing-zone', 'landing-zone->db-primary']))
    expect(e.cost.transitionMonthly).toBeGreaterThanOrEqual(5_000)
  })

  it('names a CDC tool that reads the source engine and writes the target', () => {
    const cdc = (answers: Answers) => component(design({ ...oracle, 'migration.sync': v('cdc'), ...answers }), 'cdc-pipeline')!.tech
    for (const cloud of ['aws', 'azure', 'gcp', 'onprem']) {
      expect(cdc({ 'infra.cloud': v(cloud), 'source.kinds': v(['mainframe']) }), cloud).toContain('IBM Data Replication')
      expect(cdc({ 'infra.cloud': v(cloud), 'source.rdbms_engine': v('db2') }), cloud).not.toMatch(/Datastream|Azure Database Migration Service/)
    }
    expect(cdc({ 'infra.cloud': v('aws'), 'source.rdbms_engine': v('db2') })).toContain('AWS DMS (Db2 LUW')
    expect(cdc({ 'infra.cloud': v('azure') })).toContain('GoldenGate')
    expect(cdc({ 'infra.cloud': v('azure'), 'source.rdbms_engine': v('sqlserver') })).toContain('Azure Database Migration Service')
    // Building on existing data streams into the lake, which Azure DMS does not target.
    expect(cdc({ 'infra.cloud': v('azure'), 'project.origin': v('extend_existing'), 'project.addons': v(['analytics']) })).toContain('Fabric Mirroring')
    expect(cdc({ 'infra.cloud': v('gcp'), 'project.origin': v('extend_existing'), 'project.addons': v(['analytics']) })).toContain('Datastream to BigQuery')
  })

  it('recommends the transfer link its own copy times favour', () => {
    const link = (gb: number) => design({ ...linkPending, 'source.rdbms_engine': v('postgres'), 'source.volume_gb': v(gb) })
    // 60 TB: about 190 h over 1 Gbps, 19 h over 10 Gbps, 240 h by device.
    const sixty = link(60 * 1024)
    expect(sixty.facts['migration.link']).toBe('dedicated_10g')
    expect(recommendation(sixty, 'migration.link').reasons.join(' ')).not.toContain('device is faster')
    expect(link(1_000_000).facts['migration.link']).toBe('offline_device')
    // File drops carry a Teradata cutover, so the 1 Gbps reason does not claim CDC does.
    const teradata = design({ ...linkPending, 'source.kinds': v(['warehouse']), 'source.volume_gb': v(50 * 1024) })
    expect(teradata.facts['migration.sync']).toBe('file_drop')
    for (const s of recommendation(teradata, 'migration.link').scores) for (const r of s.reasons) expect(r).not.toContain('CDC carries')
  })

  it('keeps the permanent feed of a kept database in the running cost', () => {
    const extend: Answers = { ...linkPending, 'source.volume_gb': v(2_000), 'project.origin': v('extend_existing'), 'project.addons': v(['ai']) }
    // Changes keep flowing from the kept system, so CDC beats a one-off export and is sized on the source's change rate.
    const pending = design(extend)
    expect(pending.facts['migration.sync']).toBe('cdc')
    expect(pending.facts['mig.cdcChangesQps']).toBeCloseTo((1_000_000 / kb.reference.secondsPerDay) * Number(pending.facts['traffic.peakFactor']))
    // No cutover window sizes the permanent link: 2 TB stays on a VPN, not a 10 Gbps port.
    expect(pending.facts['migration.link']).toBe('vpn')
    const drops = design({ ...extend, 'migration.sync': v('file_drop') })
    expect(component(drops, 'bulk-loader')!.phase).toBeUndefined()
    expect(component(drops, 'hybrid-link')!.phase).toBeUndefined()
    expect(drops.cost.transitionMonthly).toBe(0)
  })

  it('archives older history to priced object storage and bills the whole volume leaving the source cloud', () => {
    const e = design({ ...twelveTb, 'source.rdbms_engine': v('postgres'), 'source.volume_gb': v(100_000), 'source.history': v('recent'), 'source.location': v('other_cloud'), 'infra.cloud': v('azure') })
    // The archive is all older than a year, so the lifecycle rule bills it in the cold class.
    expect(e.facts['data.storage_class']).toBe('cold')
    expect(component(e, 'cold-storage')!.monthlyCost).toBeGreaterThan(0)
    expect(flows(e)).toContain('bulk-loader->object-storage')
    expect(flows(e)).toContain('object-storage->cold-storage')
    expect(flows(e)).not.toContain('client->object-storage')
    expect(e.facts['mig.transferGb']).toBe(100_000)
    expect(component(e, 'source-egress')!.monthlyCost).toBeCloseTo(100_000 * 0.09)
  })

  it('syncs both ways and prints a per-route runbook for a strangler migration', () => {
    const answers: Answers = { ...oracle, 'project.origin': v('replace_legacy_app'), 'source.kinds': v(['rdbms', 'legacy_app']), 'source.volume_gb': v(1_500), 'migration.strategy': v('strangler') }
    const e = design(answers)
    expect(e.facts['migration.sync']).toBe('cdc')
    expect(e.facts['migration.rollback']).toBe('reverse_cdc')
    expect(flows(e)).toEqual(expect.arrayContaining(['db-primary->cdc-pipeline', 'cdc-pipeline->legacy-db']))
    const plan = migrationMarkdown(e)
    expect(plan).toContain('Runbook per route:')
    expect(plan).toContain('Keep CDC running both ways')
    expect(plan).not.toContain('Freeze writes on the old system.')
    // Without reverse replication the waves still sync back, and the rollback avoids a snapshot restore.
    const phased = design({ ...answers, 'migration.strategy': v('phased'), 'migration.rollback': v('keep_parallel') })
    expect(flows(phased)).toContain('cdc-pipeline->legacy-db')
    expect(migrationMarkdown(phased)).toContain('Runbook per wave:')
    expect(design({ ...answers, 'migration.strategy': v('phased'), 'migration.sync': v('file_drop') }).facts['migration.rollback']).not.toBe('restore_backup')
  })

  it('feeds a data platform built on an existing database through one pipeline', () => {
    const e = design({ 'product.type': v('internal'), 'project.kind': v('data_platform'), 'project.origin': v('extend_existing'), 'infra.cloud': v('azure'), 'source.kinds': v(['rdbms']), 'source.rdbms_engine': v('oracle'), 'source.volume_gb': v(5_000), 'migration.sync': v('cdc') })
    expect(ids(e)).not.toContain('sources')
    expect(ids(e)).not.toContain('ingestion')
    expect(flows(e)).toEqual(expect.arrayContaining(['legacy-db->cdc-pipeline', 'cdc-pipeline->landing-zone', 'landing-zone->lake-storage', 'orchestrator->cdc-pipeline']))
    expect(e.facts['mig.cdcChangesQps']).toBeGreaterThan(0)
    // Other source systems still come in through the platform's ingestion.
    const more = design({ 'product.type': v('internal'), 'project.kind': v('data_platform'), 'project.origin': v('extend_existing'), 'infra.cloud': v('azure'), 'source.kinds': v(['rdbms']), 'data.source_count': v(4) })
    expect(ids(more)).toEqual(expect.arrayContaining(['sources', 'ingestion']))
  })
})

describe('CRM replacement under residency on own hardware', () => {
  it('rules out a SaaS CRM when data may not leave your hardware', () => {
    for (const residency of ['air_gapped', 'onprem_required']) {
      const e = design({ ...scenario('dynamics-crm-to-d365'), 'security.residency': v(residency), 'org.existing_platforms': v(['datacenter']) })
      expect(e.facts['infra.cloud'], residency).toBe('onprem')
      expect(e.facts['migration.approach'], residency).not.toBe('repurchase')
      expect(recommendation(e, 'migration.approach').scores.find((x) => x.optionId === 'repurchase')!.feasible, residency).toBe(false)
      expect(ids(e), residency).not.toContain('crm-target')
    }
    // Forcing it anyway is reported.
    const forced = design({ ...scenario('dynamics-crm-to-d365'), 'security.residency': v('air_gapped'), 'migration.approach': v('repurchase') })
    expect(findings(forced)).toContain('infeasible-migration.approach')
  })
})

describe('existing sources by kind', () => {
  const component = (e: Evaluation, id: string) => e.architecture.components.find((c) => c.def.id === id)
  const flows = (e: Evaluation) => e.architecture.edges.map((x) => `${x.from}->${x.to}:${x.label}`)
  const kinds = (brief: string) => suggestFromDescription(kb, brief)['source.kinds']
  const oracleAndSalesforce: Answers = {
    'product.type': v('commerce'),
    'project.origin': v('replace_legacy_app'),
    'infra.cloud': v('aws'),
    'source.kinds': v(['rdbms', 'crm']),
    'source.rdbms_engine': v('oracle'),
    'source.crm_product': v('salesforce'),
    'source.volume_gb': v(2_000),
    'migration.approach': v('refactor'),
  }

  it('detects the kind of each existing source in a brief', () => {
    expect(kinds('Replace our legacy mainframe COBOL system with a new app on AWS')).toEqual(v(['mainframe']))
    expect(kinds('Oracle database and SFTP CSV exports')).toEqual(v(['rdbms', 'files']))
    expect(kinds('Replace the legacy HubSpot CRM and Teradata warehouse with a lakehouse')).toEqual(v(['crm', 'warehouse']))
    // A named CRM product selects the CRM kind, so its product question is active and the old CRM is drawn.
    const brief = 'Migrate our home-grown CRM and the Salesforce data to Azure'
    expect(kinds(brief)).toEqual(v(['crm']))
    const e = design(suggestFromDescription(kb, brief))
    expect(e.questions.find((q) => q.question.id === 'source.crm_product')!.active).toBe(true)
    expect(component(e, 'legacy-crm')).toBeDefined()
    expect(component(design(suggestFromDescription(kb, 'Replace our legacy mainframe COBOL system with a new app on AWS')), 'legacy-db')!.tech).not.toBe('SQL Server')
    // Building a warehouse does not list one as an existing source.
    expect(kinds('Build a data warehouse for our sales team')).toBeUndefined()
  })

  it('syncs the database by its own method and extracts the SaaS CRM next to it', () => {
    const e = design(oracleAndSalesforce)
    const api = recommendation(e, 'migration.sync').scores.find((x) => x.optionId === 'api_extract')!
    expect(api.feasible).toBe(false)
    expect(e.facts['migration.sync']).not.toBe('api_extract')
    expect(component(e, 'api-extractor')).toBeDefined()
    expect(flows(e).some((x) => x.startsWith('legacy-db->'))).toBe(true)
    expect(kb.validations.some((r) => r.id === 'saas-crm-sync')).toBe(false)
    // The plan names each source's own method: the CRM's extraction, the database's sync.
    const plan = migrationMarkdown(e)
    const row = (label: string) => plan.split('\n').find((l) => l.startsWith(`| ${label} |`))!
    expect(row('Existing CRM')).toContain(e.questions.find((q) => q.question.id === 'source.crm_extract')!.question.options!.find((o) => o.id === e.facts['source.crm_extract'])!.label)
    expect(row('Existing database')).not.toContain('included above')
    // Files next to a database do not turn the database's sync into file drops.
    expect(design({ ...twelveTb, 'source.kinds': v(['rdbms', 'files']) }).facts['migration.sync']).not.toBe('file_drop')
  })

  it('sizes each kind of source where it lands', () => {
    const answers: Answers = {
      'product.type': v('commerce'),
      'project.origin': v('replace_legacy_app'),
      'project.addons': v(['analytics']),
      'infra.cloud': v('aws'),
      'source.kinds': v(['rdbms', 'legacy_app', 'warehouse']),
      'source.rdbms_engine': v('oracle'),
      'source.volume_gb': v(500),
      'source.file_volume_gb': v(40_000),
    }
    const e = design(answers)
    // The warehouse lands in the lake, not in the Oracle primary; three kinds need at least three connectors.
    expect(e.workload.dbStorageGb).toBeLessThan(1_000)
    expect(e.workload.lakeStorageTb).toBeGreaterThan(39)
    expect(e.workload.sourceCount).toBe(3)
    // The CRM API limits follow the CRM's own volume, not the database's.
    expect(findings(design({ ...oracleAndSalesforce, 'source.crm_volume_gb': v(10), 'source.crm_extract': v('bulk_api') }))).not.toContain('crm-api-limits')
    expect(findings(design({ ...oracleAndSalesforce, 'source.crm_volume_gb': v(200), 'source.crm_extract': v('bulk_api') }))).toContain('crm-api-limits')
  })

  it('bills a bought CRM\'s storage beyond its allowance', () => {
    const e = design(scenario('dynamics-crm-to-d365'))
    // 300 GB against 10 GB plus 250 MB for each of 200 licences, at about $40 per GB-month.
    expect(e.facts['mig.crmExtraStorageGb']).toBeCloseTo(240, 5)
    expect(component(e, 'crm-storage')!.monthlyCost).toBeCloseTo(240 * 40, 0)
    expect(component(design({ ...scenario('dynamics-crm-to-d365'), 'source.history': v('recent') }), 'crm-storage')!.monthlyCost).toBeCloseTo((300 * 0.3 - 60) * 40, 0)
    expect(component(design({ ...scenario('dynamics-crm-to-d365'), 'migration.crm_target': v('hubspot') }), 'crm-storage')).toBeUndefined()
  })

  it('loads a bought CRM through its import APIs and rolls back by keeping the old CRM live', () => {
    const e = design({ ...scenario('dynamics-crm-to-d365'), 'migration.strategy': v('phased'), 'migration.downtime': v('minutes') })
    const sync = recommendation(e, 'migration.sync').scores
    expect(sync.find((x) => x.optionId === 'cdc')!.feasible).toBe(false)
    expect(recommendation(e, 'migration.rollback').scores.find((x) => x.optionId === 'reverse_cdc')!.feasible).toBe(false)
    expect(e.facts['migration.rollback']).toBe('keep_parallel')
    expect(component(e, 'cdc-pipeline')).toBeUndefined()
    expect(component(e, 'bulk-loader')!.tech).toBe('Dataverse Web API bulk import (ExecuteMultiple) or a Dataverse connector')
    expect(flows(e)).not.toContain('db-primary->cdc-pipeline:Reverse replication for rollback')
    // The copy is paced by the import APIs, not the link.
    expect(Number(e.facts['mig.bulkHours'])).toBeGreaterThanOrEqual(300 / kb.reference.saasCrmImportGbPerHour)
  })

  it('copies inside one data center over the local network', () => {
    const answers: Answers = { ...twelveTb, 'infra.cloud': v('onprem'), 'source.location': v('onprem_dc') }
    delete answers['migration.link']
    const e = design(answers)
    expect(e.facts['migration.link']).toBe('same_cloud')
    expect(component(e, 'hybrid-link')).toBeUndefined()
    expect(recommendation(design({ ...answers, 'infra.cloud': v('aws') }), 'migration.link').scores.find((x) => x.optionId === 'same_cloud')!.feasible).toBe(false)
  })

  it('never ships a device to a source in another cloud', () => {
    const answers: Answers = { ...twelveTb, 'source.location': v('other_cloud'), 'source.kinds': v(['rdbms']), 'source.rdbms_engine': v('mysql'), 'source.volume_gb': v(100_000), 'migration.downtime': v('weekend') }
    delete answers['migration.link']
    const e = design(answers)
    expect(recommendation(e, 'migration.link').scores.find((x) => x.optionId === 'offline_device')!.feasible).toBe(false)
    expect(e.facts['migration.link']).not.toBe('offline_device')
    expect(component(e, 'transfer-fees')).toBeUndefined()
    // Past the device's crossover the network path is the 10 Gbps interconnect, not the default VPN.
    const petabyte = design({ ...answers, 'source.volume_gb': v(1_200_000) })
    expect(petabyte.facts['migration.link']).toBe('dedicated_10g')
    expect(findings(petabyte)).not.toContain('transfer-weeks')
  })

  it('scores links on their own copy times, so an import floor or a forced bulk export picks no faster port', () => {
    // A repurchased CRM imports no faster than the SaaS import APIs, so every link takes the same time and the VPN stays.
    for (const gb of [300, 1_000, 2_000]) {
      const e = design({ ...scenario('dynamics-crm-to-d365'), 'source.volume_gb': v(gb) })
      expect(e.questions.find((q) => q.question.id === 'migration.link')!.active, String(gb)).toBe(true)
      expect(e.facts['mig.speedup1gOverVpn'], String(gb)).toBe(1)
      expect(e.facts['migration.link'], String(gb)).toBe('vpn')
    }
    // A forced bulk export does not get the 'history loads before cutover' reason.
    const bulk = design({ ...linkPending, 'source.volume_gb': v(5 * 1024), 'migration.strategy': v('phased'), 'migration.sync': v('bulk_export') })
    for (const sc of recommendation(bulk, 'migration.link').scores) for (const r of sc.reasons) expect(r).not.toContain('history loads before cutover')
  })

  it('counts the archived history\'s link time before cutover and in the week check', () => {
    const e = design({ ...twelveTb, 'source.rdbms_engine': v('postgres'), 'source.volume_gb': v(100 * 1024), 'source.history': v('recent'), 'migration.link': v('dedicated_1g') })
    const archive = Number(e.facts['mig.archiveHours'])
    // 70% of 100 TB to object storage over 1 Gbps at 70% efficiency.
    expect(archive).toBeCloseTo((0.7 * 100 * 1024 * 1000) / ((1 * kb.reference.transferEfficiency * 1000) / 8) / 3600, 5)
    expect(e.facts['mig.transferHours']).toBeCloseTo(Number(e.facts['mig.bulkHours']) + archive)
    expect(e.facts['mig.archiveDays']).toBe(Math.ceil(archive / 24))
    expect(findings(e)).toContain('transfer-weeks')
    expect(migrationMarkdown(e)).toContain('Archive older history to object storage')
    // History kept whole archives nothing.
    expect(design({ ...twelveTb, 'source.history': v('all') }).facts['mig.archiveHours']).toBe(0)
  })
})

describe('existing data on a data platform', () => {
  it('lets the kept system\'s sync carry a sole existing source, with no second ingestion path or question', () => {
    const kept: Answers = { 'project.kind': v('data_platform'), 'project.origin': v('extend_existing'), 'infra.cloud': v('azure'), 'source.kinds': v(['rdbms']), 'source.rdbms_engine': v('oracle'), 'source.volume_gb': v(5 * 1024), 'migration.sync': v('cdc'), 'data.source_count': v(1) }
    const e = design(kept)
    expect(ids(e)).toEqual(expect.arrayContaining(['legacy-db', 'cdc-pipeline']))
    for (const id of ['sources', 'ingestion']) expect(ids(e), id).not.toContain(id)
    expect(e.questions.find((q) => q.question.id === 'data.ingestion')!.active).toBe(false)
    // A fresh start moves nothing from the kept system, so the platform keeps its own sources and ingestion.
    const fresh = design({ ...kept, 'source.history': v('none') })
    expect(ids(fresh)).toEqual(expect.arrayContaining(['sources', 'ingestion']))
    expect(fresh.questions.find((q) => q.question.id === 'data.ingestion')!.active).toBe(true)
  })

  it('counts the migrated source in the lake once and asks only for other existing data', () => {
    const e = design({ 'project.kind': v('data_platform'), 'project.origin': v('extend_existing'), 'source.kinds': v(['database']), 'source.volume_gb': v(20_480), 'data.growth_pct': v(0) })
    // The 20 TB source is in the lake already, with data.history_tb at its default of 0.
    expect(e.facts['data.history_tb']).toBe(0)
    expect(Number(e.workload.lakeStorageTb)).toBeGreaterThanOrEqual(20)
    const history = kb.questions.find((q) => q.id === 'data.history_tb')!
    expect(history.prompt).toContain('not entered as a migration source')
    expect(history.help).toContain('count each dataset once')
  })
})

describe('origin and target engine', () => {
  const answers = (origin: string): Answers => ({ 'project.kind': v('transactional_app'), 'project.origin': v(origin), 'team.size': v('multi') })

  it('takes over the application when replacing or modernizing it, not when moving only a database', () => {
    const database = design(answers('migrate_database'))
    const replace = design(answers('replace_legacy_app'))
    const modernize = design(answers('modernize_app'))
    expect(database.facts['source.kinds']).toEqual(['rdbms'])
    for (const e of [replace, modernize]) {
      expect(e.facts['source.kinds']).toEqual(['rdbms', 'legacy_app'])
      expect(ids(e)).toContain('legacy-app')
      expect(e.facts['migration.strategy']).toBe('strangler')
    }
    expect(database.facts['migration.strategy']).toBe('big_bang')
    // Replacing rebuilds the application; modernizing keeps its code on the same engine.
    expect(replace.cost.oneTime).toBeGreaterThan(modernize.cost.oneTime)
    expect(recommendation(modernize, 'migration.approach').reasons.join(' ')).toContain('Modernizing keeps')
    expect(recommendation(replace, 'migration.approach').scores.find((s) => s.optionId === 'refactor')!.reasons.join(' ')).toContain('rebuilt anyway')
  })

  it('keeps a relational source on a relational engine and flags a NoSQL target', () => {
    const source: Answers = { 'project.origin': v('migrate_database'), 'source.kinds': v(['rdbms']), 'source.rdbms_engine': v('postgres'), 'product.type': v('messaging') }
    const kept = design({ ...source, 'migration.approach': v('replatform') })
    expect(kept.facts['data.model']).toBe('relational')
    expect(kept.facts['data.sql']).toBe(true)
    expect(findings(kept)).not.toContain('relational-source-nosql-target')
    const nosql = design({ ...source, 'migration.approach': v('refactor'), 'data.model': v('wide_column') })
    expect(nosql.facts['data.sql']).toBe(false)
    expect(findings(nosql)).toContain('relational-source-nosql-target')
    // A new build of the same product still picks its store from the access pattern.
    expect(design({ 'product.type': v('messaging'), 'traffic.dau': v(5_000_000) }).facts['data.model']).toBe('wide_column')
  })
})

describe('sources, transfer rate and coexistence', () => {
  const component = (e: Evaluation, id: string) => e.architecture.components.find((c) => c.def.id === id)
  const edgeIds = (e: Evaluation) => e.architecture.edges.map((x) => `${x.from}->${x.to}`)
  const active = (e: Evaluation, id: string) => e.questions.find((q) => q.question.id === id)!.active
  const cdcScore = (e: Evaluation) => recommendation(e, 'migration.sync').scores.find((s) => s.optionId === 'cdc')!

  it('reads a legacy application entered on its own from its database', () => {
    const e = design({ 'product.type': v('internal'), 'project.origin': v('replace_legacy_app'), 'infra.cloud': v('aws'), 'source.kinds': v(['legacy_app']), 'source.volume_gb': v(20_000) })
    expect(e.facts['source.database']).toBe(true)
    expect(ids(e)).toEqual(expect.arrayContaining(['legacy-app', 'legacy-db']))
    expect(edgeIds(e)).toEqual(expect.arrayContaining(['legacy-app->legacy-db', 'legacy-db->bulk-loader']))
    for (const id of ['source.rdbms_engine', 'source.code_in_db']) expect(active(e, id), id).toBe(true)
    expect(cdcScore(e).feasible).toBe(true)
    // A warehouse has no transaction log, and the reason says so instead of blaming a SaaS CRM.
    const warehouse = design({ 'product.type': v('internal'), 'project.origin': v('replace_legacy_app'), 'source.kinds': v(['warehouse']), 'source.volume_gb': v(5_000) })
    expect(cdcScore(warehouse).feasible).toBe(false)
    expect(cdcScore(warehouse).infeasibleReason).toContain('warehouses and files are exported in batches')
  })

  it('caps a bulk copy at the target load rate and sizes the loader fleet to it', () => {
    const sqlServer = (gb: number, extra: Answers = {}) =>
      design({ 'product.type': v('commerce'), 'project.origin': v('migrate_database'), 'infra.cloud': v('aws'), 'source.kinds': v(['rdbms']), 'source.rdbms_engine': v('sqlserver'), 'source.volume_gb': v(gb), 'migration.downtime': v('overnight'), ...extra })
    // 15 TB at 400 MB/s takes about 10 h, plus validation: no link fits an 8 h window, so CDC loads beforehand over 1 Gbps.
    const large = sqlServer(15_000)
    expect(Number(large.facts['mig.cutoverRatio10g'])).toBeGreaterThan(1)
    expect(large.facts['migration.sync']).toBe('cdc')
    expect(large.facts['migration.link']).toBe('dedicated_1g')
    // A forced 10 Gbps bulk copy runs four loader nodes and overruns the window.
    const forced = sqlServer(15_000, { 'migration.link': v('dedicated_10g'), 'migration.sync': v('bulk_export') })
    expect(forced.facts['mig.loaderNodes']).toBe(kb.reference.bulkLoadMaxMBps / kb.reference.loaderNodeMBps)
    expect(component(forced, 'bulk-loader')!.monthlyCost).toBe(4 * 70)
    expect(findings(forced)).toContain('bigbang-window')
    expect(sqlServer(2_000, { 'migration.link': v('dedicated_1g') }).facts['mig.loaderNodes']).toBe(1)
  })

  it('buys no fast link for a parallel run, whose history loads before the run starts', () => {
    const e = design({ 'product.type': v('fintech'), 'project.origin': v('migrate_database'), 'infra.cloud': v('aws'), 'source.kinds': v(['rdbms']), 'source.rdbms_engine': v('oracle'), 'source.volume_gb': v(2_000), 'source.legacy_monthly_usd': v(50_000) })
    expect(e.facts['migration.strategy']).toBe('parallel_run')
    expect(e.facts['migration.link']).not.toBe('dedicated_10g')
    expect(recommendation(e, 'migration.link').scores.find((s) => s.optionId === 'dedicated_10g')!.reasons).toEqual([])
  })

  it('mirrors the inputs of a parallel run to both systems and loads the history only once', () => {
    const e = design({ 'product.type': v('fintech'), 'project.origin': v('migrate_database'), 'infra.cloud': v('aws'), 'source.kinds': v(['rdbms']), 'source.rdbms_engine': v('oracle'), 'source.volume_gb': v(2_000), 'migration.strategy': v('parallel_run'), 'migration.sync': v('cdc') })
    expect(component(e, 'request-mirror')!.phase).toBe('transition')
    expect(edgeIds(e)).toEqual(expect.arrayContaining(['lb->request-mirror', 'request-mirror->legacy-db']))
    const cdcEdges = e.architecture.edges.filter((x) => x.from === 'cdc-pipeline' && x.to === 'db-primary').map((x) => x.id.split(':')[0])
    expect(cdcEdges).toEqual(['cdc-initial-load'])
    // The months of coexistence give CDC no bonus in a parallel run, as they do for waves.
    expect(cdcScore(e).reasons.join(' ')).not.toContain('changes must flow continuously')
    const plan = migrationMarkdown(e)
    expect(plan).toContain('Stop the change stream and, at the same point, start mirroring every input to both systems')
    expect(plan).not.toContain('Freeze writes')
    expect(plan).not.toContain('Wait until the CDC lag is 0.')
    // A single cutover mirrors nothing.
    const big = design({ ...scenario('oracle-orders-to-aws'), 'migration.strategy': v('big_bang') })
    expect(ids(big)).not.toContain('request-mirror')
  })

  it('bills the trials, the load and the catch-up before coexistence, on the durations the plan prints', () => {
    const e = design({ 'product.type': v('commerce'), 'project.origin': v('migrate_database'), 'infra.cloud': v('aws'), 'source.kinds': v(['rdbms']), 'source.rdbms_engine': v('sqlserver'), 'source.volume_gb': v(100_000), 'migration.link': v('dedicated_1g'), 'migration.sync': v('cdc') })
    const days = ['mig.trialDays', 'mig.loadDays', 'mig.finalDays'].map((id) => Number(e.facts[id]))
    expect(days[2]).toBe(7)
    expect(Number(e.facts['mig.preCutoverMonths'])).toBeCloseTo((days[0] + days[1] + days[2]) / 30)
    expect(Number(e.facts['mig.preCutoverMonths'])).toBeGreaterThan(Number(e.facts['migration.coexistMonths']))
    const months = Number(e.facts['migration.coexistMonths']) + Number(e.facts['mig.preCutoverMonths'])
    expect(e.cost.transitionTotal).toBeCloseTo(e.cost.oneTime + months * (e.cost.monthly + e.cost.transitionMonthly))
    const plan = migrationMarkdown(e)
    expect(plan).toContain(`Two trial migrations on a production copy :a3, after a2, ${days[0]}d`)
    expect(plan).toContain(`Initial load :b1, after a3, ${days[1]}d`)
    expect(plan).toContain('CDC catch-up :b2, after b1, 7d')
    // A fresh start moves nothing, so nothing is billed before coexistence.
    expect(design({ ...scenario('oracle-orders-to-aws'), 'source.history': v('none') }).facts['mig.preCutoverMonths']).toBe(0)
  })

  it('names conversion tools that write the target engine', () => {
    const refactor = kb.questions.find((q) => q.id === 'migration.approach')!.options!.find((o) => o.id === 'refactor')!
    expect(refactor.cons.join(' ')).not.toContain('SSMA on Azure')
    expect(refactor.cons.join(' ')).toContain('ora2pg with Azure DMS into Azure Database for PostgreSQL')
    const fix = kb.validations.find((r) => r.id === 'refactor-heavy-code')!.fix
    expect(fix).toContain('ora2pg for a PostgreSQL target on Azure')
    expect(fix).toContain('SSMA only into SQL Server or Azure SQL')
  })

  it('names each provider\'s own CRM connector', () => {
    const crm = (cloud: string) =>
      design({ 'product.type': v('saas'), 'project.origin': v('replace_legacy_app'), 'infra.cloud': v(cloud), 'source.kinds': v(['crm']), 'source.crm_product': v('salesforce'), 'source.volume_gb': v(100), 'source.crm_extract': v('provider_connector') })
    const names = Object.fromEntries(['aws', 'azure', 'gcp', 'onprem'].map((cloud) => [cloud, component(crm(cloud), 'api-extractor')!.tech]))
    expect(names.aws).toContain('Amazon AppFlow')
    expect(names.azure).toContain('Azure Data Factory')
    expect(names.gcp).toContain('BigQuery Data Transfer Service')
    expect(names.onprem).toContain('Airbyte')
    expect(component(crm('aws'), 'api-extractor')!.monthlyCost).toBe(25)
  })

  it('reads a packaged on-premises CRM from its database and offers the vendor\'s SaaS successor', () => {
    const onprem = design({ 'product.type': v('saas'), 'project.origin': v('replace_legacy_app'), 'infra.cloud': v('azure'), 'source.kinds': v(['crm']), 'source.crm_product': v('dynamics_onprem'), 'source.volume_gb': v(500) })
    expect(onprem.facts['source.database']).toBe(true)
    expect(ids(onprem)).toEqual(expect.arrayContaining(['legacy-crm', 'legacy-db']))
    expect(ids(onprem)).not.toContain('api-extractor')
    expect(edgeIds(onprem)).toContain('legacy-crm->legacy-db')
    expect(active(onprem, 'source.crm_extract')).toBe(false)
    expect(onprem.facts['migration.approach']).toBe('repurchase')
    expect(recommendation(onprem, 'migration.approach').reasons.join(' ')).toContain('SaaS successor')
    expect(onprem.facts['migration.crm_target']).toBe('dynamics')
    // Dynamics 365 online is not the CRM in use, so it stays feasible, and the Dataverse export link is not offered for an on-premises database.
    expect(recommendation(onprem, 'migration.crm_target').reasons.join(' ')).toContain('Dynamics CRM on-premises to Dynamics 365 online')
    const kept = design({ 'product.type': v('saas'), 'project.origin': v('replace_legacy_app'), 'infra.cloud': v('azure'), 'source.kinds': v(['crm']), 'source.crm_product': v('packaged_onprem'), 'migration.approach': v('replatform') })
    expect(cdcScore(kept).feasible).toBe(true)
  })
})
