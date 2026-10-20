import type { Answers, ComponentInstance, KnowledgeBase, Overrides, QuestionState } from '../domain/types'
import { money } from '../engine/architecture'
import { compareOver, runAndPeople } from '../engine/explore'
import { useProjects } from '../store/projectStore'

/** Whole-design decisions compared option by option in side-by-side tables; their question cards get a Compare button. */
export const COMPARISONS = [
  { questionId: 'infra.cloud', title: 'Compare providers' },
  { questionId: 'data.platform', title: 'Compare data platforms' },
]

/** Applies answers at once, through the what-if preview so the change toast describes it. */
export function useApply() {
  const setWhatIf = useProjects((s) => s.setWhatIf)
  const commit = useProjects((s) => s.commitWhatIf)
  return (overrides: Answers, label: string) => {
    setWhatIf(overrides, label)
    commit()
  }
}

/** A cost line's amount for the cost tables: one-off lines say 'once' so they do not read as monthly running cost. */
export const lineCost = (line: { kind: string; monthly: number }): string => (line.kind === 'one_time' ? `${money(line.monthly)} once` : `${money(line.monthly)}/mo`)

/** Number of overridden values in a project, for the HUD and the panel header. */
export function overrideCount(o: Overrides | undefined): number {
  if (!o) return 0
  const size = (r: object | undefined) => Object.keys(r ?? {}).length
  return size(o.reference) + size(o.unitPrice) + size(o.replicas) + (o.exclude?.length ?? 0) + (o.discountPct ? 1 : 0) + (o.extraLines?.length ?? 0)
}

/** Whether the project overrides this line's unit price (for its offer and tier) or pins its instances. */
export const isOverridden = (o: Overrides | undefined, c: ComponentInstance): boolean => o?.unitPrice?.[c.priceKey] !== undefined || o?.replicas?.[c.def.id] !== undefined

/** Sets or (with undefined) removes one entry of an overrides record. */
export const withEntry = (record: Record<string, number> | undefined, key: string, value: number | undefined): Record<string, number> => {
  const next = { ...record }
  if (value === undefined) delete next[key]
  else next[key] = value
  return next
}

/** Applies a change to the active project's overrides; setOverrides validates it like an import. */
export function useEditOverrides() {
  const overrides = useProjects((s) => (s.activeId ? s.projects[s.activeId]?.overrides : undefined))
  const setOverrides = useProjects((s) => s.setOverrides)
  return { overrides: overrides ?? {}, edit: (change: (o: Overrides) => Overrides) => setOverrides(change(overrides ?? {})) }
}

export interface OptionCost {
  monthly: number
  oneOff: number
  /** Why the completed design with this option still has an error elsewhere; undefined when it fits. */
  knockOn?: string
  /** Titles of the answered questions the option puts back to their recommendation. */
  resets: string[]
  /** Their question ids, which choosing the option resets with it (optionChange), so the applied design is the one priced. */
  resetIds: string[]
}

/**
 * Each option's change in monthly run plus people cost and in one-off cost against the selected (or recommended) option, for decisions and requirements alike.
 * Every option is priced as a completed design (compareOver), like the comparison tables and the cost levers, so its follow-up questions are priced too.
 * A requirement whose options all cost the same (within $1) gets no chips.
 */
export function optionCosts(knowledge: KnowledgeBase, answers: Answers, state: QuestionState, selected: unknown): Record<string, OptionCost> | null {
  const q = state.question
  if (q.kind !== 'single' || !q.options) return null
  const reference = typeof selected === 'string' ? selected : typeof state.effectiveValue === 'string' ? state.effectiveValue : state.recommendation.optionId
  const compared = compareOver(knowledge, answers, q.id)
  const base = compared.find((c) => c.option.id === reference)?.evaluation
  if (!base) return null
  const totals = compared.map((c) => runAndPeople(c.evaluation))
  if (!q.isDecision && Math.max(...totals) - Math.min(...totals) < 1) return null
  const ownScore = (id: string) => state.recommendation.scores.find((s) => s.optionId === id)
  return Object.fromEntries(
    compared.map((c) => [
      c.option.id,
      {
        monthly: runAndPeople(c.evaluation) - runAndPeople(base),
        oneOff: c.evaluation.cost.oneTime - base.cost.oneTime,
        // The option's own infeasibility has its chip already; this marks an error the option causes elsewhere.
        ...(!c.feasible && ownScore(c.option.id)?.feasible !== false && { knockOn: c.infeasibleReason }),
        resets: c.resets.map((id) => knowledge.questions.find((x) => x.id === id)?.title ?? id),
        resetIds: c.resets,
      },
    ]),
  )
}
