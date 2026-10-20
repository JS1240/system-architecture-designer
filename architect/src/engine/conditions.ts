import type { Answers, Condition, FactValue, Facts, KnowledgeBase } from '../domain/types'
import { fmt } from './architecture'

export interface ConditionContext {
  facts: Facts
  /** Present component ids. Undefined outside the architecture phase. */
  components?: ReadonlySet<string>
}

function compare(actual: FactValue | undefined, op: string, expected: FactValue | undefined): boolean {
  switch (op) {
    case 'exists':
      return actual !== undefined && actual !== null && !(Array.isArray(actual) && actual.length === 0)
    case 'eq':
      return actual === expected
    case 'ne':
      return actual !== expected
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected
    case 'in':
      return Array.isArray(expected) && typeof actual === 'string' && expected.includes(actual)
    case 'includes':
      return Array.isArray(actual) && typeof expected === 'string' && actual.includes(expected)
    default:
      throw new Error(`Unknown operator: ${op}`)
  }
}

export function evaluateCondition(condition: Condition | undefined, ctx: ConditionContext): boolean {
  if (!condition) return true
  if ('all' in condition) return condition.all.every((c) => evaluateCondition(c, ctx))
  if ('any' in condition) return condition.any.some((c) => evaluateCondition(c, ctx))
  if ('not' in condition) return !evaluateCondition(condition.not, ctx)
  if ('has' in condition) return ctx.components?.has(condition.has) ?? false
  return compare(ctx.facts[condition.fact], condition.op, condition.value)
}

/** Whether some values of the unknown facts make the condition come out as `want`; every other fact is read from ctx. */
export function couldHold(condition: Condition | undefined, ctx: ConditionContext, unknown: ReadonlySet<string>, want = true): boolean {
  if (!condition) return want
  if ('all' in condition) return want ? condition.all.every((c) => couldHold(c, ctx, unknown, true)) : condition.all.some((c) => couldHold(c, ctx, unknown, false))
  if ('any' in condition) return want ? condition.any.some((c) => couldHold(c, ctx, unknown, true)) : condition.any.every((c) => couldHold(c, ctx, unknown, false))
  if ('not' in condition) return couldHold(condition.not, ctx, unknown, !want)
  if ('fact' in condition && unknown.has(condition.fact)) return true
  return evaluateCondition(condition, ctx) === want
}

/** Fact names referenced by a condition (used for dependency tracking). */
export function referencedFacts(condition: Condition | undefined, out: Set<string> = new Set()): Set<string> {
  if (!condition) return out
  if ('all' in condition) condition.all.forEach((c) => referencedFacts(c, out))
  else if ('any' in condition) condition.any.forEach((c) => referencedFacts(c, out))
  else if ('not' in condition) referencedFacts(condition.not, out)
  else if ('fact' in condition) out.add(condition.fact)
  return out
}

/** Component ids referenced through `has`. */
export function referencedComponents(condition: Condition | undefined, out: Set<string> = new Set()): Set<string> {
  if (!condition) return out
  if ('all' in condition) condition.all.forEach((c) => referencedComponents(c, out))
  else if ('any' in condition) condition.any.forEach((c) => referencedComponents(c, out))
  else if ('not' in condition) referencedComponents(condition.not, out)
  else if ('has' in condition) out.add(condition.has)
  return out
}

// Facts no question writes: workload metrics (with their unit) and the project profile the derived rules set ([holds, does not hold]).
const METRIC_LABEL: Record<string, [string, string]> = {
  'cap.dau': ['daily active users', ''],
  'cap.peakQps': ['peak load', 'req/s'],
  'cap.requestsMonth': ['requests a month', ''],
  'cap.peakReadQps': ['peak reads', 'req/s'],
  'cap.peakWriteQps': ['peak writes', 'req/s'],
  'cap.peakSearchQps': ['peak searches', 'req/s'],
  'cap.peakLookupQps': ['peak lookups', 'req/s'],
  'cap.peakLocationQps': ['peak location updates', '/s'],
  'cap.connections': ['concurrent connections', ''],
  'cap.egressMbps': ['peak egress', 'Mbps'],
  'cap.dbStorageGb': ['database storage', 'GB'],
  'cap.dbStorageLoad': ['database storage load', 'of one node'],
  'cap.dbPrimaryLoad': ['primary database load', 'of one node'],
  'cap.dbWriteLoad': ['database write load', 'of one node'],
  'cap.lakeStorageTb': ['lake storage', 'TB'],
  'cap.vectors': ['stored vectors', ''],
  'cap.corpusTokens': ['tokens embedded once', ''],
  'cap.llmCallsMonth': ['model calls a month', ''],
  'cap.sourceCount': ['data sources', ''],
  'cap.analyticsUsers': ['report viewers', ''],
  'availability.gap': ['the availability gap', 'pp'],
  'availability.singleRegionGap': ['the single-region availability gap', 'pp'],
  'availability.warmStandbyGap': ['the warm-standby availability gap', 'pp'],
  'availability.pilotLightGap': ['the pilot-light availability gap', 'pp'],
}
const PROFILE_LABEL: Record<string, [string, string]> = {
  // Nearly every project serves requests, so only the exception is worth a line.
  'profile.requestPath': ['', 'the project serves no user requests'],
  'profile.dataPlatform': ['the project includes a data platform', 'the project has no data platform'],
  'profile.ai': ['the project includes AI features', 'the project has no AI features'],
  'profile.integration': ['the project integrates systems', 'the project integrates no systems'],
  'profile.events': ['the project ingests event streams', 'the project ingests no event streams'],
  'profile.migration': ['the project moves an existing system', 'the project moves no existing system'],
  'profile.replace': ['the project replaces an existing system', 'the project replaces no existing system'],
  'profile.retire': ['the old system is retired', 'the old system is kept'],
  'profile.keptUncopied': ['the AI reads no copy of the kept system', 'the AI reads a copy of the kept system'],
}

export interface ExplainOptions {
  /** Only the clauses that hold positively ('Existing sources includes CRM'), not the negated ones that merely do not block ('does not include SaaS APIs'). */
  positiveOnly?: boolean
  /** The project's answers, so a question that is answered but no longer active reads as 'no longer applies' instead of 'not decided yet'. */
  answers?: Answers
}

/** Plain-language reasons a condition holds: the leaves that make it hold, labelled with question titles and option labels. */
export function explainCondition(condition: Condition | undefined, facts: Facts, kb: KnowledgeBase, options: ExplainOptions = {}): string[] {
  // Keyed by fact and bound direction, so two bounds on one fact (above 200 and above 1,000) keep the tighter one.
  const lines = new Map<string, { fact?: string; line: string; bound?: number; exists?: boolean }>()
  const ctx = { facts }
  const owner = (fact: string) => kb.questions.find((q) => (q.fact ?? q.id) === fact)
  // Options that assert the fact through `sets` (e.g. data.sql from the database choice), with their question.
  const setters = (fact: string) => kb.questions.flatMap((q) => (q.options ?? []).filter((o) => o.sets && fact in o.sets).map((o) => ({ q, o })))
  const selected = ({ q, o }: { q: { id: string; fact?: string }; o: { id: string } }) => {
    const v = facts[q.fact ?? q.id]
    return v === o.id || (Array.isArray(v) && v.includes(o.id))
  }
  const optionLabel = (fact: string, v: FactValue | undefined) => owner(fact)?.options?.find((o) => o.id === v)?.label ?? (typeof v === 'number' ? fmt(v) : String(v))
  const describe = (fact: string, op: string, value: FactValue | undefined, holds: boolean): string | null => {
    const actual = facts[fact]
    const profile = PROFILE_LABEL[fact]
    if (profile) return profile[actual === true ? 0 : 1]
    if (!owner(fact) && !METRIC_LABEL[fact]) {
      // A derived fact reads as the rule that set it, or as the rules for the compared value that did not hold.
      const rules = kb.derived?.filter((d) => d.fact === fact) ?? []
      if (rules.length > 0) {
        const fired = rules.find((d) => d.value === actual && evaluateCondition(d.when, ctx))
        if (fired) walk(fired.when, true)
        else walk({ any: rules.filter((d) => d.value === value).map((d) => d.when) }, false)
        return null
      }
      const set = setters(fact)
      if (set.length > 0 && (op === 'eq' || op === 'ne')) {
        const positive = (op === 'eq') === holds
        const matching = set.filter(({ o }) => o.sets![fact] === value)
        const shownOptions = positive && matching.some(selected) ? matching.filter(selected) : matching
        if (matching.length > 0) return `${matching[0].q.title} is ${positive ? '' : 'not '}${shownOptions.map(({ o }) => o.label).join(' or ')}`
      }
      const chosen = set.find((x) => x.o.sets![fact] === actual && selected(x))
      if (chosen) return `${chosen.q.title} is ${chosen.o.label}`
      if (set.length > 0 && actual === undefined) {
        // As for 'exists' below: an inactive setter does not apply, it is not waiting for an answer.
        const setter = set[0].q
        if (setter.askWhen && !evaluateCondition(setter.askWhen, ctx)) return `${setter.title} ${options.answers?.[setter.id] ? 'no longer applies' : 'does not apply'}`
        return `${setter.title} is not decided yet`
      }
    }
    const [metric, unit] = METRIC_LABEL[fact] ?? [owner(fact)?.title ?? fact, owner(fact)?.number?.unit ?? '']
    const shown = (v: FactValue | undefined) => (typeof v === 'number' ? `${fmt(v)}${unit ? ` ${unit}` : ''}` : optionLabel(fact, v))
    const list = (v: FactValue | undefined) => (Array.isArray(v) ? v.map((x) => optionLabel(fact, x)).join(' or ') : shown(v))
    if (op === 'exists') {
      if (holds) return `${metric} is set`
      // An inactive question emits no fact, so its absence says the question does not apply, not that it waits for an answer.
      const question = owner(fact)
      if (question?.askWhen && !evaluateCondition(question.askWhen, ctx)) return `${question.title} ${options.answers?.[question.id] ? 'no longer applies' : 'does not apply'}`
      return `${metric} is not decided yet`
    }
    if (op === 'includes') return `${metric} ${holds ? 'includes' : 'does not include'} ${optionLabel(fact, value)}`
    // A holding set reads as the value the design has, not the whole set it belongs to.
    if (op === 'in') return holds ? `${metric} is ${shown(actual)}` : `${metric} is not ${list(value)}`
    if (op === 'eq' || op === 'ne') return `${metric} is ${(op === 'eq') === holds ? '' : 'not '}${shown(value)}`
    if (typeof actual !== 'number') return `${metric} is not known yet`
    const word = { gt: ['above', 'at most'], gte: ['at least', 'below'], lt: ['below', 'at least'], lte: ['at most', 'above'] }[op as 'gt']
    return `${metric} is ${shown(actual)}, ${holds ? word[0] : word[1]} ${shown(value)}`
  }
  // Keeps the leaves that make the condition come out as `want`: a holding all or failing any needs every part, the others only the parts that decide them.
  function walk(c: Condition | undefined, want: boolean): void {
    if (!c || evaluateCondition(c, ctx) !== want) return
    if ('all' in c) c.all.forEach((part) => walk(part, want))
    else if ('any' in c) c.any.forEach((part) => walk(part, want))
    else if ('not' in c) walk(c.not, !want)
    else if ('has' in c) {
      if (options.positiveOnly && !want) return
      const line = `the design ${want ? 'includes' : 'does not include'} ${kb.components.find((x) => x.id === c.has)?.label ?? c.has}`
      lines.set(line, { line })
    } else {
      const negated = c.op === 'ne' ? want : !want
      if (options.positiveOnly && negated && !PROFILE_LABEL[c.fact] && !['gt', 'gte', 'lt', 'lte'].includes(c.op)) return
      const line = describe(c.fact, c.op, c.value, want)
      if (!line) return
      if (typeof c.value === 'number' && ['gt', 'gte', 'lt', 'lte'].includes(c.op)) {
        const lower = (c.op === 'gt' || c.op === 'gte') === want
        const key = `${c.fact}|${lower ? 'lower' : 'upper'}`
        const kept = lines.get(key)
        if (!kept || (lower ? c.value > kept.bound! : c.value < kept.bound!)) lines.set(key, { fact: c.fact, line, bound: c.value })
      } else lines.set(line, { fact: c.fact, line, exists: c.op === 'exists' && want })
    }
  }
  walk(condition, true)
  const entries = [...lines.values()]
  // 'X is set' adds nothing beside another line on the same fact.
  return entries.filter((e) => !e.exists || !entries.some((o) => o !== e && o.fact === e.fact)).map((e) => e.line)
}

// Small builders keep the knowledge base readable.
export const f = {
  eq: (fact: string, value: FactValue): Condition => ({ fact, op: 'eq', value }),
  ne: (fact: string, value: FactValue): Condition => ({ fact, op: 'ne', value }),
  gt: (fact: string, value: number): Condition => ({ fact, op: 'gt', value }),
  gte: (fact: string, value: number): Condition => ({ fact, op: 'gte', value }),
  lt: (fact: string, value: number): Condition => ({ fact, op: 'lt', value }),
  lte: (fact: string, value: number): Condition => ({ fact, op: 'lte', value }),
  in: (fact: string, value: string[]): Condition => ({ fact, op: 'in', value }),
  inc: (fact: string, value: string): Condition => ({ fact, op: 'includes', value }),
  exists: (fact: string): Condition => ({ fact, op: 'exists' }),
  all: (...all: Condition[]): Condition => ({ all }),
  any: (...any: Condition[]): Condition => ({ any }),
  not: (c: Condition): Condition => ({ not: c }),
  has: (id: string): Condition => ({ has: id }),
}
