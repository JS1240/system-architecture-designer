import type { KnowledgeBase, Overrides, ReferenceNumbers } from '../domain/types'

type ReferenceBuild = (reference: ReferenceNumbers) => Pick<KnowledgeBase, 'components' | 'services'>
// Kept beside the knowledge base, not in it, so the knowledge base stays plain JSON.
const referenceBuilds = new WeakMap<KnowledgeBase, ReferenceBuild>()

/** Registers how a knowledge base rebuilds the components and offers whose prices, sizing and notes bake in reference numbers. */
export function registerReferenceBuild(kb: KnowledgeBase, build: ReferenceBuild): void {
  referenceBuilds.set(kb, build)
}

/** The knowledge base with a project's own assumptions applied; pure, so evaluate(withOverrides(kb, o), answers) keeps its signature. */
export function withOverrides(base: KnowledgeBase, o: Overrides | undefined): KnowledgeBase {
  if (!o || Object.keys(o).length === 0) return base
  const reference = { ...base.reference, ...o.reference }
  // An overridden reference number reaches every price and sizing built from it, not only the engine's own formulas.
  const build = o.reference && referenceBuilds.get(base)
  const kb = build ? { ...base, ...build(reference) } : base
  const pinned = o.replicas ?? {}
  const excluded = new Set(o.exclude ?? [])
  // Unit prices apply in deriveArchitecture, to the offer and capacity tier they name (unitPriceKey).
  return {
    ...kb,
    reference,
    // Edge preference lists and `has` conditions already skip absent components.
    components: kb.components.filter((c) => !excluded.has(c.id)).map((c) => (pinned[c.id] !== undefined ? { ...c, fixedReplicas: pinned[c.id] } : c)),
    overrides: o,
  }
}

/** The offer and capacity tier a unit-price key (unitPriceKey) is limited to ('Fabric F-SKU capacity, F2'); '' for a component's own price. */
export const priceScope = (key: string): string => key.split('|').slice(2).join(', ')

/** What a unit-price key prices, for people: 'Data warehouse (Fabric F-SKU capacity, F2 only)'. */
export function describePriceKey(kb: KnowledgeBase, key: string): string {
  const id = key.split('|')[0]
  const label = kb.components.find((c) => c.id === id)?.label ?? id
  return priceScope(key) ? `${label} (${priceScope(key)} only)` : label
}
