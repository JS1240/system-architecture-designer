import { useMemo } from 'react'
import type { Evaluation, Overrides } from '../domain/types'
import { evaluate } from '../engine/evaluate'
import { withOverrides } from '../engine/overrides'
import { kb } from '../knowledge'
import { useProjects } from '../store/projectStore'

/** The knowledge base with the given project overrides applied, memoized on the overrides object. */
export function useKnowledge(overrides: Overrides | undefined) {
  return useMemo(() => withOverrides(kb, overrides), [overrides])
}

/**
 * The design after cutover: transition-phase components (the retiring old systems and the migration tooling) and their flows removed.
 * The scene, HUD and Inspector all read it, so a transition component selected before switching to Target is no longer shown.
 */
export function targetView(e: Evaluation): Evaluation {
  const components = e.architecture.components.filter((c) => c.phase !== 'transition')
  if (components.length === e.architecture.components.length) return e
  const kept = new Set(components.map((c) => c.def.id))
  return { ...e, architecture: { components, edges: e.architecture.edges.filter((x) => kept.has(x.from) && kept.has(x.to)) } }
}

export function useEvaluation() {
  const project = useProjects((s) => (s.activeId ? (s.projects[s.activeId] ?? null) : null))
  const whatIf = useProjects((s) => s.whatIf)
  const answers = project?.answers
  const known = useKnowledge(project?.overrides)
  const base = useMemo(() => (answers ? evaluate(known, answers) : null), [known, answers])
  const preview = useMemo(() => (answers && whatIf ? evaluate(known, { ...answers, ...whatIf }) : null), [known, answers, whatIf])
  return { project, base, current: preview ?? base, preview }
}
