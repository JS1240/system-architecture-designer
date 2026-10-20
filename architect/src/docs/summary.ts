import type { Evaluation } from '../domain/types'
import { fmt, fmtGb, formatAvailability } from '../engine/architecture'
import type { OptionComparison } from '../engine/explore'

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

/** Review lines for one design (scripts/scenario-summary.ts and the catalog golden snapshot); costs are exact so price edits show as diffs. */
export function summaryLines(e: Evaluation): string[] {
  const d = (id: string) => String(e.facts[id] ?? '-')
  const w = e.workload
  const nonprod = e.cost.byKind.nonprod ?? 0
  const support = e.cost.byKind.support ?? 0
  return [
    `kind=${d('project.kind')} origin=${d('project.origin')} cloud=${d('infra.cloud')} platform=${d('data.platform')} format=${d('data.table_format')}`,
    `load: peak ${fmt(w.peakQps)} req/s (r ${fmt(w.peakReadQps)}, w ${fmt(w.peakWriteQps)}), db ${fmtGb(w.dbStorageGb)}, total ${fmtGb(w.totalStorageGb)}, conns ${fmt(w.concurrentConnections)}`,
    `decisions: style=${d('arch.style')} db=${d('data.primary_db')} repl=${d('data.replication')} part=${d('data.partitioning')} cache=${d('perf.cache')}/${d('perf.cache_tech')} cdn=${d('perf.cdn')} async=${d('arch.async')}/${d('arch.broker')} rt=${d('perf.realtime')} search=${d('data.search')} gw=${d('arch.gateway')} api=${d('arch.api')} auth=${d('security.auth')} edge=${d('security.edge')} region=${d('reliability.multi_region')} dr=${d('reliability.dr')} compute=${d('infra.compute')} deploy=${d('ops.deploy')} obs=${d('ops.observability')} consistency=${d('product.consistency')}`,
    `components: ${e.architecture.components.map((c) => `${c.def.id}x${c.replicas}`).join(' ')}`,
    `avail ${formatAvailability(e.availability)} findings: ${e.findings.map((f) => f.rule.id).join(',')}`,
    `cost: run ${money(e.cost.monthly - nonprod - support)}${nonprod ? ` (+nonprod ${money(nonprod)})` : ''}${support ? ` (+support ${money(support)})` : ''}, people ${money(e.cost.people)}, one-off ${money(e.cost.oneTime)}, transition ${money(e.cost.transitionMonthly)}/mo`,
  ]
}

/** 'cost by provider: aws $X (+people $P), ...' from compareOver over infra.cloud; providers the design rules out are marked. */
export const providerLine = (comparisons: Pick<OptionComparison, 'option' | 'evaluation' | 'feasible'>[]): string =>
  `cost by provider: ${comparisons.map(({ option, evaluation: x, feasible }) => `${option.id} ${money(x.monthlyCost)} (+people ${money(x.cost.people)})${feasible ? '' : ' infeasible'}`).join(', ')}`
