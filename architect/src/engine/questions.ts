import type {
  AnswerValue,
  Answers,
  Facts,
  FactValue,
  KnowledgeBase,
  OptionScore,
  Question,
  QuestionState,
  QuestionStatus,
  Recommendation,
  ValidationRule,
} from '../domain/types'
import { deriveArchitecture } from './architecture'
import { recoveryGaps } from './availability'
import { evaluateCondition, referencedComponents, referencedFacts } from './conditions'
import { estimateMigration } from './migration'
import { estimateWorkload, workloadFacts } from './workload'

const MAX_ITERATIONS = 8

/** The question's default on these facts: the first matching defaultWhen, else the stated default. */
export function defaultFor(question: Question, facts: Facts): FactValue {
  const rule = question.defaultWhen?.find((d) => evaluateCondition(d.when, { facts }))
  return rule ? rule.value : question.default
}

export function recommend(question: Question, facts: Facts): Recommendation {
  const fallback = defaultFor(question, facts)
  if (question.kind !== 'single' || !question.options) {
    return { optionId: null, value: fallback, reasons: ['Default assumption from the knowledge base.'], scores: [] }
  }
  const ctx = { facts }
  const scores: OptionScore[] = question.options.map((option) => {
    const feasible = evaluateCondition(option.feasibleWhen, ctx)
    const matched = (option.score ?? []).filter((rule) => evaluateCondition(rule.when, ctx))
    // Simplicity bias: every complexity point must be earned by a matching requirement.
    const score = matched.reduce((sum, rule) => sum + rule.weight, 0) - option.complexity * 0.5
    return {
      optionId: option.id,
      score,
      feasible,
      infeasibleReason: feasible ? undefined : option.infeasibleReason,
      reasons: matched.filter((rule) => rule.weight > 0).map((rule) => rule.reason),
      penalties: matched.filter((rule) => rule.weight < 0).map((rule) => rule.reason),
    }
  })
  const optionOf = (id: string) => question.options!.find((o) => o.id === id)!
  // Among equal scores the question's stated default wins, then the simpler option.
  const isDefault = (id: string) => (id === fallback ? 0 : 1)
  const feasible = scores.filter((s) => s.feasible)
  const best = [...feasible].sort((a, b) => b.score - a.score || isDefault(a.optionId) - isDefault(b.optionId) || optionOf(a.optionId).complexity - optionOf(b.optionId).complexity)[0]
  if (!best) {
    return { optionId: null, value: fallback, reasons: ['No feasible option; using the default.'], scores }
  }
  // A requirement that an equal score cancelled still points elsewhere, so the tie and its tie-break are stated.
  const kept = (other: OptionScore) =>
    best.optionId === fallback ? 'the default' : optionOf(best.optionId).complexity < optionOf(other.optionId).complexity ? 'the simpler option' : 'the option listed first'
  // A tie broken only by list order is stated too, even when neither option has a requirement behind it.
  const ties = feasible
    .filter((s) => s !== best && s.score === best.score && (s.reasons.length > 0 || kept(s) === 'the option listed first'))
    .map((s) => `Ties with ${optionOf(s.optionId).label}${s.reasons.length > 0 ? ` (${s.reasons.join(' ')})` : ''}; ${kept(s)} is kept.`)
  const reasons =
    best.reasons.length + ties.length > 0
      ? [...best.reasons, ...ties]
      : best.optionId === fallback
        ? ['Typical default; no requirement points elsewhere.']
        : ['Simplest feasible option; no requirement calls for more.']
  return { optionId: best.optionId, value: best.optionId, reasons, scores }
}

function statusOf(answer: AnswerValue | undefined): QuestionStatus {
  if (!answer) return 'pending'
  if (answer.kind === 'unknown') return 'unknown'
  if (answer.kind === 'custom') return 'custom'
  return 'answered'
}

function effectiveValue(answer: AnswerValue | undefined, rec: Recommendation): FactValue {
  if (!answer) return null
  if (answer.kind === 'value') return answer.value
  if (answer.kind === 'custom') return answer.treatAs
  return rec.value
}

function applyValue(question: Question, value: FactValue, facts: Facts): void {
  if (value === null) return
  facts[question.fact ?? question.id] = value
  const selected = Array.isArray(value) ? value : [value]
  for (const option of question.options ?? []) {
    if (option.sets && selected.includes(option.id)) Object.assign(facts, option.sets)
  }
}

/** Adds derived facts: the first matching rule per fact wins, and a fact an answer already set is kept. */
function applyDerived(kb: KnowledgeBase, facts: Facts): void {
  for (const d of kb.derived ?? []) if (!(d.fact in facts) && evaluateCondition(d.when, { facts })) facts[d.fact] = d.value
}

/** Maps each fact name to the question ids that produce it. */
export function factProducers(kb: KnowledgeBase): Map<string, string[]> {
  const producers = new Map<string, string[]>()
  const add = (fact: string, id: string) => {
    const list = producers.get(fact) ?? []
    if (!list.includes(id)) list.push(id)
    producers.set(fact, list)
  }
  for (const q of kb.questions) {
    add(q.fact ?? q.id, q.id)
    for (const option of q.options ?? []) for (const key of Object.keys(option.sets ?? {})) add(key, q.id)
  }
  const trafficInputs = [...producers.entries()]
    // A measured peak replaces the traffic derived from daily users.
    .filter(([fact]) => fact.startsWith('traffic.') || fact.startsWith('data.object') || fact.startsWith('data.retention') || fact.startsWith('data.media') || fact === 'source.measured_peak_qps')
    .flatMap(([, ids]) => ids)
  // A derived fact follows the questions that produce the facts its condition reads; the ones the workload reads are listed below.
  for (const d of kb.derived ?? []) for (const fact of referencedFacts(d.when)) for (const id of producers.get(fact) ?? []) add(d.fact, id)
  // The primary serves the cache misses that no replica may take, so its load also follows caching, consistency and replication.
  // Live tracking adds location updates, a PostGIS index writes them to the primary, and the store sets each node's write capacity
  // and the copies it keeps. Kind and type logic lives in derived facts (kb.derived), which map back to the questions they read.
  const workloadInputs: Record<string, string[]> = {
    'perf.cacheHitRatio': ['dbPrimaryLoad'],
    // Media a CDN serves leaves the origin's internet egress.
    'perf.cdn': ['originEgressGbMonth', 'originEgressPeakMbps'],
    'data.strongConsistency': ['dbPrimaryLoad'],
    'data.replication': ['dbPrimaryLoad'],
    'traffic.liveTracking': ['peakLocationQps', 'peakRealtimeQps', 'dbWriteLoad', 'dbPrimaryLoad'],
    'data.geo_index': ['dbWriteLoad', 'dbPrimaryLoad'],
    'data.nodeWriteFactor': ['dbWriteLoad', 'dbPrimaryLoad'],
    'data.storeReplicas': ['dbStorageLoad'],
    // A migrated relational database holds more data on one node.
    'migration.loadsRelationalDb': ['dbStorageLoad'],
    // Analytics: existing data adds to the lake the queries scan; query hours and report viewers pass through.
    // A lifecycle rule moves old objects to a colder class.
    'data.storage_class': ['coldObjectStorageGb'],
    'data.history_tb': ['lakeStorageTb', 'scannedTbMonth', 'platformChangesGbMonth'],
    'data.growth_pct': ['lakeStorageTb', 'scannedTbMonth', 'platformChangesGbMonth'],
    'data.source_count': ['sourceCount'],
    'data.analytics_hours': ['analyticsHours', 'scannedTbMonth'],
    'data.analytics_users': ['analyticsUsers'],
    // AI: the token mix weights each completion, and the corpus adds vectors and monthly re-embedding.
    'ai.tokens_in': ['weightedTokensPerCall'],
    'ai.tokens_out': ['weightedTokensPerCall', 'peakLlmTokensPerSec'],
    // Model calls follow the assistant messages per user, the pages an extraction reads and the rows SQL AI functions enrich; rows have a token mix of their own.
    'ai.messages_per_user': ['weightedTokensPerCall', 'llmCallsMonth', 'peakLlmQps', 'peakLlmTokensPerSec'],
    'ai.rows_month': ['weightedTokensPerCall', 'llmCallsMonth', 'peakLlmQps', 'peakLlmTokensPerSec'],
    // A language model in the design is what makes model calls, embeddings and vectors at all.
    'profile.llm': ['storageGb', 'corpusTokens', 'vectors', 'embedTokensMonth', 'dbStorageGb', 'dbStorageLoad', 'llmCallsMonth', 'peakLlmQps', 'peakLlmTokensPerSec', 'peakAgentTaskQps', 'peakAgentLlmQps', 'peakExtractLlmQps'],
    // Pending capabilities count as an assistant with retrieval only on a request path.
    'profile.requestPath': ['llmCallsMonth', 'peakLlmQps', 'peakLlmTokensPerSec', 'storageGb', 'corpusTokens', 'vectors', 'embedTokensMonth'],
    // Only retrieval embeds, and the embeddings load the primary only when pgvector runs in a PostgreSQL primary.
    'ai.corpus_gb': ['storageGb', 'corpusTokens', 'vectors', 'embedTokensMonth', 'dbStorageGb', 'dbStorageLoad', 'llmCallsMonth', 'peakLlmQps', 'peakLlmTokensPerSec'],
    // Kept records join the corpus unless agents read them live; then nothing is copied into the lake either.
    'ai.existing_data': ['storageGb', 'corpusTokens', 'vectors', 'embedTokensMonth', 'dbStorageGb', 'dbStorageLoad', 'lakeStorageTb', 'scannedTbMonth'],
    'ai.refresh_pct': ['embedTokensMonth', 'llmCallsMonth', 'peakLlmQps', 'peakLlmTokensPerSec'],
    'ai.capabilities': ['weightedTokensPerCall', 'storageGb', 'corpusTokens', 'vectors', 'embedTokensMonth', 'dbStorageGb', 'dbStorageLoad', 'llmCallsMonth', 'peakLlmQps', 'peakLlmTokensPerSec', 'peakAgentTaskQps', 'peakAgentLlmQps', 'peakExtractLlmQps'],
    'ai.vector_store': ['dbStorageGb', 'dbStorageLoad'],
    'data.primary_db': ['dbStorageGb', 'dbStorageLoad'],
    // Migrated records join the database (replacing) or the lake (extending), after the history policy.
    'source.volume_gb': ['storageGb', 'dbStorageGb', 'dbStorageLoad', 'lakeStorageTb', 'scannedTbMonth', 'corpusTokens', 'vectors'],
    'source.crm_volume_gb': ['storageGb', 'dbStorageGb', 'dbStorageLoad', 'lakeStorageTb', 'scannedTbMonth', 'corpusTokens', 'vectors'],
    'source.file_volume_gb': ['storageGb', 'lakeStorageTb', 'scannedTbMonth', 'corpusTokens', 'vectors'],
    // Each selected kind splits the volume between the database, the lake and a bought CRM, and needs a connector of its own.
    'source.kinds': ['storageGb', 'dbStorageGb', 'dbStorageLoad', 'lakeStorageTb', 'scannedTbMonth', 'sourceCount'],
    'source.history': ['storageGb', 'dbStorageGb', 'dbStorageLoad', 'lakeStorageTb', 'scannedTbMonth', 'corpusTokens', 'vectors'],
    'project.origin': ['storageGb', 'dbStorageGb', 'dbStorageLoad', 'lakeStorageTb', 'scannedTbMonth', 'corpusTokens', 'vectors'],
    // Kept or bought records join the lake only when an analytics platform holds one.
    'data.platform': ['lakeStorageTb', 'scannedTbMonth'],
    // A bought CRM takes the records out of the database, and an analytics platform ingests them into the lake.
    'migration.approach': ['dbStorageGb', 'dbStorageLoad', 'lakeStorageTb', 'scannedTbMonth'],
  }
  for (const [fact, metrics] of Object.entries(workloadInputs)) for (const id of producers.get(fact) ?? []) for (const metric of metrics) add(`cap.${metric}`, id)
  // Every metric also follows traffic and data volume; listed after the inputs specific to each metric, so those lead a finding's links.
  for (const metric of ['dau', 'peakQps', 'requestsMonth', 'readQps', 'writeQps', 'peakReadQps', 'peakWriteQps', 'storageGb', 'dbStorageGb', 'egressMbps', 'cacheGb', 'connections', 'dbWriteLoad', 'dbPrimaryLoad', 'dbStorageLoad', 'peakJobsQps', 'peakSearchQps', 'peakLookupQps', 'peakLocationQps', 'peakRealtimeQps', 'lakeStorageTb', 'scannedTbMonth', 'platformChangesGbMonth', 'vectors', 'embedTokensMonth', 'llmCallsMonth', 'peakLlmQps', 'peakLlmTokensPerSec', 'originEgressGbMonth', 'originEgressPeakMbps', 'computeQps', 'appFleetLoad', 'objectStorageGb', 'coldObjectStorageGb']) {
    for (const id of trafficInputs) add(`cap.${metric}`, id)
  }
  // Migration estimates (migration.ts) follow the source volume, the link, the sync method, the window and the strategy.
  const volume = ['mig.sourceGb', 'mig.transferGb', 'mig.bulkHoursVpn', 'mig.bulkHours1g', 'mig.bulkHours10g', 'mig.deviceSpeedup10g', 'mig.speedup10gOver1g', 'mig.speedup1gOverVpn', 'mig.bulkHoursDevice', 'mig.archiveHours', 'mig.transferHours', 'mig.bulkHours', 'mig.cutoverHours', 'mig.cutoverRatioVpn', 'mig.cutoverRatio1g', 'mig.cutoverRatio10g', 'mig.bulkCutoverRatio', 'mig.cutoverRatio']
  const migrationInputs: Record<string, string[]> = {
    'project.origin': [...volume, 'mig.cdcChangesQps', 'migration.coexistMonths', 'mig.engineeringFteMonths'],
    'source.data_quality': ['migration.coexistMonths', 'mig.engineeringFteMonths'],
    'migration.approach': ['mig.engineeringFteMonths', 'mig.transferGb', 'mig.bulkHours', 'mig.cutoverHours', 'mig.bulkCutoverRatio', 'mig.cutoverRatio', 'mig.crmExtraStorageGb'],
    'source.code_in_db': ['mig.engineeringFteMonths'],
    'source.kinds': ['mig.engineeringFteMonths', ...volume, 'mig.crmGb', 'mig.filesGb'],
    'source.change_rows_day': ['mig.cdcChangesQps'],
    'source.volume_gb': volume,
    'source.crm_volume_gb': [...volume, 'mig.crmGb', 'mig.crmExtraStorageGb'],
    'source.file_volume_gb': [...volume, 'mig.filesGb'],
    'source.history': [...volume, 'mig.crmGb', 'mig.filesGb', 'mig.crmExtraStorageGb'],
    'source.crm_users': ['mig.crmExtraStorageGb'],
    'migration.crmStorageBaseGb': ['mig.crmExtraStorageGb'],
    'migration.crmStoragePerUserGb': ['mig.crmExtraStorageGb'],
    'migration.link': ['mig.bulkHours', 'mig.archiveHours', 'mig.transferHours', 'mig.loaderNodes', 'mig.cutoverHours', 'mig.bulkCutoverRatio', 'mig.cutoverRatio'],
    'migration.sync': ['mig.cutoverHours', 'mig.cutoverRatio'],
    'migration.downtimeHours': ['mig.cutoverRatioVpn', 'mig.cutoverRatio1g', 'mig.cutoverRatio10g', 'mig.bulkCutoverRatio', 'mig.cutoverRatio'],
    'cap.peakWriteQps': ['mig.cdcChangesQps'],
    'profile.requestPath': ['mig.cdcChangesQps'],
    'migration.coexistence_months': ['migration.coexistMonths'],
    'migration.defaultCoexistMonths': ['migration.coexistMonths'],
  }
  for (const [fact, metrics] of Object.entries(migrationInputs)) for (const id of producers.get(fact) ?? []) for (const metric of metrics) add(metric, id)
  // estimateAvailability (availability.ts) compares the target with what the store, its replication, the site and the regional topology reach.
  for (const fact of ['reliability.nines', 'reliability.multi_region', 'reliability.dr', 'data.replication', 'data.storeReplicas', 'data.primary_db', 'infra.cloud', 'onprem.siteAvailability']) {
    for (const id of producers.get(fact) ?? []) add('availability.gap', id)
  }
  // A cost kind's amount and share (cost.transfer, cost.licenseShare) follow the facts that size its lines, then the conditions that add them.
  const lines = [
    ...kb.components.map((c) => ({ kind: c.costKind ?? 'run', sizing: c.sizing, when: c.when })),
    ...kb.services.filter((o) => o.costKind).map((o) => ({ kind: o.costKind!, sizing: o.sizing ?? kb.components.find((c) => c.id === o.component)?.sizing, when: o.when })),
  ]
  const sizingFacts = (sizing: (typeof lines)[number]['sizing']) => (typeof sizing === 'object' ? [...sizing.product, ...(sizing.floor ?? [])].filter((x): x is string => typeof x === 'string') : [])
  for (const inputs of [(l: (typeof lines)[number]) => sizingFacts(l.sizing), (l: (typeof lines)[number]) => [...referencedFacts(l.when)]]) {
    for (const line of lines) for (const fact of inputs(line)) for (const id of producers.get(fact) ?? []) for (const key of [`cost.${line.kind}`, `cost.${line.kind}Share`]) add(key, id)
  }
  return producers
}

const producersCache = new WeakMap<KnowledgeBase, Map<string, string[]>>()
/** factProducers, computed once per knowledge base. */
export const producersOf = (kb: KnowledgeBase) => {
  if (!producersCache.has(kb)) producersCache.set(kb, factProducers(kb))
  return producersCache.get(kb)!
}

/** Question ids whose answers a validation rule reads, so a finding can link to the questions that resolve it. */
export function questionsForRule(rule: ValidationRule, kb: KnowledgeBase): string[] {
  const producers = producersOf(kb)
  const facts = referencedFacts(rule.when)
  // Findings carry filled-in text, so the placeholders are read from the knowledge base's rule: a ratio's message names the fact it compares with ({usd:infra.budgetUsd}).
  const source = kb.validations.find((r) => r.id === rule.id) ?? rule
  for (const m of `${source.message} ${source.fix}`.matchAll(/\{(?:usd:|pct:)?([\w.-]+)\}/g)) facts.add(m[1])
  // evaluate() divides the cost by the budget (and, during coexistence, adds the months both systems run).
  if (facts.has('cost.budgetRatio') || facts.has('cost.transitionBudgetRatio')) facts.add('infra.budgetUsd')
  if (facts.has('cost.transitionBudgetRatio')) facts.add('migration.coexistence_months')
  // A rule on a component (has('queue')) points at the questions that add it.
  for (const id of referencedComponents(rule.when)) referencedFacts(kb.components.find((c) => c.id === id)?.when, facts)
  return [...new Set([...facts].flatMap((fact) => producers.get(fact) ?? []))]
}

const dependenciesCache = new WeakMap<KnowledgeBase, Map<string, string[]>>()

/** Questions whose answers this question's relevance, default, feasibility or scores read; fixed per knowledge base, so computed once. */
function questionDependencies(kb: KnowledgeBase, question: Question): string[] {
  if (!dependenciesCache.has(kb)) dependenciesCache.set(kb, new Map())
  const cache = dependenciesCache.get(kb)!
  const known = cache.get(question.id)
  if (known) return known
  const producers = producersOf(kb)
  const facts = referencedFacts(question.askWhen)
  for (const rule of question.defaultWhen ?? []) referencedFacts(rule.when, facts)
  for (const option of question.options ?? []) {
    referencedFacts(option.feasibleWhen, facts)
    for (const rule of option.score ?? []) referencedFacts(rule.when, facts)
  }
  const ids = new Set<string>()
  for (const fact of facts) for (const id of producers.get(fact) ?? []) if (id !== question.id) ids.add(id)
  cache.set(question.id, [...ids])
  return cache.get(question.id)!
}

export interface ResolvedQuestions {
  facts: Facts
  states: QuestionState[]
}

// Fixed-point loop: relevance and recommendations depend on facts from other answers.
export function resolveQuestions(kb: KnowledgeBase, answers: Answers): ResolvedQuestions {
  const ordered = [...kb.questions].sort((a, b) => a.priority - b.priority)
  let facts: Facts = {}
  let states: QuestionState[] = []
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const next: Facts = {}
    // The design the remaining recommendations would complete, so a decision asked before its inputs reads them as they will be answered.
    const assumed: Facts = {}
    states = ordered.map((question) => {
      const active = evaluateCondition(question.askWhen, { facts })
      const recommendation = recommend(question, facts)
      const answer = answers[question.id]
      const status: QuestionStatus = active ? statusOf(answer) : 'inactive'
      const raw = active ? effectiveValue(answer, recommendation) : null
      // Number answers keep to the question's bounds, as the UI's inputs do, so scenarios and what-if levers cannot leave them.
      const value = question.number && typeof raw === 'number' ? Math.min(question.number.max, Math.max(question.number.min, raw)) : raw
      if (active) applyValue(question, value, next)
      if (active) applyValue(question, status === 'pending' ? recommendation.value : value, assumed)
      const chosen = answer?.kind === 'value' ? answer.value : answer?.kind === 'custom' ? answer.treatAs : null
      return {
        question,
        status,
        active,
        effectiveValue: value,
        recommendation,
        divergesFromRecommendation:
          active && question.isDecision && question.kind === 'single' && recommendation.optionId !== null && chosen !== null && chosen !== recommendation.optionId,
        dependsOn: questionDependencies(kb, question),
      }
    })
    applyDerived(kb, next)
    applyDerived(kb, assumed)
    const available = new Set(kb.components.map((c) => c.id))
    const workload = estimateWorkload(next, kb.reference, available)
    Object.assign(next, workloadFacts(workload, kb.reference))
    // A pinned fleet (project overrides) keeps its count whatever the load, so conditions on its size read the pin.
    for (const c of kb.components) if (c.fixedReplicas !== undefined) next[`size.${c.id}.pinned`] = c.fixedReplicas
    Object.assign(next, estimateMigration(next, kb.reference))
    // The topology and DR decisions read the availability gap that each way to recover a regional outage leaves on that design.
    const assumedWorkload = estimateWorkload(assumed, kb.reference, available)
    Object.assign(assumed, workloadFacts(assumedWorkload, kb.reference))
    for (const c of kb.components) if (c.fixedReplicas !== undefined) assumed[`size.${c.id}.pinned`] = c.fixedReplicas
    Object.assign(assumed, estimateMigration(assumed, kb.reference))
    Object.assign(next, recoveryGaps(deriveArchitecture(kb, assumed, answers, assumedWorkload), assumed))
    const stable = JSON.stringify(next) === JSON.stringify(facts)
    facts = next
    if (stable) break
  }
  return { facts, states }
}
