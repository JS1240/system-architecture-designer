import type { NumberSpec } from '../domain/types'

/** Slider steps per decade on a log scale. */
const LOG_STEP = 0.05

/** A number question's range slider; a log range that starts at 0 gets a zero stop one step below its smallest positive value. */
export function sliderScale(spec: NumberSpec): { min: number; max: number; step: number; toSlider: (v: number) => number; fromSlider: (s: number) => number } {
  if (spec.scale !== 'log') return { min: spec.min, max: spec.max, step: (spec.max - spec.min) / 100, toSlider: (v) => v, fromSlider: (s) => s }
  const floor = spec.min > 0 ? spec.min : Math.min(1, ...spec.presets.map((p) => p.value).filter((v) => v > 0))
  const low = Math.log10(floor)
  const zeroStop = spec.min > 0 ? null : low - LOG_STEP
  return {
    min: zeroStop ?? low,
    max: Math.log10(spec.max),
    step: LOG_STEP,
    toSlider: (v) => (zeroStop !== null && v <= 0 ? zeroStop : Math.log10(Math.max(floor, v))),
    fromSlider: (s) => (zeroStop !== null && s < low - LOG_STEP / 2 ? 0 : Number((10 ** s).toPrecision(2))),
  }
}

/** The key event comes from a text field, which keeps its own Escape and undo. */
export function isTypingTarget(target: { tagName?: string; type?: string; isContentEditable?: boolean } | null): boolean {
  if (!target) return false
  if (target.isContentEditable || target.tagName === 'TEXTAREA') return true
  return target.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(target.type ?? 'text')
}

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6 }

/** A typed number as people write it ('5,000', '$5000', '5k', '1.2M', '20 000'); null when it still does not read as a number. */
export function parseNumberInput(text: string): number | null {
  let t = text.trim().replace(/[\s_$]/g, '')
  // Commas only as thousands separators: '1,5' is ambiguous, so it is rejected rather than read as 15.
  if (t.includes(',')) {
    if (!/^-?\d{1,3}(,\d{3})+(\.\d+)?[kKmM]?$/.test(t)) return null
    t = t.replace(/,/g, '')
  }
  const factor = SUFFIX[t.slice(-1).toLowerCase()] ?? 1
  if (factor !== 1) t = t.slice(0, -1)
  if (t === '' || !/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null
  return Number(t) * factor
}
