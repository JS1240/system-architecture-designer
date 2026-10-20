import type { Answers, ComponentInstance, Evaluation, KnowledgeBase, Project, QuestionState } from '../domain/types'
import { fmt, fmtGb, formatAvailability, instanceClass, offerFor } from '../engine/architecture'
import { evaluate } from '../engine/evaluate'
import { compareOver, runAndPeople, type OptionComparison } from '../engine/explore'
import { describePriceKey, withOverrides } from '../engine/overrides'
import { cite } from '../knowledge/sources'

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
const signedMoney = (n: number) => `${n < 0 ? '-' : '+'}${money(Math.abs(n))}`
const hours = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : `${fmt(Math.round(h * 10) / 10)} h`)
// Labels, technologies and custom answers are free text; an unescaped pipe would shift the cells of a Markdown table.
const cell = (s: string) => s.replace(/\|/g, '\\|')
const lineKind = (c: ComponentInstance) => (c.phase === 'transition' && c.costKind !== 'one_time' ? 'transition' : c.costKind)

/** Cost lines, recurring ones largest first and one-off ones after them: priced components, the engineer's extra lines and the non-production share (bill of materials). */
export function costLines(e: Evaluation): { key: string; label: string; kind: string; monthly: number }[] {
  return [
    ...e.architecture.components.filter((c) => c.monthlyCost > 0).map((c) => ({ key: c.def.id, label: c.def.label, kind: lineKind(c), monthly: c.monthlyCost })),
    ...e.cost.extraLines.map((l, i) => ({ key: `extra-${i}`, label: `${l.label} (added)`, kind: l.costKind, monthly: l.monthly })),
    ...(e.cost.byKind.nonprod ? [{ key: 'nonprod', label: 'Staging and dev environments', kind: 'nonprod', monthly: e.cost.byKind.nonprod }] : []),
    ...(e.cost.byKind.support ? [{ key: 'support', label: 'Vendor support and maintenance', kind: 'support', monthly: e.cost.byKind.support }] : []),
  ].sort((a, b) => Number(a.kind === 'one_time') - Number(b.kind === 'one_time') || b.monthly - a.monthly)
}

export interface CostRow {
  component: string
  technology: string
  units: number
  unitPrice: number
  instanceClass: string
  kind: string
  monthly: number
  /** Share of the monthly run, people and transition cost; null for one-off lines. */
  share: number | null
}

/** One row per component, largest first: the cost estimate table and the bill of materials CSV. */
export function costEstimateRows(e: Evaluation): CostRow[] {
  const base = e.cost.monthly + e.cost.people + e.cost.transitionMonthly
  return e.architecture.components
    .map((c) => {
      const kind = lineKind(c)
      return { component: c.def.label, technology: c.tech, units: c.units, unitPrice: c.unitCost, instanceClass: c.instanceClass ?? '', kind, monthly: c.monthlyCost, share: kind === 'one_time' || base <= 0 ? null : c.monthlyCost / base }
    })
    .sort((a, b) => b.monthly - a.monthly)
}

// Text cells can come from imported projects, so a leading formula character is neutralized for spreadsheets.
const csvCell = (v: string | number) => {
  const s = typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const csv = (rows: (string | number)[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n'
const round2 = (n: number) => Math.round(n * 100) / 100

export const BOM_HEADER = ['Component', 'Technology', 'Units', 'Unit price (USD)', 'Instance class', 'Kind', 'Monthly (USD)', 'Share (%)']
export const bomCsv = (e: Evaluation): string => {
  const base = e.cost.monthly + e.cost.people + e.cost.transitionMonthly
  const share = (kind: string, monthly: number) => (kind === 'one_time' || base <= 0 ? '' : ((monthly / base) * 100).toFixed(1))
  // Staging/dev and engineer-added lines are not components, but the BOM total must match the running cost.
  const extra = costLines(e).filter((l) => !e.architecture.components.some((c) => c.def.id === l.key))
  return csv([
    BOM_HEADER,
    ...costEstimateRows(e).map((r) => [r.component, r.technology, round2(r.units), round2(r.unitPrice), r.instanceClass, r.kind, Math.round(r.monthly), r.share === null ? '' : (r.share * 100).toFixed(1)]),
    ...extra.map((l) => [l.label, '', '', '', '', l.kind, Math.round(l.monthly), share(l.kind, l.monthly)]),
  ])
}

export const PROVIDER_COST_HEADER = ['Provider', 'Feasible', 'Run per month (USD)', 'People per month (USD)', 'One-off (USD)', 'Transition per month (USD)', 'Run + people per month (USD)', 'Not feasible because']
export const providerCostCsv = (comparisons: OptionComparison[]): string =>
  csv([
    PROVIDER_COST_HEADER,
    ...comparisons.map(({ option, evaluation: x, feasible, infeasibleReason }) => [
      option.label,
      feasible ? 'yes' : 'no',
      Math.round(x.monthlyCost),
      Math.round(x.cost.people),
      Math.round(x.cost.oneTime),
      Math.round(x.cost.transitionMonthly),
      Math.round(runAndPeople(x)),
      infeasibleReason ?? '',
    ]),
  ])

/** Label of a question's value in effect, or '-' while it is pending or inactive. */
function valueLabel(e: Evaluation, id: string): string {
  const s = e.questions.find((q) => q.question.id === id)
  if (!s?.active || s.effectiveValue === null || s.effectiveValue === undefined) return '-'
  const label = (x: unknown) => s.question.options?.find((o) => o.id === x)?.label ?? String(x)
  return Array.isArray(s.effectiveValue) ? s.effectiveValue.map(label).join(', ') || 'none' : label(s.effectiveValue)
}

const oldestAsOf = (e: Evaluation): string | undefined => e.architecture.components.flatMap((c) => c.offer?.asOf ?? []).sort()[0]

// The spec's column order; the infra.cloud options keep their own order for tie-breaks.
const PROVIDER_ORDER = ['aws', 'azure', 'gcp', 'onprem']

/** Each component's service in the design completed on every provider (the designs the cost per provider CSV prices); components no provider names are left out. */
export function providerMapMarkdown(e: Evaluation, kb: KnowledgeBase, providers: OptionComparison[]): string {
  const columns = [...providers].sort((a, b) => PROVIDER_ORDER.indexOf(a.option.id) - PROVIDER_ORDER.indexOf(b.option.id))
  // The chosen design's components first, then those only another provider's design has.
  const defs = new Map([e, ...columns.map((c) => c.evaluation)].flatMap((x) => x.architecture.components.map((c) => [c.def.id, c.def] as const)))
  const rows = [...defs.values()].flatMap((def) => {
    const own = e.architecture.components.find((c) => c.def.id === def.id)
    const names = columns.map(({ evaluation: x }) => (x.architecture.components.some((c) => c.def.id === def.id) ? offerFor(kb, def, x.facts)?.name : undefined))
    return names.some(Boolean) ? [`| ${cell(def.label)} | ${cell(own?.tech ?? '-')} | ${names.map((n) => cell(n ?? '-')).join(' | ')} | ${own ? money(own.monthlyCost) : '-'} |`] : []
  })
  return [`| Component | Chosen service | ${columns.map((p) => p.option.label).join(' | ')} | Monthly |`, `|---|---|${columns.map(() => '---|').join('')}---|`, ...rows].join('\n')
}

/** The context answers and every project override next to the knowledge-base default it replaces. */
function constraintsMarkdown(project: Project, e: Evaluation, kb: KnowledgeBase): string {
  const context = e.questions.filter((q) => q.active && q.status !== 'pending' && q.question.category === 'context')
  const o = project.overrides ?? {}
  const label = (id: string) => kb.components.find((c) => c.id === id)?.label ?? id
  // Unit prices and fleet sizes without any override: the defaults the overrides replace.
  const listed = o.unitPrice || o.replicas ? evaluate(kb.overrides?.unitPrice ? { ...kb, overrides: { ...kb.overrides, unitPrice: undefined } } : kb, project.answers).architecture.components : []
  const defaults = new Map<string, ComponentInstance>(listed.map((c) => [c.def.id, c]))
  const listPrices = new Map(listed.map((c) => [c.priceKey, c.listPrice]))
  const rows = [
    ...Object.entries(o.reference ?? {}).map(([key, v]) => [`Reference: ${key}`, Number(kb.reference[key as keyof typeof kb.reference]).toLocaleString('en-US'), Number(v).toLocaleString('en-US')]),
    ...Object.entries(o.unitPrice ?? {}).map(([key, v]) => [`Unit price: ${describePriceKey(kb, key)}${listPrices.has(key) ? '' : ' (not in this design)'}`, listPrices.has(key) ? money(listPrices.get(key)!) : '-', money(v)]),
    ...Object.entries(o.replicas ?? {}).map(([id, v]) => [`Instances: ${label(id)}`, defaults.has(id) ? String(defaults.get(id)!.replicas) : '-', String(v)]),
    ...(o.exclude ?? []).map((id) => [`Component: ${label(id)}`, 'included', 'excluded']),
    ...(o.discountPct ? [[`Negotiated discount${o.discountProvider ? ` (${o.discountProvider} only)` : ' (no cloud assigned, not applied)'}`, '0%', `${o.discountPct}%`]] : []),
    ...(o.extraLines ?? []).map((l) => [`Added line: ${l.label} (${l.costKind}, ${l.tier})`, '-', money(l.monthly)]),
  ]
  return [
    '| Constraint | Value |',
    '|---|---|',
    ...context.map((q) => `| ${cell(q.question.title)} | ${cell(answerText(q, project.answers))} |`),
    '',
    ...(rows.length
      ? ['| Override | Default | Value |', '|---|---|---|', ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)]
      : ['No overrides: list prices and planning numbers come from the knowledge base.']),
  ].join('\n')
}

// shortcut: a fixed 14-day rollback window (general knowledge); add a migration.rollback_days question when projects need another.
const ROLLBACK_DAYS = 14

/** Source inventory, runbook and a Mermaid gantt chart for a migration; the cutover, rollback window and decommission only when the old system is retired. */
export function migrationMarkdown(e: Evaluation): string {
  const num = (id: string, fallback = 0) => (typeof e.facts[id] === 'number' ? (e.facts[id] as number) : fallback)
  const has = (id: string) => e.architecture.components.find((c) => c.def.id === id)
  const retiring = e.facts['profile.retire'] === true
  const sync = e.facts['migration.sync']
  // A fresh start moves no data: no load, trial migration or catch-up, and the old system stays readable until it is retired.
  const fresh = e.facts['source.history'] === 'none'
  const noMove = 'No data moves; keep the old system read-only until retirement.'
  const tools = ['cdc-pipeline', 'bulk-loader', 'api-extractor'].flatMap((id) => has(id)?.tech ?? []).join(' + ') || '-'
  const sources = e.architecture.components.filter((c) => c.def.tier === 'legacy' && c.def.shape !== 'monitor')
  const cutover = num('mig.cutoverHours')
  // The engine's defaults: an 8 h window, and a pending sync method costed as a bulk copy.
  const window = num('migration.downtimeHours', 8)
  const coexist = num('migration.coexistMonths')
  const bulk = sync === undefined || sync === 'bulk_export'
  // Until these are answered the cutover figures rest on defaults, so the plan says which answers it waits for.
  const openInputs = fresh ? [] : [['migration.sync', 'sync method'], ['migration.downtime', 'downtime window'], ['source.volume_gb', 'volume']].flatMap(([id, what]) => (valueLabel(e, id) === '-' ? [what] : []))
  const coexistOpen = valueLabel(e, 'migration.strategy') === '-' && valueLabel(e, 'migration.coexistence_months') === '-'
  // Durations in days from the transfer estimate (migration.ts, which bills the same days), the engineering effort and the strategy's coexistence.
  const loadDays = num('mig.loadDays', 1)
  const archiveDays = num('mig.archiveDays', 0)
  const trialDays = num('mig.trialDays', 2)
  // shortcut: conversion assumes two engineers share the effort; plan the real staffing for dates.
  const conversionDays = Math.max(5, Math.ceil((num('mig.engineeringFteMonths') * 30) / 2))
  const start = new Date().toISOString().slice(0, 10)
  const keep: Record<string, string> = {
    reverse_cdc: `Keep reverse CDC from the new system to the old one running for ${ROLLBACK_DAYS} days, then stop it.`,
    restore_backup: `Keep the pre-cutover snapshot for ${ROLLBACK_DAYS} days; a rollback loses the writes made since cutover.`,
    keep_parallel: 'Keep the old system live until sign-off.',
    none: 'No rollback: fix forward.',
  }
  // The step follows the rollback answer the plan prints, so an open rollback decision stays open here too.
  const rollback = valueLabel(e, 'migration.rollback') === '-' ? undefined : keep[String(e.facts['migration.rollback'])]
  const drain = sync === 'cdc' ? 'Wait until the CDC lag is 0.' : bulk ? `Export and load the full copy${sync === undefined ? ' (sync method open)' : ''}.` : 'Load the last increment.'
  const keepInSync =
    sync === 'cdc' ? 'Keep CDC from the old system to the new one running and alert on its lag.' : bulk ? `Export and load the full copy on a schedule${sync === undefined ? ' (sync method open)' : ''}.` : 'Load the increments on a schedule.'
  // Waves and a strangler facade move one part at a time while the rest stays on the old system, so their runbook repeats per wave or route.
  const strategy = e.facts['migration.strategy']
  const unit = strategy === 'phased' ? 'wave' : strategy === 'strangler' ? 'route' : undefined
  const finish = [rollback ?? 'Choose the rollback path (open question).', 'Decommission the old system and stop its licenses.']
  const perUnit = (part: string) => [
    unit === 'wave' ? 'Pick the next wave (module, tenant or region) and freeze writes to its data on the old system.' : 'Build the next route in the new system and freeze changes to it in the old one.',
    drain,
    `Reconcile the ${part}'s row counts and checksums between old and new.`,
    unit === 'wave' ? 'Switch the wave\'s users to the new system.' : 'Point the facade\'s route at the new system.',
    `Run the smoke tests for the ${part}.`,
    sync === 'cdc'
      ? `Keep CDC running both ways: old to new for the ${part}s still on the old system, new to old for the ${part}s already moved.`
      : `Copy the moved ${part}s' writes back to the old system on a schedule while other ${part}s still use it.`,
    `To roll a ${part} back, ${unit === 'wave' ? 'switch its users back to the old system' : 'point the facade at the old system for it again'}${sync === 'cdc' ? '; the reverse stream has kept its data current' : ''}.`,
    `Repeat for every remaining ${part}; after the last one:`,
    ...finish,
  ]
  // Both systems take the same inputs into their own stores, so the sync only loads the history before the mirror starts; a running change stream would overwrite the new system's results.
  const parallel = [
    sync === 'cdc' ? 'Load the history with the CDC snapshot and let the change stream catch up.' : bulk ? `Export and load the full copy${sync === undefined ? ' (sync method open)' : ''}.` : 'Load the history from the increments.',
    `${sync === 'cdc' ? 'Stop the change stream and, at the same point, start' : 'Start'} mirroring every input to both systems; each keeps its own store, and the old system stays the system of record.`,
    'Compare the outputs of both systems daily and fix every difference.',
    'Switch users to the new system and stop the mirror once the outputs match for the agreed period.',
    'Run the smoke tests.',
    ...finish,
  ]
  const steps = fresh
    ? [noMove, ...(retiring ? ['Switch users to the new system.', 'Run the smoke tests.', 'Decommission the old system and stop its licenses.'] : [])]
    : retiring
    ? unit
      ? perUnit(unit)
      : strategy === 'parallel_run'
      ? parallel
      : ['Freeze writes on the old system.', drain, 'Reconcile row counts and checksums between old and new.', 'Switch connection strings or DNS to the new system.', 'Run the smoke tests.', ...finish]
    : [`Load the initial copy with ${tools}.`, keepInSync, 'Reconcile row counts and checksums between old and new after each load.', 'The old system stays in place: nothing is switched over or decommissioned.']
  const printed = new Set<string>()
  return [
    '| Source | Technology | Volume | Sync method | Tool |',
    '|---|---|---|---|---|',
    ...sources.map((c) => {
      // A SaaS CRM or API leaves through the extractor as the CRM extraction says; the other sources follow the sync method.
      const viaApi = c.def.id === 'legacy-saas' || (c.def.id === 'legacy-crm' && e.facts['source.crmOnDatabase'] !== true)
      const sync = c.def.id === 'legacy-crm' && viaApi && valueLabel(e, 'source.crm_extract') !== '-' ? valueLabel(e, 'source.crm_extract') : viaApi ? 'API extraction' : valueLabel(e, 'migration.sync')
      const tool = (viaApi ? ['api-extractor'] : ['cdc-pipeline', 'bulk-loader']).flatMap((id) => has(id)?.tech ?? []).join(' + ') || '-'
      // A CRM, warehouse or files next to other sources have volumes of their own (source.crm_volume_gb, source.file_volume_gb); the rest share the main volume.
      const own = c.def.id === 'legacy-crm' ? 'source.crm_volume_gb' : c.def.id === 'file-source' ? 'source.file_volume_gb' : undefined
      const key = own && typeof e.facts[own] === 'number' ? own : 'source.volume_gb'
      const volume = fresh ? 'none (fresh start)' : printed.has(key) ? 'included above' : fmtGb(num(key))
      printed.add(key)
      return `| ${cell(c.def.label)} | ${cell(c.tech)} | ${volume} | ${cell(sync)} | ${cell(tool)} |`
    }),
    '',
    `- Strategy: ${valueLabel(e, 'migration.strategy')}; sync: ${valueLabel(e, 'migration.sync')}; link: ${valueLabel(e, 'migration.link')}`,
    ...(retiring
      ? [
          openInputs.length
            ? `- Cutover estimate: open (answer ${openInputs.join(', ')})`
            : `- Cutover estimate: ${hours(cutover)} against a ${hours(window)} window (${cutover <= window ? 'fits' : 'overruns'})`,
          `- Rollback: ${valueLabel(e, 'migration.rollback')}`,
          `- Coexistence: ${coexistOpen ? 'open (answer the migration strategy)' : `${fmt(coexist)} months`}; decommission the old system after the ${ROLLBACK_DAYS}-day rollback window`,
        ]
      : []),
    '',
    retiring ? (unit && !fresh ? `Runbook per ${unit}:` : strategy === 'parallel_run' && !fresh ? 'Parallel-run runbook:' : 'Cutover runbook:') : 'Sync runbook:',
    '',
    ...steps.map((step, i) => `${i + 1}. ${step}`),
    '',
    '```mermaid',
    'gantt',
    '  title Migration plan',
    '  dateFormat YYYY-MM-DD',
    '  section Prepare',
    `  Assess and inventory :a1, ${start}, 14d`,
    `  Schema and code conversion :a2, after a1, ${conversionDays}d`,
    ...(fresh
      ? ['  section Move', '  No data moves, old system read-only :milestone, b2, after a2, 0d']
      : [
          `  Two trial migrations on a production copy :a3, after a2, ${trialDays}d`,
          '  section Move',
          ...(archiveDays > 0 ? [`  Archive older history to object storage :b0, after a3, ${archiveDays}d`] : []),
          `  Initial load :b1, after ${archiveDays > 0 ? 'b0' : 'a3'}, ${loadDays}d`,
          `  ${sync === 'cdc' ? 'CDC catch-up' : bulk ? 'Final full copy' : 'Final increments'} :b2, after b1, ${num('mig.finalDays', loadDays)}d`,
        ]),
    ...(retiring
      ? [
          `  Coexistence${unit ? ` (${unit}s move one at a time)` : ''} :b3, after b2, ${Math.max(1, Math.round(coexist * 30))}d`,
          `  ${unit ? `Last ${unit} moved` : 'Cutover'} :milestone, b4, after b3, 0d`,
          '  section After cutover',
          `  Rollback window :c1, after b4, ${ROLLBACK_DAYS}d`,
          '  Decommission :c2, after c1, 14d',
        ]
      : ['  Sync in operation :milestone, b3, after b2, 0d']),
    '```',
  ].join('\n')
}

/** Cost consequences of a single-choice decision against the next feasible option; providers are priced as completed designs (compareOver). */
function decisionCostLines(state: QuestionState, e: Evaluation, kb: KnowledgeBase, answers: Answers, providers: OptionComparison[]): string[] {
  const q = state.question
  if (q.kind !== 'single' || !q.options) return []
  const label = (id: string) => q.options!.find((o) => o.id === id)?.label ?? id
  // Run plus people per month, and the transition and one-off costs where the alternative changes them (migration decisions).
  const vs = (own: Evaluation, alt: Evaluation, name: string) => {
    const extra = [
      ['transition', own.cost.transitionMonthly - alt.cost.transitionMonthly, '/mo'],
      ['one-off', own.cost.oneTime - alt.cost.oneTime, ''],
    ].flatMap(([what, d, unit]) => (Math.abs(d as number) >= 1 ? [`, ${what} ${signedMoney(d as number)}${unit}`] : []))
    return `- Cost: ${signedMoney(runAndPeople(own) - runAndPeople(alt))}/mo${extra.join('')} vs ${name}`
  }
  const ranked = state.recommendation.scores.filter((s) => s.feasible && s.optionId !== state.effectiveValue).sort((a, b) => b.score - a.score)
  const lines: string[] = []
  if (q.id === 'infra.cloud') {
    const compared = providers
    const own = compared.find((c) => c.option.id === state.effectiveValue)?.evaluation ?? e
    const next = ranked.map((s) => compared.find((c) => c.option.id === s.optionId && c.feasible)).find(Boolean)
    if (next) lines.push(vs(own, next.evaluation, next.option.label))
    const rejected = compared.filter((c) => c.option.id !== state.effectiveValue).map((c) => `${c.option.label} ${money(runAndPeople(c.evaluation))}/mo${c.feasible ? '' : ' (infeasible)'}`)
    if (rejected.length) lines.push(`- Rejected providers (run + people): ${rejected.join(', ')}`)
    return lines
  }
  const next = ranked[0]
  if (!next) return []
  const alt = evaluate(kb, { ...answers, [q.id]: { kind: 'value', value: next.optionId } })
  return [vs(e, alt, label(next.optionId))]
}

/** Components that read or write the tables of a decision whose fact names a component's technology (the table format's lake and catalog). */
function enginesOn(state: QuestionState, e: Evaluation): string[] {
  const id = state.question.id
  const subjects = new Set(e.architecture.components.filter((c) => c.def.techFrom?.fact === id || c.def.techSuffixFrom?.some((s) => s.fact === id)).map((c) => c.def.id))
  const peers = new Set(e.architecture.edges.flatMap((x) => (subjects.has(x.to) ? [x.from] : subjects.has(x.from) ? [x.to] : [])).filter((p) => !subjects.has(p)))
  const engines = e.architecture.components.filter((c) => peers.has(c.def.id)).map((c) => `${c.tech} (${c.def.label})`)
  return engines.length ? [`- Engines that read or write ${valueLabel(e, id)} on ${valueLabel(e, 'data.platform')}: ${engines.join('; ')}`] : []
}

function answerText(state: QuestionState, answers: Answers): string {
  const answer = answers[state.question.id]
  const label = (id: unknown) => state.question.options?.find((o) => o.id === id)?.label ?? String(id)
  const v = state.effectiveValue
  const base = Array.isArray(v) ? v.map(label).join(', ') || 'none' : state.question.kind === 'number' ? `${fmt(Number(v))} ${state.question.number?.unit ?? ''}` : label(v)
  if (answer?.kind === 'custom') return `${answer.text} (treated as ${label(answer.treatAs)})`
  if (answer?.kind === 'unknown') return `${base} (assumed)`
  return base
}

export function mermaidDiagram(e: Evaluation): string {
  const id = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '_')
  const lines = ['flowchart LR']
  const tiers = new Map<string, string[]>()
  for (const c of e.architecture.components) tiers.set(c.def.tier, [...(tiers.get(c.def.tier) ?? []), c.def.id])
  for (const [tier, members] of tiers) {
    // Prefixed so a tier never shares an id with a node in it (tier 'client' holds node 'client'), which Mermaid rejects as a cycle.
    lines.push(`  subgraph tier_${tier}["${tier}"]`)
    for (const m of members) {
      const c = e.architecture.components.find((x) => x.def.id === m)!
      lines.push(`    ${id(m)}["${c.def.label}<br/>${c.tech.replace(/"/g, "'")}${c.replicas > 1 ? ` x${c.replicas}` : ''}"]`)
    }
    lines.push('  end')
  }
  for (const edge of e.architecture.edges) {
    const arrow = edge.protocol === 'async' || edge.protocol === 'replication' || edge.protocol === 'cdc' ? '-.->' : '-->'
    lines.push(`  ${id(edge.from)} ${arrow}|"${edge.label.replace(/"/g, "'")}"| ${id(edge.to)}`)
  }
  return lines.join('\n')
}

// A data platform serves no requests, so its section reports what sizes the lake and the queries; the analytics add-on prints both.
export function capacityMarkdown(e: Evaluation, kb: KnowledgeBase): string {
  return [...(e.facts['profile.requestPath'] !== false ? [requestCapacity(e, kb)] : []), ...(e.facts['profile.dataPlatform'] === true ? [dataPlatformCapacity(e, kb)] : [])].join('\n\n')
}

function dataPlatformCapacity(e: Evaluation, kb: KnowledgeBase): string {
  const w = e.workload
  const n = (id: string) => (typeof e.facts[id] === 'number' ? (e.facts[id] as number) : 0)
  const rows = [
    ['Existing data loaded', `${fmt(n('data.history_tb'))} TB`],
    ['Data growth per year', `${fmt(n('data.growth_pct'))}%`],
    ['Source systems', String(w.sourceCount)],
    ...(typeof e.facts['source.volume_gb'] === 'number' ? [['Main source', fmtGb(n('source.volume_gb'))]] : []),
    ...(w.dbStorageGb > 0 ? [['Operational records copied in', fmtGb(w.dbStorageGb)]] : []),
    ['Report readers', fmt(w.analyticsUsers)],
    ['Query hours a day', fmt(w.analyticsHours)],
    ['Report freshness', valueLabel(e, 'data.freshness')],
    ['Lake size a year ahead', `${fmt(w.lakeStorageTb)} TB`],
    ['Data scanned per month', `${fmt(w.scannedTbMonth)} TB`],
  ]
  return [
    '| Analytics metric | Estimate |',
    '|---|---|',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    '',
    `Formulas: lake size = (operational records + existing data + data moved from an existing system) x (1 + growth per year); data scanned per month = lake size x ${Math.round(kb.reference.analyticsScanShare * 100)}% per 8 query hours x query hours a day / 8 x 30. ${e.architecture.components.some((c) => c.def.id === 'ingestion') ? 'Ingestion is priced per source system' : 'The existing system\'s sync method carries the data in (see the migration plan), so no separate ingestion is priced'}; the warehouse or capacity follows the lake size, the readers and the query hours.`,
  ].join('\n')
}

function requestCapacity(e: Evaluation, kb: KnowledgeBase): string {
  const w = e.workload
  // Only connection fleets and live-location clients use the connection count; elsewhere it is an unused default share of DAU.
  const connected = w.peakLocationQps > 0 || e.architecture.components.some((c) => c.def.sizing === 'wsGateway' || c.def.sizing === 'connections')
  const rows = [
    ['Daily active users', fmt(w.dau)],
    ['Average requests/s', fmt(w.avgQps)],
    ['Peak requests/s', fmt(w.peakQps)],
    ['Peak reads/s', fmt(w.peakReadQps)],
    ['Peak writes/s', fmt(w.peakWriteQps)],
    ['New data per year', fmtGb(w.storagePerYearGb)],
    ['Total stored (retention x replication)', fmtGb(w.totalStorageGb)],
    ['Database records (before replication)', fmtGb(w.dbStorageGb)],
    ['Peak egress', `${fmt(w.egressMbps)} Mbps`],
    ['Cache working set (20% of daily reads)', fmtGb(w.cacheMemoryGb)],
    ...(connected ? [['Concurrent connections', fmt(w.concurrentConnections)]] : []),
    ['Instance class (application tier)', instanceClass(w.peakQps / kb.reference.appInstanceQps).name],
  ]
  const ref = kb.reference
  return [
    '| Metric | Estimate |',
    '|---|---|',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    '',
    `Formulas: average QPS = DAU x requests per user / 86,400; peak = average x peak factor; writes = QPS / (1 + read ratio); new data per year = writes/s x 86,400 x 365 x record size (records over ${ref.blobThresholdKb} KB go to object storage and add a ${ref.metadataRowKb} KB database row) + DAU x uploads per user x 365 x media size (+ ${ref.embeddingKb} KB per retrieval chunk of each upload); total stored = new data per year x retention x replication factor (${ref.replicationFactor}).`,
    `Planning heuristics (fleets sized for ${Math.round(ref.targetUtilization * 100)}% peak utilization): ${fmt(ref.appInstanceQps)} req/s per app instance, ${fmt(ref.dbPrimaryWriteQps)} writes/s per relational primary, ${fmt(ref.dbReplicaReadQps)} reads/s per replica, ${ref.cacheNodeMemoryGb} GB per cache node, ${fmt(ref.wsConnectionsPerNode)} connections per real-time node.`,
  ].join('\n')
}

export function adrMarkdown(state: QuestionState, index: number, answers: Answers, consequences: string[] = []): string {
  const q = state.question
  const chosen = q.options?.find((o) => o.id === state.effectiveValue)
  const answer = answers[q.id]
  const status = answer?.kind === 'unknown' ? 'Proposed (accepted recommendation)' : 'Accepted'
  const alternatives = (q.options ?? []).filter((o) => o.id !== chosen?.id)
  const score = (id: string) => state.recommendation.scores.find((s) => s.optionId === id)
  return [
    `### ADR-${String(index).padStart(3, '0')}: ${q.title}`,
    '',
    `Status: ${status}`,
    '',
    `Context: ${q.prompt}${q.help ? ` ${q.help}` : ''}`,
    '',
    `Decision: ${answerText(state, answers)}.${chosen ? ` ${chosen.description}` : ''}`,
    '',
    'Rationale:',
    ...(state.recommendation.optionId === chosen?.id ? state.recommendation.reasons : [`Chosen by the engineer; the engine recommends "${q.options?.find((o) => o.id === state.recommendation.optionId)?.label ?? 'n/a'}".`]).map((r) => `- ${r}`),
    '',
    'Consequences:',
    ...(chosen ? [...chosen.pros.map((p) => `- (+) ${p}`), ...chosen.cons.map((c) => `- (-) ${c}`), ...(score(chosen.id)?.penalties ?? []).map((p) => `- (-) ${p}`)] : ['- See custom notes.']),
    ...consequences,
    '',
    'Alternatives considered:',
    ...alternatives.map((o) => {
      const s = score(o.id)
      const why = s && !s.feasible ? `infeasible: ${s.infeasibleReason}` : `score ${s?.score.toFixed(1) ?? 'n/a'}; ${o.cons.slice(0, 2).join('; ') || o.description}`
      return `- ${o.label} (${why})`
    }),
    '',
    `Sources: ${q.sources.map(cite).join('; ')}`,
  ].join('\n')
}

function guidance(e: Evaluation): string[] {
  const has = (id: string) => e.architecture.components.some((c) => c.def.id === id)
  const strong = e.facts['data.strongConsistency'] === true
  // The build order follows the task: an app ships its request path, a data platform one source end to end, an AI app the model call with its evals.
  const requestPath = e.facts['profile.requestPath'] !== false
  const model = has('llm-api') || has('llm-serving')
  // A platform fed only by the kept existing system takes that system's feed (the migration plan's sync) instead of an ingestion tool.
  const dataPath = `${has('ingestion') ? 'one source -> ingestion' : "the existing system's feed"} -> lake or warehouse registered in the catalog -> the first BI report, with pipeline CI/CD, data-quality checks and lineage. Add the next source only once it loads on schedule.`
  const steps: string[] = [
    ...(e.facts['profile.retire'] === true
      ? ['Migrate first: inventory the sources, convert the schema and code, run two full trial migrations on a production copy, then load, catch up and cut over with the runbook and rollback path of the migration plan.']
      : []),
    ...(requestPath
      ? ['Ship the core path: clients -> DNS -> application -> primary database, with backups, CI/CD and basic monitoring. Benchmark it before adding anything else (primer scaling_aws: benchmark, profile, fix the bottleneck, repeat).']
      : e.facts['profile.dataPlatform'] === true
        ? [`Ship ${dataPath}`]
        : []),
    ...(model ? ['Ship the model call with tracing and an evaluation set of real questions before tuning prompts; gate every prompt or model change on the evaluation scores.'] : []),
  ]
  // A database is partitioned when the design splits it (sharding or federation), not when it runs a replica set.
  const partitioned = ['hash_sharding', 'range_sharding', 'federation'].includes(String(e.facts['data.partitioning']))
  const later: [boolean, string][] = [
    [model && (has('vector-db') || has('embeddings')), 'Add retrieval: parse and chunk the documents, embed them, and measure retrieval quality on the evaluation set before widening the corpus.'],
    [has('guardrails'), 'Put the guardrails in front of the model: input and output filters, PII redaction and limits on tokens and cost per user.'],
    [has('agent-runtime'), 'Add agents last: give each tool the narrowest permissions, log every action, and require approval for writes until the evaluations show they are safe.'],
    [requestPath && has('ingestion'), `Add the analytics platform: ${dataPath}`],
    [requestPath && has('object-storage'), 'Move files to object storage with pre-signed uploads; keep the database for records only.'],
    [has('cold-storage'), 'Add the lifecycle rule that moves objects older than a year to the cold class; keep often-read objects in the standard class.'],
    [has('lb'), 'Run at least two stateless application instances behind the load balancer across availability zones; move sessions out of process.'],
    [has('cdn'), 'Front static and media content with the CDN using versioned URLs.'],
    [has('cache'), 'Add the cache for the hottest read paths first; measure hit ratio and add TTL jitter.'],
    [has('db-replica') && !strong, 'Add read replicas and route read-only queries to them; keep read-your-writes on the primary.'],
    [has('db-replica') && strong, 'Add one failover standby per database partition and keep all reads on the primary; strong consistency rules out reading from asynchronous replicas.'],
    [requestPath && (has('queue') || has('stream')), 'Move slow work (media, notifications, fan-out) to the queue with idempotent workers and a dead-letter queue.'],
    [has('search'), 'Index searchable data through change data capture into the search cluster.'],
    [has('ws-gateway'), 'Introduce the real-time gateway with heartbeats, sticky routing and pub/sub between nodes.'],
    [has('db-primary') && partitioned, 'Partition the database once its load (writes plus the reads it must serve) or size reaches about 60% of one node; choose a high-cardinality shard key.'],
    [has('api-gateway'), 'Centralize authentication, quotas and routing in the API gateway.'],
    [has('standby-region') || has('peer-region'), 'Add the second region last; rehearse failover and measure RTO/RPO.'],
  ]
  for (const [applies, text] of later) if (applies) steps.push(text)
  return steps.map((text, i) => `${i + 1}. ${text}`)
}

/** providers: compareOver on infra.cloud with the project's prices, passed in when the caller already has it (the cost per provider CSV). */
export function generateMarkdown(project: Project, e: Evaluation, kb: KnowledgeBase, providers?: OptionComparison[]): string {
  const active = e.questions.filter((q) => q.active && q.status !== 'pending')
  const requirements = active.filter((q) => !q.question.isDecision)
  const decisions = active.filter((q) => q.question.isDecision)
  const assumptions = active.filter((q) => q.status === 'unknown')
  const pending = e.questions.filter((q) => q.active && q.status === 'pending')
  const categoryLabel = new Map(kb.categories.map((c) => [c.id, c.label]))
  const priced = withOverrides(kb, project.overrides)
  const compared = providers ?? compareOver(priced, project.answers, 'infra.cloud', e)
  const migrating = e.facts['profile.migration'] === true
  const { cost } = e
  const nonprod = cost.byKind.nonprod ?? 0
  const support = cost.byKind.support ?? 0
  const overrides = project.overrides ?? {}
  const overrideCount =
    Object.keys({ ...overrides.reference, ...overrides.unitPrice }).length + Object.keys(overrides.replicas ?? {}).length + (overrides.exclude?.length ?? 0) + (overrides.discountPct ? 1 : 0) + (overrides.extraLines?.length ?? 0)
  let n = 0
  const section = (title: string) => `## ${++n}. ${title}`
  return [
    `# ${project.name}: Architecture Specification`,
    '',
    `Generated ${new Date().toISOString().slice(0, 10)} by System Architecture Designer (knowledge base v${kb.version}).`,
    '',
    project.description ? `> ${project.description}` : '',
    '',
    section('Summary'),
    '',
    `- Components: ${e.architecture.components.length}; connections: ${e.architecture.edges.length}`,
    `- Estimated request-path availability: ${formatAvailability(e.availability)}`,
    `- Rough monthly infrastructure cost: ${money(e.monthlyCost)} (heuristic list prices with the region, commitment and project overrides applied)`,
    `- Cost by kind: run ${money(cost.monthly - nonprod - support)}/month${nonprod ? ` (+ non-production ${money(nonprod)})` : ''}${support ? ` (+ vendor support ${money(support)})` : ''}, people ${money(cost.people)}/month, one-off ${money(cost.oneTime)}, transition ${money(cost.transitionMonthly)}/month`,
    `- Cost by tier: ${Object.entries(cost.byTier).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1]).map(([tier, v]) => `${tier} ${money(v)}`).join(', ') || 'none'}`,
    `- Cost basis: provider ${valueLabel(e, 'infra.cloud')}, region ${valueLabel(e, 'infra.region')}, commitment ${valueLabel(e, 'infra.commitment')}, environments ${valueLabel(e, 'ops.environments')}, support ${valueLabel(e, 'ops.support')}, list prices as of ${oldestAsOf(e) ?? 'n/a'} (oldest offer), ${overrideCount} override(s)`,
    ...(migrating && (cost.oneTime > 0 || cost.transitionMonthly > 0)
      ? [`- Migration: transition ${money(cost.transitionMonthly)}/month for ${e.facts['migration.coexistMonths'] ?? 0} months of coexistence and ${fmt(Number(e.facts['mig.preCutoverMonths'] ?? 0))} months of trials, load and catch-up before it, ${money(cost.oneTime)} one-off (transfer and engineering estimate), ${money(cost.transitionTotal)} in total until cutover; payback ${cost.paybackMonths === null ? 'n/a' : `${Math.ceil(cost.paybackMonths)} months`}`]
      : []),
    `- Decisions recorded: ${decisions.length}; open questions: ${pending.length}`,
    '',
    section('Requirements'),
    '',
    '| Area | Requirement | Value |',
    '|---|---|---|',
    ...requirements.map((q) => `| ${categoryLabel.get(q.question.category)} | ${cell(q.question.title)} | ${cell(answerText(q, project.answers))} |`),
    '',
    assumptions.length ? '### Assumptions\n\n' + assumptions.map((q) => `- ${q.question.title}: ${answerText(q, project.answers)}`).join('\n') : '',
    '',
    section('Capacity estimates'),
    '',
    capacityMarkdown(e, kb),
    '',
    section('Architecture diagram'),
    '',
    '```mermaid',
    mermaidDiagram(e),
    '```',
    '',
    section('Components and technology justification'),
    '',
    '| Component | Technology | Instances | Monthly | Why | Sizing |',
    '|---|---|---|---|---|---|',
    ...e.architecture.components.map((c) => `| ${cell(c.def.label)} | ${cell(c.tech)} | ${c.replicas} | ${money(c.monthlyCost)} | ${cell(c.def.reason)} | ${cell(c.sizingNote)} |`),
    '',
    section('Cost estimate'),
    '',
    '| Component | Technology | Units | Unit price | Class | Kind | Monthly | Share |',
    '|---|---|---|---|---|---|---|---|',
    ...costEstimateRows(e).map((r) => `| ${cell(r.component)} | ${cell(r.technology)} | ${fmt(round2(r.units))} | ${r.unitPrice > 0 && r.unitPrice < 10 ? `$${r.unitPrice.toFixed(2)}` : money(r.unitPrice)} | ${r.instanceClass || '-'} | ${r.kind} | ${money(r.monthly)} | ${r.share === null ? '-' : `${(r.share * 100).toFixed(1)}%`} |`),
    ...costLines(e).filter((l) => !e.architecture.components.some((c) => c.def.id === l.key)).map((l) => `| ${cell(l.label)} | - | - | - | - | ${l.kind} | ${money(l.monthly)} | - |`),
    '',
    `Cost basis: ${valueLabel(e, 'infra.cloud')} list prices as of ${oldestAsOf(e) ?? 'n/a'}, region ${valueLabel(e, 'infra.region')}, commitment ${valueLabel(e, 'infra.commitment')}, environments ${valueLabel(e, 'ops.environments')}. Heuristic public list prices, not quotes; one-off lines are paid once and carry no share.`,
    '',
    section('Provider service map'),
    '',
    providerMapMarkdown(e, kb, compared),
    '',
    section('Constraints and overrides'),
    '',
    constraintsMarkdown(project, e, kb),
    '',
    section('Validation findings'),
    '',
    ...(e.findings.length ? e.findings.map((f) => `- [${f.rule.severity.toUpperCase()}] ${f.rule.title}: ${f.rule.message} Fix: ${f.rule.fix}`) : ['No findings.']),
    '',
    section('Architecture Decision Records'),
    '',
    ...decisions.map(
      (d, i) =>
        adrMarkdown(d, i + 1, project.answers, [...decisionCostLines(d, e, priced, project.answers, compared), ...(d.question.id === 'data.table_format' ? enginesOn(d, e) : [])]) + '\n',
    ),
    section('Implementation guidance'),
    '',
    'Build in this order. Each step should be triggered by a measured bottleneck, not by the diagram.',
    '',
    ...guidance(e),
    '',
    ...(migrating ? [section('Migration plan'), '', migrationMarkdown(e), ''] : []),
    ...(pending.length ? [section('Open questions'), '', ...pending.map((q) => `- ${q.question.prompt}`)] : []),
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n')
}
