import { useMemo, useRef, useState } from 'react'
import type { Answers, AnswerValue, FactValue, Question, Scenario } from '../domain/types'
import { evaluate } from '../engine/evaluate'
import { pickSuggestions, suggestFromDescription, suggestionKey, suggestionValues } from '../engine/explore'
import { kb } from '../knowledge'
import { useProjects } from '../store/projectStore'
import { parseNumberInput } from './input'
import { decidesFor, kindExamples, shownChoice } from './kindCards'
import { SuggestionChips, UnmappedTerms } from './Suggestions'

const v = (value: FactValue): AnswerValue => ({ kind: 'value', value })
const question = (id: string) => kb.questions.find((q) => q.id === id)!
const kindQuestion = question('project.kind')
const originQuestion = question('project.origin')
// Fixed constraints asked before the first question; each shows only while the draft makes it relevant (sources only for a migration).
const CONSTRAINTS = ['infra.cloud', 'security.residency', 'org.existing_platforms', 'security.compliance', 'infra.budget', 'team.size', 'source.kinds'].map(question)

/** Step-2 choices (null: Not decided) over the step-1 answers, so step 2 shows exactly what Start saves (Not decided drops a used Azure). */
function withChoices(answers: Answers, choices: Record<string, AnswerValue | null>): Answers {
  const out = { ...answers }
  for (const [id, a] of Object.entries(choices)) {
    if (a) out[id] = a
    else delete out[id]
  }
  return out
}

type Group = 'data' | 'ai' | 'migration' | 'other' | 'case'
const GROUP_LABEL: Record<Group, string> = { data: 'Data and analytics', ai: 'AI applications', migration: 'Migration and modernization', other: 'Enterprise starters', case: 'Learn from case studies' }

function groupOf(s: Scenario, facts: Record<string, FactValue>): Group {
  if (s.caseStudy) return 'case'
  if (facts['profile.migration']) return 'migration'
  if (facts['profile.dataPlatform']) return 'data'
  if (facts['profile.ai']) return 'ai'
  return 'other'
}

function useScenarios() {
  return useMemo(
    () =>
      kb.scenarios.map((s) => {
        const facts = evaluate(kb, s.answers).facts
        return { scenario: s, group: groupOf(s, facts), kind: String(facts['project.kind'] ?? kindQuestion.default) }
      }),
    [],
  )
}

function NumberField({ q, value, onChange }: { q: Question; value: FactValue | undefined; onChange: (a: AnswerValue | undefined) => void }) {
  // The typed text stays as typed; the answer is clamped to the question's range, and text that does not read as a number is flagged, not dropped silently.
  const [text, setText] = useState(typeof value === 'number' ? String(value) : '')
  const parsed = parseNumberInput(text)
  const invalid = text.trim() !== '' && parsed === null
  return (
    <label className="field">
      <span>
        {q.title} ({q.number!.unit})
      </span>
      <input
        className="input mono"
        inputMode="decimal"
        placeholder="Not decided"
        value={text}
        aria-invalid={invalid}
        onChange={(e) => {
          const n = parseNumberInput(e.target.value)
          setText(e.target.value)
          onChange(n === null ? undefined : v(Math.min(q.number!.max, Math.max(q.number!.min, n))))
        }}
      />
      {invalid && <span className="option-warn" role="alert">Not a number, so nothing is saved. Type digits, e.g. 5000, 5,000 or 5k.</span>}
    </label>
  )
}

function ConstraintField({ q, value, onChange }: { q: Question; value: AnswerValue | undefined; onChange: (a: AnswerValue | undefined) => void }) {
  const current = value?.kind === 'value' ? value.value : undefined
  if (q.kind === 'number') return <NumberField q={q} value={current} onChange={onChange} />
  const chosen = Array.isArray(current) ? current : typeof current === 'string' ? [current] : []
  return (
    <fieldset className="constraint">
      <legend>{q.title}</legend>
      <div className="presets" role={q.kind === 'single' ? 'radiogroup' : 'group'} aria-label={q.title}>
        {q.kind === 'single' && (
          <button type="button" role="radio" aria-checked={chosen.length === 0} className={`chip-btn ${chosen.length === 0 ? 'active' : ''}`} onClick={() => onChange(undefined)}>
            Not decided
          </button>
        )}
        {q.options!.map((o) => {
          const on = chosen.includes(o.id)
          const next = on ? chosen.filter((x) => x !== o.id) : [...chosen, o.id]
          return (
            <button
              key={o.id}
              type="button"
              {...(q.kind === 'single' ? { role: 'radio', 'aria-checked': on } : { 'aria-pressed': on })}
              className={`chip-btn ${on ? 'active' : ''}`}
              title={o.description}
              onClick={() => onChange(q.kind === 'single' ? v(o.id) : next.length ? v(next) : undefined)}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}

export function Welcome() {
  const projects = useProjects((s) => s.projects)
  const createProject = useProjects((s) => s.createProject)
  const openProject = useProjects((s) => s.openProject)
  const deleteProject = useProjects((s) => s.deleteProject)
  const duplicateProject = useProjects((s) => s.duplicateProject)
  const importProject = useProjects((s) => s.importProject)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [step, setStep] = useState<1 | 2>(1)
  const [kind, setKind] = useState<string | null>(null)
  const [origin, setOrigin] = useState<string | null>(null)
  const [constraints, setConstraints] = useState<Record<string, AnswerValue | null>>({})
  // Chips toggled off, and per question whether its chips are used as answers or ignored; neither keeps them as suggestions.
  const [off, setOff] = useState<ReadonlySet<string>>(new Set())
  const [decision, setDecision] = useState<Record<string, 'use' | 'ignore'>>({})
  const [error, setError] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const form = useRef<HTMLFormElement>(null)
  // The two steps differ in height, so the form scrolls back to its top on a step change.
  const goTo = (next: 1 | 2) => {
    setStep(next)
    form.current?.scrollIntoView({ block: 'start' })
  }
  const scenarios = useScenarios()
  const decides = useMemo(() => Object.fromEntries(kindQuestion.options!.map((o) => [o.id, decidesFor(o.id)])), [])
  const suggestions = useMemo(() => suggestFromDescription(kb, description), [description])
  const setup = useMemo((): Answers => ({ ...(kind && { 'project.kind': v(kind) }), ...(origin && { 'project.origin': v(origin) }) }), [kind, origin])
  const picked = useMemo(() => pickSuggestions(kb, suggestions, off), [suggestions, off])
  const used = useMemo(() => Object.fromEntries(Object.entries(picked).filter(([id]) => decision[id] === 'use')), [picked, decision])
  // The constraint questions the kind, origin and used suggestions make relevant, e.g. the existing sources only for a migration.
  const answers = useMemo(() => withChoices({ ...used, ...setup }, constraints), [used, setup, constraints])
  const draft = useMemo(() => evaluate(kb, answers), [answers])
  const shownConstraints = CONSTRAINTS.filter((q) => draft.questions.find((s) => s.question.id === q.id)?.active)
  const list = Object.values(projects).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  // A used detection shows as the selected kind and origin; an ignored or untoggled one drops its badge.
  const shownKind = shownChoice(kind, answers, 'project.kind')
  const shownOrigin = shownChoice(origin, answers, 'project.origin')
  const detectedKind = decision['project.kind'] === 'ignore' ? null : shownChoice(null, picked, 'project.kind')

  const start = () => {
    const kept = Object.fromEntries(Object.entries(picked).filter(([id]) => !decision[id]))
    const fixed = Object.fromEntries(Object.entries(constraints).filter(([id]) => shownConstraints.some((q) => q.id === id)))
    // Detections toggled off or ignored stay dismissed, so the brief and a description edit do not offer them again.
    const dismissed = Object.entries(suggestions).flatMap(([id, a]) => suggestionValues(a).map((x) => suggestionKey(id, x)).filter((key) => off.has(key) || decision[id] === 'ignore'))
    createProject(name.trim() || 'Untitled system', description.trim(), withChoices({ ...used, ...setup }, fixed), kept, dismissed)
  }
  const groupAction = (id: string, d: 'use' | 'ignore', label: string) => (
    <button type="button" className={`btn btn-ghost ${decision[id] === d ? 'active' : ''}`} aria-pressed={decision[id] === d} onClick={() =>
        setDecision((x) => {
          const { [id]: was, ...rest } = x
          return was === d ? rest : { ...rest, [id]: d }
        })
      }
    >
      {label}
    </button>
  )

  return (
    <main className="welcome">
      <section className="welcome-hero">
        <div className="eyebrow">System Architecture Designer</div>
        <h1>Describe the system. Answer what matters. Watch the architecture build itself.</h1>
        <p className="muted">
          A decision engine built from three system-design knowledge bases ({kb.questions.length} questions, {kb.components.length} component types,{' '}
          {kb.validations.length} validation rules). It asks only what your earlier answers make relevant and prefers the simplest design that meets your numbers.
        </p>
      </section>

      <div className="welcome-grid">
        <form
          ref={form}
          className="card new-project"
          onSubmit={(e) => {
            e.preventDefault()
            if (step === 1) goTo(2)
            else start()
          }}
        >
          <div className="row">
            <h2>New project</h2>
            <span className="spacer" />
            <span className="faint">Step {step} of 2</span>
          </div>
          {step === 1 ? (
            <>
              <label className="field">
                <span>Name</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Photo sharing app" />
              </label>
              <label className="field">
                <span>What does it do?</span>
                <textarea
                  className="textarea"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="A marketplace where sellers upload photos, buyers search the catalog, chat with sellers and pay at checkout."
                />
              </label>
              {Object.keys(suggestions).length > 0 && (
                <div className="detected">
                  <span className="faint">Detected in the description. Use answers them now, Ignore drops them; the rest show as suggestions on their question.</span>
                  <SuggestionChips
                    suggestions={suggestions}
                    off={off}
                    setOff={setOff}
                    dimmed={(id) => decision[id] === 'ignore'}
                    actions={(id) => (
                      <>
                        {groupAction(id, 'use', 'Use')}
                        {groupAction(id, 'ignore', 'Ignore')}
                      </>
                    )}
                  />
                </div>
              )}
              <UnmappedTerms description={description} />
              <fieldset className="constraint">
                <legend>What kind of work is this?</legend>
                <div className="kind-grid">
                  {kindQuestion.options!.map((o) => {
                    const examples = kindExamples(scenarios, o.id)
                    return (
                      <div key={o.id} className={`kind-card ${shownKind === o.id ? 'selected' : ''}`}>
                        <button type="button" className="kind-main" aria-pressed={shownKind === o.id} onClick={() => setKind(kind === o.id ? null : o.id)}>
                          <strong>
                            {o.label} {detectedKind === o.id && <span className="chip chip-suggested">from your description</span>}
                          </strong>
                          <span className="muted">{o.description}</span>
                          {decides[o.id].length > 0 && (
                            <span className="faint">
                              You will decide: {decides[o.id].slice(0, 3).join(', ')}
                              {decides[o.id].length > 3 && ` and ${decides[o.id].length - 3} more`}
                            </span>
                          )}
                        </button>
                        {examples.length > 0 && (
                          <span className="kind-examples faint">
                            Start from example:{' '}
                            {examples.map((x) => (
                              <button key={x.scenario.id} type="button" className="link" onClick={() => createProject(x.scenario.name, x.scenario.description, x.scenario.answers, {})}>
                                {x.scenario.name}
                              </button>
                            ))}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </fieldset>
              <fieldset className="constraint">
                <legend>{originQuestion.title}</legend>
                <div className="presets" role="radiogroup" aria-label={originQuestion.title}>
                  {originQuestion.options!.map((o) => (
                    <button key={o.id} type="button" role="radio" aria-checked={shownOrigin === o.id} className={`chip-btn ${shownOrigin === o.id ? 'active' : ''}`} title={o.description} onClick={() => setOrigin(origin === o.id ? null : o.id)}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </fieldset>
              <button className="btn btn-primary" type="submit">
                Next: fixed constraints
              </button>
            </>
          ) : (
            <>
              <p className="muted">Constraints that are already fixed. They are saved as answers before the first question; leave anything open as Not decided.</p>
              {shownConstraints.map((q) => (
                <ConstraintField
                  key={q.id}
                  q={q}
                  value={answers[q.id]}
                  onChange={(a) => setConstraints((c) => ({ ...c, [q.id]: a ?? null }))}
                />
              ))}
              <div className="row">
                <button className="btn" type="button" onClick={() => goTo(1)}>
                  Back
                </button>
                <button className="btn btn-primary" type="submit">
                  Start designing
                </button>
              </div>
            </>
          )}
        </form>

        <section className="card">
          <h2>Start from a scenario</h2>
          <p className="muted">Requirements are filled in; you make the decisions.</p>
          {(['data', 'ai', 'migration', 'other'] as const).map((g) => {
            const items = scenarios.filter((x) => x.group === g)
            return (
              items.length > 0 && (
                <div key={g} className="scenario-list">
                  <div className="eyebrow">{GROUP_LABEL[g]}</div>
                  {items.map(({ scenario: s }) => (
                    <button key={s.id} className="scenario" onClick={() => createProject(s.name, s.description, s.answers, {})}>
                      <strong>{s.name}</strong>
                      <span className="muted">{s.description}</span>
                    </button>
                  ))}
                </div>
              )
            )
          })}
          <details className="scenario-list">
            <summary className="eyebrow">{GROUP_LABEL.case}</summary>
            {scenarios
              .filter((x) => x.group === 'case')
              .map(({ scenario: s }) => (
                <button key={s.id} className="scenario" onClick={() => createProject(s.name, s.description, s.answers, {})}>
                  <strong>{s.name}</strong>
                  <span className="muted">{s.description}</span>
                </button>
              ))}
          </details>
        </section>

        <section className="card">
          <div className="row">
            <h2>Your projects</h2>
            <span className="spacer" />
            <button className="btn" onClick={() => file.current?.click()}>
              Import JSON
            </button>
            <input
              ref={file}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              aria-label="Import project file"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (!f) return
                try {
                  importProject(await f.text())
                  setError(null)
                } catch (err) {
                  setError(`Import failed: ${(err as Error).message}`)
                }
                e.target.value = ''
              }}
            />
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          {list.length === 0 ? (
            <p className="faint">Projects are saved in this browser automatically.</p>
          ) : (
            <ul className="project-list">
              {list.map((p) => (
                <li key={p.id}>
                  <button className="project-open" onClick={() => openProject(p.id)}>
                    <strong>{p.name}</strong>
                    <span className="faint">
                      {Object.keys(p.answers).length} answers · {p.versions.length} versions · {new Date(p.updatedAt).toLocaleDateString()}
                    </span>
                  </button>
                  <button className="btn btn-ghost" onClick={() => duplicateProject(p.id)}>Duplicate</button>
                  <button
                    className="btn btn-ghost btn-danger"
                    onClick={() => {
                      if (confirm(`Delete "${p.name}"? This cannot be undone.`)) deleteProject(p.id)
                    }}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  )
}
