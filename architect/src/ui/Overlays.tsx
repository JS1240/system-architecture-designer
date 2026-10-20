import { useEffect, useRef, useState } from 'react'
import type { Evaluation } from '../domain/types'
import { fmt, fmtGb, fmtUnits, formatAvailability, offerFor, providerAlternatives } from '../engine/architecture'
import { transitionMonths } from '../engine/evaluate'
import { diffEvaluations, isEmptyDiff, runAndPeople, type ArchitectureDiff } from '../engine/explore'
import { kb } from '../knowledge'
import { cite, sourceUrl } from '../knowledge/sources'
import { utilizationColor } from '../scene/palette'
import { PROTOCOL_COLOR, PROTOCOL_LABEL, TIER_COLOR, TIER_LABEL } from '../scene/layout'
import { useProjects } from '../store/projectStore'
import { ComponentCost, OverrideDot } from './CostPanel'
import { isOverridden, overrideCount } from './costing'
import { duration } from './migrationFigures'

const label = (e: Evaluation, id: string) => e.architecture.components.find((c) => c.def.id === id)?.def.label ?? kb.components.find((c) => c.id === id)?.label ?? id
const money = (n: number) => `$${fmt(n)}`
const names = (ids: string[], e: Evaluation) => (ids.length > 4 ? `${ids.slice(0, 4).map((id) => label(e, id)).join(', ')} and ${ids.length - 4} more` : ids.map((id) => label(e, id)).join(', '))

/** 'Transition $X/mo x N mo + $Y one-off; payback N mo' while a migration has transition or one-off costs. */
function transitionLine(e: Evaluation): string | undefined {
  const { oneTime, transitionMonthly, paybackMonths } = e.cost
  // A new build can carry one-off costs too (an embeddings backfill); only a migration has a transition.
  if (e.facts['profile.migration'] !== true || (oneTime <= 0 && transitionMonthly <= 0)) return undefined
  // Building on existing data retires nothing, so it has no coexistence months or payback, only the one-off work.
  if (e.facts['profile.replace'] !== true) return `One-off ${money(oneTime)}`
  const months = transitionMonths(e.facts)
  const payback = paybackMonths === null ? 'payback n/a' : `payback ${Math.ceil(paybackMonths)} mo`
  return `Transition ${money(transitionMonthly)}/mo x ${fmt(months)} mo + ${money(oneTime)} one-off; ${payback}`
}

export function Hud({ evaluation, onOpenCost }: { evaluation: Evaluation; onOpenCost: () => void }) {
  const overrides = useProjects((s) => overrideCount(s.activeId ? s.projects[s.activeId]?.overrides : undefined))
  const edit = useProjects((s) => s.edit)
  const showCategory = useProjects((s) => s.showCategory)
  const w = evaluation.workload
  // Until traffic is set, request and storage figures are zeros rather than results.
  const trafficPending = evaluation.questions.some((s) => s.question.id === 'traffic.dau' && s.active && s.status === 'pending')
  const setTraffic = { value: 'Set traffic', sub: 'opens the daily active users question', tone: 'link', onClick: () => edit('traffic.dau'), title: 'Open the daily active users question' }
  const { cost } = evaluation
  const target = evaluation.facts['reliability.nines']
  const budget = evaluation.facts['infra.budgetUsd']
  const availabilityOk = typeof target !== 'number' || evaluation.availability >= target
  const costOk = typeof budget !== 'number' || evaluation.monthlyCost <= budget
  // A data platform serves no requests, so its tiles show what sizes it: the analytics data and who queries it.
  const fact = (id: string) => (typeof evaluation.facts[id] === 'number' ? (evaluation.facts[id] as number) : undefined)
  const [growth, sources, viewers, hours] = ['data.growth_pct', 'data.source_count', 'data.analytics_users', 'data.analytics_hours'].map(fact)
  const open = (id: string, what: string) => ({ onClick: () => edit(id), title: `Open the ${what} question` })
  const requestTiles = [
    trafficPending ? { label: 'Peak traffic', ...setTraffic } : { label: 'Peak traffic', value: `${fmt(w.peakQps)} req/s`, sub: `${fmt(w.peakReadQps)} reads · ${fmt(w.peakWriteQps)} writes` },
    trafficPending ? { label: 'Storage', ...setTraffic } : { label: 'Storage', value: fmtGb(w.totalStorageGb), sub: `${fmtGb(w.storagePerYearGb)} new per year` },
  ]
  const dataTiles = [
    {
      label: 'Analytics data',
      // The lake a year ahead (workload.ts): existing data, records copied in and data moved from an existing system, with growth.
      value: w.lakeStorageTb === 0 ? 'none yet' : fmtGb(w.lakeStorageTb * 1024),
      sub: ['a year ahead', growth !== undefined && `${fmtUnits(growth)}% growth per year`, sources !== undefined && `${fmtUnits(sources)} source${sources === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
      ...open('data.history_tb', 'existing analytics data'),
    },
    {
      label: 'Report viewers',
      value: viewers === undefined ? 'not set' : fmtUnits(viewers),
      sub: hours === undefined ? 'who reads the reports' : `${fmtUnits(hours)} query h/day`,
      ...open('data.analytics_users', 'report viewers'),
    },
  ]
  const stats: { label: string; value: string; sub: string; tone?: string; onClick?: () => void; title?: string }[] = [
    // No request path: a data platform shows its data tiles; a bought SaaS (a CRM) is sized by its users and the migration tile, so it shows neither.
    ...(evaluation.facts['profile.requestPath'] !== false ? requestTiles : evaluation.facts['profile.dataPlatform'] === true ? dataTiles : []),
    {
      label: 'Availability',
      // An empty design has nothing to estimate yet, not the region's 99.99%.
      value: evaluation.architecture.components.length === 0 ? 'n/a' : formatAvailability(evaluation.availability),
      sub: evaluation.architecture.components.length === 0 ? 'no components yet' : typeof target === 'number' ? `target ${target}%` : 'no target yet',
      tone: availabilityOk ? 'ok' : 'danger',
      onClick: () => showCategory('reliability'),
      title: 'Open the Reliability questions in the outline',
    },
    { label: 'Components', value: String(evaluation.architecture.components.length), sub: `${evaluation.architecture.edges.length} data flows` },
  ]
  // A migration that moves data shows its own copy time, the cutover against the window and the months both systems run.
  const copyHours = fact('mig.bulkHours')
  const archiveHours = fact('mig.archiveHours') ?? 0
  const cutover = fact('mig.cutoverHours')
  if (copyHours !== undefined && cutover !== undefined && evaluation.facts['source.history'] !== 'none') {
    const replacing = evaluation.facts['profile.replace'] === true
    const window = fact('migration.downtimeHours') ?? 8
    const months = fact('migration.coexistMonths') ?? 0
    stats.push({
      label: 'Migration',
      value: `${duration(copyHours + archiveHours)} copy`,
      sub: `${archiveHours > 0 ? `incl. ${duration(archiveHours)} archive · ` : ''}${replacing ? `cutover ${duration(cutover)} vs ${duration(window)} window · ${fmtUnits(months)} mo coexistence` : 'initial load; the old system stays'}`,
      tone: replacing && cutover > window ? 'danger' : replacing ? 'ok' : undefined,
      ...open('migration.link', 'transfer link'),
    })
  }
  // The transition line already carries the one-off amount, so it is printed on its own only without one.
  const transition = transitionLine(evaluation)
  const costLines = [
    cost.people > 0 && `Infrastructure ${money(evaluation.monthlyCost)} + people ${money(cost.people)}`,
    !transition && cost.oneTime > 0 && `One-off ${money(cost.oneTime)}`,
    transition ?? (cost.transitionMonthly > 0 && `Transition ${money(cost.transitionMonthly)}/mo`),
    overrides > 0 && `${overrides} override${overrides === 1 ? '' : 's'}`,
  ].filter((line): line is string => !!line)
  const stat = (s: (typeof stats)[number]) => {
    const body = (
      <>
        <span className="eyebrow">{s.label}</span>
        <span className="hud-value mono">{s.value}</span>
        <span className="hud-sub faint">{s.sub}</span>
      </>
    )
    return s.onClick ? (
      <button key={s.label} className={`hud-stat hud-button ${s.tone ? `tone-${s.tone}` : ''}`} onClick={s.onClick} title={s.title}>
        {body}
      </button>
    ) : (
      <div key={s.label} className={`hud-stat ${s.tone ? `tone-${s.tone}` : ''}`}>
        {body}
      </div>
    )
  }
  return (
    <div className="hud" role="group" aria-label="Architecture metrics">
      {stats.slice(0, 3).map(stat)}
      <button className={`hud-stat hud-button tone-${costOk ? 'ok' : 'warn'}`} onClick={onOpenCost} title="Open the cost breakdown">
        <span className="eyebrow">
          Monthly cost {overrides > 0 && <OverrideDot title={`${overrides} override${overrides === 1 ? '' : 's'} in this project`} />}
        </span>
        <span className="hud-value mono">
          {money(runAndPeople(evaluation))}/mo
          {typeof budget === 'number' && budget > 0 && <span className="hud-budget"> · infrastructure {Math.round((evaluation.monthlyCost / budget) * 100)}% of {money(budget)} budget</span>}
        </span>
        <span className="hud-sub faint">{typeof budget === 'number' ? 'click for the breakdown' : 'rough estimate · click for the breakdown'}</span>
        {costLines.map((line) => (
          <span key={line} className="hud-sub faint">
            {line}
          </span>
        ))}
      </button>
      {stats.slice(3).map(stat)}
    </div>
  )
}

export function Legend() {
  const [open, setOpen] = useState(false)
  const protocols = ['http', 'ws', 'query', 'async', 'replication', 'cdc', 'telemetry'] as const
  return (
    <div className={`legend ${open ? 'open' : ''}`}>
      <button className="btn btn-ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        Legend
      </button>
      {open && (
        <div className="legend-body">
          <div className="eyebrow">Tiers</div>
          {(Object.keys(TIER_LABEL) as (keyof typeof TIER_LABEL)[]).map((t) => (
            <div key={t} className="legend-row">
              <span className="swatch" style={{ background: TIER_COLOR[t] }} />
              {TIER_LABEL[t]}
            </div>
          ))}
          <div className="eyebrow">Flows (dashed = asynchronous)</div>
          {protocols.map((p) => (
            <div key={p} className="legend-row">
              <span className="swatch line" style={{ background: PROTOCOL_COLOR[p] }} />
              {PROTOCOL_LABEL[p]}
            </div>
          ))}
          <div className="eyebrow">Ring = utilization at peak</div>
          <div className="legend-row">
            <span className="swatch" style={{ background: utilizationColor(0.5) }} /> under 70%
            <span className="swatch" style={{ background: utilizationColor(0.8) }} /> 70-90%
            <span className="swatch" style={{ background: utilizationColor(1) }} /> over 90%
          </div>
          <div className="faint">Drag to rotate · right-drag to pan · scroll to zoom · click a building</div>
        </div>
      )}
    </div>
  )
}

export function Inspector({ evaluation }: { evaluation: Evaluation }) {
  const overrides = useProjects((s) => (s.activeId ? s.projects[s.activeId]?.overrides : undefined))
  const selected = useProjects((s) => s.selectedComponent)
  const select = useProjects((s) => s.select)
  const edit = useProjects((s) => s.edit)
  const c = evaluation.architecture.components.find((x) => x.def.id === selected)
  if (!c) return null
  const incoming = evaluation.architecture.edges.filter((e) => e.to === c.def.id)
  const outgoing = evaluation.architecture.edges.filter((e) => e.from === c.def.id)
  const decision = c.def.techFrom ? kb.questions.find((q) => q.id === c.def.techFrom!.fact) : undefined
  const offer = c.offer && offerFor(kb, c.def, evaluation.facts)
  const providerLabel = (id: string) => kb.questions.find((q) => q.id === 'infra.cloud')?.options?.find((o) => o.id === id)?.label ?? id
  const alternatives = offer && offer.provider !== 'any' ? providerAlternatives(kb, c.def, evaluation.facts) : []
  const overridden = isOverridden(overrides, c)
  return (
    <aside className="inspector" aria-label={`${c.def.label} details`}>
      <header>
        <div>
          <div className="eyebrow" style={{ color: TIER_COLOR[c.def.tier] }}>{TIER_LABEL[c.def.tier]}</div>
          <h3>
            {c.def.label}
            {overridden && <OverrideDot />}
          </h3>
          <div className="muted">{c.tech}</div>
        </div>
        <button className="btn btn-ghost" onClick={() => select(null)} aria-label="Close inspector">
          Close
        </button>
      </header>
      <p>{c.def.description}</p>
      <dl className="kv">
        <dt>Instances</dt>
        <dd className="mono">{c.replicas}</dd>
        {c.utilization > 0 && (
          <>
            <dt>Peak utilization</dt>
            <dd>
              <span className="meter">
                <span style={{ width: `${Math.min(100, c.utilization * 100)}%`, background: utilizationColor(c.utilization) }} />
              </span>
              <span className="mono">{Math.round(c.utilization * 100)}%</span>
            </dd>
          </>
        )}
        <dt>{c.costKind === 'one_time' ? 'One-off cost' : 'Monthly cost'}</dt>
        <dd className="mono">{money(c.monthlyCost)}</dd>
        {(c.phase === 'transition' || c.def.tier === 'legacy') && (
          <>
            <dt>Phase</dt>
            <dd>{c.phase === 'transition' ? 'Removed at cutover' : 'Kept (integrate)'}</dd>
          </>
        )}
        {offer && (
          <>
            <dt>Service</dt>
            <dd>
              {offer.name} <span className="faint">({offer.monthlyCostPerUnit !== undefined ? `$${offer.monthlyCostPerUnit} per ${offer.unit ?? 'unit'}, ` : ''}list prices as of {offer.asOf})</span>
            </dd>
          </>
        )}
        {alternatives.length > 0 && (
          <>
            <dt>On other providers</dt>
            <dd>{alternatives.map((a) => `${providerLabel(a.provider)}: ${a.name ?? 'not offered'}`).join(' · ')}</dd>
          </>
        )}
      </dl>
      <ComponentCost c={c} e={evaluation} />
      <div className="section">
        <div className="eyebrow">Why it is here</div>
        <p>{c.def.reason}</p>
        {decision &&
          (evaluation.questions.find((s) => s.question.id === decision.id)?.active ? (
            <p className="faint">
              Technology comes from the decision{' '}
              <button className="link" onClick={() => edit(decision.id)} title="Open this question in the sidebar">
                "{decision.title}"
              </button>
              .
            </p>
          ) : (
            <p className="faint">Technology comes from the decision "{decision.title}".</p>
          ))}
      </div>
      <div className="section">
        <div className="eyebrow">Sizing</div>
        <p>{c.sizingNote}</p>
        <p className="faint">{c.def.scalingNotes}</p>
      </div>
      <div className="section">
        <div className="eyebrow">Responsibilities</div>
        <ul>{c.def.responsibilities.map((r) => <li key={r}>{r}</li>)}</ul>
      </div>
      {(incoming.length > 0 || outgoing.length > 0) && (
        <div className="section">
          <div className="eyebrow">Data flows</div>
          <ul className="flows">
            {incoming.map((e) => (
              <li key={e.id}>
                <span className="swatch line" style={{ background: PROTOCOL_COLOR[e.protocol] }} />
                <button className="link" onClick={() => select(e.from)}>{label(evaluation, e.from)}</button> → here: {e.label}
                {e.qps > 0 && <span className="faint mono"> {fmt(e.qps)}/s</span>}
              </li>
            ))}
            {outgoing.map((e) => (
              <li key={e.id}>
                <span className="swatch line" style={{ background: PROTOCOL_COLOR[e.protocol] }} />
                here → <button className="link" onClick={() => select(e.to)}>{label(evaluation, e.to)}</button>: {e.label}
                {e.qps > 0 && <span className="faint mono"> {fmt(e.qps)}/s</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="section">
        <div className="eyebrow">Sources</div>
        <ul className="sources">
          {c.def.sources.map((s) => (
            <li key={s.title} className="faint">
              {sourceUrl(s) ? (
                <a href={sourceUrl(s)} target="_blank" rel="noreferrer">
                  {cite(s)}
                </a>
              ) : (
                cite(s)
              )}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}

function describeDiff(d: ArchitectureDiff, before: Evaluation, after: Evaluation): string[] {
  const out: string[] = []
  if (d.added.length) out.push(`Added ${names(d.added, after)}`)
  if (d.removed.length) out.push(`Removed ${names(d.removed, before)}`)
  for (const r of d.rescaled.slice(0, 2)) out.push(`${label(after, r.id)}: ${r.from} → ${r.to} instances`)
  for (const r of d.retech.slice(0, 2)) out.push(`${label(after, r.id)}: ${r.from} → ${r.to}`)
  // An override or a new answer can re-decide assumed answers (a standby region once a replica is excluded), which explains added components.
  for (const r of d.redecided.slice(0, 2)) out.push(`Assumed ${r.title}: ${r.from} → ${r.to}`)
  if (d.redecided.length > 2) out.push(`${d.redecided.length - 2} more assumed answer(s) changed`)
  if (d.newQuestions.length) out.push(`${d.newQuestions.length} new question(s) unlocked`)
  if (d.droppedQuestions.length) out.push(`${d.droppedQuestions.length} question(s) no longer relevant`)
  if (d.findingsAdded.length) out.push(`${d.findingsAdded.length} new finding(s): ${after.findings.find((x) => x.rule.id === d.findingsAdded[0])?.rule.title}${d.findingsAdded.length > 1 ? ', ...' : ''}`)
  if (d.findingsResolved.length) out.push(`${d.findingsResolved.length} finding(s) resolved`)
  if (Math.abs(d.costDelta) >= 1) out.push(`Cost ${d.costDelta > 0 ? '+' : '-'}${money(Math.abs(d.costDelta))}/month`)
  return out
}

export function ChangeToast({ evaluation, hidden }: { evaluation: Evaluation; hidden: boolean }) {
  const previous = useRef<Evaluation | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const undo = useProjects((s) => s.undo)
  const undoLabel = useProjects((s) => (s.activeId ? s.history[s.activeId]?.past.at(-1)?.label : undefined))
  useEffect(() => {
    const before = previous.current
    previous.current = evaluation
    if (!before) return
    const d = diffEvaluations(before, evaluation)
    if (isEmptyDiff(d)) return
    setLines(describeDiff(d, before, evaluation))
    const t = setTimeout(() => setLines([]), 6500)
    return () => clearTimeout(t)
  }, [evaluation])
  if (lines.length === 0 || hidden) return null
  return (
    <div className="toast" role="status" aria-live="polite">
      <div className="toast-head">
        <div className="eyebrow">Architecture updated</div>
        {undoLabel && (
          <button className="btn btn-ghost" onClick={undo} title={`Undo ${undoLabel}`}>
            Undo
          </button>
        )}
      </div>
      <ul>{lines.map((l) => <li key={l}>{l}</li>)}</ul>
    </div>
  )
}

export function WhatIfBanner({ base, preview }: { base: Evaluation; preview: Evaluation }) {
  const commit = useProjects((s) => s.commitWhatIf)
  const discard = useProjects((s) => s.setWhatIf)
  const whatIfLabel = useProjects((s) => s.whatIfLabel)
  const lines = describeDiff(diffEvaluations(base, preview), base, preview)
  return (
    <div className="whatif" role="status">
      <div>
        <div className="eyebrow">{whatIfLabel ? `What-if: ${whatIfLabel}` : 'Preview of this option'}</div>
        <div className="whatif-lines">{lines.length ? lines.join(' · ') : 'No architectural change.'}</div>
      </div>
      {whatIfLabel && (
        <div className="whatif-actions">
          <button className="btn btn-primary" onClick={commit}>Apply</button>
          <button className="btn" onClick={() => discard(null)}>Discard</button>
        </div>
      )}
    </div>
  )
}
