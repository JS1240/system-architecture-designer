import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AnswerValue, Answers, CostKind, ExtraCostLine, NumericReferenceKey, Overrides, Project, Question, Tier, Version } from '../domain/types'
import { fmt } from '../engine/architecture'
import { evaluate } from '../engine/evaluate'
import { addSuggestions, autoComplete, pickSuggestions, suggestFromDescription, usableSuggestions } from '../engine/explore'
import { withOverrides } from '../engine/overrides'
import { kb } from '../knowledge'
import { referenceInfo } from '../knowledge/reference'

const now = () => new Date().toISOString()
const STORE_KEY = 'sad-projects-v1'
const newId = () => crypto.randomUUID()

export function blankProject(name: string, description = '', answers: Answers = {}): Project {
  const t = now()
  return { id: newId(), name, description, createdAt: t, updatedAt: t, answers, versions: [] }
}

const isAnswer = (a: unknown): a is AnswerValue => {
  if (!a || typeof a !== 'object') return false
  const x = a as Record<string, unknown>
  if (x.kind === 'unknown') return true
  if (x.kind === 'custom') return typeof x.text === 'string' && typeof x.treatAs === 'string'
  if (x.kind !== 'value') return false
  const v = x.value
  return v === null || ['string', 'number', 'boolean'].includes(typeof v) || (Array.isArray(v) && v.every((i) => typeof i === 'string'))
}

const questions = new Map(kb.questions.map((q) => [q.id, q]))

// An option id the question does not offer would count as answered yet set nothing, silently dropping the requirement.
const fitsQuestion = (q: Question, a: AnswerValue): boolean => {
  const offered = (id: unknown) => q.options?.some((o) => o.id === id) ?? false
  if (a.kind === 'unknown') return true
  // The UI offers custom answers on single-choice questions only; elsewhere the one option it names would replace a list or a number.
  if (a.kind === 'custom') return q.kind === 'single' && offered(a.treatAs)
  if (q.kind === 'number') return typeof a.value === 'number' && Number.isFinite(a.value)
  if (q.kind === 'multi') return Array.isArray(a.value) && a.value.every(offered)
  return offered(a.value)
}

// Bump when a knowledge change renames or removes question or option ids, and map the old answers in migrateAnswers.
// 2: infra.budget became a number (it was four bucket options).
// 3: source.location names the provider (aws, azure, gcp) instead of 'same_cloud'.
// 4: unit-price overrides are keyed by the offer and capacity tier they price (unitPriceKey), not the component id alone.
// 5: the negotiated discount names the cloud it was negotiated with (discountProvider).
// 7: unit-price keys follow renamed offers (RENAMED_OFFERS), and a push CDN's bare 'cdn' price moves onto its own-edge offer (scopeOverrides).
const STORE_VERSION = 7

/** Offer names a knowledge change replaced: [old, new]. A unit-price key holds the offer name (unitPriceKey), so saved keys follow the rename. */
const RENAMED_OFFERS: [string, string][] = [['Azure Cosmos DB for PostgreSQL (Citus)', 'Azure Database for PostgreSQL elastic clusters (Citus)']]
// The replica offer's name starts with the primary's, so one rename covers both.
const renamedKey = (key: string): string => RENAMED_OFFERS.reduce((k, [from, to]) => k.replace(`|${from}`, `|${to}`), key)

const BUDGET_BUCKETS: Record<string, number> = { minimal: 500, moderate: 5_000, substantial: 50_000, enterprise: 10_000_000 }

/** Maps answers saved under older question or option ids onto the current ones; saved projects and imports pass through it. */
export const migrateAnswers = (raw: object): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...raw }
  const budget = out['infra.budget'] as { kind?: string; value?: unknown; treatAs?: unknown } | undefined
  const bucket = budget?.kind === 'value' ? budget.value : budget?.kind === 'custom' ? budget.treatAs : undefined
  if (typeof bucket === 'string' && bucket in BUDGET_BUCKETS) out['infra.budget'] = { kind: 'value', value: BUDGET_BUCKETS[bucket] }
  // 'The target cloud' becomes the provider the project chose; without a chosen cloud provider it stays unanswered.
  const location = out['source.location'] as { kind?: string; value?: unknown; treatAs?: unknown } | undefined
  if (location?.kind === 'value' ? location.value === 'same_cloud' : location?.kind === 'custom' && location.treatAs === 'same_cloud') {
    const cloud = out['infra.cloud'] as { kind?: string; value?: unknown } | undefined
    const target = cloud?.kind === 'value' && ['aws', 'azure', 'gcp'].includes(String(cloud.value)) ? String(cloud.value) : undefined
    if (!target) delete out['source.location']
    else out['source.location'] = location?.kind === 'custom' ? { ...location, treatAs: target } : { kind: 'value', value: target }
  }
  return out
}

function cleanAnswers(raw: unknown): Answers {
  if (!raw || typeof raw !== 'object') throw new Error('answers must be an object')
  const out: Answers = {}
  for (const [id, a] of Object.entries(migrateAnswers(raw))) {
    const q = questions.get(id)
    if (q && isAnswer(a) && fitsQuestion(q, a)) out[id] = a
  }
  return out
}

const componentIds = new Set(kb.components.map((c) => c.id))
const referenceKeys = new Set(Object.entries(kb.reference).filter(([, value]) => typeof value === 'number').map(([key]) => key))
export const TIERS: Tier[] = ['client', 'edge', 'ingress', 'compute', 'async', 'data', 'ops', 'legacy']
export const COST_KINDS: CostKind[] = ['run', 'license', 'one_time', 'people', 'nonprod', 'transfer']
/** Clouds a negotiated discount can be signed with. */
export const DISCOUNT_PROVIDERS = ['aws', 'azure', 'gcp']
const amount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
/** Keeps entries whose key passes `key` and whose value passes `value`. */
const pick = (raw: unknown, key: (k: string) => boolean, value: (v: unknown, k: string) => v is number) =>
  Object.fromEntries(Object.entries(record(raw)).filter(([k, v]) => key(k) && value(v, k))) as Record<string, number>

/** Validates project overrides (untrusted input): finite non-negative numbers, known reference keys and component ids; anything else is dropped. */
export function cleanOverrides(raw: unknown): Overrides | undefined {
  const o = record(raw)
  const out: Overrides = {}
  // A capacity or divisor of 0 would turn every cost into Infinity or NaN.
  const reference = pick(o.reference, (k) => referenceKeys.has(k), (v, k): v is number => amount(v) && (v > 0 || !referenceInfo[k as NumericReferenceKey].positive))
  if (Object.keys(reference).length) out.reference = reference
  const unitPrice = pick(o.unitPrice, (k) => componentIds.has(k.split('|')[0]), amount)
  if (Object.keys(unitPrice).length) out.unitPrice = unitPrice
  // A pinned fleet runs at least one whole instance.
  const replicas = pick(o.replicas, (k) => componentIds.has(k), (v): v is number => amount(v) && Number.isInteger(v) && v >= 1)
  if (Object.keys(replicas).length) out.replicas = replicas
  const exclude = Array.isArray(o.exclude) ? o.exclude.filter((id): id is string => typeof id === 'string' && componentIds.has(id)) : []
  if (exclude.length) out.exclude = [...new Set(exclude)]
  if (amount(o.discountPct) && o.discountPct <= 90) {
    out.discountPct = o.discountPct
    if (typeof o.discountProvider === 'string' && DISCOUNT_PROVIDERS.includes(o.discountProvider)) out.discountProvider = o.discountProvider
  }
  const extraLines = (Array.isArray(o.extraLines) ? o.extraLines : [])
    .map(record)
    .filter((l) => typeof l.label === 'string' && l.label.trim() && TIERS.includes(l.tier as Tier) && amount(l.monthly) && COST_KINDS.includes(l.costKind as CostKind))
    .slice(0, 20)
    .map((l): ExtraCostLine => ({ label: String(l.label).slice(0, 80), tier: l.tier as Tier, monthly: l.monthly as number, costKind: l.costKind as CostKind }))
  if (extraLines.length) out.extraLines = extraLines
  return Object.keys(out).length ? out : undefined
}

/**
 * Renames keys of renamed offers (RENAMED_OFFERS), and moves unit prices saved under a bare component id (store version 3 and older files) onto the offer and tier that priced
 * the component for these answers, so they keep applying to that offer only; components no offer prices keep their id.
 * A discount saved without its cloud (store version 4 and older files) goes to the cloud these answers run on, the only one it applied to then
 * that the user saw; with no cloud decided it stays unassigned and applies nowhere until set again.
 */
export function scopeOverrides(raw: Overrides | undefined, answers: Answers): Overrides | undefined {
  const overrides = raw?.unitPrice ? { ...raw, unitPrice: Object.fromEntries(Object.entries(raw.unitPrice).map(([k, v]) => [renamedKey(k), v])) } : raw
  const prices = overrides?.unitPrice
  const bareKeys = prices !== undefined && Object.keys(prices).some((k) => !k.includes('|'))
  const bareDiscount = overrides?.discountPct !== undefined && overrides.discountProvider === undefined
  if (!overrides || (!bareKeys && !bareDiscount)) return overrides
  const { unitPrice: _old, ...rest } = overrides
  const e = evaluate(withOverrides(kb, rest), answers)
  const cloud = String(e.facts['infra.cloud'])
  const keys = new Map(e.architecture.components.map((c) => [c.def.id, c.priceKey]))
  return {
    ...overrides,
    ...(bareKeys && { unitPrice: Object.fromEntries(Object.entries(prices).map(([k, v]) => [keys.get(k) ?? k, v])) }),
    ...(bareDiscount && DISCOUNT_PROVIDERS.includes(cloud) && { discountProvider: cloud }),
  }
}

const withOverridesOf = <T extends { answers: Answers }>(target: T, raw: unknown): T => {
  const overrides = scopeOverrides(cleanOverrides(raw), target.answers)
  return overrides ? { ...target, overrides } : target
}

/** Validated suggestions minus the questions already answered and the dismissed values; none at all leaves the field out. */
const withSuggestions = (p: Project, raw: unknown): Project => {
  const valid = pickSuggestions(kb, raw && typeof raw === 'object' ? cleanAnswers(raw) : {}, new Set(p.dismissed ?? []))
  const suggestions = Object.fromEntries(Object.entries(valid).filter(([id]) => !(id in p.answers)))
  const { suggestions: _old, ...rest } = p
  return Object.keys(suggestions).length ? { ...rest, suggestions } : rest
}

/** Validated dismissed suggestion keys ('question=value' of a known question); none at all leaves the field out. */
const withDismissed = (p: Project, raw: unknown): Project => {
  const keys = Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string' && questions.has(k.split('=')[0])).slice(0, 500) : []
  const { dismissed: _old, ...rest } = p
  return keys.length ? { ...rest, dismissed: [...new Set(keys)] } : rest
}

/** Validates an imported project file (untrusted input). */
export function parseProject(json: string): Project {
  const raw = JSON.parse(json) as Record<string, unknown>
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('Project file has no name.')
  const versions = Array.isArray(raw.versions) ? raw.versions : []
  const project = withOverridesOf(
    {
      ...blankProject(raw.name.slice(0, 120), typeof raw.description === 'string' ? raw.description.slice(0, 4000) : '', cleanAnswers(raw.answers)),
      versions: versions
        .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && typeof (v as Record<string, unknown>).name === 'string')
        .map((v) => withOverridesOf({ id: newId(), name: String(v.name).slice(0, 120), createdAt: typeof v.createdAt === 'string' ? v.createdAt : now(), answers: cleanAnswers(v.answers) }, v.overrides)),
    },
    raw.overrides,
  )
  return withSuggestions(withDismissed(project, raw.dismissed), raw.suggestions)
}

// Saved overrides pass the same validation as an import (store version 5 and older could save a 0 divisor).
const scoped = <T extends { answers: Answers; overrides?: Overrides }>(x: T): T => {
  const { overrides: raw, ...rest } = x
  const overrides = scopeOverrides(cleanOverrides(raw), x.answers)
  return (overrides ? { ...rest, overrides } : rest) as T
}

/** Projects saved by an older store version get their answers migrated and validated like an import. */
export function migrateStore(persisted: unknown): { projects: Record<string, Project>; activeId: string | null } {
  const stored = (persisted ?? {}) as { projects?: Record<string, Project>; activeId?: string | null }
  const projects = Object.fromEntries(
    Object.entries(stored.projects ?? {}).map(([id, p]) => [
      id,
      withSuggestions(withDismissed(scoped({ ...p, answers: cleanAnswers(p.answers ?? {}), versions: (p.versions ?? []).map((ver) => scoped({ ...ver, answers: cleanAnswers(ver.answers ?? {}) })) }), p.dismissed), p.suggestions),
    ]),
  )
  return { projects, activeId: stored.activeId ?? null }
}

/** A project's answers and overrides before a change, named after the change ('Cloud provider = Azure'). */
export interface HistoryEntry {
  answers: Answers
  overrides?: Overrides
  label: string
}

const HISTORY_LIMIT = 100

/** Answers in a key-order-independent form, to tell whether two answer sets are the same. */
const canonical = (answers: Answers) => JSON.stringify(Object.keys(answers).sort().map((k) => [k, answers[k]]))

function answerLabel(questionId: string, answer: AnswerValue | null): string {
  const q = questions.get(questionId)
  const title = q?.title ?? questionId
  if (!answer) return `Clear ${title}`
  if (answer.kind === 'unknown') return `${title} = assumed`
  if (answer.kind === 'custom') return `${title} = ${answer.text}`
  const label = (v: unknown) => q?.options?.find((o) => o.id === v)?.label ?? (typeof v === 'number' ? fmt(v) : String(v))
  return `${title} = ${Array.isArray(answer.value) ? answer.value.map(label).join(', ') || 'none' : label(answer.value)}`
}

export type Panel = 'explore' | 'docs' | 'cost' | null

interface ProjectState {
  projects: Record<string, Project>
  activeId: string | null
  /** Temporary overrides for what-if exploration; never persisted into the project. */
  whatIf: Answers | null
  /** Set for explicit explorations (scenario lab); null for transient hover previews. */
  whatIfLabel: string | null
  selectedComponent: string | null
  /** The side panel open over the stage; selecting a component closes it, so the inspector it would cover shows. */
  panel: Panel
  /** The answered question the sidebar opens for editing (cost panel links); null shows the next question. */
  editing: string | null
  /** Counts edit() and showCategory() calls, so opening the question that is already open still brings it forward. */
  editRequest: number
  /** The outline category showCategory() expands (the HUD availability tile opens Reliability). */
  focusCategory: string | null
  /** Per-project undo and redo stacks; in memory only, never persisted. */
  history: Record<string, { past: HistoryEntry[]; future: HistoryEntry[] }>
  undo: () => void
  redo: () => void
  active: () => Project | null
  /** Detected suggestions default to those of the description; answered questions and dismissed keys drop out of them. */
  createProject: (name: string, description: string, answers?: Answers, suggestions?: Answers, dismissed?: string[]) => string
  openProject: (id: string) => void
  closeProject: () => void
  deleteProject: (id: string) => void
  duplicateProject: (id: string) => void
  renameProject: (name: string) => void
  /** Also re-detects the suggestions, so the question cards follow the edited brief. */
  setDescription: (description: string) => void
  setAnswer: (questionId: string, answer: AnswerValue | null) => void
  /** Previews the chosen suggestions as a what-if (a multi-choice keeps its chosen values); committing it is one undo step. */
  applySuggestions: (answers: Answers) => void
  /** Applies the pending suggestions, then accepts the recommendation for every remaining question. */
  autoCompleteActive: () => void
  saveVersion: (name: string) => void
  restoreVersion: (versionId: string) => void
  deleteVersion: (versionId: string) => void
  importProject: (json: string) => string
  setWhatIf: (overrides: Answers | null, label?: string) => void
  /** A hover or focus preview of one option; it never replaces or clears a labelled what-if, so its Apply and Discard stay. */
  previewOption: (overrides: Answers | null) => void
  commitWhatIf: () => void
  select: (componentId: string | null) => void
  setPanel: (panel: Panel) => void
  edit: (questionId: string | null) => void
  showCategory: (categoryId: string) => void
  /** Replaces the active project's overrides, validated like an import; empty overrides are removed. */
  setOverrides: (overrides: Overrides | undefined) => void
}

/**
 * Stored projects replace the in-memory ones. The first load opens the stored project; a reload after another tab saved
 * (`reload`) keeps the project this tab has open, or none once that project is deleted.
 */
export const mergeStored = (stored: unknown, current: ProjectState, reload: boolean): ProjectState => {
  const saved = (stored ?? {}) as Partial<Pick<ProjectState, 'projects' | 'activeId'>>
  const projects = saved.projects ?? current.projects
  const activeId = reload ? (current.activeId && projects[current.activeId] ? current.activeId : null) : (saved.activeId ?? null)
  return { ...current, projects, activeId }
}
let loaded = false

/** Below 900 px an open panel hides the sidebar (app.css), so opening a question from the panel closes it to show the question. */
const NARROW_QUERY = '(max-width: 900px)'
const sidebarHidden = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches

export const useProjects = create<ProjectState>()(
  persist(
    (set, get) => {
      const update = (fn: (p: Project) => Project) => {
        const p = get().active()
        if (!p) return
        set((s) => ({ projects: { ...s.projects, [p.id]: { ...fn(p), updatedAt: now() } } }))
      }
      // An undoable change to the answers or overrides: the state before it goes on the undo stack under `label`.
      const change = (label: string, fn: (p: Project) => Project) => {
        const p = get().active()
        if (!p) return
        const next = fn(p)
        if (canonical(next.answers) === canonical(p.answers) && JSON.stringify(next.overrides) === JSON.stringify(p.overrides)) return
        const past = [...(get().history[p.id]?.past ?? []), { answers: p.answers, overrides: p.overrides, label }].slice(-HISTORY_LIMIT)
        set((s) => ({ projects: { ...s.projects, [p.id]: { ...next, updatedAt: now() } }, history: { ...s.history, [p.id]: { past, future: [] } } }))
      }
      // Moves the newest entry of one stack onto the other, swapping it with the current state.
      const travel = (from: 'past' | 'future') => {
        const p = get().active()
        const h = p && get().history[p.id]
        const entry = h?.[from].at(-1)
        if (!p || !h || !entry) return
        const to = from === 'past' ? 'future' : 'past'
        const moved = { ...h, [from]: h[from].slice(0, -1), [to]: [...h[to], { answers: p.answers, overrides: p.overrides, label: entry.label }] }
        set((s) => ({
          projects: { ...s.projects, [p.id]: { ...p, answers: entry.answers, overrides: entry.overrides, updatedAt: now() } },
          history: { ...s.history, [p.id]: moved },
          whatIf: null,
          whatIfLabel: null,
        }))
      }
      return {
        projects: {},
        activeId: null,
        whatIf: null,
        whatIfLabel: null,
        selectedComponent: null,
        panel: null,
        editing: null,
        editRequest: 0,
        focusCategory: null,
        history: {},
        undo: () => travel('past'),
        redo: () => travel('future'),
        active: () => {
          const { projects, activeId } = get()
          return activeId ? (projects[activeId] ?? null) : null
        },
        createProject: (name, description, answers = {}, suggestions = suggestFromDescription(kb, description), dismissed = []) => {
          // Suggestions that do not apply to the design they describe (an app type on a data platform) are never stored.
          const p = withSuggestions(withDismissed(blankProject(name, description, answers), dismissed), usableSuggestions(kb, answers, suggestions))
          set((s) => ({ projects: { ...s.projects, [p.id]: p }, activeId: p.id, whatIf: null, selectedComponent: null }))
          return p.id
        },
        openProject: (id) => set({ activeId: id, whatIf: null, selectedComponent: null, editing: null, panel: null }),
        closeProject: () => set({ activeId: null, whatIf: null, selectedComponent: null, editing: null, panel: null }),
        deleteProject: (id) =>
          set((s) => {
            const rest = { ...s.projects }
            delete rest[id]
            return { projects: rest, activeId: s.activeId === id ? null : s.activeId }
          }),
        duplicateProject: (id) => {
          const source = get().projects[id]
          if (!source) return
          const copy = withSuggestions(
            { ...blankProject(`${source.name} (copy)`, source.description, source.answers), versions: source.versions, ...(source.overrides && { overrides: source.overrides }), ...(source.dismissed && { dismissed: source.dismissed }) },
            source.suggestions,
          )
          set((s) => ({ projects: { ...s.projects, [copy.id]: copy } }))
        },
        renameProject: (name) => update((p) => ({ ...p, name })),
        setDescription: (description) => update((p) => withSuggestions({ ...p, description }, suggestFromDescription(kb, description))),
        setAnswer: (questionId, answer) =>
          change(answerLabel(questionId, answer), (p) => {
            const answers = { ...p.answers }
            if (answer) answers[questionId] = answer
            else delete answers[questionId]
            return { ...p, answers }
          }),
        applySuggestions: (answers) => {
          const before = get().active()?.answers ?? {}
          // A multi-choice gains the suggested values; the ones already chosen (e.g. HIPAA) stay. Infeasible values drop out.
          const merged = addSuggestions(kb, before, answers)
          const usable = usableSuggestions(kb, Object.fromEntries(Object.entries(before).filter(([id]) => !(id in merged))), merged, true)
          const n = Object.keys(usable).length
          if (n > 0) get().setWhatIf(usable, `Apply ${n} suggestion${n === 1 ? '' : 's'} from the brief`)
        },
        autoCompleteActive: () => {
          const p = get().active()
          const before = p?.answers ?? {}
          // The answers detected in the brief and not dismissed come before the recommendations, as the Welcome page promises;
          // a question the user answered keeps that answer, and suggestions that do not apply to this design are left out.
          const answers = autoComplete(kb, { ...before, ...usableSuggestions(kb, before, p?.suggestions ?? {}) })
          change(`Auto-design ${Object.keys(answers).length - Object.keys(before).length} answers`, (q) => withSuggestions({ ...q, answers }, q.suggestions))
        },
        // Versions snapshot the overrides too, so comparing versions shows changed assumptions and prices.
        saveVersion: (name) => update((p) => ({ ...p, versions: [...p.versions, { id: newId(), name, createdAt: now(), answers: p.answers, ...(p.overrides && { overrides: p.overrides }) }] })),
        restoreVersion: (versionId) => {
          const p = get().active()
          const v = p?.versions.find((x) => x.id === versionId)
          if (!p || !v) return
          // Answers or prices and assumptions no version holds would be lost, so they are saved first.
          const current = canonical(p.answers) + JSON.stringify(p.overrides ?? null)
          const saved = (x: Version) => canonical(x.answers) + JSON.stringify(x.overrides ?? null) === current
          if ((Object.keys(p.answers).length > 0 || p.overrides) && !p.versions.some(saved)) get().saveVersion(`Before restore ${new Date().toLocaleTimeString()}`)
          change(`Restore ${v.name}`, (q) => ({ ...q, answers: v.answers, overrides: v.overrides }))
        },
        deleteVersion: (versionId) => update((p) => ({ ...p, versions: p.versions.filter((v) => v.id !== versionId) })),
        importProject: (json) => {
          const p = parseProject(json)
          set((s) => ({ projects: { ...s.projects, [p.id]: p }, activeId: p.id, whatIf: null }))
          return p.id
        },
        setWhatIf: (overrides, label) => set({ whatIf: overrides, whatIfLabel: overrides ? (label ?? null) : null }),
        previewOption: (overrides) => {
          if (get().whatIfLabel === null) set({ whatIf: overrides, whatIfLabel: null })
        },
        commitWhatIf: () => {
          const overrides = get().whatIf
          if (overrides) change(get().whatIfLabel ?? 'Apply what-if', (p) => ({ ...p, answers: { ...p.answers, ...overrides } }))
          set({ whatIf: null, whatIfLabel: null })
        },
        select: (componentId) => set(componentId ? { selectedComponent: componentId, panel: null } : { selectedComponent: null }),
        setPanel: (panel) => set({ panel }),
        edit: (questionId) => set((s) => ({ editing: questionId, focusCategory: null, editRequest: s.editRequest + 1, panel: sidebarHidden() ? null : s.panel })),
        showCategory: (categoryId) => set((s) => ({ editing: null, focusCategory: categoryId, editRequest: s.editRequest + 1, panel: sidebarHidden() ? null : s.panel })),
        setOverrides: (overrides) =>
          change('Edit cost assumptions', (p) => {
            const { overrides: _old, ...rest } = p
            const clean = scopeOverrides(cleanOverrides(overrides), p.answers)
            return clean ? { ...rest, overrides: clean } : rest
          }),
      }
    },
    {
      name: STORE_KEY,
      version: STORE_VERSION,
      partialize: (s) => ({ projects: s.projects, activeId: s.activeId }),
      migrate: migrateStore,
      merge: (stored, current) => mergeStored(stored, current, loaded),
      onRehydrateStorage: () => () => {
        loaded = true
      },
    },
  ),
)

/**
 * Another tab saved the projects: reload them, so this tab's next save does not write back its stale copy and delete
 * the projects created or edited there. `target` is the window in the app.
 */
export function followOtherTabs(target: Pick<EventTarget, 'addEventListener'>): void {
  target.addEventListener('storage', (event) => {
    if ((event as StorageEvent).key === STORE_KEY) void useProjects.persist.rehydrate()
  })
}

if (typeof window !== 'undefined') followOtherTabs(window)
