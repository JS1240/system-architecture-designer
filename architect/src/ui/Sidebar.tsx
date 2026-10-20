import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Answers, Evaluation, FactValue, KnowledgeBase, Overrides, QuestionState } from '../domain/types'
import { fmt, money } from '../engine/architecture'
import { explainCondition } from '../engine/conditions'
import { assumptionSensitivity, runAndPeople, type AssumptionImpact } from '../engine/explore'
import { questionsForRule } from '../engine/questions'
import { kb } from '../knowledge'
import { cite } from '../knowledge/sources'
import { utilizationColor } from '../scene/palette'
import { TIER_LABEL } from '../scene/layout'
import { useProjects } from '../store/projectStore'
import { COMPARISONS, isOverridden, useApply } from './costing'
import { QuestionCard } from './QuestionCard'
import { useKnowledge } from './useEvaluation'

type Tab = 'design' | 'findings' | 'components'
type Dot = 'answered' | 'assumed' | 'custom' | 'revisit' | 'pending'

const DOT_LABEL: Record<Dot, string> = { answered: 'answered', assumed: 'assumed', custom: 'custom', revisit: 'revisit', pending: 'pending' }

const dotOf = (s: QuestionState): Dot =>
  s.divergesFromRecommendation ? 'revisit' : s.status === 'unknown' ? 'assumed' : s.status === 'custom' ? 'custom' : s.status === 'pending' ? 'pending' : 'answered'

const questionTitle = (id: string) => kb.questions.find((q) => q.id === id)?.title ?? id

function valueLabel(s: QuestionState, answers: Answers): string {
  const answer = answers[s.question.id]
  if (answer?.kind === 'custom') return answer.text
  const v = s.effectiveValue
  if (s.question.kind === 'number') return `${fmt(Number(v))} ${s.question.number?.unit ?? ''}`
  const label = (id: unknown) => s.question.options?.find((o) => o.id === id)?.label ?? String(id)
  return Array.isArray(v) ? v.map(label).join(', ') || 'None' : label(v)
}

const categories = [...kb.categories].sort((a, b) => a.order - b.order)

/** Every category with its active questions, pending ones included; any of them opens in the card. */
function Outline({
  evaluation,
  answers,
  open,
  expanded,
  onToggle,
  onOpen,
  onClear,
}: {
  evaluation: Evaluation
  answers: Answers
  open: string | null
  expanded: ReadonlySet<string>
  onToggle: (categoryId: string) => void
  onOpen: (id: string) => void
  onClear: (id: string) => void
}) {
  const inactiveAnswered = evaluation.questions.filter((s) => !s.active && answers[s.question.id])
  return (
    <nav className="outline" aria-label="Question outline">
      {categories.map((cat) => {
        const items = evaluation.questions.filter((s) => s.active && s.question.category === cat.id)
        if (items.length === 0) return null
        const done = items.filter((s) => s.status !== 'pending').length
        const isOpen = expanded.has(cat.id)
        return (
          <div key={cat.id} id={`outline-${cat.id}`} className="outline-group">
            <button className="outline-head" aria-expanded={isOpen} onClick={() => onToggle(cat.id)}>
              <span className="outline-label">{cat.label}</span>
              <span className="outline-dots" aria-hidden="true">
                {items.map((s) => (
                  <span key={s.question.id} className={`dot dot-${dotOf(s)}`} title={`${s.question.title}: ${DOT_LABEL[dotOf(s)]}`} />
                ))}
              </span>
              <span className="faint mono">
                {done}/{items.length}
              </span>
            </button>
            {isOpen &&
              items.map((s) => {
                const dot = dotOf(s)
                return (
                  <button key={s.question.id} className={`answered-item ${open === s.question.id ? 'active' : ''}`} aria-current={open === s.question.id ? 'true' : undefined} onClick={() => onOpen(s.question.id)}>
                    <span className="answered-title">
                      <span className={`dot dot-${dot}`} aria-hidden="true" /> {s.question.title}
                    </span>
                    <span className="answered-value">
                      {dot === 'assumed' && <span className="chip">assumed</span>}
                      {s.status === 'custom' && <span className="chip chip-accent">custom</span>}
                      {dot === 'revisit' && (
                        <span className="chip chip-warn" title={`Now recommended: ${s.question.options?.find((o) => o.id === s.recommendation.optionId)?.label}`}>
                          revisit
                        </span>
                      )}
                      {dot === 'pending' ? <span className="faint">pending</span> : valueLabel(s, answers)}
                    </span>
                  </button>
                )
              })}
          </div>
        )
      })}
      {inactiveAnswered.length > 0 && (
        <div className="outline-group">
          <div className="eyebrow">No longer relevant (kept, ignored)</div>
          {inactiveAnswered.map((s) => (
            <div key={s.question.id} className="answered-item inactive">
              <span>
                <span className="answered-title">{s.question.title}</span>
                <span className="faint inactive-why">Off because {explainCondition({ not: s.question.askWhen ?? { all: [] } }, evaluation.facts, kb, { answers }).join('; ') || 'its conditions no longer hold'}</span>
              </span>
              <button className="btn btn-ghost" onClick={() => onClear(s.question.id)} aria-label={`Clear ${s.question.title}`}>
                Clear
              </button>
            </div>
          ))}
        </div>
      )}
    </nav>
  )
}

/** One segment per category, sized by its active questions and filled by the answered share. */
function Progress({ evaluation }: { evaluation: Evaluation }) {
  const { answered, total } = evaluation.progress
  const segments = categories
    .map((cat) => {
      const items = evaluation.questions.filter((s) => s.active && s.question.category === cat.id)
      return { cat, total: items.length, done: items.filter((s) => s.status !== 'pending').length }
    })
    .filter((s) => s.total > 0)
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={answered} aria-label={`${answered} of ${total} relevant questions answered`}>
      {segments.map((s) => (
        <div key={s.cat.id} className="progress-seg" style={{ flexGrow: s.total }} title={`${s.cat.label}: ${s.done} of ${s.total}`}>
          <div className="progress-bar" style={{ width: `${(s.done / s.total) * 100}%` }} />
        </div>
      ))}
    </div>
  )
}

export function Findings({ evaluation, onOpen }: { evaluation: Evaluation; onOpen?: (questionId: string) => void }) {
  const setWhatIf = useProjects((s) => s.setWhatIf)
  if (evaluation.findings.length === 0) return <p className="muted pad">No findings. The design passes every validation rule in the knowledge base.</p>
  const stateOf = (id: string) => evaluation.questions.find((s) => s.question.id === id)
  return (
    <ul className="findings">
      {evaluation.findings.map(({ rule }) => {
        // An infeasible-<question> finding names the question whose answer the engine ruled out, and knows the option it recommends instead.
        const ruledOut = rule.id.startsWith('infeasible-') ? stateOf(rule.id.slice('infeasible-'.length)) : undefined
        const fix = ruledOut?.question.options?.find((o) => o.id === ruledOut.recommendation.optionId)
        const targets = [...new Set([...(ruledOut ? [ruledOut.question.id] : []), ...questionsForRule(rule, kb)])].filter((id) => stateOf(id)?.active).slice(0, 4)
        return (
          <li key={rule.id} className={`finding finding-${rule.severity}`}>
            <div className="finding-head">
              <span className={`chip chip-${rule.severity === 'error' ? 'danger' : rule.severity === 'warning' ? 'warn' : 'accent'}`}>{rule.severity}</span>
              <strong>{rule.title}</strong>
            </div>
            <p className="muted">{rule.message}</p>
            <p>
              <span className="faint">Fix: </span>
              {rule.fix}
            </p>
            {(onOpen && targets.length > 0) || (ruledOut && fix) ? (
              <div className="finding-actions">
                {ruledOut && fix && (
                  <button className="btn" onClick={() => setWhatIf({ [ruledOut.question.id]: { kind: 'value', value: fix.id } }, `${ruledOut.question.title} = ${fix.label}`)}>
                    Preview fix
                  </button>
                )}
                {onOpen &&
                  targets.map((id) => (
                    <button key={id} className="btn btn-ghost" onClick={() => onOpen(id)}>
                      Go to {questionTitle(id)}
                    </button>
                  ))}
              </div>
            ) : null}
            <p className="faint source">{rule.sources.map(cite).join(' · ')}</p>
          </li>
        )
      })}
    </ul>
  )
}

type ComponentFilter = 'hot' | 'external' | 'override'
const FILTER_LABEL: Record<ComponentFilter, string> = { hot: 'Over 70% utilization', external: 'External', override: 'Override' }

/** Every component as a keyboard-reachable row, grouped by tier; a row opens the inspector. */
function ComponentList({ evaluation, overrides }: { evaluation: Evaluation; overrides: Overrides | undefined }) {
  const selected = useProjects((s) => s.selectedComponent)
  const select = useProjects((s) => s.select)
  const [filters, setFilters] = useState<Set<ComponentFilter>>(new Set())
  const test: Record<ComponentFilter, (c: Evaluation['architecture']['components'][number]) => boolean> = {
    hot: (c) => c.utilization > 0.7,
    external: (c) => c.def.shape === 'external',
    override: (c) => isOverridden(overrides, c),
  }
  const shown = evaluation.architecture.components.filter((c) => [...filters].every((f) => test[f](c)))
  return (
    <div className="component-list">
      <div className="presets" role="group" aria-label="Filter components">
        {(Object.keys(FILTER_LABEL) as ComponentFilter[]).map((f) => (
          <button
            key={f}
            className={`chip-btn ${filters.has(f) ? 'active' : ''}`}
            aria-pressed={filters.has(f)}
            onClick={() => setFilters((s) => (s.has(f) ? new Set([...s].filter((x) => x !== f)) : new Set([...s, f])))}
          >
            {FILTER_LABEL[f]}
          </button>
        ))}
      </div>
      {shown.length === 0 && <p className="faint">No component matches these filters.</p>}
      {(Object.keys(TIER_LABEL) as (keyof typeof TIER_LABEL)[]).map((tier) => {
        const rows = shown.filter((c) => c.def.tier === tier)
        if (rows.length === 0) return null
        return (
          <div key={tier} className="outline-group">
            <div className="eyebrow">{TIER_LABEL[tier]}</div>
            {rows.map((c) => (
              <button key={c.def.id} className={`component-row ${selected === c.def.id ? 'active' : ''}`} aria-current={selected === c.def.id ? 'true' : undefined} onClick={() => select(c.def.id)}>
                <span className="component-name">
                  <span>{c.def.label}</span>
                  <span className="faint">{c.tech}</span>
                </span>
                <span className="mono faint">x{c.replicas}</span>
                <span className="meter" title={`${Math.round(c.utilization * 100)}% peak utilization`}>
                  {c.utilization > 0 && <span style={{ width: `${Math.min(100, c.utilization * 100)}%`, background: utilizationColor(c.utilization) }} />}
                </span>
                <span className="mono">{money(c.monthlyCost)}</span>
              </button>
            ))}
          </div>
        )
      })}
    </div>
  )
}

function impactText(i: AssumptionImpact): string {
  if (i.maxCost - i.minCost >= 1) return `${money(i.minCost)} to ${money(i.maxCost)}/mo`
  if (i.findingChanges > 0) return `changes ${i.findingChanges} finding${i.findingChanges === 1 ? '' : 's'}`
  if (i.componentChanges > 0) return `changes ${i.componentChanges} component${i.componentChanges === 1 ? '' : 's'}`
  return 'no effect'
}

/** The assumed answers, those that move the design most first, each to confirm as it is or to edit. */
function AssumptionRows({ knowledge, answers, evaluation, onOpen }: { knowledge: KnowledgeBase; answers: Answers; evaluation: Evaluation; onOpen: (id: string) => void }) {
  const setAnswer = useProjects((s) => s.setAnswer)
  // shortcut: one evaluation per option (about 2 ms each, 100-400 ms for 20-55 assumptions) on the main thread, only while the list is open; move to a Worker if it grows.
  const [basis, setBasis] = useState(answers)
  const ranked = useMemo(() => assumptionSensitivity(knowledge, basis), [knowledge, basis])
  // Confirm stores the value the design already applies, so the ranking stays and is not recomputed; any other change recomputes it.
  const confirmedOnly = Object.keys({ ...basis, ...answers }).every((id) => {
    const answer = answers[id]
    return basis[id] === answer || (answer?.kind === 'value' && JSON.stringify(ranked.find((i) => i.question.id === id)?.value) === JSON.stringify(answer.value))
  })
  if (!confirmedOnly) setBasis(answers)
  const impacts = ranked.filter((i) => evaluation.questions.find((s) => s.question.id === i.question.id)?.status === 'unknown')
  return (
    <ul className="assumptions">
      {impacts.map((i) => {
        const state = evaluation.questions.find((s) => s.question.id === i.question.id)
        return (
          <li key={i.question.id}>
            <span>
              {i.question.title} <span className="faint">(assumed {state ? valueLabel(state, answers) : String(i.value)})</span>: <span className="mono">{impactText(i)}</span>
            </span>
            <span className="row">
              <button className="btn btn-ghost" disabled={i.value === null} onClick={() => i.value !== null && setAnswer(i.question.id, { kind: 'value', value: i.value })}>
                Confirm
              </button>
              <button className="btn btn-ghost" onClick={() => onOpen(i.question.id)}>
                Edit
              </button>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

export function Sidebar({ evaluation, onOpenDocs, onCompare }: { evaluation: Evaluation; onOpenDocs: () => void; onCompare: (questionId: string) => void }) {
  const [tab, setTab] = useState<Tab>('design')
  const editing = useProjects((s) => s.editing)
  const setEditing = useProjects((s) => s.edit)
  const project = useProjects((s) => (s.activeId ? s.projects[s.activeId] : null))!
  const knowledge = useKnowledge(project.overrides)
  const setAnswer = useProjects((s) => s.setAnswer)
  const setWhatIf = useProjects((s) => s.setWhatIf)
  const apply = useApply()
  const whatIf = useProjects((s) => s.whatIf)
  const previewOption = useProjects((s) => s.previewOption)
  const autoCompleteActive = useProjects((s) => s.autoCompleteActive)
  const editRequest = useProjects((s) => s.editRequest)
  const focusCategory = useProjects((s) => s.focusCategory)
  const [reviewOpen, setReviewOpen] = useState(false)
  // Kept here, outside the design tab, so the expanded categories survive a tab switch.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([(editing ? kb.questions.find((q) => q.id === editing) : evaluation.next?.question)?.category ?? '']))
  // A question or category opened from elsewhere (inspector, cost panel, HUD) shows on the design tab, also when it is already the open one.
  const [seenRequest, setSeenRequest] = useState(editRequest)
  if (editRequest !== seenRequest) {
    setSeenRequest(editRequest)
    if (editing || focusCategory) setTab('design')
    if (focusCategory && !expanded.has(focusCategory)) setExpanded(new Set([...expanded, focusCategory]))
  }
  useEffect(() => {
    if (focusCategory) document.getElementById(`outline-${focusCategory}`)?.scrollIntoView({ block: 'nearest' })
  }, [focusCategory, editRequest])

  const editingState = editing ? evaluation.questions.find((s) => s.question.id === editing && s.active) : undefined
  const current = editingState ?? evaluation.next
  const { answered, total } = evaluation.progress
  const errors = evaluation.findings.filter((f) => f.rule.severity !== 'info').length
  const active = evaluation.questions.filter((s) => s.active)
  const confirmed = active.filter((s) => s.status === 'answered' || s.status === 'custom').length
  const assumed = active.filter((s) => s.status === 'unknown').length
  const openable = useMemo(() => new Set(evaluation.questions.filter((s) => s.active).map((s) => s.question.id)), [evaluation])

  const open = (id: string) => {
    setTab('design')
    setEditing(id)
  }
  const preview = (questionId: string) => (value: FactValue | null) => previewOption(value === null ? null : { [questionId]: { kind: 'value', value } })

  const tabButton = (id: Tab, label: ReactNode) => (
    <button role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
      {label}
    </button>
  )

  return (
    <aside className="sidebar" aria-label="Design questions">
      <Progress evaluation={evaluation} />
      <div className="sidebar-total faint">
        <span className="mono">{money(runAndPeople(evaluation))}/mo</span> after {answered} answer{answered === 1 ? '' : 's'}
      </div>
      <div className="tabs" role="tablist">
        {tabButton(
          'design',
          <>
            Design <span className="faint">{answered}/{total}</span>
          </>,
        )}
        {tabButton('findings', <>Findings {errors > 0 && <span className="chip chip-warn">{errors}</span>}</>)}
        {tabButton('components', <>Components ({evaluation.architecture.components.length})</>)}
      </div>

      <div className="sidebar-scroll">
        {tab === 'design' && (
          <>
            {current ? (
              <>
                {editingState && (
                  <button className="btn btn-ghost back" onClick={() => setEditing(null)}>
                    Back to next question
                  </button>
                )}
                <QuestionCard
                  key={current.question.id}
                  state={current}
                  facts={evaluation.facts}
                  answers={project.answers}
                  knowledge={knowledge}
                  onCompare={COMPARISONS.some((c) => c.questionId === current.question.id) ? () => onCompare(current.question.id) : undefined}
                  onOpen={(id) => setEditing(id)}
                  openable={openable}
                  answer={project.answers[current.question.id]}
                  suggestion={project.suggestions?.[current.question.id]}
                  previewing={(whatIf?.[current.question.id] as { value?: FactValue } | undefined)?.value ?? null}
                  onPreview={preview(current.question.id)}
                  onAnswer={(a) => {
                    setWhatIf(null)
                    setAnswer(current.question.id, a)
                    if (editingState) setEditing(null)
                  }}
                  onApply={(change, label) => {
                    apply(change, label)
                    if (editingState) setEditing(null)
                  }}
                />
                <div className="skip-row">
                  <button
                    className="btn btn-ghost"
                    onClick={() => {
                      setEditing(null)
                      autoCompleteActive()
                    }}
                    title="Use the answers detected in the brief, then accept the recommendation for every remaining question"
                  >
                    Auto-design the rest with recommendations
                  </button>
                </div>
              </>
            ) : (
              <section className="question-card done">
                <div className="eyebrow">Every relevant decision is made</div>
                <h2>
                  Design complete: {confirmed} of {total} answers confirmed
                </h2>
                <p className="muted">Change any answer below and the architecture, capacity and documents update. Save a version before you explore alternatives.</p>
                {assumed > 0 && (
                  <details className="assumption-review" open={reviewOpen} onToggle={(e) => setReviewOpen(e.currentTarget.open)}>
                    <summary>Confirm {assumed} assumption{assumed === 1 ? '' : 's'}</summary>
                    <p className="faint">Sorted by how far each assumption moves the monthly cost over its options (numbers at x0.1 and x10, or their presets when 0).</p>
                    {reviewOpen && <AssumptionRows knowledge={knowledge} answers={project.answers} evaluation={evaluation} onOpen={open} />}
                  </details>
                )}
                <button className="btn btn-primary" onClick={onOpenDocs}>
                  Open generated documentation
                </button>
              </section>
            )}
            <Outline
              evaluation={evaluation}
              answers={project.answers}
              open={current?.question.id ?? null}
              expanded={expanded}
              onToggle={(id) => setExpanded((e) => (e.has(id) ? new Set([...e].filter((x) => x !== id)) : new Set([...e, id])))}
              // A second click on the open question closes it again.
              onOpen={(id) => setEditing(id === editing ? null : id)}
              onClear={(id) => setAnswer(id, null)}
            />
          </>
        )}
        {tab === 'findings' && <Findings evaluation={evaluation} onOpen={open} />}
        {tab === 'components' && <ComponentList evaluation={evaluation} overrides={project.overrides} />}
      </div>
    </aside>
  )
}
