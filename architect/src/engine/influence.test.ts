import { describe, expect, it } from 'vitest'
import type { Answers, Evaluation } from '../domain/types'
import { kb } from '../knowledge'
import { evaluate } from './evaluate'
import { autoComplete, diffEvaluations, isEmptyDiff } from './explore'

// A decision influences the design when switching options changes components, technology, sizing,
// findings, cost or which questions are asked next.
function changes(a: Evaluation, b: Evaluation): boolean {
  const d = diffEvaluations(a, b)
  return !isEmptyDiff(d) || Math.abs(d.costDelta) > 0 || Math.abs(a.availability - b.availability) > 1e-9
}

// Completed scenarios, so questions that depend on earlier decisions are active too.
const designs = kb.scenarios.map((s) => autoComplete(kb, s.answers))

describe('every single-choice question (decisions and requirements) influences the design', () => {
  const decisions = kb.questions.filter((q) => q.kind === 'single')

  for (const q of decisions) {
    it(q.id, () => {
      let influenced = false
      let tried = 0
      for (const answers of designs) {
        const state = evaluate(kb, answers).questions.find((s) => s.question.id === q.id)!
        if (!state.active) continue
        const values = q.options!.map((o) => o.id)
        const evals = values.map((value) => evaluate(kb, autoComplete(kb, { ...answers, [q.id]: { kind: 'value', value } } as Answers)))
        tried++
        if (evals.some((e, i) => i > 0 && changes(evals[0], e))) influenced = true
        if (influenced) break
      }
      expect(tried, `${q.id} is never active in any scenario`).toBeGreaterThan(0)
      expect(influenced, `${q.id}: no option changes the architecture, findings or later questions`).toBe(true)
    })
  }
})

describe('numeric requirements drive capacity, cost or findings', () => {
  // Only what the design shows: the workload copies some inputs verbatim (sourceCount, analyticsHours), so it is left out.
  // Widened on purpose: inputs such as a budget or the months old and new systems coexist change the cost or the findings, not the components.
  // Units and replicas count only where they bill: a $0 pass-through unit ('sources') only mirrors the input.
  const sized = (c: Evaluation['architecture']['components'][number]) => (c.monthlyCost > 0 || c.unitCost > 0 ? [c.def.id, c.tech, c.replicas, c.units] : [c.def.id, c.tech])
  const outcome = (e: Evaluation) =>
    JSON.stringify([e.cost, e.availability, e.findings.map((x) => x.rule.id), e.architecture.components.map(sized), e.questions.filter((x) => x.active).map((x) => x.question.id)])

  for (const q of kb.questions.filter((x) => x.kind === 'number')) {
    it(q.id, () => {
      let tried = 0
      let influenced = false
      for (const base of designs.filter((answers) => evaluate(kb, answers).questions.find((x) => x.question.id === q.id)?.active)) {
        tried++
        const low = evaluate(kb, autoComplete(kb, { ...base, [q.id]: { kind: 'value', value: q.number!.min } }))
        const high = evaluate(kb, autoComplete(kb, { ...base, [q.id]: { kind: 'value', value: q.number!.max } }))
        influenced = outcome(low) !== outcome(high)
        if (influenced) break
      }
      expect(tried, `${q.id} is never active in any scenario`).toBeGreaterThan(0)
      expect(influenced, `${q.id}: neither bound changes the cost, components, findings or later questions in any scenario`).toBe(true)
    })
  }
})
