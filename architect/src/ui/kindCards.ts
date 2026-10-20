import type { Answers, Question, Scenario } from '../domain/types'
import { evaluateCondition, referencedFacts } from '../engine/conditions'
import { kb } from '../knowledge'

const kindQuestion = kb.questions.find((q) => q.id === 'project.kind')!

/** Profile flags a kind turns on that not every kind turns on (profile.ai for an AI app). */
function flagsOf(kind: string): string[] {
  return (kb.derived ?? [])
    .filter((d) => d.value === true && referencedFacts(d.when).has('project.kind'))
    .filter((d) => evaluateCondition(d.when, { facts: { 'project.kind': kind } }) && !kindQuestion.options!.every((o) => evaluateCondition(d.when, { facts: { 'project.kind': o.id } })))
    .map((d) => d.fact)
}

/** Titles of the questions a kind brings, from the flag fewest kinds share (profile.ai before the request path every app has). */
export function decidesFor(kind: string): string[] {
  const shared = (flag: string) => kindQuestion.options!.filter((o) => flagsOf(o.id).includes(flag)).length
  // A flag most kinds turn on (the request path) does not tell this kind apart, so it lists nothing on the card.
  const flags = flagsOf(kind).filter((flag) => shared(flag) <= kindQuestion.options!.length / 2)
  const rank = (q: Question) => Math.min(...[...referencedFacts(q.askWhen)].filter((x) => flags.includes(x)).map(shared))
  const gated = kb.questions.filter((q) => [...referencedFacts(q.askWhen)].some((x) => flags.includes(x)))
  const best = Math.min(...gated.map(rank))
  return gated.filter((q) => rank(q) === best).sort((a, b) => a.priority - b.priority).map((q) => q.title)
}

/** A kind card's two example scenarios: those that pick the kind first, then case studies, then those that only fall back to the default kind. */
export function kindExamples<T extends { scenario: Scenario; kind: string }>(scenarios: T[], kind: string): T[] {
  const rank = (x: T) => ('project.kind' in x.scenario.answers ? 0 : x.scenario.caseStudy ? 1 : 2)
  return scenarios.filter((x) => x.kind === kind).sort((a, b) => rank(a) - rank(b)).slice(0, 2)
}

/** The choice a chip row shows: the one clicked, else the one a used detection answers. */
export const shownChoice = (clicked: string | null, answers: Answers, questionId: string): string | null => {
  const a = answers[questionId]
  return clicked ?? (a?.kind === 'value' && typeof a.value === 'string' ? a.value : null)
}
