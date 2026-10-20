import type { Answers, AnswerValue, Evaluation, FactValue, KnowledgeBase, Question, QuestionOption } from '../domain/types'
import { evaluate, transitionMonths } from './evaluate'
import { fmt } from './architecture'
import { evaluateCondition } from './conditions'

/** Accepts the recommendation for every remaining relevant question. */
export function autoComplete(kb: KnowledgeBase, answers: Answers): Answers {
  let current = { ...answers }
  for (let i = 0; i < kb.questions.length; i++) {
    const next = evaluate(kb, current).next
    if (!next) break
    current = { ...current, [next.question.id]: { kind: 'unknown' } }
  }
  return current
}

/** The design with every remaining question at its recommendation; compared alternatives take their scores and their metrics from it alike. */
export const assumedDesign = (kb: KnowledgeBase, answers: Answers): Evaluation => evaluate(kb, autoComplete(kb, answers))

export interface WhatIfLever {
  label: string
  overrides: Answers
}

/**
 * What-if presets for this design, built on the same path the preview takes (evaluate(answers + lever) against evaluate(answers)):
 * only levers whose questions are active and whose trial design differs in cost, parts or findings, so a data platform never shows
 * traffic levers it ignores and a design already on Azure gets no 'Move to Azure'.
 */
export function whatIfLevers(kb: KnowledgeBase, answers: Answers): WhatIfLever[] {
  const base = evaluate(kb, answers)
  const num = (id: string, fallback: number) => (typeof base.facts[id] === 'number' ? (base.facts[id] as number) : fallback)
  const lever = (label: string, id: string, value: FactValue): WhatIfLever => ({ label, overrides: { [id]: { kind: 'value', value } } })
  const dau = num('traffic.dau', 10_000)
  const active = new Set(base.questions.filter((s) => s.active).map((s) => s.question.id))
  const moves = (l: WhatIfLever) => {
    const d = diffEvaluations(base, evaluate(kb, { ...answers, ...l.overrides }))
    return Math.abs(d.costDelta) >= 0.5 || d.added.length + d.removed.length + d.rescaled.length + d.retech.length + d.findingsAdded.length + d.findingsResolved.length > 0
  }
  return [
    lever('Traffic x10', 'traffic.dau', dau * 10),
    lever('Traffic x100', 'traffic.dau', dau * 100),
    lever('Traffic / 10', 'traffic.dau', Math.max(10, dau / 10)),
    lever('Existing data x10', 'data.history_tb', Math.max(1, num('data.history_tb', 0)) * 10),
    lever('Data doubles yearly', 'data.growth_pct', 100),
    lever('Report viewers x10', 'data.analytics_users', num('data.analytics_users', 25) * 10),
    lever('Queries 24 h', 'data.analytics_hours', 24),
    lever('Fresh in minutes', 'data.freshness', 'minutes'),
    lever('Four nines', 'reliability.availability', 'four'),
    lever('Global users', 'traffic.geo', 'global'),
    lever('Spiky traffic', 'traffic.peak', 'spiky'),
    lever('Team of 100', 'team.size', 'large'),
    lever('Tiny budget', 'infra.budget', 500),
    lever('Move to Azure', 'infra.cloud', 'azure'),
    lever('Move to on-prem', 'infra.cloud', 'onprem'),
    lever('Data x10', 'data.object_kb', num('data.object_kb', 2) * 10),
    lever('Retention 7 years', 'data.retention_years', 7),
    lever('3-year commitment', 'infra.commitment', 'commit_3y'),
  ].filter((l) => Object.keys(l.overrides).every((id) => active.has(id)) && moves(l))
}

/** Monthly run plus people cost: what 'cheapest' compares. */
export const runAndPeople = (e: Evaluation): number => e.monthlyCost + e.cost.people

/** Months the cost levers compare over, as the cost panel's longest headline total. */
export const LEVER_HORIZON_MONTHS = 36

/** One-off cost, run and people for `months`, and the transition lines (old system, migration tooling) for the transition months inside them. */
export function horizonCost(e: Evaluation, months: number): number {
  return e.cost.oneTime + months * runAndPeople(e) + Math.min(months, transitionMonths(e.facts)) * e.cost.transitionMonthly
}

// Capabilities the kind, the add-ons or the answers put in the design (kb.derived): a lever that switches one off saves money by dropping what the project is for.
const CAPABILITY_FLAGS = ['profile.ai', 'profile.llm', 'profile.dataPlatform', 'profile.integration', 'profile.events', 'profile.multiTenant']
const dropsCapability = (base: Evaluation, trial: Evaluation) => CAPABILITY_FLAGS.some((fact) => base.facts[fact] === true && trial.facts[fact] !== true)

// Errors an option causes elsewhere: another decision's choice no longer fits (e.g. Fabric on own hardware).
const newInfeasible = (base: Evaluation, trial: Evaluation) => {
  const before = new Set(base.findings.map((x) => x.rule.id))
  return trial.findings.find((x) => x.rule.id.startsWith('infeasible-') && !before.has(x.rule.id))?.rule
}

export interface ResolvedOption {
  evaluation: Evaluation
  /** Answered questions the option rules out, put back to their recommendation (Fabric Mirroring once Databricks is compared). */
  resets: string[]
}

/**
 * The completed design with `questionId` at `value`. An answer elsewhere that the option makes infeasible (an ingestion or compute choice that only
 * fits the current platform) goes back to its recommendation, so the option is priced and judged as the user would get it, not as a broken design.
 */
export function resolveOption(kb: KnowledgeBase, completed: Answers, questionId: string, value: FactValue, reference: Evaluation): ResolvedOption {
  const before = new Set(reference.findings.map((x) => x.rule.id))
  let trial: Answers = { ...completed, [questionId]: { kind: 'value', value } }
  const resets: string[] = []
  for (;;) {
    const evaluation = assumedDesign(kb, trial)
    const knockOn = evaluation.findings
      .map((x) => x.rule.id)
      .filter((id) => id.startsWith('infeasible-') && !before.has(id))
      .map((id) => id.slice('infeasible-'.length))
      .filter((id) => id !== questionId && trial[id] !== undefined && trial[id].kind !== 'unknown')
    // Each pass turns at least one answer into an assumption, so the loop ends.
    if (knockOn.length === 0) return { evaluation, resets }
    for (const id of knockOn) {
      trial = { ...trial, [id]: { kind: 'unknown' } }
      resets.push(id)
    }
  }
}

/** The answers that apply a compared option: the option itself plus its resets as assumptions, one undo step. */
export const optionChange = (questionId: string, value: FactValue, resets: string[]): Answers => ({
  [questionId]: { kind: 'value', value },
  ...Object.fromEntries(resets.map((id) => [id, { kind: 'unknown' as const }])),
})

export interface OptionComparison {
  option: QuestionOption
  evaluation: Evaluation
  feasible: boolean
  infeasibleReason?: string
  recommended: boolean
  /** Answered questions this option puts back to their recommendation (resolveOption). */
  resets: string[]
}

/** One completed design per option of a question (e.g. each provider), with whether the option fits the rest of the design and why not. */
export function compareOver(kb: KnowledgeBase, answers: Answers, questionId: string, base?: Evaluation): OptionComparison[] {
  const question = kb.questions.find((q) => q.id === questionId)
  // Completed once: an assumed answer follows each option's recommendation, so only the questions an option newly activates are left to complete.
  const completed = autoComplete(kb, answers)
  const reference = base ?? evaluate(kb, completed)
  return (question?.options ?? []).map((option) => {
    const { evaluation, resets } = resolveOption(kb, completed, questionId, option.id, reference)
    const state = evaluation.questions.find((s) => s.question.id === questionId)
    const score = state?.recommendation.scores.find((s) => s.optionId === option.id)
    const knockOn = newInfeasible(reference, evaluation)
    const feasible = (score?.feasible ?? true) && !knockOn
    return {
      option,
      evaluation,
      feasible,
      ...(!feasible && { infeasibleReason: score && !score.feasible ? score.infeasibleReason : `${knockOn!.title}: ${knockOn!.message}` }),
      recommended: state?.recommendation.optionId === option.id,
      resets,
    }
  })
}

/** Totals closer than this share are a tie: approximate list prices do not separate them. */
export const PRICE_TIE_SHARE = 0.02

/** The feasible option with the lowest run plus people cost, or null when another feasible option is within PRICE_TIE_SHARE of it. */
export function cheapestOption(results: OptionComparison[]): string | null {
  const sorted = results.filter((r) => r.feasible).sort((a, b) => runAndPeople(a.evaluation) - runAndPeople(b.evaluation))
  if (sorted.length === 0) return null
  const low = runAndPeople(sorted[0].evaluation)
  return sorted.length > 1 && runAndPeople(sorted[1].evaluation) - low <= PRICE_TIE_SHARE * low ? null : sorted[0].option.id
}

export interface CostLever {
  question: Question
  from: QuestionOption
  to: QuestionOption
  /** Change in monthly run plus people cost; negative is a saving. */
  delta: number
  /** Change in the one-off and transition cost paid within the horizon; levers rank on the horizon total, so a monthly saving that costs more up front can fall out. */
  upfrontDelta: number
  /** Change in horizonCost over LEVER_HORIZON_MONTHS; negative is a saving. */
  horizonDelta: number
  evaluation: Evaluation
  diff: ArchitectureDiff
  /** Answered questions the switch puts back to their recommendation; Apply applies them with it (optionChange). */
  resets: string[]
}

/** For each answered single-choice decision, the feasible other option with the lowest LEVER_HORIZON_MONTHS total and what it saves, largest saving first; options that drop a capability of the project (an LLM from an AI app) are no lever. */
export function costLevers(kb: KnowledgeBase, answers: Answers, current = evaluate(kb, answers)): CostLever[] {
  const levers: CostLever[] = []
  // Alternatives are priced as completed designs, like compareOver: an option's follow-up questions take their recommendation instead of staying pending and unpriced.
  const completed = autoComplete(kb, answers)
  const base = Object.keys(completed).length === Object.keys(answers).length ? current : evaluate(kb, completed)
  for (const s of current.questions) {
    const q = s.question
    const from = q.options?.find((o) => o.id === s.effectiveValue)
    if (!s.active || s.status === 'pending' || !q.isDecision || q.kind !== 'single' || !from) continue
    let best: CostLever | undefined
    for (const to of q.options!) {
      const score = s.recommendation.scores.find((x) => x.optionId === to.id)
      if (to.id === from.id || (score && !score.feasible)) continue
      const { evaluation, resets } = resolveOption(kb, completed, q.id, to.id, base)
      if (newInfeasible(base, evaluation) || dropsCapability(base, evaluation)) continue
      const delta = runAndPeople(evaluation) - runAndPeople(base)
      const horizonDelta = horizonCost(evaluation, LEVER_HORIZON_MONTHS) - horizonCost(base, LEVER_HORIZON_MONTHS)
      if (horizonDelta <= -1 && (!best || horizonDelta < best.horizonDelta)) {
        best = { question: q, from, to, delta, upfrontDelta: horizonDelta - LEVER_HORIZON_MONTHS * delta, horizonDelta, evaluation, diff: diffEvaluations(base, evaluation), resets }
      }
    }
    if (best) levers.push(best)
  }
  return levers.sort((a, b) => a.horizonDelta - b.horizonDelta)
}

export interface AssumptionImpact {
  question: Question
  /** The assumed value, as the engine applies it; Confirm stores it as an answer. */
  value: FactValue
  /** Lowest and highest monthly run plus people cost over the question's options (numbers at x0.1 and x10, or their presets when 0). */
  minCost: number
  maxCost: number
  /** Most findings any variant adds or resolves, and most components it adds, removes or re-technologies. */
  findingChanges: number
  componentChanges: number
}

const sensitivityCache = new WeakMap<KnowledgeBase, WeakMap<Answers, AssumptionImpact[]>>()

/**
 * How much each assumed answer (kind 'unknown', or pending and assumed by autoComplete) moves the completed design,
 * largest cost range first: every feasible option of a choice, a number at x0.1 and x10 (its presets when 0), each option of a multi-choice toggled.
 * Memoized per knowledge base and answers object.
 */
export function assumptionSensitivity(kb: KnowledgeBase, answers: Answers): AssumptionImpact[] {
  const cached = sensitivityCache.get(kb)?.get(answers)
  if (cached) return cached
  const completed = autoComplete(kb, answers)
  const base = evaluate(kb, completed)
  const impacts = base.questions
    .filter((s) => s.active && s.status === 'unknown')
    .map((s): AssumptionImpact => {
      const q = s.question
      const v = s.effectiveValue
      const variants: FactValue[] =
        q.kind === 'number' && typeof v === 'number'
          ? // Scaling 0 gives 0, so a number assumed at 0 (no existing data) tries its presets instead.
            [...new Set(v === 0 ? q.number!.presets.map((p) => p.value) : [v * 0.1, v * 10])].map((x) => Math.min(q.number!.max, Math.max(q.number!.min, x))).filter((x) => x !== v)
          : q.kind === 'multi'
            ? (q.options ?? []).map((o) => (Array.isArray(v) && v.includes(o.id) ? v.filter((x) => x !== o.id) : [...(Array.isArray(v) ? v : []), o.id]))
            : (q.options ?? []).filter((o) => o.id !== v && s.recommendation.scores.find((x) => x.optionId === o.id)?.feasible !== false).map((o) => o.id)
      const costs = [runAndPeople(base)]
      let findingChanges = 0
      let componentChanges = 0
      for (const value of variants) {
        const trial = evaluate(kb, { ...completed, [q.id]: { kind: 'value', value } })
        const d = diffEvaluations(base, trial)
        costs.push(runAndPeople(trial))
        findingChanges = Math.max(findingChanges, d.findingsAdded.length + d.findingsResolved.length)
        componentChanges = Math.max(componentChanges, d.added.length + d.removed.length + d.retech.length)
      }
      return { question: q, value: v, minCost: Math.min(...costs), maxCost: Math.max(...costs), findingChanges, componentChanges }
    })
    .sort((a, b) => b.maxCost - b.minCost - (a.maxCost - a.minCost) || b.findingChanges - a.findingChanges || b.componentChanges - a.componentChanges)
  if (!sensitivityCache.has(kb)) sensitivityCache.set(kb, new WeakMap())
  sensitivityCache.get(kb)!.set(answers, impacts)
  return impacts
}

const normalize = (description: string) => ` ${description.toLowerCase().replace(/[^a-z0-9\- ]/g, ' ')} `
// Whole words with an optional plural, so 'chat' does not fire on 'chatbot' nor 'card' on 'cardiology'.
const mentions = (text: string, word: string) => new RegExp(`\\b(?:${word})(s|es)?\\b`).test(text)
// 'migrate|migration+crm' needs every '+' part (any '|' word) and scores one hit per part, outranking a bare 'migrate'.
// A leading '~' marks a weak signal worth half a hit in all ('move our+database'), so any explicit word of another option outranks it.
const keywordHits = (text: string, keywords: string[] = []) =>
  keywords.reduce((n, k) => {
    const parts = k.replace(/^~/, '').split('+')
    return parts.every((p) => mentions(text, p)) ? n + (k.startsWith('~') ? 0.5 : parts.length) : n
  }, 0)

/** Suggests answers from keywords in a free-text description, over every question whose options carry keywords. */
export function suggestFromDescription(kb: KnowledgeBase, description: string): Answers {
  const text = normalize(description)
  const suggestions: Answers = {}
  for (const question of kb.questions.filter((q) => q.options?.some((o) => o.keywords?.length))) {
    const scored = question
      .options!.filter((o) => keywordHits(text, o.negativeKeywords) === 0)
      .map((o) => ({ id: o.id, hits: keywordHits(text, o.keywords) }))
      .filter((o) => o.hits > 0)
    if (scored.length === 0) continue
    if (question.kind === 'single') {
      suggestions[question.id] = { kind: 'value', value: scored.sort((a, b) => b.hits - a.hits)[0].id }
    } else {
      suggestions[question.id] = { kind: 'value', value: scored.map((o) => o.id) }
    }
  }
  return suggestions
}

export const suggestionValues = (a: AnswerValue): string[] => (a.kind === 'value' ? [a.value].flat().map(String) : [])
/** Identifies one suggested value, so a UI can toggle it off. */
export const suggestionKey = (questionId: string, value: string) => `${questionId}=${value}`

/** The suggestions without the values toggled off; a multi-choice keeps its remaining values. */
export function pickSuggestions(kb: KnowledgeBase, suggestions: Answers, off: ReadonlySet<string>): Answers {
  const out: Answers = {}
  for (const [id, a] of Object.entries(suggestions)) {
    const kept = suggestionValues(a).filter((v) => !off.has(suggestionKey(id, v)))
    if (kept.length > 0) out[id] = { kind: 'value', value: kb.questions.find((q) => q.id === id)?.kind === 'multi' ? kept : kept[0] }
  }
  return out
}

const isMulti = (kb: KnowledgeBase, id: string) => kb.questions.find((q) => q.id === id)?.kind === 'multi'

/** The suggestions the answers do not hold yet: a multi-choice keeps only its values not chosen already, a single choice only a different value. */
export function newSuggestions(kb: KnowledgeBase, answers: Answers, suggestions: Answers): Answers {
  const out: Answers = {}
  for (const [id, a] of Object.entries(suggestions)) {
    const held = suggestionValues(answers[id] ?? { kind: 'unknown' })
    const fresh = suggestionValues(a).filter((v) => !held.includes(v))
    if (fresh.length > 0) out[id] = isMulti(kb, id) ? { kind: 'value', value: fresh } : a
  }
  return out
}

/** The answers the suggestions change: a multi-choice adds the suggested values to the chosen ones, a single choice takes the suggested value. */
export function addSuggestions(kb: KnowledgeBase, answers: Answers, suggestions: Answers): Answers {
  return Object.fromEntries(
    Object.entries(suggestions).map(([id, a]) => [id, isMulti(kb, id) ? { kind: 'value', value: [...new Set([...suggestionValues(answers[id] ?? { kind: 'unknown' }), ...suggestionValues(a)])] } : a]),
  )
}

/** The suggested questions that are active once the suggestions apply; the rest set an answer that matters only when the design makes them relevant. */
export function activeSuggestions(kb: KnowledgeBase, answers: Answers, suggestions: Answers): string[] {
  const e = evaluate(kb, { ...answers, ...addSuggestions(kb, answers, suggestions) })
  return Object.keys(suggestions).filter((id) => e.questions.some((q) => q.question.id === id && q.active))
}

/**
 * The suggestions auto-design may apply: only for questions the user has not answered, active once the suggestions apply,
 * and only feasible values (a data platform drops the app type and the request-path capabilities a brief mentions).
 * keepInactive keeps the suggestions of questions not active yet, which the brief applies for when they become relevant.
 */
export function usableSuggestions(kb: KnowledgeBase, answers: Answers, suggestions: Answers, keepInactive = false): Answers {
  const pending = Object.fromEntries(Object.entries(suggestions).filter(([id]) => !(id in answers)))
  const e = evaluate(kb, { ...answers, ...pending })
  const out: Answers = {}
  for (const [id, a] of Object.entries(pending)) {
    const state = e.questions.find((q) => q.question.id === id)
    if (!state?.active) {
      if (keepInactive) out[id] = a
      continue
    }
    // Multiple-choice questions carry no scores, so their options are checked against the facts the way evaluate() flags them.
    const fits = (v: string) => {
      const option = state.question.options?.find((o) => o.id === v)
      return state.question.kind === 'multi' ? !option?.feasibleWhen || evaluateCondition(option.feasibleWhen, { facts: e.facts }) : state.recommendation.scores.find((x) => x.optionId === v)?.feasible !== false
    }
    const feasible = suggestionValues(a).filter(fits)
    if (feasible.length > 0) out[id] = { kind: 'value', value: isMulti(kb, id) ? feasible : feasible[0] }
  }
  return out
}

// Platforms often named in enterprise briefs, on top of the catalog's technology names.
const KNOWN_TERMS = ['Oracle', 'SQL Server', 'Databricks', 'Fabric', 'Salesforce', 'SAP']

/** Known technology names in the description that no suggestion maps, so the gap is visible ('Not mapped yet: Kafka'). */
export function unmappedTerms(kb: KnowledgeBase, description: string): string[] {
  const text = normalize(description)
  const suggested = suggestFromDescription(kb, description)
  // The keywords of every suggested option: a term with one of them as a whole word (or inside one) is mapped.
  const mapped = Object.entries(suggested).flatMap(([id, a]) => {
    const values = suggestionValues(a)
    return (kb.questions.find((q) => q.id === id)?.options ?? []).filter((o) => values.includes(o.id)).flatMap((o) => o.keywords ?? []).flatMap((k) => k.replace(/^~/, '').split('+'))
  })
  // 'Cassandra / ScyllaDB', 'Apache Kafka' and 'OpenTelemetry + Prometheus' are matched part by part; 'AWS Lambda' is judged as 'Lambda', not as the cloud.
  const names = kb.technologies.flatMap((t) => t.name.split(/[/(),+]/).map((part) => part.trim().replace(/^(Apache|Amazon|Microsoft|AWS|Azure|Google) /, '')))
  return [...new Set([...names, ...KNOWN_TERMS])].filter((term) => {
    const t = normalize(term).trim()
    return t.length > 1 && mentions(text, t) && !mapped.some((k) => k.split('|').some((w) => mentions(` ${t} `, w) || mentions(` ${w} `, t)))
  })
}

export interface ArchitectureDiff {
  added: string[]
  removed: string[]
  rescaled: { id: string; from: number; to: number }[]
  retech: { id: string; from: string; to: string }[]
  newQuestions: string[]
  droppedQuestions: string[]
  /** Change in monthly run plus people cost, the total the HUD headline shows. */
  costDelta: number
  findingsAdded: string[]
  findingsResolved: string[]
  /** Assumed answers ('Not sure') the engine re-decided, e.g. a standby region once a replica is excluded; answered ones never change by themselves. */
  redecided: { id: string; title: string; from: string; to: string }[]
}

/** An effective value as people read it: option labels for choices, the number with its unit otherwise. */
export function valueText(question: Question, value: FactValue): string {
  const label = (v: FactValue) => question.options?.find((o) => o.id === v)?.label ?? String(v)
  if (Array.isArray(value)) return value.length ? value.map(label).join(', ') : 'none'
  if (typeof value === 'number') return `${fmt(value)}${question.number ? ` ${question.number.unit}` : ''}`
  return label(value)
}

export function diffEvaluations(before: Evaluation, after: Evaluation): ArchitectureDiff {
  const byId = (e: Evaluation) => new Map(e.architecture.components.map((c) => [c.def.id, c]))
  const a = byId(before)
  const b = byId(after)
  const activeIds = (e: Evaluation) => new Set(e.questions.filter((q) => q.active).map((q) => q.question.id))
  const qa = activeIds(before)
  const qb = activeIds(after)
  const findingIds = (e: Evaluation) => new Set(e.findings.map((x) => x.rule.id))
  const fa = findingIds(before)
  const fb = findingIds(after)
  return {
    added: [...b.keys()].filter((id) => !a.has(id)),
    removed: [...a.keys()].filter((id) => !b.has(id)),
    rescaled: [...b.values()]
      .filter((c) => a.has(c.def.id) && a.get(c.def.id)!.replicas !== c.replicas)
      .map((c) => ({ id: c.def.id, from: a.get(c.def.id)!.replicas, to: c.replicas })),
    retech: [...b.values()]
      .filter((c) => a.has(c.def.id) && a.get(c.def.id)!.tech !== c.tech)
      .map((c) => ({ id: c.def.id, from: a.get(c.def.id)!.tech, to: c.tech })),
    newQuestions: [...qb].filter((id) => !qa.has(id)),
    droppedQuestions: [...qa].filter((id) => !qb.has(id)),
    costDelta: runAndPeople(after) - runAndPeople(before),
    findingsAdded: [...fb].filter((id) => !fa.has(id)),
    findingsResolved: [...fa].filter((id) => !fb.has(id)),
    redecided: after.questions
      .filter((q) => q.status === 'unknown' && qa.has(q.question.id))
      .flatMap((q) => {
        const was = before.questions.find((x) => x.question.id === q.question.id)!.effectiveValue
        return JSON.stringify(was) === JSON.stringify(q.effectiveValue) ? [] : [{ id: q.question.id, title: q.question.title, from: valueText(q.question, was), to: valueText(q.question, q.effectiveValue) }]
      }),
  }
}

export function isEmptyDiff(d: ArchitectureDiff): boolean {
  return (
    d.added.length + d.removed.length + d.rescaled.length + d.retech.length + d.newQuestions.length + d.droppedQuestions.length + d.findingsAdded.length + d.findingsResolved.length + d.redecided.length === 0
  )
}
