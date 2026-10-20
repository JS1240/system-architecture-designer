import type { Answers, Architecture, CostKind, Evaluation, ExtraCostLine, Facts, Finding, KnowledgeBase, ReferenceNumbers, SupportPlan, ValidationRule } from '../domain/types'
import { architectureFacts, deriveArchitecture, fmt } from './architecture'
import { estimateAvailability } from './availability'
import { couldHold, evaluateCondition, f, referencedFacts } from './conditions'
import { producersOf, resolveQuestions } from './questions'
import { estimateWorkload } from './workload'

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const

const numberFact = (facts: Facts, key: string): number | null => (typeof facts[key] === 'number' && Number.isFinite(facts[key]) ? (facts[key] as number) : null)

/** A support plan's price for a month's bill: each band of the bill at its share, and at least the plan's minimum. */
export function supportPlanPrice(plan: SupportPlan, bill: number): number {
  let banded = 0
  let from = 0
  for (const tier of plan.tiers) {
    const to = tier.upTo ?? Infinity
    banded += Math.max(0, Math.min(bill, to) - from) * tier.share
    from = to
  }
  return Math.max(plan.min, banded)
}

/** Months both systems are paid for: the trials, load and catch-up before coexistence (mig.preCutoverMonths), then coexistence itself. */
export const transitionMonths = (facts: Facts): number => (numberFact(facts, 'migration.coexistMonths') ?? 0) + (numberFact(facts, 'mig.preCutoverMonths') ?? 0)

/** Splits component costs: transition-phase lines, one-time and people costs stay out of the steady-state monthly total. */
function costBreakdown(architecture: Architecture, facts: Facts, extraLines: ExtraCostLine[], reference: ReferenceNumbers): Evaluation['cost'] {
  const cost: Evaluation['cost'] = { monthly: 0, people: 0, oneTime: 0, transitionMonthly: 0, transitionTotal: 0, paybackMonths: null, byTier: {}, byKind: {}, extraLines }
  const lines: { costKind: CostKind; phase?: 'transition'; tier: string; monthly: number }[] = [
    ...architecture.components.map((c) => ({ costKind: c.costKind, phase: c.phase, tier: c.def.tier, monthly: c.monthlyCost })),
    ...extraLines,
  ]
  for (const c of lines) {
    // One-off lines (transfer fees, migration engineering) are paid once, also when they belong to the transition.
    if (c.costKind !== 'one_time' && c.phase === 'transition') {
      cost.transitionMonthly += c.monthly
      continue
    }
    cost.byKind[c.costKind] = (cost.byKind[c.costKind] ?? 0) + c.monthly
    if (c.costKind === 'one_time') cost.oneTime += c.monthly
    else if (c.costKind === 'people') cost.people += c.monthly
    else {
      cost.monthly += c.monthly
      cost.byTier[c.tier] = (cost.byTier[c.tier] ?? 0) + c.monthly
    }
  }
  // shortcut: staging and dev cost a share of the production instances (ops.environments), not a re-sized design; size them on their own traffic for a quote.
  // Per-use lines (requests, seats, tokens, bytes served, capacity SKUs) follow production traffic, and a second region is production too, so neither is copied.
  const instanceLines = architecture.components.filter((c) => c.costKind === 'run' && c.phase !== 'transition' && c.instanceClass !== null && c.def.shape !== 'region')
  const instances = instanceLines.reduce((sum, c) => sum + c.monthlyCost, 0)
  // An own edge fleet (push CDN) is sized on production media traffic, so staging uses it rather than a copy.
  const copiedLines = instanceLines.filter((c) => c.def.id !== 'cdn')
  const nonprodShare = numberFact(facts, 'cost.nonprodShare') ?? 0
  const nonprod = nonprodShare * copiedLines.reduce((sum, c) => sum + c.monthlyCost, 0)
  if (nonprod > 0) {
    cost.byKind.nonprod = (cost.byKind.nonprod ?? 0) + nonprod
    // Each tier's staging copy follows its own instances, so the tiers still add up to the monthly total.
    for (const c of copiedLines) cost.byTier[c.def.tier] = (cost.byTier[c.def.tier] ?? 0) + nonprodShare * c.monthlyCost
    cost.monthly += nonprod
  }
  // Vendor support (ops.support): a cloud plan prices the month's bill band by band above its minimum; own hardware pays subscriptions and maintenance on its servers, staging and dev included.
  // The cloud plan covers only the cloud's own bill, so SaaS seats and third-party lines (Dynamics 365, Snowflake, a model vendor's API) stay out of it.
  // shortcut: extra cost lines from project overrides name no biller, so they stay out of the plan too.
  const level = String(facts['ops.support'])
  const cloud = String(facts['infra.cloud'])
  const onpremShare = level === 'enterprise' ? reference.onpremSupportSharePremium : level === 'business' ? reference.onpremSupportShare : 0
  const plan = reference.supportPlans[cloud]?.[level]
  const cloudBill =
    nonprod + architecture.components.filter((c) => c.billedBy === cloud && c.phase !== 'transition' && c.costKind !== 'one_time' && c.costKind !== 'people').reduce((sum, c) => sum + c.monthlyCost, 0)
  const support = cost.monthly <= 0 ? 0 : cloud === 'onprem' ? onpremShare * (instances + nonprod) : plan ? supportPlanPrice(plan, cloudBill) : 0
  if (support > 0) {
    cost.byKind.support = support
    cost.byTier.ops = (cost.byTier.ops ?? 0) + support
    cost.monthly += support
  }
  // Trials, the initial load and the catch-up bill the target, the link and the tooling before coexistence starts, so they are transition months too.
  cost.transitionTotal = cost.oneTime + transitionMonths(facts) * (cost.monthly + cost.transitionMonthly)
  // Only a retired old system stops billing, so extending or retaining it never pays back. The old figure counts its staff, so the new people cost counts too.
  const saving = facts['profile.retire'] === true ? (numberFact(facts, 'source.legacy_monthly_usd') ?? 0) - cost.monthly - cost.people : 0
  cost.paybackMonths = saving > 0 ? cost.transitionTotal / saving : null
  return cost
}

export function evaluate(kb: KnowledgeBase, answers: Answers): Evaluation {
  const { facts, states } = resolveQuestions(kb, answers)
  const workload = estimateWorkload(facts, kb.reference, new Set(kb.components.map((c) => c.id)))
  const architecture = deriveArchitecture(kb, facts, answers, workload)
  const components = new Set(architecture.components.map((c) => c.def.id))
  const cost = costBreakdown(architecture, facts, kb.overrides?.extraLines ?? [], kb.reference)
  const monthlyCost = cost.monthly
  const steady = architecture.components.filter((c) => c.phase !== 'transition' && c.costKind !== 'one_time' && c.costKind !== 'people')
  const top = [...steady].sort((a, b) => b.monthlyCost - a.monthlyCost).slice(0, 3)
  // Amounts and shares of the monthly total by cost kind; an answered share (cost.nonprodShare) is kept.
  const byKind: Facts = {}
  for (const [kind, amount] of Object.entries(cost.byKind)) {
    byKind[`cost.${kind}`] = amount
    if (kind !== 'one_time' && kind !== 'people' && !(`cost.${kind}Share` in facts)) byKind[`cost.${kind}Share`] = monthlyCost > 0 ? amount / monthlyCost : 0
  }
  const availability = estimateAvailability(architecture, facts)
  const target = typeof facts['reliability.nines'] === 'number' ? facts['reliability.nines'] : null
  const budget = typeof facts['infra.budgetUsd'] === 'number' ? facts['infra.budgetUsd'] : null
  const derived: Facts = {
    'availability.estimate': availability,
    'availability.gap': target === null ? 0 : target - availability,
    ...byKind,
    'cost.monthly': monthlyCost,
    // Instance-priced lines and platform capacity sold under its own commitment: the lines a purchase commitment discounts.
    'cost.instanceMonthly': steady.filter((c) => c.instanceClass !== null || c.committable).reduce((sum, c) => sum + c.monthlyCost - (c.storageCost ?? 0), 0),
    'cost.topComponents': top.map((c) => `${c.def.label} $${fmt(c.monthlyCost)}`).join(', '),
    'cost.budgetRatio': budget === null ? 0 : monthlyCost / budget,
    'cost.people': cost.people,
    'cost.oneTime': cost.oneTime,
    'cost.transitionMonthly': cost.transitionMonthly,
    'cost.transitionTotal': cost.transitionTotal,
    // During coexistence both systems are paid for, so the budget is compared with their sum.
    'cost.transitionBudgetRatio': budget === null ? 0 : (monthlyCost + cost.transitionMonthly) / budget,
  }
  const ctx = { facts: { ...facts, ...architectureFacts(architecture, kb.reference), ...derived }, components }
  // Messages and fixes quote the design's own numbers: {usd:fact}, {pct:fact} or {fact}.
  const fill = (text: string) =>
    text.replace(/\{(usd:|pct:)?([\w.-]+)\}/g, (match, format: string | undefined, key: string) => {
      const value = ctx.facts[key]
      if (value === undefined || value === null) return match
      if (format === 'usd:') return `$${fmt(Number(value))}`
      if (format === 'pct:') return `${Math.round(Number(value) * 100)}%`
      return String(value)
    })
  const fired = kb.validations.filter((rule) => evaluateCondition(rule.when, ctx)).map((rule) => ({ ...rule, message: fill(rule.message), fix: fill(rule.fix) }))
  // An answer can pick an option the engine ruled out; unless an error rule already names that decision, the option's own reason becomes the finding.
  const explained = new Set(fired.filter((rule) => rule.severity === 'error').flatMap((rule) => [...referencedFacts(rule.when)]))
  const infeasible = states.flatMap((s) => {
    const option = s.active && s.question.kind === 'single' ? s.question.options?.find((o) => o.id === s.effectiveValue) : undefined
    const score = s.recommendation.scores.find((x) => x.optionId === option?.id)
    if (!option?.feasibleWhen || !score || score.feasible || explained.has(s.question.id)) return []
    const recommended = s.question.options?.find((o) => o.id === s.recommendation.optionId)
    const rule: ValidationRule = {
      id: `infeasible-${s.question.id}`,
      severity: 'error',
      when: f.not(option.feasibleWhen),
      title: `${s.question.title}: "${option.label}" does not fit this design`,
      message: score.infeasibleReason ?? 'The option is infeasible for the current requirements.',
      fix: recommended ? `Choose "${recommended.label}" (the recommendation), or change the requirement that rules this option out.` : 'Change the requirement that rules this option out.',
      sources: s.question.sources,
    }
    return [rule]
  })
  // A multiple-choice answer can include an option the design rules out (an assistant on a data platform): its reason becomes the finding.
  const infeasibleChoices = states.flatMap((s) => {
    const chosen = s.active && s.question.kind === 'multi' && Array.isArray(s.effectiveValue) ? s.effectiveValue : []
    const option = s.question.options?.find((o) => chosen.includes(o.id) && o.feasibleWhen && !evaluateCondition(o.feasibleWhen, { facts }))
    if (!option || explained.has(s.question.id)) return []
    const rule: ValidationRule = {
      id: `infeasible-${s.question.id}`,
      severity: 'error',
      when: f.not(option.feasibleWhen!),
      title: `${s.question.title}: "${option.label}" does not fit this design`,
      message: option.infeasibleReason ?? 'The option is infeasible for the current requirements.',
      fix: `Remove "${option.label}", or change the requirement that rules it out.`,
      sources: s.question.sources,
    }
    return [rule]
  })
  const findings: Finding[] = [...fired, ...infeasible, ...infeasibleChoices]
    .map((rule) => ({ rule }))
    .sort((a, b) => SEVERITY_ORDER[a.rule.severity] - SEVERITY_ORDER[b.rule.severity])
  const active = states.filter((s) => s.active)
  const categoryOrder = new Map(kb.categories.map((c) => [c.id, c.order]))
  const pending = active.filter((s) => s.status === 'pending')
  const pendingIds = new Set(pending.map((s) => s.question.id))
  // An inactive question that another pending answer could still make relevant may become active, so a question that reads its facts waits for it as well.
  // Relevance that only the candidate's own answer decides does not hold the candidate back.
  const factsOf = new Map<string, string[]>()
  for (const [fact, ids] of producersOf(kb)) for (const id of ids) factsOf.set(id, [...(factsOf.get(id) ?? []), fact])
  const inactive = states.filter((s) => !s.active)
  const unsettledFor = (candidate: string) => {
    const unsettled = new Set([...pendingIds].filter((id) => id !== candidate))
    const unknown = new Set([...unsettled].flatMap((id) => factsOf.get(id) ?? []))
    for (let grew = true; grew; ) {
      grew = false
      for (const s of inactive) {
        if (unsettled.has(s.question.id) || !couldHold(s.question.askWhen, { facts }, unknown)) continue
        unsettled.add(s.question.id)
        for (const fact of factsOf.get(s.question.id) ?? []) unknown.add(fact)
        grew = true
      }
    }
    return unsettled
  }
  // A recommendation reads facts from its dependencies, so ask those first; questions that wait on each other keep the category order.
  const ready = pending.filter((s) => {
    const unsettled = unsettledFor(s.question.id)
    return !s.dependsOn.some((id) => unsettled.has(id))
  })
  const next =
    [...(ready.length > 0 ? ready : pending)]
      .sort(
        (a, b) =>
          (categoryOrder.get(a.question.category) ?? 0) - (categoryOrder.get(b.question.category) ?? 0) ||
          a.question.priority - b.question.priority,
      )[0] ?? null
  return {
    facts: ctx.facts,
    questions: states,
    next,
    workload,
    architecture,
    findings,
    monthlyCost,
    cost,
    availability,
    progress: { answered: active.filter((s) => s.status !== 'pending').length, total: active.length },
  }
}
