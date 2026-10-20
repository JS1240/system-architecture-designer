import type { GuideEntry, KnowledgeBase } from '../domain/types'
import { registerReferenceBuild } from '../engine/overrides'
import { buildPriced, kbCore } from './core'
import guides from './guides.generated.json'

export const kbFull: KnowledgeBase = { ...kbCore, guides: guides as GuideEntry[] }
registerReferenceBuild(kbFull, buildPriced)
