import { describe, expect, it } from 'vitest'
import type { Answers, Evaluation, KnowledgeBase, Overrides } from '../domain/types'
import { generateMarkdown } from '../docs/generate'
import { kb } from '../knowledge'
import { blankProject, scopeOverrides } from '../store/projectStore'
import { evaluate } from './evaluate'
import { autoComplete, compareOver, costLevers, diffEvaluations, runAndPeople } from './explore'
import { withOverrides } from './overrides'

const v = (value: unknown) => ({ kind: 'value' as const, value: value as string })
const scenario = (id: string): Answers => kb.scenarios.find((s) => s.id === id)!.answers
const design = (answers: Answers, k: KnowledgeBase = kb): Evaluation => evaluate(k, autoComplete(k, answers))
const component = (e: Evaluation, id: string) => e.architecture.components.find((c) => c.def.id === id)
const findings = (e: Evaluation) => e.findings.map((x) => x.rule.id)
const finding = (e: Evaluation, id: string) => e.findings.find((x) => x.rule.id === id)?.rule

describe('cost basis', () => {
  const shop = design(scenario('ecommerce'))

  it('prices instance lines by region and leaves usage lines at the US list price', () => {
    const frankfurt = design({ ...scenario('ecommerce'), 'infra.region': v('eu_central') })
    expect(shop.facts['infra.region']).toBe('us_east')
    let instances = 0
    for (const c of frankfurt.architecture.components) {
      const base = component(shop, c.def.id)!
      const own = (x: typeof c) => x.monthlyCost - (x.storageCost ?? 0)
      if (c.instanceClass === null) expect(c.monthlyCost, c.def.id).toBeCloseTo(base.monthlyCost)
      else {
        instances++
        expect(own(c), c.def.id).toBeCloseTo(own(base) * 1.15)
        expect(c.storageCost ?? 0, c.def.id).toBeCloseTo(base.storageCost ?? 0)
      }
    }
    expect(instances).toBeGreaterThan(3)
  })

  it('halves the application cost on a 3-year commitment and is infeasible on own hardware', () => {
    const committed = design({ ...scenario('ecommerce'), 'infra.commitment': v('commit_3y') })
    expect(component(committed, 'app')!.monthlyCost).toBeCloseTo(component(shop, 'app')!.monthlyCost * 0.5)
    // On demand is the default, so pinned designs keep their prices; large on-demand fleets get a hint with the amount.
    expect(shop.facts['infra.commitment']).toBe('on_demand')
    expect(finding(design(scenario('sales-rank')), 'commitment-opportunity')!.message).toMatch(/^Instances and committable platform capacity cost \$[\d.]+k a month/)
    const onprem = design(scenario('onprem-iceberg-lakehouse'))
    expect(onprem.questions.find((s) => s.question.id === 'infra.commitment')!.recommendation.scores.filter((s) => s.feasible).map((s) => s.optionId)).toEqual(['on_demand'])
    expect(findings(onprem)).not.toContain('commitment-opportunity')
  })

  it('ignores a purchase commitment on own hardware, in the design and in the provider comparison', () => {
    const regulated = scenario('onprem-regulated-ai')
    const committed = design({ ...regulated, 'infra.commitment': v('commit_3y') })
    // Servers are bought, so the question does not apply: no 50% off and no infeasibility error.
    expect(committed.questions.find((s) => s.question.id === 'infra.commitment')!.active).toBe(false)
    expect(committed.monthlyCost).toBeCloseTo(design(regulated).monthlyCost)
    expect(findings(committed).filter((id) => id.startsWith('infeasible-'))).toEqual([])
    // A commitment chosen on a cloud keeps the on-prem column at its on-demand price and feasible.
    const onprem = (answers: Answers) => compareOver(kb, answers, 'infra.cloud').find((r) => r.option.id === 'onprem')!
    const carried = onprem({ ...scenario('sales-rank'), 'infra.commitment': v('commit_3y') })
    expect(carried.feasible).toBe(true)
    expect(carried.evaluation.monthlyCost).toBeCloseTo(onprem(scenario('sales-rank')).evaluation.monthlyCost)
  })

  it('bills an autoscaled cloud fleet on its average size, and own hardware and pinned fleets on the peak', () => {
    // The same average traffic with a higher peak sizes a larger peak fleet, but bills the same average fleet.
    const app = (answers: Answers, k: KnowledgeBase = kb) => component(design(answers, k), 'app')!
    const steady = app({ ...scenario('sales-rank'), 'traffic.peak': v('steady') })
    const spiky = app({ ...scenario('sales-rank'), 'traffic.peak': v('spiky') })
    expect(spiky.replicas).toBeGreaterThan(3 * steady.replicas)
    expect(spiky.units).toBe(steady.units)
    expect(spiky.monthlyCost).toBeCloseTo(steady.monthlyCost)
    expect(spiky.units).toBeLessThan(spiky.replicas)
    expect(spiky.sizingNote).toMatch(/Autoscaled: billed on about \d+ instance\(s\)/)
    // A 3-year commitment then discounts only that baseline.
    expect(app({ ...scenario('sales-rank'), 'traffic.peak': v('spiky'), 'infra.commitment': v('commit_3y') }).monthlyCost).toBeCloseTo(0.5 * spiky.monthlyCost)
    // Own hardware is bought for the peak.
    const owned = app({ ...scenario('sales-rank'), 'traffic.peak': v('spiky'), 'infra.cloud': v('onprem') })
    expect(owned.units).toBe(owned.replicas)
    // A pinned fleet runs its pinned count all month.
    const pinned = app({ ...scenario('sales-rank'), 'traffic.peak': v('spiky') }, withOverrides(kb, { replicas: { app: 40 } }))
    expect(pinned.units).toBe(40)
  })

  it('prices each compute platform: VM nodes below managed containers, PaaS above, plus a control-plane fee per Kubernetes cluster', () => {
    const on = (compute: string, answers = scenario('sales-rank')) => design({ ...answers, 'infra.compute': v(compute) })
    const containers = on('managed_containers')
    const kubernetes = on('kubernetes')
    const vms = on('vms')
    const app = (e: Evaluation) => component(e, 'app')!
    expect(app(kubernetes).unitCost).toBeCloseTo(app(containers).unitCost / 1.2)
    expect(app(vms).unitCost).toBeCloseTo(app(containers).unitCost / 1.2)
    expect(app(on('paas')).unitCost).toBeCloseTo(app(containers).unitCost * 1.6)
    expect(component(kubernetes, 'k8s-control-plane')!.monthlyCost).toBe(73)
    expect(component(vms, 'k8s-control-plane')).toBeUndefined()
    // The run cost now separates the platforms; people still decide small designs for managed containers.
    expect(kubernetes.monthlyCost).toBeLessThan(containers.monthlyCost)
    expect(runAndPeople(on('kubernetes', scenario('url-shortener')))).toBeGreaterThan(runAndPeople(on('managed_containers', scenario('url-shortener'))))
    // Own hardware keeps its own price level for every platform.
    const onprem = (compute: string) => app(on(compute, { ...scenario('sales-rank'), 'infra.cloud': v('onprem') })).unitCost
    expect(onprem('kubernetes')).toBeCloseTo(onprem('vms'))
  })

  it('prices own SQL Server and Oracle licences (BYOL, Azure Hybrid Benefit) as compute plus support', () => {
    const crm = scenario('sqlserver-crm-to-azure')
    const included = design(crm)
    const owned = design({ ...crm, 'org.existing_platforms': v(['db_licenses']) })
    const primary = (e: Evaluation) => component(e, 'db-primary')!
    expect(primary(owned).tech).toMatch(/^Azure SQL Managed Instance \(Azure Hybrid Benefit\)/)
    expect(primary(owned).monthlyCost).toBeLessThan(0.7 * primary(included).monthlyCost)
    expect(owned.monthlyCost).toBeLessThan(included.monthlyCost)
    // Oracle on RDS includes a licence only for Standard Edition 2; with own licences it is RDS BYOL.
    const oracle = { ...scenario('oracle-orders-to-aws'), 'data.primary_db': v('oracle'), 'migration.approach': v('replatform') }
    expect(primary(design(oracle)).tech).toMatch(/^RDS for Oracle SE2 \(license-included\)/)
    expect(primary(design({ ...oracle, 'org.existing_platforms': v(['db_licenses']) })).tech).toMatch(/^RDS for Oracle \(BYOL\)/)
  })

  it('prices the push CDN as an own edge of whole servers, open only to a video service at streaming scale', () => {
    const shop = design(scenario('ecommerce'))
    const push = shop.questions.find((s) => s.question.id === 'perf.cdn')!.recommendation.scores.find((s) => s.optionId === 'push')!
    expect(push.feasible).toBe(false)
    expect(costLevers(kb, autoComplete(kb, scenario('ecommerce'))).map((l) => `${l.question.id}=${l.to.id}`)).not.toContain('perf.cdn=push')
    // Each edge server costs its full price, with no smaller instance class.
    const video = component(design(scenario('video-streaming')), 'cdn')!
    expect(video.instanceClass).toBe('large')
    expect(video.unitCost).toBe(1_500)
    expect(design({ ...scenario('video-streaming'), 'traffic.dau': v(10_000) }).questions.find((s) => s.question.id === 'perf.cdn')!.recommendation.optionId).not.toBe('push')
  })

  it('scales BigQuery on-demand scans with the query hours, like the hourly warehouses', () => {
    const bigquery = (hours: number) => component(design({ ...scenario('databricks-ml-aws'), 'product.features': v(['accounts', 'ml', 'analytics']), 'infra.cloud': v('gcp'), 'data.platform': v('native'), 'data.history_tb': v(120), 'data.analytics_hours': v(hours) }), 'warehouse')!
    expect(bigquery(8).tech).toMatch(/^BigQuery/)
    expect(bigquery(24).monthlyCost).toBeCloseTo(3 * bigquery(8).monthlyCost, -2)
    expect(bigquery(2).monthlyCost).toBeCloseTo(bigquery(8).monthlyCost / 4, -2)
  })

  it('offers dashboards built into Databricks and Snowflake with no viewer licence', () => {
    const viewers = { ...scenario('databricks-ml-aws'), 'product.features': v(['accounts', 'ml', 'analytics']), 'data.analytics_users': v(1_000) }
    const options = compareOver(kb, viewers, 'bi.tool')
    const builtIn = options.find((r) => r.option.id === 'platform_dashboards')!
    expect(builtIn.feasible).toBe(true)
    expect(component(builtIn.evaluation, 'bi')!.monthlyCost).toBe(0)
    expect(component(builtIn.evaluation, 'bi')!.tech).toBe('Databricks AI/BI dashboards')
    expect(Math.min(...options.filter((r) => r.feasible).map((r) => runAndPeople(r.evaluation)))).toBe(runAndPeople(builtIn.evaluation))
    expect(design(viewers).facts['bi.tool']).toBe('platform_dashboards')
    // Fabric has Power BI instead.
    expect(compareOver(kb, scenario('fabric-bi-azure'), 'bi.tool').find((r) => r.option.id === 'platform_dashboards')!.feasible).toBe(false)
  })

  it('bills origin egress, so dropping the CDN no longer looks cheaper', () => {
    const noCdn = design({ ...scenario('ecommerce'), 'perf.cdn': v('none') })
    expect(component(noCdn, 'cdn')).toBeUndefined()
    // The media the CDN served now leaves the origin at the internet rate ($90 vs $40 per TB).
    expect(component(noCdn, 'internet-egress')!.monthlyCost).toBeGreaterThan(component(shop, 'cdn')!.monthlyCost + component(shop, 'internet-egress')!.monthlyCost)
    expect(noCdn.monthlyCost).toBeGreaterThan(shop.monthlyCost)
    expect(findings(noCdn)).toContain('media-no-cdn')
    expect(finding(noCdn, 'egress-dominates')!.message).toMatch(/^Internet and cross-site transfer is \d+% of the monthly cost \(\$[\d.]+k\)/)
    // With the CDN, the origin still sends the API responses.
    expect(shop.workload.originEgressGbMonth).toBeGreaterThan(0)
    expect(component(shop, 'internet-egress')!.monthlyCost).toBeCloseTo(Math.ceil(shop.workload.originEgressGbMonth) * 0.09)
    expect(component(shop, 'internet-egress')!.costKind).toBe('transfer')
  })

  it('prices database volumes on every copy plus backups of the primary', () => {
    // Range-sharded PostgreSQL on EC2 keeps a volume per copy; hash sharding would pick Aurora's shared cluster volume.
    const e = design({ ...scenario('url-shortener'), 'data.partitioning': { kind: 'value', value: 'range_sharding' } })
    const gb = e.workload.dbStorageGb
    const primary = component(e, 'db-primary')!
    expect(primary.storageCost).toBeCloseTo(gb * 0.115 + gb * 0.095)
    expect(primary.sizingNote).toContain('Storage:')
    const replica = component(e, 'db-replica')!
    // Each replica copies one partition, so the replicas hold replicas / partitions full copies.
    expect(replica.storageCost).toBeCloseTo(gb * (replica.replicas / primary.replicas) * 0.115)
  })

  it('adds non-production environments as a share of the production instances only', () => {
    const staged = design({ ...scenario('ecommerce'), 'ops.environments': v('prod_staging') })
    const instances = staged.architecture.components.filter((c) => c.costKind === 'run' && c.instanceClass !== null && c.def.shape !== 'region' && c.phase !== 'transition')
    expect(staged.cost.byKind.nonprod).toBeCloseTo(0.15 * instances.reduce((sum, c) => sum + c.monthlyCost, 0))
    // A second region, CDN bytes, per-seat and per-call lines follow production traffic, so staging does not copy them.
    const social = design({ ...scenario('social-network'), 'ops.environments': v('prod_staging_dev') })
    const perUse = social.architecture.components.filter((c) => ['peer-region', 'standby-region', 'cdn', 'object-storage', 'internet-egress', 'llm-api', 'bi'].includes(c.def.id))
    expect(perUse.length).toBeGreaterThan(0)
    const withoutPerUse = 0.25 * (social.cost.byKind.run! - perUse.reduce((sum, c) => sum + c.monthlyCost, 0))
    expect(social.cost.byKind.nonprod!).toBeLessThanOrEqual(withoutPerUse + 1e-6)
    // Vendor support is a share of the whole bill, so it is taken off both totals before comparing.
    const prodOnly = design({ ...scenario('ecommerce'), 'ops.environments': v('prod_only') })
    const supportless = (x: typeof shop) => x.monthlyCost - (x.cost.byKind.support ?? 0)
    expect(supportless(staged)).toBeCloseTo(supportless(prodOnly) + staged.cost.byKind.nonprod!)
    expect(prodOnly.cost.byKind.nonprod).toBeUndefined()
  })

  it('names the largest cost lines and the numbers in the over-budget finding', () => {
    const e = design({ ...scenario('ecommerce'), 'infra.budget': v(500) })
    const rule = finding(e, 'over-budget')!
    expect(rule.message).toMatch(/^The rough monthly estimate, \$[\d.]+k, is above the \$500 budget\.$/)
    // Labour and one-off lines stay out of the monthly total, so they are not named either.
    const monthly = e.architecture.components.filter((c) => c.costKind !== 'people' && c.costKind !== 'one_time' && c.phase !== 'transition')
    const top = monthly.sort((a, b) => b.monthlyCost - a.monthlyCost).slice(0, 3)
    for (const c of top) expect(rule.fix).toContain(c.def.label)
    expect(rule.fix).not.toContain('{')
  })

  it('flags a serving region outside the residency zone and lets the region follow the zone by default', () => {
    const rag = design(scenario('rag-assistant-azure'))
    expect(rag.facts['infra.region']).toBe('eu_west')
    expect(findings(rag)).not.toContain('region-outside-residency')
    const us = design({ ...scenario('rag-assistant-azure'), 'infra.region': v('us_east') })
    expect(finding(us, 'region-outside-residency')!.message).toContain('the eu zone')
    expect(findings(design({ ...scenario('rag-assistant-azure'), 'security.residency': v('sovereign') }))).toContain('sovereign-offerings')
  })

  it('reads a numeric budget into infra.budgetUsd', () => {
    expect(shop.facts['infra.budgetUsd']).toBe(50_000)
    expect(design({ ...scenario('ecommerce'), 'infra.budget': v(1_234) }).facts['infra.budgetUsd']).toBe(1_234)
  })
})

describe('project overrides', () => {
  const answers = autoComplete(kb, scenario('url-shortener'))
  const base = evaluate(kb, answers)
  const run = (o: Overrides) => evaluate(withOverrides(kb, o), answers)

  it('changes nothing when empty', () => {
    expect(withOverrides(kb, {})).toBe(kb)
    expect(withOverrides(kb, undefined)).toBe(kb)
    expect(run({ exclude: [], reference: {} })).toEqual(base)
  })

  it('applies every editable reference number to the prices and sizing built from it', () => {
    const priced = (id: string, reference: Overrides['reference'], k = kb) => {
      const a = autoComplete(k, scenario(id))
      return [evaluate(k, a), evaluate(withOverrides(k, { reference }), a)] as const
    }
    // The loaded FTE-month cost prices migration engineering and platform operations.
    const [crm, crmRate] = priced('sqlserver-crm-to-azure', { opsFteMonthlyUsd: 25_000 })
    for (const id of ['migration-engineering', 'platform-ops']) expect(component(crmRate, id)!.monthlyCost, id).toBeCloseTo(2 * component(crm, id)!.monthlyCost)
    expect(crmRate.cost.oneTime).toBeGreaterThan(crm.cost.oneTime)
    // The FTE-month table is flat, so each approach's effort is a number a project can override.
    const effort = autoComplete(kb, { ...scenario('oracle-orders-to-aws'), 'migration.approach': v('replatform'), 'source.data_quality': v('poor') })
    expect(evaluate(withOverrides(kb, { reference: { migrationFteMonthsReplatform: 20, dataQualityFteMonthsPoor: 5 } }), effort).facts['mig.engineeringFteMonths']).toBe(25)
    // On-premises staff count and storage price.
    const [lake, lakeRef] = priced('onprem-iceberg-lakehouse', { onpremOpsFte: 4, onpremStoragePerTbMonth: 12 })
    // A larger on-premises base; the self-run lakehouse's share and the estate's servers stay.
    expect(component(lakeRef, 'platform-ops')!.monthlyCost - component(lake, 'platform-ops')!.monthlyCost).toBeCloseTo((4 - kb.reference.onpremOpsFte) * kb.reference.opsFteMonthlyUsd)
    expect(component(lakeRef, 'lake-storage')!.monthlyCost).toBeCloseTo(2 * component(lake, 'lake-storage')!.monthlyCost)
    // GPU throughput sizes the self-hosted model's nodes.
    const [gpu, slowGpu] = priced('onprem-regulated-ai', { gpuTokensPerSecond: 5 })
    expect(component(slowGpu, 'llm-serving')!.replicas).toBeGreaterThan(component(gpu, 'llm-serving')!.replicas)
    // Device capacity sets the number of offline device jobs.
    const device = { ...scenario('oracle-orders-to-aws'), 'migration.link': v('offline_device'), 'source.volume_gb': v(200_000) }
    const a = autoComplete(kb, device)
    expect(component(evaluate(withOverrides(kb, { reference: { offlineDeviceTb: 40 } }), a), 'transfer-fees')!.monthlyCost).toBe(Math.ceil(200_000 / 1024 / 40) * 300)
  })

  it('raises the utilization finding when db-primary is pinned below its need', () => {
    expect(component(base, 'db-primary')!.replicas).toBeGreaterThan(1)
    expect(findings(base)).not.toContain('pinned-replicas-overloaded')
    const pinned = run({ replicas: { 'db-primary': 1 } })
    const primary = component(pinned, 'db-primary')!
    expect(primary.replicas).toBe(1)
    expect(primary.utilization).toBeGreaterThan(0.7)
    expect(finding(pinned, 'pinned-replicas-overloaded')!.message).toContain('Primary database runs at')
  })

  it('keeps a standby for every partition of a primary pinned above its need, with frozen answers and re-decided ones', () => {
    for (const [id, pin] of [['ride-hailing', 30], ['url-shortener', 8]] as const) {
      const answers = autoComplete(kb, scenario(id))
      const pinned = withOverrides(kb, { replicas: { 'db-primary': pin } })
      for (const e of [evaluate(pinned, answers), design(answers, pinned)]) {
        expect(Number(e.facts['reliability.nines']), id).toBeGreaterThanOrEqual(99.9)
        expect(component(e, 'db-primary')!.replicas, id).toBe(pin)
        expect(component(e, 'db-primary')!.sizingNote, id).toMatch(new RegExp(`^${pin} partitions, driven by a pinned count`))
        expect(component(e, 'db-replica')!.replicas, id).toBeGreaterThanOrEqual(pin)
        expect(findings(e), id).not.toContain('availability-gap')
        // More partitions alone re-decide no replication or topology.
        expect(e.facts['data.replication'], id).toBe(evaluate(kb, answers).facts['data.replication'])
      }
    }
  })

  it('routes the primary load past an excluded replica tier or cache, so the partitioning decision and the offer follow it', () => {
    const answers = autoComplete(kb, scenario('social-graph'))
    const base = evaluate(kb, answers)
    expect(component(base, 'db-replica')).toBeDefined()
    expect(base.questions.find((q) => q.question.id === 'data.partitioning')!.active).toBe(false)
    const load = (exclude: string[]) => {
      const frozen = evaluate(withOverrides(kb, { exclude }), answers)
      expect(frozen.questions.find((q) => q.question.id === 'data.partitioning')!.active, String(exclude)).toBe(true)
      return Number(frozen.facts['cap.dbPrimaryLoad'])
    }
    const noReplicas = load(['db-replica'])
    expect(noReplicas).toBeGreaterThan(Number(base.facts['cap.dbPrimaryLoad']) * 10)
    // Without the cache too, its 80% hits land on the primary as well.
    expect(load(['db-replica', 'cache'])).toBeGreaterThan(noReplicas * 4)
    // Re-decided, the split primary leaves the single-writer managed offer.
    const redecided = design(answers, withOverrides(kb, { exclude: ['db-replica'] }))
    expect(redecided.facts['data.partitioning']).toMatch(/sharding/)
    expect(component(redecided, 'db-primary')!.tech).not.toMatch(/^RDS/)
    expect(findings(redecided)).not.toContain('availability-gap')
  })

  it('replaces unit prices, including group offers, and leaves other components alone', () => {
    const at = (price: number) => run({ unitPrice: { [component(base, 'app')!.priceKey]: price } })
    expect(component(at(200), 'app')!.monthlyCost).toBeCloseTo(component(at(100), 'app')!.monthlyCost * 2)
    expect(component(at(200), 'cache')!.monthlyCost).toBeCloseTo(component(base, 'cache')!.monthlyCost)
  })

  it('prices only the offer and capacity tier an override names, so alternatives and other tiers keep their list price', () => {
    const fabric = (tb: number) => autoComplete(kb, { ...scenario('fabric-bi-azure'), 'data.platform': v('fabric'), 'data.history_tb': v(tb) })
    const small = fabric(0)
    const warehouse = component(evaluate(kb, small), 'warehouse')!
    expect(warehouse.priceKey).toBe(`warehouse|any|${warehouse.offer!.name}|F2`)
    const o = { unitPrice: { [warehouse.priceKey]: 5_000 } }
    expect(component(evaluate(withOverrides(kb, o), small), 'warehouse')!.monthlyCost).toBeCloseTo(5_000)
    // Another platform in the comparisons is priced at its own list price.
    const databricks = { ...small, 'data.platform': v('databricks') }
    expect(component(evaluate(withOverrides(kb, o), databricks), 'warehouse')!.monthlyCost).toBeCloseTo(component(evaluate(kb, databricks), 'warehouse')!.monthlyCost)
    // So is another provider's native warehouse once the price was set on Azure's.
    const native = autoComplete(kb, { ...scenario('fabric-bi-azure'), 'data.platform': v('native') })
    const azure = component(evaluate(kb, native), 'warehouse')!
    const aws = { ...native, 'infra.cloud': v('aws') }
    const redshift = component(evaluate(withOverrides(kb, { unitPrice: { [azure.priceKey]: 5_000 } }), aws), 'warehouse')!
    expect(redshift.priceKey).not.toBe(azure.priceKey)
    expect(redshift.monthlyCost).toBeCloseTo(component(evaluate(kb, aws), 'warehouse')!.monthlyCost)
    // More data sizes a larger F-SKU, whose list price the F2 price does not replace, so the cost follows the data again.
    const big = fabric(30)
    const f64 = component(evaluate(withOverrides(kb, o), big), 'warehouse')!
    expect(f64.sizingNote).toMatch(/^F64: /)
    expect(f64.monthlyCost).toBeCloseTo(component(evaluate(kb, big), 'warehouse')!.monthlyCost)
  })

  it('merges reference numbers, excludes components and applies the cloud discount', () => {
    expect(component(run({ reference: { appInstanceQps: 100 } }), 'app')!.replicas).toBeGreaterThan(component(base, 'app')!.replicas)
    expect(component(run({ exclude: ['cache'] }), 'cache')).toBeUndefined()
    const discounted = run({ discountPct: 20, discountProvider: String(base.facts['infra.cloud']) })
    expect(component(discounted, 'app')!.monthlyCost).toBeCloseTo(component(base, 'app')!.monthlyCost * 0.8)
    expect(discounted.monthlyCost).toBeLessThan(base.monthlyCost)
  })

  it('applies a negotiated discount only on the cloud it was negotiated with', () => {
    // An AWS EDP makes AWS cheaper in the provider comparison, and leaves Azure and Google Cloud at their list price.
    const edp = withOverrides(kb, { discountPct: 20, discountProvider: 'aws' })
    const listed = new Map(compareOver(kb, scenario('ecommerce'), 'infra.cloud').map((r) => [r.option.id, r.evaluation.monthlyCost]))
    const negotiated = new Map(compareOver(edp, scenario('ecommerce'), 'infra.cloud').map((r) => [r.option.id, r.evaluation.monthlyCost]))
    expect(negotiated.get('aws')!).toBeLessThan(0.9 * listed.get('aws')!)
    for (const other of ['azure', 'gcp', 'onprem']) expect(negotiated.get(other), other).toBeCloseTo(listed.get(other)!)
    // A discount saved before it named its cloud goes to the cloud the design ran on; without a decided cloud it applies nowhere.
    expect(scopeOverrides({ discountPct: 20 }, autoComplete(kb, scenario('ecommerce')))).toEqual({ discountPct: 20, discountProvider: 'aws' })
    expect(scopeOverrides({ discountPct: 20 }, {})).toEqual({ discountPct: 20 })
    expect(evaluate(withOverrides(kb, { discountPct: 20 }), answers).monthlyCost).toBeCloseTo(base.monthlyCost)
  })

  it('discounts the lines the chosen cloud bills, whatever their drawing shape, and not other vendors on it', () => {
    const ratio = (answers: Answers, id: string) => {
      const completed = autoComplete(kb, answers)
      const listed = evaluate(kb, completed)
      const discounted = evaluate(withOverrides(kb, { discountPct: 30, discountProvider: String(listed.facts['infra.cloud']) }), completed)
      return component(discounted, id)!.monthlyCost / component(listed, id)!.monthlyCost
    }
    const aws = { ...scenario('databricks-ml-aws'), 'product.features': v(['accounts', 'ml', 'analytics']), 'bi.tool': v('quicksight') }
    // AWS's own services drawn as external: QuickSight, Cognito, Bedrock.
    expect(ratio(aws, 'bi')).toBeCloseTo(0.7)
    expect(ratio(aws, 'auth')).toBeCloseTo(0.7)
    expect(ratio(scenario('agent-support-copilot-aws'), 'llm-api')).toBeCloseTo(0.7)
    // Databricks, Snowflake and Fabric bill their own lines on AWS; Azure bills Fabric and Azure Databricks.
    expect(ratio(aws, 'warehouse')).toBeCloseTo(1)
    for (const platform of ['snowflake', 'fabric']) expect(ratio({ ...aws, 'data.platform': v(platform) }, 'warehouse'), platform).toBeCloseTo(1)
    expect(ratio({ ...aws, 'data.platform': v('fabric') }, 'lake-storage')).toBeCloseTo(1)
    const azure = { ...aws, 'bi.tool': v('power_bi'), 'infra.cloud': v('azure') }
    for (const platform of ['databricks', 'fabric']) expect(ratio({ ...azure, 'data.platform': v(platform) }, 'warehouse'), platform).toBeCloseTo(0.7)
    // Databricks jobs follow the same biller: Microsoft on Azure, Databricks on AWS.
    expect(ratio({ ...azure, 'data.platform': v('databricks') }, 'orchestrator')).toBeCloseTo(0.7)
    expect(ratio({ ...aws, 'data.platform': v('databricks') }, 'orchestrator')).toBeCloseTo(1)
    // ClickHouse Cloud and Snowpipe bill through their own vendors.
    expect(ratio({ ...aws, 'data.platform': v('olap_db') }, 'warehouse')).toBeCloseTo(1)
    expect(ratio({ ...aws, 'data.platform': v('olap_db') }, 'lake-storage')).toBeCloseTo(1)
    const gcpSnowflake = { ...aws, 'infra.cloud': v('gcp'), 'bi.tool': v('looker'), 'data.platform': v('snowflake'), 'data.ingestion': v('batch') }
    expect(ratio(gcpSnowflake, 'ingestion')).toBeCloseTo(1)
  })

  it('bills the media from the origin when the CDN is excluded', () => {
    const shopAnswers = autoComplete(kb, scenario('ecommerce'))
    const shop = evaluate(kb, shopAnswers)
    const noCdn = evaluate(withOverrides(kb, { exclude: ['cdn'] }), shopAnswers)
    expect(component(shop, 'cdn')).toBeDefined()
    expect(component(noCdn, 'cdn')).toBeUndefined()
    expect(noCdn.workload.originEgressGbMonth).toBeGreaterThan(shop.workload.originEgressGbMonth * 2)
    expect(component(noCdn, 'internet-egress')!.monthlyCost).toBeGreaterThan(component(shop, 'internet-egress')!.monthlyCost * 2)
  })

  it('counts extra lines in the totals, the cost table and the docs bill of materials', () => {
    const e = run({ extraLines: [{ label: 'Confluent Cloud', tier: 'async', monthly: 1_000, costKind: 'run' }] })
    // The added line also raises the support plan, which prices the whole bill.
    expect(e.monthlyCost - (e.cost.byKind.support ?? 0)).toBeCloseTo(base.monthlyCost - (base.cost.byKind.support ?? 0) + 1_000)
    expect(e.cost.extraLines).toHaveLength(1)
    expect(generateMarkdown(blankProject('X'), e, kb)).toContain('| Confluent Cloud (added) | - | - | - | - | run | $1,000 | - |')
  })
})

describe('overrides reach every threshold and show what they re-decide', () => {
  it('adds the load balancer and object storage from the live reference numbers and pins, not copies of the defaults', () => {
    // 200k employees on managed containers: about 694 req/s, one app instance at the default 1,000 req/s and 70% target.
    const tool = autoComplete(kb, { ...scenario('internal-tool'), 'traffic.dau': v(200_000), 'infra.compute': v('managed_containers') })
    const has = (e: Evaluation, id: string) => !!component(e, id)
    expect(has(evaluate(kb, tool), 'lb')).toBe(false)
    for (const o of [{ reference: { appInstanceQps: 100 } }, { reference: { targetUtilization: 0.3 } }, { replicas: { app: 4 } }] satisfies Overrides[]) {
      const e = evaluate(withOverrides(kb, o), tool)
      expect(component(e, 'app')!.replicas, JSON.stringify(o)).toBeGreaterThan(1)
      expect(has(e, 'lb'), JSON.stringify(o)).toBe(true)
      expect(e.architecture.edges.some((x) => x.from === 'client' && x.to === 'app'), JSON.stringify(o)).toBe(false)
    }
    // 40 KB records stay in the database at the 64 KB default; a 16 KB threshold moves them to object storage, which is then drawn and priced.
    const cache = { ...autoComplete(kb, scenario('query-cache')), 'data.object_kb': v(40) }
    expect(has(evaluate(kb, cache), 'object-storage')).toBe(false)
    const blobs = evaluate(withOverrides(kb, { reference: { blobThresholdKb: 16 } }), cache)
    expect(blobs.workload.objectStorageGb).toBeGreaterThan(0)
    expect(component(blobs, 'object-storage')!.monthlyCost).toBeGreaterThan(0)
  })

  it('warns about a pinned fleet against the overridden target utilization', () => {
    const shop = autoComplete(kb, scenario('ecommerce'))
    const app = component(evaluate(kb, shop), 'app')!
    // Pinned to the automatic count, the fleet runs below the default 70% target; a 20% target puts it above.
    const pin = { replicas: { app: app.replicas } }
    expect(findings(evaluate(withOverrides(kb, pin), shop))).not.toContain('pinned-replicas-overloaded')
    expect(findings(evaluate(withOverrides(kb, { ...pin, reference: { targetUtilization: 0.2 } }), shop))).toContain('pinned-replicas-overloaded')
  })

  it('lists the assumed answers an exclusion or a pin re-decides, and what they add', () => {
    const shop = autoComplete(kb, scenario('ecommerce'))
    const excluded = diffEvaluations(evaluate(kb, shop), evaluate(withOverrides(kb, { exclude: ['db-replica'] }), shop))
    expect(excluded.added).toContain('standby-region')
    expect(excluded.redecided).toContainEqual(expect.objectContaining({ id: 'reliability.multi_region', to: 'Active-passive (warm standby)' }))
    const saas = autoComplete(kb, scenario('azure-m365-saas'))
    const pinned = diffEvaluations(evaluate(kb, saas), evaluate(withOverrides(kb, { replicas: { app: 1 } }), saas))
    expect(pinned.redecided.map((r) => r.id)).toContain('reliability.dr')
    // An answer the user gave is never re-decided.
    const answered = { ...shop, 'reliability.multi_region': v('single_region') }
    expect(diffEvaluations(evaluate(kb, answered), evaluate(withOverrides(kb, { exclude: ['db-replica'] }), answered)).redecided.map((r) => r.id)).not.toContain('reliability.multi_region')
  })
})
