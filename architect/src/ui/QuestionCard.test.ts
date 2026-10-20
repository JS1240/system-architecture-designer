import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Answers } from '../domain/types'
import { evaluate } from '../engine/evaluate'
import { kb } from '../knowledge'
import { autoComplete, optionChange, runAndPeople } from '../engine/explore'
import { optionCosts } from './costing'
import { linkOptionFigure } from './migrationFigures'
import { QuestionCard } from './QuestionCard'

const render = (answers: Answers, questionId: string) => {
  const e = evaluate(kb, answers)
  const state = e.questions.find((q) => q.question.id === questionId)!
  const noop = () => {}
  return renderToStaticMarkup(createElement(QuestionCard, { state, answer: answers[questionId], onAnswer: noop, onPreview: noop, previewing: null, facts: e.facts }))
}
const checked = (html: string) => [...html.matchAll(/<input type="checkbox" checked=""[^>]*\/><span><span class="option-label">([^<]+)</g)].map((m) => m[1])

describe('question card', () => {
  it('starts a pending multi question from the kind\'s default and names it', () => {
    const html = render({ 'project.kind': { kind: 'value', value: 'ai_app' } }, 'product.features')
    const labels = ['accounts', 'ml'].map((id) => kb.questions.find((q) => q.id === 'product.features')!.options!.find((o) => o.id === id)!.label)
    expect(checked(html)).toEqual(labels)
    expect(html).toContain('default for AI-powered app')
    expect(html).toContain(`Not sure: assume ${labels.join(', ')}`)
  })

  it('keeps the user\'s own selection over the default', () => {
    const html = render({ 'project.kind': { kind: 'value', value: 'ai_app' }, 'product.features': { kind: 'value', value: ['search'] } }, 'product.features')
    expect(checked(html)).toEqual([kb.questions.find((q) => q.id === 'product.features')!.options!.find((o) => o.id === 'search')!.label])
  })
})

describe('migration figures on the cards', () => {
  const twelveTb: Answers = {
    'product.type': { kind: 'value', value: 'commerce' },
    'project.origin': { kind: 'value', value: 'migrate_database' },
    'infra.cloud': { kind: 'value', value: 'aws' },
    'source.kinds': { kind: 'value', value: ['rdbms'] },
    'source.rdbms_engine': { kind: 'value', value: 'oracle' },
    'source.volume_gb': { kind: 'value', value: 12 * 1024 },
    'migration.downtime': { kind: 'value', value: 'overnight' },
    'migration.sync': { kind: 'value', value: 'cdc' },
    'traffic.dau': { kind: 'value', value: 100_000 },
  }

  it('shows each link option\'s copy time and the cutover against the window', () => {
    const link = render(twelveTb, 'migration.link')
    expect(link).toContain('This copy: about 39 h; a bulk cutover overruns the window.')
    // Over 10 Gbps the target's bulk-load rate, not the link, caps the copy.
    expect(link).toContain('This copy: about 8.5 h; a bulk cutover overruns the window.')
    expect(render(twelveTb, 'migration.downtime')).toMatch(/cutover about 15 min against a window of 8.0 h \(fits\)/)
    expect(render(twelveTb, 'migration.sync')).toContain('This design: copy about')
  })

  it('shows the device\'s own time whichever link is selected', () => {
    const hundredTb = { ...twelveTb, 'source.volume_gb': { kind: 'value' as const, value: 100 * 1024 }, 'migration.link': { kind: 'value' as const, value: 'vpn' } }
    expect(render(hundredTb, 'migration.link')).toContain('This copy: about 10 days.')
    expect(linkOptionFigure('offline_device', evaluate(kb, hundredTb).facts)).toBe('This copy: about 10 days.')
  })
})

describe('option costs on the card', () => {
  const scenario = (id: string) => kb.scenarios.find((x) => x.id === id)!.answers
  const stateOf = (answers: Answers, id: string) => evaluate(kb, answers).questions.find((q) => q.question.id === id)!

  it('prices the options of a requirement too, and previews them on hover like a decision', () => {
    const answers = autoComplete(kb, scenario('rag-assistant-azure'))
    const state = stateOf(answers, 'reliability.availability')
    expect(state.question.isDecision).toBe(false)
    const costs = optionCosts(kb, answers, state, null)!
    expect(Object.keys(costs)).toEqual(state.question.options!.map((o) => o.id))
    expect(Math.max(...Object.values(costs).map((c) => c.monthly))).toBeGreaterThanOrEqual(1)
    const noop = () => {}
    const html = renderToStaticMarkup(createElement(QuestionCard, { state, answer: answers[state.question.id], onAnswer: noop, onPreview: noop, previewing: null, facts: evaluate(kb, answers).facts, answers, knowledge: kb }))
    expect(html).toContain('cost-chip')
  })

  it('gives a requirement whose options cost the same no chips', () => {
    const answers = autoComplete(kb, scenario('rag-assistant-azure'))
    // The latency target changes findings here, not the bill: no row of $0 chips.
    expect(optionCosts(kb, answers, stateOf(answers, 'perf.latency'), null)).toBeNull()
  })

  it('applies an option with the answers its chip resets, so the applied design costs what the chip says', () => {
    // Every assumption made explicit, so switching the provider has answered follow-ups to reset.
    const assumed = evaluate(kb, autoComplete(kb, scenario('web-crawler')))
    const answers: Answers = Object.fromEntries(assumed.questions.filter((s) => s.active && s.effectiveValue !== null).map((s) => [s.question.id, { kind: 'value', value: s.effectiveValue! }]))
    const state = stateOf(answers, 'infra.cloud')
    const costs = optionCosts(kb, answers, state, null)!
    const [id, cost] = Object.entries(costs).find(([, c]) => c.resetIds.length > 0)!
    // The card applies this change on click (onApply), one undo step like the comparison table's Apply.
    const applied = optionChange('infra.cloud', id, cost.resetIds)
    const total = (a: Answers) => runAndPeople(evaluate(kb, autoComplete(kb, a)))
    expect(total({ ...answers, ...applied })).toBeCloseTo(total(answers) + cost.monthly, 0)
  })
})

describe('add-ons card', () => {
  it('rules out the add-on the kind of task already includes, with the reason', () => {
    const html = render({ 'project.kind': { kind: 'value', value: 'data_platform' } }, 'project.addons')
    const analytics = kb.questions.find((q) => q.id === 'project.addons')!.options!.find((o) => o.id === 'analytics')!
    expect(html).toContain(analytics.infeasibleReason)
    expect(html).toMatch(/<input type="checkbox" disabled=""/)
    // An app keeps every add-on.
    expect(render({ 'project.kind': { kind: 'value', value: 'transactional_app' } }, 'project.addons')).not.toContain('disabled=""')
    // Choosing it anyway on a data platform is an error finding.
    const e = evaluate(kb, { 'project.kind': { kind: 'value', value: 'data_platform' }, 'project.addons': { kind: 'value', value: ['analytics'] } })
    expect(e.findings.map((x) => x.rule.id)).toContain('infeasible-project.addons')
  })
})
