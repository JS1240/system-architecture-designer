import { describe, expect, it } from 'vitest'
import { kb } from '../knowledge'
import { isTypingTarget, parseNumberInput, sliderScale } from './input'

const spec = (id: string) => kb.questions.find((q) => q.id === id)!.number!

describe('number sliders', () => {
  it('reach every decade of a wide range that starts at 0, and keep a stop for 0', () => {
    for (const id of ['source.legacy_monthly_usd', 'source.measured_peak_qps', 'data.history_tb', 'data.growth_pct']) {
      const s = sliderScale(spec(id))
      expect(s.fromSlider(s.min), id).toBe(0)
      expect(s.toSlider(0), id).toBe(s.min)
      // One step above the zero stop is the smallest positive value, and the realistic small values are a few steps apart.
      expect(s.fromSlider(s.min + s.step), id).toBe(1)
      for (const v of [3, 30, 3_000]) if (v <= spec(id).max) expect(s.fromSlider(s.toSlider(v)), `${id} ${v}`).toBeCloseTo(v, 0)
      expect((s.max - s.min) / s.step, id).toBeGreaterThan(60)
    }
    // A log range above 0 has no zero stop, and a linear range is unchanged.
    expect(sliderScale(spec('ai.corpus_gb')).min).toBeCloseTo(Math.log10(0.01))
    expect(sliderScale({ min: 0, max: 36, unit: 'months', scale: 'linear', presets: [] })).toMatchObject({ min: 0, max: 36, step: 0.36 })
  })
})

describe('workspace keys', () => {
  it('leave Escape and undo to text fields, but not to sliders, buttons or checkboxes', () => {
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' })).toBe(true)
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    for (const type of ['range', 'checkbox', 'radio', 'button']) expect(isTypingTarget({ tagName: 'INPUT', type }), type).toBe(false)
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('typed numbers', () => {
  it('read separators, a currency sign and k or M suffixes, and reject the rest', () => {
    expect(['5000', '5,000', '$5,000', ' 5 000 ', '5k', '5K', '$5k', '5_000'].map(parseNumberInput)).toEqual(Array(8).fill(5_000))
    expect(parseNumberInput('1.2M')).toBe(1_200_000)
    expect(parseNumberInput('20,000')).toBe(20_000)
    expect(parseNumberInput('0.5')).toBe(0.5)
    expect(parseNumberInput('1,234,567.5')).toBe(1_234_567.5)
    for (const bad of ['', 'abc', '1,5', '5,00', '5kk', 'k', '$', '5 apples']) expect(parseNumberInput(bad), bad).toBeNull()
  })
})
