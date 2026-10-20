import { useMemo, useState } from 'react'
import type { Answers, ComponentInstance, CostKind, Evaluation, ExtraCostLine, KnowledgeBase, NumericReferenceKey, Overrides, Question, Tier } from '../domain/types'
import { fmt, fmtUnits, money, offerFor, signedMoney, unitMoney } from '../engine/architecture'
import { referencedFacts } from '../engine/conditions'
import { evaluate } from '../engine/evaluate'
import { costLevers, diffEvaluations, horizonCost, LEVER_HORIZON_MONTHS, optionChange } from '../engine/explore'
import { describePriceKey, priceScope, withOverrides } from '../engine/overrides'
import { factProducers } from '../engine/questions'
import { costLines } from '../docs/generate'
import { kb as baseKb } from '../knowledge'
import { referenceInfo } from '../knowledge/reference'
import { TIER_COLOR, TIER_LABEL } from '../scene/layout'
import { COST_KINDS, DISCOUNT_PROVIDERS, TIERS, useProjects } from '../store/projectStore'
import { isOverridden, lineCost, overrideCount, useApply, useEditOverrides, withEntry } from './costing'
import { useKnowledge } from './useEvaluation'

type Tab = 'breakdown' | 'prices'

const KIND_LABEL: Record<string, string> = { one_time: 'One-off', run: 'Infrastructure', license: 'Licenses', transfer: 'Data transfer', nonprod: 'Staging and dev', support: 'Support and maintenance', people: 'People' }
const KIND_COLOR: Record<string, string> = { run: 'var(--accent)', license: 'var(--purple)', transfer: 'var(--warn)', nonprod: 'var(--info)', support: 'var(--text-muted)', people: 'var(--ok)' }
const producers = factProducers(baseKb)
const referenceKeys = Object.entries(baseKb.reference)
  .filter(([, v]) => typeof v === 'number')
  .map(([k]) => k as NumericReferenceKey)

export const OverrideDot = ({ title = 'Overridden in this project' }: { title?: string }) => <span className="override-dot" title={title} aria-label={title} role="img" />

/** A number input that commits on Enter or blur; blank or invalid input (0 when `positive`) keeps the current value. */
export function NumberOverride({
  label,
  value,
  overridden,
  positive = false,
  onCommit,
  onReset,
}: {
  label: string
  value: number
  overridden: boolean
  positive?: boolean
  onCommit: (v: number) => void
  onReset: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    const v = Number(draft)
    setDraft(null)
    if (draft !== null && draft.trim() !== '' && Number.isFinite(v) && (positive ? v > 0 : v >= 0)) onCommit(v)
  }
  return (
    <span className="override-input">
      <input
        className="input mono"
        aria-label={label}
        inputMode="decimal"
        value={draft ?? String(Number(value.toPrecision(6)))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {overridden && (
        <button className="btn btn-ghost" onClick={onReset} aria-label={`Reset ${label}`}>
          Reset
        </button>
      )}
    </span>
  )
}

/** The decisions that pick this component's technology or price: its techFrom fact and the facts its provider offer depends on. */
function drivers(kb: KnowledgeBase, c: ComponentInstance, e: Evaluation): Question[] {
  const facts = new Set<string>()
  if (c.def.techFrom) facts.add(c.def.techFrom.fact)
  const offer = offerFor(kb, c.def, e.facts)
  if (offer) {
    referencedFacts(offer.when, facts)
    if (offer.provider !== 'any') facts.add('infra.cloud')
  }
  const ids = new Set([...facts].flatMap((fact) => [fact, ...(producers.get(fact) ?? [])]))
  return e.questions
    .filter((s) => s.active && ids.has(s.question.id))
    .map((s) => s.question)
    .sort((a, b) => Number(b.isDecision) - Number(a.isDecision))
    .slice(0, 2)
}

/** Inspector section: what the component's cost is made of, and the project's overrides for it (unit price, pinned instances, exclusion). */
export function ComponentCost({ c, e }: { c: ComponentInstance; e: Evaluation }) {
  const { overrides, edit } = useEditOverrides()
  const answers = useProjects((s) => (s.activeId ? s.projects[s.activeId]?.answers : undefined))
  const select = useProjects((s) => s.select)
  const [confirmExclude, setConfirmExclude] = useState(false)
  const id = c.def.id
  const key = c.priceKey
  const price = overrides.unitPrice?.[key]
  const pinned = overrides.replicas?.[id]
  // What leaving the component out changes, computed only once the engineer asks to exclude it.
  const impact = useMemo(() => {
    if (!confirmExclude || !answers) return null
    const current = evaluate(withOverrides(baseKb, overrides), answers)
    const without = evaluate(withOverrides(baseKb, { ...overrides, exclude: [...(overrides.exclude ?? []), id] }), answers)
    const d = diffEvaluations(current, without)
    const name = (x: string) => current.architecture.components.find((k) => k.def.id === x)?.def.label ?? x
    return {
      edges: current.architecture.edges.filter((edge) => edge.from === id || edge.to === id).map((edge) => `${name(edge.from)} → ${name(edge.to)}: ${edge.label}`),
      removed: d.removed.filter((x) => x !== id).map(name),
      // Assumed answers re-resolve on the design without it, so what the engine adds in its place is shown before it applies.
      added: d.added.map((x) => without.architecture.components.find((k) => k.def.id === x)?.def.label ?? x),
      redecided: d.redecided.map((r) => `${r.title}: ${r.from} → ${r.to}`),
      findings: d.findingsAdded.map((x) => without.findings.find((f) => f.rule.id === x)?.rule.title ?? x),
      resolved: d.findingsResolved.map((x) => current.findings.find((f) => f.rule.id === x)?.rule.title ?? x),
      delta: without.monthlyCost - current.monthlyCost,
    }
  }, [confirmExclude, answers, overrides, id])
  const unitName = offerFor(baseKb, c.def, e.facts)?.unit ?? (c.instanceClass ? `${c.instanceClass} instance` : 'unit')
  const usage = c.units * c.unitCost
  return (
    <>
      <div className="section">
        <div className="eyebrow">Cost composition</div>
        <ul>
          <li>
            {c.costKind === 'transfer' ? 'Transfer' : c.instanceClass ? 'Instances' : 'Usage'}: {fmtUnits(c.units)} x {unitMoney(c.unitCost)} per {unitName} = <span className="mono">{money(usage)}</span>
          </li>
          {(c.storageCost ?? 0) > 0 && (
            <li>
              Storage and backups: <span className="mono">{money(c.storageCost!)}</span>
            </li>
          )}
          {Math.abs(c.monthlyCost - usage - (c.storageCost ?? 0)) >= 1 && <li>Copied from the regional stack: <span className="mono">{money(c.monthlyCost)}</span></li>}
        </ul>
      </div>
      <div className="section">
        <div className="eyebrow">Overrides for this project</div>
        <dl className="kv">
          {c.listPrice > 0 || price !== undefined ? (
            <>
              <dt>Unit price {price !== undefined && <OverrideDot />}</dt>
              <dd>
                <NumberOverride
                  label={`${c.def.label} unit price`}
                  value={price ?? c.listPrice}
                  overridden={price !== undefined}
                  onCommit={(v) => edit((o) => ({ ...o, unitPrice: withEntry(o.unitPrice, key, v) }))}
                  onReset={() => edit((o) => ({ ...o, unitPrice: withEntry(o.unitPrice, key, undefined) }))}
                />
                {priceScope(key) && <span className="faint block">Applies to {priceScope(key)} only</span>}
              </dd>
            </>
          ) : null}
          {c.instanceClass !== null && (
            <>
              <dt>Instances {pinned !== undefined && <OverrideDot />}</dt>
              <dd>
                <span className="row" role="group" aria-label="Instance count">
                  <button className={`chip-btn ${pinned === undefined ? 'active' : ''}`} aria-pressed={pinned === undefined} onClick={() => edit((o) => ({ ...o, replicas: withEntry(o.replicas, id, undefined) }))}>
                    Auto
                  </button>
                  <button className={`chip-btn ${pinned !== undefined ? 'active' : ''}`} aria-pressed={pinned !== undefined} onClick={() => edit((o) => ({ ...o, replicas: withEntry(o.replicas, id, c.replicas) }))}>
                    Pin
                  </button>
                  {pinned !== undefined && (
                    <NumberOverride
                      label={`${c.def.label} pinned instances`}
                      value={pinned}
                      overridden={false}
                      onCommit={(v) => edit((o) => ({ ...o, replicas: withEntry(o.replicas, id, Math.max(1, Math.round(v))) }))}
                      onReset={() => undefined}
                    />
                  )}
                </span>
              </dd>
            </>
          )}
        </dl>
        <div className="row">
          {!confirmExclude && (
            <button className="btn btn-ghost btn-danger" onClick={() => setConfirmExclude(true)}>
              Exclude from design
            </button>
          )}
          {(price !== undefined || pinned !== undefined) && (
            <button className="btn btn-ghost" onClick={() => edit((o) => ({ ...o, unitPrice: withEntry(o.unitPrice, key, undefined), replicas: withEntry(o.replicas, id, undefined) }))}>
              Reset overrides
            </button>
          )}
        </div>
        {confirmExclude && impact && (
          <div className="exclude-warning" role="alert">
            <strong>Exclude {c.def.label}?</strong>
            {impact.edges.length > 0 && <p>Flows that go with it: {impact.edges.join('; ')}.</p>}
            {impact.removed.length > 0 && <p>Also removed: {impact.removed.join(', ')}.</p>}
            {impact.redecided.length > 0 && <p>Assumed answers that change: {impact.redecided.join('; ')}.</p>}
            {impact.added.length > 0 && <p>Added in its place: {impact.added.join(', ')}.</p>}
            {impact.findings.length > 0 && <p>New findings: {impact.findings.join('; ')}.</p>}
            {impact.resolved.length > 0 && <p className="faint">Resolved: {impact.resolved.join('; ')}.</p>}
            <p className="faint">Monthly cost {signedMoney(impact.delta)}. Restore it in the cost panel under Prices and assumptions.</p>
            <div className="row">
              <button
                className="btn btn-danger"
                onClick={() => {
                  edit((o) => ({ ...o, exclude: [...(o.exclude ?? []), id] }))
                  setConfirmExclude(false)
                  select(null)
                }}
              >
                Exclude
              </button>
              <button className="btn" onClick={() => setConfirmExclude(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function StackedBar({ title, parts }: { title: string; parts: { key: string; label: string; value: number; color: string }[] }) {
  const shown = parts.filter((p) => p.value > 0).sort((a, b) => b.value - a.value)
  const total = shown.reduce((sum, p) => sum + p.value, 0)
  if (total <= 0) return null
  return (
    <div className="cost-bar-block">
      <div className="eyebrow">{title}</div>
      <div className="cost-bar" role="img" aria-label={`${title}: ${shown.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(', ')}`}>
        {shown.map((p) => (
          <span key={p.key} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} title={`${p.label} ${money(p.value)}`} />
        ))}
      </div>
      <ul className="cost-bar-legend">
        {shown.map((p) => (
          <li key={p.key}>
            <span className="swatch" style={{ background: p.color }} />
            {p.label} <span className="mono">{money(p.value)}</span> <span className="faint mono">{Math.round((p.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Breakdown({ e, kb, answers, overrides }: { e: Evaluation; kb: KnowledgeBase; answers: Answers; overrides: Overrides }) {
  const edit = useProjects((s) => s.edit)
  const setWhatIf = useProjects((s) => s.setWhatIf)
  const apply = useApply()
  const levers = useMemo(() => costLevers(kb, answers, e), [kb, answers, e])
  const { cost } = e
  const nonprod = cost.byKind.nonprod ?? 0
  const recurring = cost.monthly + cost.people
  const budget = typeof e.facts['infra.budgetUsd'] === 'number' ? e.facts['infra.budgetUsd'] : null
  const headline = [
    { label: 'Run', value: cost.monthly - nonprod, sub: 'production and support, a month' },
    { label: 'Non-prod', value: nonprod, sub: 'staging and dev' },
    { label: 'People', value: cost.people, sub: 'a month' },
    { label: 'One-off', value: cost.oneTime, sub: 'paid once' },
    ...(cost.transitionMonthly > 0 ? [{ label: 'Transition', value: cost.transitionMonthly, sub: 'a month until cutover' }] : []),
    { label: 'Year 1', value: horizonCost(e, 12), sub: cost.transitionMonthly > 0 ? 'one-off + transition + 12 months' : 'one-off + 12 months' },
    { label: '3 years', value: horizonCost(e, LEVER_HORIZON_MONTHS), sub: cost.transitionMonthly > 0 ? 'one-off + transition + 36 months' : 'one-off + 36 months' },
  ]
  const byKind = Object.entries({ ...cost.byKind, people: cost.people })
    .filter(([kind]) => kind !== 'one_time')
    .map(([kind, value]) => ({ key: kind, label: KIND_LABEL[kind] ?? kind, value, color: KIND_COLOR[kind] ?? 'var(--text-faint)' }))
  const byTier = Object.entries(cost.byTier).map(([tier, value]) => ({ key: tier, label: TIER_LABEL[tier as Tier] ?? tier, value, color: TIER_COLOR[tier as Tier] ?? 'var(--text-faint)' }))
  const shareBase = recurring + cost.transitionMonthly
  const components = new Map(e.architecture.components.map((c) => [c.def.id, c]))
  return (
    <>
      <section className="panel-section">
        <div className="cost-headline">
          {headline.map((h) => (
            <div key={h.label} className="cost-stat">
              <span className="eyebrow">{h.label}</span>
              <span className="mono cost-stat-value">{money(h.value)}</span>
              <span className="faint">{h.sub}</span>
            </div>
          ))}
        </div>
        {budget !== null && (
          <p className={budget >= cost.monthly ? 'muted' : 'option-warn'}>
            Budget {money(budget)}/mo: {Math.round((cost.monthly / budget) * 100)}% used,{' '}
            {budget >= cost.monthly ? `${money(budget - cost.monthly)} headroom` : `${money(cost.monthly - budget)} over`}.
          </p>
        )}
        <StackedBar title="By cost kind (monthly)" parts={byKind} />
        <StackedBar title="By tier (monthly run)" parts={byTier} />
      </section>

      <section className="panel-section">
        <h3>Cost levers</h3>
        {levers.length === 0 ? (
          <p className="faint">Every answered decision is already at its cheapest feasible option.</p>
        ) : (
          <ul className="lever-list">
            {levers.slice(0, 8).map((l) => {
              const label = `${l.question.title} = ${l.to.label}`
              const change = optionChange(l.question.id, l.to.id, l.resets)
              const availability = l.evaluation.availability - e.availability
              return (
                <li key={l.question.id}>
                  <span>
                    <strong>{l.question.title}</strong>: {l.to.label} instead of {l.from.label}{' '}
                    <span className="mono cost-down">{signedMoney(l.horizonDelta)} over 3 years</span>
                    <span className="faint">
                      {` · ${signedMoney(l.delta)}/mo`}
                      {Math.abs(l.upfrontDelta) >= 1 && ` · one-off and transition ${signedMoney(l.upfrontDelta)}`}
                      {Math.abs(availability) >= 0.0005 && ` · availability ${availability > 0 ? '+' : ''}${availability.toFixed(3)} pp`}
                      {l.diff.findingsAdded.length > 0 && ` · ${l.diff.findingsAdded.length} new finding(s)`}
                      {l.resets.length > 0 && ` · resets ${l.resets.map((id) => kb.questions.find((q) => q.id === id)?.title ?? id).join(', ')} to the recommendation`}
                    </span>
                  </span>
                  <span className="row-actions">
                    <button className="btn btn-ghost" onClick={() => setWhatIf(change, label)}>
                      Preview
                    </button>
                    <button className="btn btn-ghost" onClick={() => apply(change, label)}>
                      Apply
                    </button>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="panel-section">
        <h3>By component</h3>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Component</th>
                <th>Technology</th>
                <th>Units</th>
                <th>Unit price</th>
                <th>Class</th>
                <th>Kind</th>
                <th>Cost</th>
                <th>Share</th>
                <th>Driven by</th>
              </tr>
            </thead>
            <tbody>
              {costLines(e).map((line) => {
                const c = components.get(line.key)
                return (
                  <tr key={line.key}>
                    <td>
                      {line.label}
                      {c && isOverridden(overrides, c) && <OverrideDot />}
                    </td>
                    <td>
                      {c ? c.tech : '-'}
                      {c?.offer && <span className="faint block">prices {c.offer.asOf}</span>}
                    </td>
                    <td className="mono">{c ? fmtUnits(c.units) : '-'}</td>
                    <td className="mono">{c && c.listPrice > 0 ? unitMoney(c.unitCost) : '-'}</td>
                    <td className="faint">{c?.instanceClass ?? '-'}</td>
                    <td className="faint">{line.kind}</td>
                    <td className="mono">{lineCost(line)}</td>
                    <td className="mono">{line.kind === 'one_time' || shareBase <= 0 ? '-' : `${Math.round((line.monthly / shareBase) * 100)}%`}</td>
                    <td>
                      {c &&
                        drivers(kb, c, e).map((q) => (
                          <button key={q.id} className="link block" onClick={() => edit(q.id)}>
                            {q.title}
                          </button>
                        ))}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="faint">Approximate public list prices (USD), not quotes. Share is of the monthly total including people and transition costs.</p>
      </section>
    </>
  )
}

const NEW_LINE: ExtraCostLine = { label: '', tier: 'ops', costKind: 'license', monthly: 0 }

/** Cost lines the knowledge base does not price (a licence, a support contract, a service of your own), added to the running cost. */
function ExtraLines({ lines, onChange }: { lines: ExtraCostLine[]; onChange: (lines: ExtraCostLine[]) => void }) {
  const [draft, setDraft] = useState(NEW_LINE)
  const add = () => {
    if (!draft.label.trim() || !(draft.monthly >= 0)) return
    onChange([...lines, { ...draft, label: draft.label.trim() }])
    setDraft(NEW_LINE)
  }
  const replace = (i: number, line: ExtraCostLine | null) => onChange(lines.flatMap((l, j) => (j !== i ? [l] : line ? [line] : [])))
  return (
    <section className="panel-section">
      <h3>Added lines</h3>
      {lines.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Line</th>
              <th>Tier</th>
              <th>Kind</th>
              <th>Monthly</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={`${i}-${l.label}`}>
                <td>{l.label}</td>
                <td className="faint">{TIER_LABEL[l.tier] ?? l.tier}</td>
                <td className="faint">{KIND_LABEL[l.costKind] ?? l.costKind}</td>
                <td>
                  <NumberOverride label={`${l.label} monthly cost`} value={l.monthly} overridden={false} onCommit={(monthly) => replace(i, { ...l, monthly })} onReset={() => undefined} />
                </td>
                <td>
                  <button className="btn btn-ghost" onClick={() => replace(i, null)} aria-label={`Remove ${l.label}`}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row">
        <input className="input" aria-label="New line label" placeholder="Label, e.g. Vendor support" maxLength={80} value={draft.label} onChange={(ev) => setDraft({ ...draft, label: ev.target.value })} />
        <select className="input" aria-label="New line tier" value={draft.tier} onChange={(ev) => setDraft({ ...draft, tier: ev.target.value as Tier })}>
          {TIERS.map((t) => (
            <option key={t} value={t}>
              {TIER_LABEL[t] ?? t}
            </option>
          ))}
        </select>
        <select className="input" aria-label="New line kind" value={draft.costKind} onChange={(ev) => setDraft({ ...draft, costKind: ev.target.value as CostKind })}>
          {COST_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k] ?? k}
            </option>
          ))}
        </select>
        <input className="input mono" aria-label="New line monthly cost" inputMode="decimal" placeholder="$/month" value={draft.monthly || ''} onChange={(ev) => setDraft({ ...draft, monthly: Number(ev.target.value) })} onKeyDown={(ev) => ev.key === 'Enter' && add()} />
        <button className="btn" onClick={add} disabled={!draft.label.trim() || !(draft.monthly >= 0)}>
          Add
        </button>
      </div>
      <p className="faint">Licences, support contracts or services the design does not price; they count in the running cost and the docs. One-off lines count once.</p>
    </section>
  )
}

function Prices({ e, answers }: { e: Evaluation; answers: Answers }) {
  const { overrides, edit } = useEditOverrides()
  // Unit prices without this project's unit-price overrides: the defaults each override replaces.
  const defaults = useMemo(() => {
    const { unitPrice: _prices, ...rest } = overrides
    return new Map(evaluate(withOverrides(baseKb, rest), answers).architecture.components.map((c) => [c.priceKey, c.listPrice]))
  }, [overrides, answers])
  const priced = e.architecture.components.filter((c) => (c.monthlyCost > 0 && c.listPrice > 0) || overrides.unitPrice?.[c.priceKey] !== undefined)
  // Prices set on another provider, platform or capacity tier: kept for when the design returns to it, but not applied now.
  const inDesign = new Set(e.architecture.components.map((c) => c.priceKey))
  const unused = Object.entries(overrides.unitPrice ?? {}).filter(([key]) => !inDesign.has(key))
  const label = (id: string) => baseKb.components.find((c) => c.id === id)?.label ?? id
  // The slider holds a draft while it moves and commits once on release, so one drag is one undo step.
  const [discount, setDiscount] = useState<number | null>(null)
  const releaseDiscount = () => {
    if (discount === null) return
    setDiscount(null)
    // The store assigns an unassigned discount to the cloud the design runs on now (scopeOverrides).
    edit((o) => ({ ...o, discountPct: discount || undefined, discountProvider: undefined }))
  }
  const cloudLabel = (id: unknown) => baseKb.questions.find((q) => q.id === 'infra.cloud')?.options?.find((o) => o.id === id)?.label ?? String(id)
  const cloud = e.facts['infra.cloud']
  const onCloud = DISCOUNT_PROVIDERS.includes(String(cloud))
  return (
    <>
      <section className="panel-section">
        <h3>Discount</h3>
        <label className="discount">
          <input
            type="range"
            min={0}
            max={90}
            step={1}
            value={discount ?? overrides.discountPct ?? 0}
            aria-label="Negotiated discount on cloud lines"
            disabled={!onCloud}
            onChange={(ev) => setDiscount(Number(ev.target.value))}
            onPointerUp={releaseDiscount}
            onKeyUp={releaseDiscount}
            onBlur={releaseDiscount}
          />
          <span className="mono">{discount ?? overrides.discountPct ?? 0}%</span>
          {overrides.discountPct ? <OverrideDot /> : null}
        </label>
        <p className="faint">
          A negotiated discount (EDP, MACC, CUD) is a contract with one cloud: it comes off that cloud's own instance and usage lines, while other clouds in the comparison, third-party services and own hardware keep their price.
          {overrides.discountProvider
            ? ` Negotiated with ${cloudLabel(overrides.discountProvider)}${overrides.discountProvider === cloud ? '.' : `, so not applied on ${cloudLabel(cloud)}; moving the slider sets a discount for ${cloudLabel(cloud)} instead.`}`
            : onCloud
              ? ` Applies to ${cloudLabel(cloud)}.`
              : ' Choose a cloud provider to set one.'}
        </p>
      </section>

      <section className="panel-section">
        <h3>Unit prices</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Component</th>
              <th>Source</th>
              <th>Default</th>
              <th>Unit price</th>
            </tr>
          </thead>
          <tbody>
            {priced.map((c) => {
              const key = c.priceKey
              const value = overrides.unitPrice?.[key]
              const offer = offerFor(baseKb, c.def, e.facts)
              return (
                <tr key={key}>
                  <td>
                    {c.def.label}
                    {value !== undefined && <OverrideDot />}
                  </td>
                  <td className="faint">{offer ? `${priceScope(key)} only, list price ${offer.asOf}` : 'Component default, general knowledge'}</td>
                  <td className="mono">
                    {unitMoney(defaults.get(key) ?? c.listPrice)}
                    {offer?.unit && <span className="faint"> / {offer.unit}</span>}
                  </td>
                  <td>
                    <NumberOverride
                      label={`${c.def.label} unit price`}
                      value={value ?? defaults.get(key) ?? c.listPrice}
                      overridden={value !== undefined}
                      onCommit={(v) => edit((o) => ({ ...o, unitPrice: withEntry(o.unitPrice, key, v) }))}
                      onReset={() => edit((o) => ({ ...o, unitPrice: withEntry(o.unitPrice, key, undefined) }))}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="faint">List price of one unit before the instance class, region, commitment and discount factors. A price applies to the offer and capacity tier it was set on; another provider, platform or tier keeps its list price.</p>
        {unused.length > 0 && (
          <>
            <h4>Prices not in the current design</h4>
            <ul className="lever-list">
              {unused.map(([key, v]) => (
                <li key={key}>
                  <span>
                    {describePriceKey(baseKb, key)} <span className="mono">{unitMoney(v)}</span>
                  </span>
                  <button className="btn btn-ghost" onClick={() => edit((o) => ({ ...o, unitPrice: withEntry(o.unitPrice, key, undefined) }))}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <ExtraLines lines={overrides.extraLines ?? []} onChange={(extraLines) => edit((o) => ({ ...o, extraLines }))} />

      {((overrides.exclude?.length ?? 0) > 0 || Object.keys(overrides.replicas ?? {}).length > 0) && (
        <section className="panel-section">
          <h3>Components</h3>
          <ul className="lever-list">
            {(overrides.exclude ?? []).map((id) => (
              <li key={`x${id}`}>
                <span>
                  {label(id)} <span className="faint">excluded from the design</span>
                </span>
                <button className="btn btn-ghost" onClick={() => edit((o) => ({ ...o, exclude: o.exclude?.filter((x) => x !== id) }))}>
                  Restore
                </button>
              </li>
            ))}
            {Object.entries(overrides.replicas ?? {}).map(([id, n]) => (
              <li key={`p${id}`}>
                <span>
                  {label(id)} <span className="faint">pinned to {n} instance(s)</span>
                </span>
                <button className="btn btn-ghost" onClick={() => edit((o) => ({ ...o, replicas: withEntry(o.replicas, id, undefined) }))}>
                  Auto
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel-section">
        <h3>Reference numbers</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Assumption</th>
              <th>Default</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {referenceKeys.map((key) => {
              const fallback = baseKb.reference[key]
              const value = overrides.reference?.[key]
              const info = referenceInfo[key]
              return (
                <tr key={key}>
                  <td>
                    {info.label}
                    {value !== undefined && <OverrideDot />}
                    <span className="faint block">{info.source}</span>
                  </td>
                  <td className="mono">
                    {fmt(fallback)}
                    {info.unit && <span className="faint"> {info.unit}</span>}
                  </td>
                  <td>
                    <NumberOverride
                      label={info.label}
                      value={value ?? fallback}
                      overridden={value !== undefined}
                      positive={info.positive}
                      onCommit={(v) => edit((o) => ({ ...o, reference: withEntry(o.reference, key, v) }))}
                      onReset={() => edit((o) => ({ ...o, reference: withEntry(o.reference, key, undefined) }))}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="faint">Planning heuristics from the knowledge base (general knowledge and the system design sources); replace them with your own load tests and quotes.</p>
      </section>
    </>
  )
}

export function CostPanel({ base }: { base: Evaluation }) {
  const project = useProjects((s) => (s.activeId ? (s.projects[s.activeId] ?? null) : null))
  const knowledge = useKnowledge(project?.overrides)
  const [tab, setTab] = useState<Tab>('breakdown')
  if (!project) return null
  return (
    <div className="panel-body">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'breakdown'} className={tab === 'breakdown' ? 'active' : ''} onClick={() => setTab('breakdown')}>
          Breakdown
        </button>
        <button role="tab" aria-selected={tab === 'prices'} className={tab === 'prices' ? 'active' : ''} onClick={() => setTab('prices')}>
          Prices and assumptions {overrideCount(project.overrides) > 0 && <span className="chip">{overrideCount(project.overrides)}</span>}
        </button>
      </div>
      {tab === 'breakdown' ? <Breakdown e={base} kb={knowledge} answers={project.answers} overrides={project.overrides ?? {}} /> : <Prices e={base} answers={project.answers} />}
    </div>
  )
}
