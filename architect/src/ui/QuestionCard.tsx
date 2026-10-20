import { useMemo, useState } from 'react'
import type { Answers, AnswerValue, Facts, FactValue, KnowledgeBase, Question, QuestionOption, QuestionState } from '../domain/types'
import { fmt, money, signedMoney } from '../engine/architecture'
import { evaluateCondition, explainCondition, referencedFacts } from '../engine/conditions'
import { evaluate } from '../engine/evaluate'
import { optionChange, runAndPeople } from '../engine/explore'
import { kb } from '../knowledge'

const questionTitle = (id: string) => kb.questions.find((q) => q.id === id)?.title ?? id
import { optionCosts, type OptionCost } from './costing'
import { cutoverFigure, linkOptionFigure } from './migrationFigures'
import { parseNumberInput, sliderScale } from './input'

interface Props {
  state: QuestionState
  answer: AnswerValue | undefined
  /** Detected in the project description; shown as the draft until the user answers. */
  suggestion?: AnswerValue
  onAnswer: (answer: AnswerValue | null) => void
  /** Applies an option together with the answers it resets (its cost chip prices both), as one undo step. */
  onApply?: (answers: Answers, label: string) => void
  onPreview: (value: FactValue | null) => void
  previewing: FactValue | null
  /** Facts of the current design, to show on which providers each option is feasible. */
  facts?: Facts
  /** The project's answers and knowledge base (with its overrides), to price each option. */
  answers?: Answers
  knowledge?: KnowledgeBase
  /** Opens the side-by-side comparison of this question's options. */
  onCompare?: () => void
  /** Opens another question in the card; `openable` lists the ids it can open (the active ones). */
  onOpen?: (questionId: string) => void
  openable?: ReadonlySet<string>
}

function useOptionCosts(state: QuestionState, selected: unknown, answers?: Answers, knowledge?: KnowledgeBase): Record<string, OptionCost> | null {
  return useMemo(() => (answers && knowledge ? optionCosts(knowledge, answers, state, selected) : null), [state, selected, answers, knowledge])
}

/** The monthly total with the question at each preset. */
function usePresetTotals(state: QuestionState, answers?: Answers, knowledge?: KnowledgeBase): Record<string, number> | null {
  const q = state.question
  return useMemo(() => {
    if (!answers || !knowledge || q.kind !== 'number' || !q.number) return null
    return Object.fromEntries(q.number.presets.map((p) => [p.label, runAndPeople(evaluate(knowledge, { ...answers, [q.id]: { kind: 'value', value: p.value } }))]))
  }, [q, answers, knowledge])
}

function CostChips({ cost }: { cost: OptionCost }) {
  const tone = (n: number) => (n >= 1 ? 'cost-up' : n <= -1 ? 'cost-down' : '')
  return (
    <>
      <span className={`chip cost-chip ${tone(cost.monthly)}`}>{signedMoney(cost.monthly)}{Math.abs(cost.monthly) >= 1 ? '/mo' : ''}</span>
      {Math.abs(cost.oneOff) >= 1 && <span className={`chip cost-chip ${tone(cost.oneOff)}`}>{signedMoney(cost.oneOff)} one-off</span>}
      {cost.resets.length > 0 && <span className="chip" title={`Priced with ${cost.resets.join(', ')} back at the recommendation`}>resets {cost.resets.length} answer{cost.resets.length === 1 ? '' : 's'}</span>}
      {cost.knockOn && <span className="chip chip-danger" title={cost.knockOn}>Infeasible</span>}
    </>
  )
}
const providers = kb.questions.find((q) => q.id === 'infra.cloud')?.options ?? []

/** Providers on which the option is feasible with the other answers as they are; null when its feasibility does not depend on the provider. */
function runsOn(option: QuestionOption, facts: Facts): string | null {
  if (!referencedFacts(option.feasibleWhen).has('infra.cloud')) return null
  const labels = providers.filter((p) => evaluateCondition(option.feasibleWhen, { facts: { ...facts, 'infra.cloud': p.id } })).map((p) => p.label)
  return labels.length > 0 ? labels.join(', ') : 'no provider with the current answers'
}

/** The project kind whose rule set this question's default, to name it beside the default; null when the stated default applies. */
function defaultKind(q: Question, facts?: Facts): string | null {
  const rule = facts && q.defaultWhen?.find((d) => evaluateCondition(d.when, { facts }))
  if (!rule || !referencedFacts(rule.when).has('project.kind')) return null
  return kb.questions.find((x) => x.id === 'project.kind')?.options?.find((o) => o.id === facts['project.kind'])?.label ?? null
}

function NumberInput({ state, answer, onAnswer, onPreview, totals }: Pick<Props, 'state' | 'answer' | 'onAnswer' | 'onPreview'> & { totals: Record<string, number> | null }) {
  const spec = state.question.number!
  // Unanswered, the slider starts at the default the engine assumes for these facts (defaultWhen), not the stated one.
  const assumed = typeof state.recommendation.value === 'number' ? state.recommendation.value : (state.question.default as number)
  const current = answer?.kind === 'value' && typeof answer.value === 'number' ? answer.value : assumed
  // null shows the committed value; a string holds what the user is typing.
  const [draft, setDraft] = useState<string | null>(null)
  // The slider previews while it moves and commits once on release, so one drag is one undo step.
  const [slide, setSlide] = useState<number | null>(null)
  const scale = sliderScale(spec)
  const { toSlider, fromSlider } = scale
  // Text that does not read as a number stays in the field, marked invalid, instead of reverting as if it were saved.
  const [invalid, setInvalid] = useState(false)
  const commit = (v: number | null) => {
    if (v === null || !Number.isFinite(v)) {
      setInvalid(true)
      return
    }
    setDraft(null)
    setInvalid(false)
    onAnswer({ kind: 'value', value: Math.min(spec.max, Math.max(spec.min, v)) })
  }
  const release = () => {
    if (slide === null) return
    setSlide(null)
    commit(slide)
  }
  return (
    <div className="number-input">
      <div className="presets">
        {spec.presets.map((p) => (
          <button key={p.label} className={`chip-btn ${current === p.value && answer ? 'active' : ''}`} onClick={() => commit(p.value)}>
            {p.label}
            {totals && <span className="preset-cost mono">{money(totals[p.label])}/mo</span>}
          </button>
        ))}
      </div>
      <input
        type="range"
        aria-label={`${state.question.title} slider`}
        min={scale.min}
        max={scale.max}
        step={scale.step}
        value={toSlider(slide ?? current)}
        onChange={(e) => {
          const v = fromSlider(Number(e.target.value))
          setSlide(v)
          onPreview(v)
        }}
        onPointerUp={release}
        onKeyUp={release}
        onBlur={release}
      />
      <div className="number-row">
        <input
          className="input mono"
          aria-label={state.question.title}
          inputMode="decimal"
          value={draft ?? String(slide ?? current)}
          aria-invalid={invalid}
          onChange={(e) => {
            setDraft(e.target.value)
            setInvalid(false)
          }}
          onBlur={() => draft !== null && commit(parseNumberInput(draft))}
          onKeyDown={(e) => e.key === 'Enter' && draft !== null && commit(parseNumberInput(draft))}
        />
        <span className="muted">{spec.unit}</span>
        {!answer && (
          <button className="btn btn-primary" onClick={() => commit(current)}>
            Use {fmt(current)}
          </button>
        )}
      </div>
      {invalid && <p className="option-warn" role="alert">Not a number, so it was not saved. Type digits, e.g. 20000, 20,000 or 20k.</p>}
    </div>
  )
}

export function QuestionCard({ state, answer, suggestion, onAnswer, onApply, onPreview, previewing, facts, answers, knowledge, onCompare, onOpen, openable }: Props) {
  const q = state.question
  const [expanded, setExpanded] = useState<string | null>(null)
  const [customOpen, setCustomOpen] = useState(answer?.kind === 'custom')
  const [customText, setCustomText] = useState(answer?.kind === 'custom' ? answer.text : '')
  // Suggestions count only until the question is answered.
  const suggested = !answer && suggestion?.kind === 'value' ? [suggestion.value].flat().filter((v): v is string => typeof v === 'string') : []
  const [treatAs, setTreatAs] = useState(answer?.kind === 'custom' ? answer.treatAs : (suggested[0] ?? state.recommendation.optionId ?? q.options?.[0]?.id ?? ''))
  const recommended = state.recommendation.optionId
  const selected = answer?.kind === 'value' ? answer.value : answer?.kind === 'custom' ? answer.treatAs : null
  const multiSelected = Array.isArray(selected) ? selected : []
  // A pending question has no effective value; the engine assumes the recommendation's value (the kind's default), so the draft starts there.
  const multiDefault = Array.isArray(state.recommendation.value) ? state.recommendation.value : []
  const [multiDraft, setMultiDraft] = useState<string[]>(
    multiSelected.length ? multiSelected : suggested.length ? suggested : Array.isArray(state.effectiveValue) ? state.effectiveValue : multiDefault,
  )
  const kindLabel = useMemo(() => defaultKind(q, facts), [q, facts])
  const defaultChip = <span className="chip">default{kindLabel ? ` for ${kindLabel}` : ''}</span>
  const assumption =
    q.kind === 'single'
      ? recommended && `"${q.options?.find((o) => o.id === recommended)?.label}"`
      : q.kind === 'multi'
        ? multiDefault.length > 0 ? multiDefault.map((id) => q.options?.find((o) => o.id === id)?.label ?? id).join(', ') : 'none'
        : q.kind === 'number' && typeof state.recommendation.value === 'number' && `${fmt(state.recommendation.value)} ${q.number?.unit ?? ''}`.trim()
  const fromDescription = <span className="chip chip-suggested">from your description</span>

  const scoreOf = (id: string) => state.recommendation.scores.find((s) => s.optionId === id)
  const costs = useOptionCosts(state, selected, answers, knowledge)
  const presetTotals = usePresetTotals(state, answers, knowledge)
  const why = useMemo(() => (facts && q.askWhen ? explainCondition(q.askWhen, facts, kb, { positiveOnly: true }) : []), [facts, q])

  return (
    <section className="question-card" aria-labelledby={`q-${q.id}`}>
      <header className="question-head">
        <div className="eyebrow">{kb.categories.find((c) => c.id === q.category)?.label}{q.isDecision ? ' · decision' : ' · requirement'}</div>
        <h2 id={`q-${q.id}`}>{q.prompt}</h2>
        {why.length > 0 && <p className="faint question-why">Asked because {why.join('; ')}.</p>}
        {q.help && <p className="muted question-help">{q.help}</p>}
        {facts && ['migration.sync', 'migration.downtime', 'migration.link'].includes(q.id) && cutoverFigure(facts) && <p className="question-help question-figure">{cutoverFigure(facts)}</p>}
        {state.dependsOn.length > 0 && (
          <div className="depends">
            <span className="faint">Depends on</span>
            {state.dependsOn.slice(0, 6).map((id) =>
              onOpen && openable?.has(id) ? (
                <button key={id} className="chip chip-link" onClick={() => onOpen(id)} title={`Open ${questionTitle(id)}`}>
                  {questionTitle(id)}
                </button>
              ) : (
                <span key={id} className="chip">
                  {questionTitle(id)}
                </span>
              ),
            )}
          </div>
        )}
      </header>

      {q.kind === 'number' && <NumberInput state={state} answer={answer} onAnswer={onAnswer} onPreview={onPreview} totals={presetTotals} />}

      {q.kind === 'multi' && (
        <div className="options">
          {q.options!.map((o) => {
            const checked = multiDraft.includes(o.id)
            // A ruled-out option can still be unticked, but not ticked (an add-on the kind of task already includes).
            const ruledOut = !!facts && !!o.feasibleWhen && !evaluateCondition(o.feasibleWhen, { facts })
            return (
              <label key={o.id} className={`option option-check ${checked ? 'selected' : ''} ${ruledOut ? 'infeasible' : ''}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={ruledOut && !checked}
                  onChange={() => setMultiDraft((d) => (checked ? d.filter((x) => x !== o.id) : [...d, o.id]))}
                />
                <span>
                  <span className="option-label">{o.label}</span>
                  {suggested.includes(o.id) && <> {fromDescription}</>}
                  {multiDefault.includes(o.id) && <> {defaultChip}</>}
                  <span className="option-desc muted">{o.description}</span>
                  {ruledOut && <span className="option-warn">{o.infeasibleReason}</span>}
                </span>
              </label>
            )
          })}
          <button className="btn btn-primary" onClick={() => onAnswer({ kind: 'value', value: multiDraft })}>
            Confirm {multiDraft.length} selected
          </button>
        </div>
      )}

      {q.kind === 'single' && (
        <div className="options" role="radiogroup" aria-labelledby={`q-${q.id}`}>
          {q.options!.map((o) => {
            const s = scoreOf(o.id)
            const isRecommended = recommended === o.id && q.isDecision
            const isSelected = selected === o.id
            const open = expanded === o.id
            const runs = facts ? runsOn(o, facts) : null
            return (
              <div key={o.id} className={`option ${isSelected ? 'selected' : ''} ${suggested.includes(o.id) ? 'suggested' : ''} ${s && !s.feasible ? 'infeasible' : ''} ${previewing === o.id ? 'previewing' : ''}`}>
                <button
                  className="option-main"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => {
                    const resetIds = costs?.[o.id]?.resetIds ?? []
                    if (onApply && resetIds.length > 0) onApply(optionChange(q.id, o.id, resetIds), `${q.title} = ${o.label}`)
                    else onAnswer({ kind: 'value', value: o.id })
                  }}
                  onMouseEnter={() => onPreview(o.id)}
                  onMouseLeave={() => onPreview(null)}
                  onFocus={() => onPreview(o.id)}
                  onBlur={() => onPreview(null)}
                >
                  <span className="option-top">
                    <span className="option-label">{o.label}</span>
                    {isRecommended && <span className="chip chip-accent">Recommended</span>}
                    {suggested.includes(o.id) && fromDescription}
                    {s && !s.feasible && <span className="chip chip-danger">Infeasible</span>}
                    {costs?.[o.id] && <CostChips cost={costs[o.id]} />}
                    {q.isDecision && <span className="complexity" aria-label={`Complexity ${o.complexity} of 5`}>{'●'.repeat(o.complexity)}{'○'.repeat(5 - o.complexity)}</span>}
                  </span>
                  <span className="option-desc muted">{o.description}</span>
                  {runs && <span className="option-runs faint">Runs on: {runs}</span>}
                  {facts && q.id === 'migration.link' && s?.feasible !== false && linkOptionFigure(o.id, facts) && <span className="option-runs faint">{linkOptionFigure(o.id, facts)}</span>}
                  {s && !s.feasible && <span className="option-warn">{s.infeasibleReason}</span>}
                  {isRecommended && s && s.reasons.length > 0 && <span className="option-why">{s.reasons[0]}</span>}
                </button>
                {(o.pros.length > 0 || o.cons.length > 0) && (
                  <button className="option-more" aria-expanded={open} onClick={() => setExpanded(open ? null : o.id)}>
                    {open ? 'Hide trade-offs' : 'Trade-offs'}
                  </button>
                )}
                {open && (
                  <div className="tradeoffs">
                    <ul className="pros">{o.pros.map((p) => <li key={p}>{p}</li>)}</ul>
                    <ul className="cons">{o.cons.map((c) => <li key={c}>{c}</li>)}</ul>
                    {s && s.reasons.length + s.penalties.length > 0 && (
                      <div className="faint">
                        {s.reasons.length > 0 && `Matched: ${s.reasons.join(' ')} `}
                        {s.penalties.length > 0 && `Against: ${s.penalties.join(' ')} `}
                        (score {s.score.toFixed(1)})
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <footer className="question-foot">
        <button className="btn" onClick={() => onAnswer({ kind: 'unknown' })} title="Use the recommendation or default as an assumption">
          Not sure: assume {assumption || 'default'}
        </button>
        {onCompare && (
          <button className="btn btn-ghost" onClick={onCompare}>
            Compare
          </button>
        )}
        {q.kind === 'single' && (
          <button className="btn btn-ghost" onClick={() => setCustomOpen((v) => !v)} aria-expanded={customOpen}>
            Custom answer
          </button>
        )}
        {answer && (
          <button className="btn btn-ghost" onClick={() => onAnswer(null)}>
            Clear
          </button>
        )}
      </footer>

      {customOpen && q.kind === 'single' && (
        <div className="custom">
          <input className="input" placeholder="e.g. CockroachDB, NATS, Fly.io" value={customText} onChange={(e) => setCustomText(e.target.value)} aria-label="Custom answer" />
          <div className="muted">Behaves like (drives the engine):</div>
          <div className="presets" role="radiogroup" aria-label="Behaves like">
            {q.options!.map((o) => (
              <button key={o.id} role="radio" aria-checked={treatAs === o.id} className={`chip-btn ${treatAs === o.id ? 'active' : ''}`} onClick={() => setTreatAs(o.id)}>
                {o.label}
              </button>
            ))}
          </div>
          <button className="btn btn-primary" disabled={!customText.trim()} onClick={() => onAnswer({ kind: 'custom', text: customText.trim(), treatAs })}>
            Save custom answer
          </button>
        </div>
      )}
    </section>
  )
}
