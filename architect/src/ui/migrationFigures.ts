import type { Facts } from '../domain/types'
import { fmt } from '../engine/architecture'

const num = (facts: Facts, id: string) => (typeof facts[id] === 'number' ? (facts[id] as number) : undefined)
export const duration = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${fmt(Math.round(h * 10) / 10)} h` : `${fmt(Math.round((h / 24) * 10) / 10)} days`)

// Each link option's bulk copy and its cutover share of the window (migration.ts); the same site or cloud copies at about 10 Gbps.
const LINK_FACTS: Record<string, [string, string | undefined]> = {
  vpn: ['mig.bulkHoursVpn', 'mig.cutoverRatioVpn'],
  dedicated_1g: ['mig.bulkHours1g', 'mig.cutoverRatio1g'],
  dedicated_10g: ['mig.bulkHours10g', 'mig.cutoverRatio10g'],
  same_cloud: ['mig.bulkHours10g', 'mig.cutoverRatio10g'],
  offline_device: ['mig.bulkHoursDevice', undefined],
}

/** What the copy takes over one transfer link option in this design, and whether a bulk cutover over it fits the downtime window; null outside a migration. */
export function linkOptionFigure(optionId: string, facts: Facts): string | null {
  const [hoursFact, ratioFact] = LINK_FACTS[optionId] ?? []
  if (hoursFact === undefined || num(facts, 'mig.sourceGb') === undefined) return null
  // The device's own time (migration.ts), the same whichever link is selected.
  const copy = num(facts, hoursFact)
  if (copy === undefined) return null
  const ratio = ratioFact ? num(facts, ratioFact) : undefined
  // Only a replaced system has a cutover window.
  const fit = facts['profile.replace'] === true && ratio !== undefined ? `; a bulk cutover ${ratio <= 1 ? 'fits' : 'overruns'} the window` : ''
  return `This copy: about ${duration(copy)}${fit}.`
}

/** The cutover of this design against its downtime window, and the coexistence months; null when nothing is cut over. */
export function cutoverFigure(facts: Facts): string | null {
  const cutover = num(facts, 'mig.cutoverHours')
  if (facts['profile.replace'] !== true || cutover === undefined) return null
  const window = num(facts, 'migration.downtimeHours') ?? 8
  const copy = num(facts, 'mig.bulkHours')
  const archive = num(facts, 'mig.archiveHours') ?? 0
  const archived = archive > 0 ? ` (plus ${duration(archive)} for the archived history before cutover)` : ''
  return `This design: copy about ${duration(copy ?? 0)}${archived}, cutover about ${duration(cutover)} against a window of ${duration(window)} (${cutover <= window ? 'fits' : 'overruns'}).`
}
