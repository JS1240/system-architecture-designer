import { describe, expect, it } from 'vitest'
import { evaluate } from '../engine/evaluate'
import { autoComplete } from '../engine/explore'
import { kb } from '../knowledge'
import { decidesFor, kindExamples, shownChoice } from './kindCards'

const v = (value: string | number) => ({ kind: 'value' as const, value })
const kinds = kb.questions.find((q) => q.id === 'project.kind')!.options!.map((o) => o.id)
const title = (id: string) => kb.questions.find((q) => q.id === id)!.title
// The Welcome page reads scenarios with the kind they evaluate to.
const scenarios = kb.scenarios.map((scenario) => ({ scenario, kind: String(evaluate(kb, scenario.answers).facts['project.kind'] ?? 'transactional_app') }))

describe('kind cards', () => {
  it('lists the questions each specialised kind brings', () => {
    expect(decidesFor('b2b_saas')).toEqual([title('tenancy.tenants'), title('tenancy.model')])
    expect(decidesFor('integration')).toEqual(expect.arrayContaining([title('integration.systems'), title('integration.approach')]))
    expect(decidesFor('event_streaming')).toEqual(expect.arrayContaining([title('events.rate'), title('events.retention_days')]))
    for (const kind of kinds.filter((k) => k !== 'transactional_app')) expect(decidesFor(kind), kind).not.toEqual([])
  })

  it('designs a B2B SaaS differently from a plain web app', () => {
    const design = (answers: Record<string, ReturnType<typeof v>>) => evaluate(kb, autoComplete(kb, answers))
    const web = design({ 'project.kind': v('transactional_app') })
    expect(web.questions.some((q) => q.active && q.question.id.startsWith('tenancy.'))).toBe(false)
    const saas = design({ 'project.kind': v('b2b_saas'), 'tenancy.model': v('db_per_tenant'), 'tenancy.tenants': v(40) })
    expect(saas.architecture.components.find((c) => c.def.id === 'db-primary')!.tech).toContain('tenant catalog')
    const tenants = saas.architecture.components.find((c) => c.def.id === 'tenant-databases')!
    expect(tenants.units).toBe(40)
    expect(saas.monthlyCost).toBeGreaterThan(web.monthlyCost)
    // Hundreds of small tenants share tables.
    expect(design({ 'project.kind': v('b2b_saas'), 'tenancy.tenants': v(2_000) }).facts['tenancy.model']).toBe('pooled')
  })

  it('offers an example for every kind, leading with scenarios that pick the kind, then case studies', () => {
    for (const kind of kinds) expect(kindExamples(scenarios, kind).length, kind).toBeGreaterThan(0)
    const web = kindExamples(scenarios, 'transactional_app')
    expect(web.every((x) => x.scenario.caseStudy)).toBe(true)
    expect(web.map((x) => x.scenario.name).join()).not.toMatch(/Databricks/)
    expect(kindExamples(scenarios, 'ai_app').every((x) => 'project.kind' in x.scenario.answers)).toBe(true)
  })

  it('shows a used detection as the selected choice until one is clicked', () => {
    const answers = { 'project.origin': v('migrate_database') }
    expect(shownChoice(null, answers, 'project.origin')).toBe('migrate_database')
    expect(shownChoice('new_build', answers, 'project.origin')).toBe('new_build')
    expect(shownChoice(null, {}, 'project.kind')).toBeNull()
  })
})
