import type { KnowledgeBase, ReferenceNumbers } from '../domain/types'
import { registerReferenceBuild } from '../engine/overrides'
import { patterns, technologies } from './catalog'
import { buildComponents, components } from './components'
import { derived } from './derived'
import { edges } from './edges'
import { questions } from './questions'
import { reference } from './reference'
import { scenarios } from './scenarios'
import { buildServices, services } from './services'
import { validations } from './validations'

export const kbCore: KnowledgeBase = {
  version: '1.0.0',
  categories: [
    { id: 'product', label: 'Product', order: 1 },
    // Organisational and residency constraints come right after the product, so the provider is fixed before the decisions it names and prices.
    { id: 'context', label: 'Context and constraints', order: 2 },
    // What exists today comes before the traffic, since a measured peak and the migrated data replace derived estimates.
    { id: 'migration', label: 'Existing sources and migration', order: 3 },
    { id: 'traffic', label: 'Traffic', order: 4 },
    { id: 'data', label: 'Data', order: 5 },
    { id: 'ai', label: 'AI', order: 6 },
    { id: 'performance', label: 'Performance', order: 7 },
    { id: 'architecture', label: 'Architecture', order: 8 },
    { id: 'security', label: 'Security', order: 9 },
    { id: 'reliability', label: 'Reliability', order: 10 },
    { id: 'infrastructure', label: 'Infrastructure', order: 11 },
    { id: 'operations', label: 'Operations', order: 12 },
  ],
  questions,
  components,
  edges,
  validations,
  technologies,
  patterns,
  reference,
  scenarios,
  services,
  derived,
}

/** Components and offers rebuilt from a project's reference numbers (withOverrides). */
export const buildPriced = (reference: ReferenceNumbers) => ({ components: buildComponents(reference), services: buildServices(reference) })
registerReferenceBuild(kbCore, buildPriced)
