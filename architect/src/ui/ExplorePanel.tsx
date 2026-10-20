import { useEffect, useMemo, useState } from 'react'
import type { Answers, Evaluation, KnowledgeBase, Overrides, Question } from '../domain/types'
import { fmt, formatAvailability, signedMoney } from '../engine/architecture'
import { evaluate } from '../engine/evaluate'
import { assumedDesign, cheapestOption, compareOver, diffEvaluations, optionChange, PRICE_TIE_SHARE, runAndPeople, whatIfLevers } from '../engine/explore'
import { withOverrides } from '../engine/overrides'
import { costLines } from '../docs/generate'
import { kb as baseKb } from '../knowledge'
import { useProjects } from '../store/projectStore'
import { COMPARISONS, lineCost, useApply } from './costing'
import { useKnowledge } from './useEvaluation'

const money = (n: number) => `$${fmt(n)}`

const optionLabel = (q: Question, v: unknown) => q.options?.find((o) => o.id === v)?.label ?? (v === null ? 'not decided' : String(v))

/** Decisions whose value differs between two designs, plus the `also` questions (answers a compared option reset) that differ. */
function flippedDecisions(kb: KnowledgeBase, a: Evaluation, b: Evaluation, also: string[] = []) {
  return kb.questions
    .filter((q) => q.isDecision || also.includes(q.id))
    .map((q) => ({ q, va: a.questions.find((s) => s.question.id === q.id)!, vb: b.questions.find((s) => s.question.id === q.id)! }))
    .filter(({ va, vb }) => JSON.stringify(va.effectiveValue) !== JSON.stringify(vb.effectiveValue))
}

const availabilityDelta = (d: number) => (Math.abs(d) < 0.0005 ? 'same' : `${d > 0 ? '+' : ''}${d.toFixed(3)} pp`)

function Metrics({ e }: { e: Evaluation }) {
  return (
    <>
      <td className="mono">{e.architecture.components.length}</td>
      <td className="mono">{formatAvailability(e.availability)}</td>
      <td className="mono">{money(runAndPeople(e))}</td>
      <td className="mono">{e.findings.filter((f) => f.rule.severity !== 'info').length}</td>
    </>
  )
}

function WhatIfLab({ kb, answers }: { kb: KnowledgeBase; answers: Answers }) {
  const setWhatIf = useProjects((s) => s.setWhatIf)
  const levers = useMemo(() => whatIfLevers(kb, answers), [kb, answers])
  return (
    <section className="panel-section">
      <h3>What-if scenarios</h3>
      <p className="muted">Preview a change in the 3D view and see its impact before you apply it. Questions that the change unlocks stay open until you answer them.</p>
      <div className="presets">
        {levers.map((l) => (
          <button key={l.label} className="chip-btn" onClick={() => setWhatIf(l.overrides, l.label)}>
            {l.label}
          </button>
        ))}
      </div>
    </section>
  )
}

function AlternativesTable({ answers, kb, base }: { answers: Answers; kb: KnowledgeBase; base: Evaluation }) {
  const decisions = kb.questions.filter((q) => q.isDecision)
  const apply = useApply()
  const activeDecisions = decisions.filter((q) => base.questions.find((s) => s.question.id === q.id)?.active)
  const [questionId, setQuestionId] = useState(activeDecisions[0]?.id ?? '')
  const setWhatIf = useProjects((s) => s.setWhatIf)
  const question = kb.questions.find((q) => q.id === questionId)
  const state = base.questions.find((s) => s.question.id === questionId)
  const rows = useMemo(
    () =>
      (question?.options ?? []).map((o) => {
        const trial = { ...answers, [questionId]: { kind: 'value' as const, value: o.id } }
        return { option: o, e: assumedDesign(kb, trial) }
      }),
    [kb, question, answers, questionId],
  )
  if (!question || !state) return null
  return (
    <section className="panel-section">
      <h3>Compare alternatives</h3>
      <div className="presets" role="radiogroup" aria-label="Decision to compare">
        {activeDecisions.map((q) => (
          <button key={q.id} role="radio" aria-checked={q.id === questionId} className={`chip-btn ${q.id === questionId ? 'active' : ''}`} onClick={() => setQuestionId(q.id)}>
            {q.title}
          </button>
        ))}
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Option</th>
            <th>Score</th>
            <th>Parts</th>
            <th>Avail.</th>
            <th>Run + people/mo</th>
            <th>Issues</th>
            <th>Δ cost</th>
            <th>Δ avail.</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ option, e }) => {
            const label = `${question.title} = ${option.label}`
            const s = state.recommendation.scores.find((x) => x.optionId === option.id)
            return (
              <tr key={option.id} className={state.effectiveValue === option.id ? 'current' : ''}>
                <td>
                  {option.label}
                  {state.recommendation.optionId === option.id && <span className="chip chip-accent">rec.</span>}
                  {s && !s.feasible && <span className="chip chip-danger" title={s.infeasibleReason}>infeasible</span>}
                </td>
                <td className="mono">{s?.score.toFixed(1)}</td>
                <Metrics e={e} />
                <td className="mono">{signedMoney(runAndPeople(e) - runAndPeople(base))}</td>
                <td className="mono">{availabilityDelta(e.availability - base.availability)}</td>
                <td className="row-actions">
                  <button className="btn btn-ghost" onClick={() => setWhatIf({ [questionId]: { kind: 'value', value: option.id } }, label)}>
                    Preview
                  </button>
                  <button className="btn btn-ghost" onClick={() => apply({ [questionId]: { kind: 'value', value: option.id } }, label)}>
                    Apply
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="faint">Score = matched requirement weights minus a simplicity penalty (0.5 per complexity point). Δ cost is monthly run plus people cost against the current design.</p>
    </section>
  )
}

/** One column per option of a whole-design decision: each present component's service and cost, then totals, risks and the decisions that flip. */
function CompareTable({ answers, kb, base, questionId, title }: { answers: Answers; kb: KnowledgeBase; base: Evaluation; questionId: string; title: string }) {
  const setWhatIf = useProjects((s) => s.setWhatIf)
  const apply = useApply()
  const question = kb.questions.find((q) => q.id === questionId)
  const active = !!base.questions.find((s) => s.question.id === questionId)?.active
  const results = useMemo(() => (active ? compareOver(kb, answers, questionId, base) : []), [active, kb, answers, questionId, base])
  if (!question || results.length === 0) return null
  const feasible = results.filter((r) => r.feasible)
  const cheapest = cheapestOption(results)
  const current = base.questions.find((s) => s.question.id === questionId)?.effectiveValue
  // Components of the current design first, then those only another option adds.
  const rowIds = [...new Set([base, ...results.map((r) => r.evaluation)].flatMap((e) => e.architecture.components.map((c) => c.def.id)))]
  const labelOf = (id: string) => [base, ...results.map((r) => r.evaluation)].flatMap((e) => e.architecture.components).find((c) => c.def.id === id)!.def.label
  const footer: { label: string; cell: (e: Evaluation) => string }[] = [
    { label: 'Run', cell: (e) => money(e.monthlyCost) },
    { label: 'People', cell: (e) => money(e.cost.people) },
    { label: 'One-off', cell: (e) => money(e.cost.oneTime) },
    { label: 'Total / mo', cell: (e) => money(runAndPeople(e)) },
    { label: 'vs current', cell: (e) => signedMoney(runAndPeople(e) - runAndPeople(base)) },
    { label: 'Availability', cell: (e) => formatAvailability(e.availability) },
    { label: 'Errors / warnings', cell: (e) => `${e.findings.filter((f) => f.rule.severity === 'error').length} / ${e.findings.filter((f) => f.rule.severity === 'warning').length}` },
  ]
  return (
    <section className="panel-section" id={`compare-${questionId}`}>
      <h3>{title}</h3>
      <p className="muted">Each column completes the design with that {question.title.toLowerCase()} and the remaining recommendations. Costs are monthly list-price estimates.</p>
      {feasible.length > 1 && !cheapest && (
        <p className="faint">The cheapest options are within {PRICE_TIE_SHARE * 100}% of each other, closer than list prices are exact: choose on fit, skills and existing contracts.</p>
      )}
      <div className="table-scroll">
        <table className="table compare-table">
          <thead>
            <tr>
              <th />
              {results.map((r) => (
                <th key={r.option.id} className={`${r.feasible ? '' : 'infeasible'} ${r.option.id === current ? 'current' : ''}`}>
                  {r.option.label}
                  {r.recommended && <span className="chip chip-accent">Best fit</span>}
                  {r.option.id === cheapest && <span className="chip chip-ok">Cheapest</span>}
                  {!r.feasible && <span className="option-warn compare-reason">{r.infeasibleReason}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowIds.map((id) => (
              <tr key={id}>
                <td>{labelOf(id)}</td>
                {results.map((r) => {
                  const c = r.evaluation.architecture.components.find((x) => x.def.id === id)
                  return (
                    <td key={r.option.id} className={r.feasible ? '' : 'infeasible'}>
                      {c ? (
                        <>
                          {c.tech}
                          <span className="faint mono compare-cost">{money(c.monthlyCost)}</span>
                        </>
                      ) : (
                        <span className="faint">-</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
            {footer.map((row) => (
              <tr key={row.label} className="compare-total">
                <td>{row.label}</td>
                {results.map((r) => (
                  <td key={r.option.id} className={`mono ${r.feasible ? '' : 'infeasible'}`}>
                    {row.cell(r.evaluation)}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="compare-total">
              <td>Decisions that flip</td>
              {results.map((r) => {
                const flips = flippedDecisions(kb, base, r.evaluation, r.resets).filter(({ q }) => q.id !== questionId)
                return (
                  <td key={r.option.id} className={r.feasible ? '' : 'infeasible'}>
                    {flips.length === 0 ? (
                      <span className="faint">none</span>
                    ) : (
                      <ul className="compare-flips">
                        {flips.map(({ q, va, vb }) => (
                          <li key={q.id}>
                            {q.title}: {optionLabel(q, va.effectiveValue)} → {optionLabel(q, vb.effectiveValue)}
                            {r.resets.includes(q.id) && <span className="faint"> (your answer does not fit; reset to the recommendation)</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                )
              })}
            </tr>
            <tr>
              <td />
              {results.map((r) => {
                const label = `${question.title} = ${r.option.label}`
                const change = optionChange(questionId, r.option.id, r.resets)
                return (
                  <td key={r.option.id} className="row-actions">
                    <button className="btn btn-ghost" onClick={() => setWhatIf(change, label)}>
                      Preview
                    </button>
                    <button className="btn btn-ghost" disabled={r.option.id === current || !r.feasible} title={r.feasible ? undefined : r.infeasibleReason} onClick={() => apply(change, label)}>
                      Apply
                    </button>
                  </td>
                )
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}

const answersOf = (id: string, current: Answers, versions: { id: string; answers: Answers }[]) =>
  id === 'current' ? current : (versions.find((v) => v.id === id)?.answers ?? current)
// Each version is evaluated with the overrides it was saved with.
const knowledgeOf = (id: string, current: KnowledgeBase, versions: { id: string; overrides?: Overrides }[]) => {
  const version = versions.find((v) => v.id === id)
  return version ? withOverrides(baseKb, version.overrides) : current
}

function Versions({ answers, kb }: { answers: Answers; kb: KnowledgeBase }) {
  const project = useProjects((s) => (s.activeId ? s.projects[s.activeId] : null))!
  const saveVersion = useProjects((s) => s.saveVersion)
  const restoreVersion = useProjects((s) => s.restoreVersion)
  const deleteVersion = useProjects((s) => s.deleteVersion)
  const [name, setName] = useState('')
  const [compareA, setCompareA] = useState<string>('current')
  const [compareB, setCompareB] = useState<string>(project.versions.at(-1)?.id ?? 'current')
  const versions = project.versions
  const a = useMemo(() => evaluate(knowledgeOf(compareA, kb, versions), answersOf(compareA, answers, versions)), [kb, compareA, answers, versions])
  const b = useMemo(() => evaluate(knowledgeOf(compareB, kb, versions), answersOf(compareB, answers, versions)), [kb, compareB, answers, versions])
  const diff = diffEvaluations(a, b)
  const decisionDiffs = flippedDecisions(kb, a, b)
  const options = [{ id: 'current', name: 'Current design' }, ...project.versions]

  return (
    <section className="panel-section">
      <h3>Versions</h3>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          saveVersion(name.trim() || `Version ${project.versions.length + 1}`)
          setName('')
        }}
      >
        <input className="input" placeholder="Version name, e.g. MVP" value={name} onChange={(e) => setName(e.target.value)} aria-label="Version name" />
        <button className="btn btn-primary" type="submit">
          Save version
        </button>
      </form>
      {project.versions.length === 0 && <p className="faint">No versions yet. Save one before exploring alternatives.</p>}
      <ul className="version-list">
        {[...project.versions].reverse().map((v) => (
          <li key={v.id}>
            <span>
              <strong>{v.name}</strong> <span className="faint">{new Date(v.createdAt).toLocaleString()}</span>
            </span>
            <span className="row">
              <button className="btn btn-ghost" onClick={() => restoreVersion(v.id)}>Restore</button>
              <button className="btn btn-ghost btn-danger" onClick={() => window.confirm(`Delete version "${v.name}"? This cannot be undone.`) && deleteVersion(v.id)} aria-label={`Delete ${v.name}`}>Delete</button>
            </span>
          </li>
        ))}
      </ul>

      <h3>Compare versions</h3>
      <div className="compare-pick">
        {(['A', 'B'] as const).map((side) => (
          <div key={side} className="presets" role="radiogroup" aria-label={`Version ${side}`}>
            <span className="faint">{side}</span>
            {options.map((o) => {
              const active = (side === 'A' ? compareA : compareB) === o.id
              return (
                <button key={o.id} role="radio" aria-checked={active} className={`chip-btn ${active ? 'active' : ''}`} onClick={() => (side === 'A' ? setCompareA : setCompareB)(o.id)}>
                  {o.name}
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <table className="table">
        <thead>
          <tr>
            <th />
            <th>Parts</th>
            <th>Avail.</th>
            <th>Run + people/mo</th>
            <th>Issues</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>A</td>
            <Metrics e={a} />
          </tr>
          <tr>
            <td>B</td>
            <Metrics e={b} />
          </tr>
        </tbody>
      </table>
      <ul className="diff-list">
        {diff.added.map((id) => <li key={`a${id}`} className="diff-add">+ {b.architecture.components.find((c) => c.def.id === id)?.def.label}</li>)}
        {diff.removed.map((id) => <li key={`r${id}`} className="diff-remove">- {a.architecture.components.find((c) => c.def.id === id)?.def.label}</li>)}
        {diff.rescaled.map((r) => <li key={`s${r.id}`}>~ {b.architecture.components.find((c) => c.def.id === r.id)?.def.label}: {r.from} → {r.to} instances</li>)}
        {decisionDiffs.map(({ q, va, vb }) => (
          <li key={q.id}>
            ~ {q.title}: {optionLabel(q, va.effectiveValue)} → {optionLabel(q, vb.effectiveValue)}
          </li>
        ))}
        {diff.added.length + diff.removed.length + diff.rescaled.length + decisionDiffs.length === 0 && <li className="faint">A and B are identical.</li>}
      </ul>
    </section>
  )
}

/** The bill of materials: monthly lines largest first, then one-off lines, with the engineer's extra lines and the non-production share. */
function CostTable({ e }: { e: Evaluation }) {
  const rows = costLines(e)
  return (
    <section className="panel-section">
      <h3>Cost lines</h3>
      <table className="table">
        <thead>
          <tr>
            <th>Line</th>
            <th>Kind</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <td className="faint">{r.kind}</td>
              <td className="mono">{lineCost(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/** `focus` scrolls to a section, e.g. 'compare-infra.cloud' from the provider card's Compare button. */
export function ExplorePanel({ base, focus }: { base: Evaluation; focus?: string | null }) {
  const answers = useProjects((s) => (s.activeId ? s.projects[s.activeId].answers : {}))
  const overrides = useProjects((s) => (s.activeId ? s.projects[s.activeId].overrides : undefined))
  const kb = useKnowledge(overrides)
  const assumed = useMemo(() => assumedDesign(kb, answers), [kb, answers])
  useEffect(() => {
    if (focus) document.getElementById(focus)?.scrollIntoView({ block: 'start' })
  }, [focus])
  return (
    <div className="panel-body">
      <WhatIfLab kb={kb} answers={answers} />
      {COMPARISONS.map((c) => (
        <CompareTable key={c.questionId} answers={answers} kb={kb} base={assumed} questionId={c.questionId} title={c.title} />
      ))}
      <CostTable e={base} />
      <AlternativesTable answers={answers} kb={kb} base={assumed} />
      <Versions answers={answers} kb={kb} />
    </div>
  )
}
