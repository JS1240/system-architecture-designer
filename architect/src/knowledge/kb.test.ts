import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LinearSizing, SourceRef } from '../domain/types'
import { referencedComponents, referencedFacts } from '../engine/conditions'
import { factProducers } from '../engine/questions'
import { kbFull as kb } from './full'
import { cite, S, sourceUrl } from './sources'

// 'general' sources cite general practice, not a repository file.
const REPO_DIRS: Record<Exclude<SourceRef['repo'], 'general'>, string> = {
  'system-design-primer': 'system-design-primer-master',
  'system-design-101': 'system-design-101-main',
  'system-design-main': 'system-design-main',
}
const ROOT = resolve(__dirname, '../../..')
// The source repositories are git-ignored (their licences forbid redistribution); checks against them run where they are checked out.
const hasRepos = Object.values(REPO_DIRS).every((dir) => existsSync(resolve(ROOT, dir)))

function allSources(): SourceRef[] {
  return [
    ...kb.questions.flatMap((q) => [...q.sources, ...(q.options ?? []).flatMap((o) => o.sources ?? [])]),
    ...kb.components.flatMap((c) => c.sources),
    ...kb.validations.flatMap((v) => v.sources),
    ...kb.technologies.flatMap((t) => t.sources),
    ...kb.patterns.flatMap((p) => p.sources),
    ...kb.reference.sources,
    ...kb.scenarios.flatMap((s) => s.sources ?? []),
    ...kb.services.flatMap((o) => o.sources ?? []),
  ]
}

const linearSizings = (): LinearSizing[] => [
  ...kb.components.flatMap((c) => (typeof c.sizing === 'object' ? [c.sizing] : [])),
  ...kb.services.flatMap((o) => (o.sizing ? [o.sizing] : [])),
]

describe('knowledge base integrity', () => {
  it('is pure JSON data', () => {
    expect(JSON.parse(JSON.stringify(kb))).toEqual(kb)
  })

  it('states monthly downtime on one month length, 30.44 days as in the primer', () => {
    const month = (365.25 / 12) * 24 * 60
    const minutesPer: Record<string, number> = { h: 60, min: 1, s: 1 / 60 }
    for (const row of kb.reference.availabilityTable) {
      const [amount, unit] = row.downtimePerMonth.split(' ')
      const expected = (1 - parseFloat(row.nines) / 100) * month
      expect(Math.abs((Number(amount) * minutesPer[unit]) / expected - 1), row.nines).toBeLessThan(0.005)
    }
  })

  it('has unique ids', () => {
    for (const list of [kb.questions, kb.components, kb.edges, kb.validations]) {
      const ids = list.map((x) => x.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('references only facts that some question, workload or architecture produces', () => {
    const producers = factProducers(kb)
    // flow.* are the drawn flows the architecture computes before sizing (architecture.ts).
    const derivedPrefixes = ['cap.', 'size.', 'availability.', 'cost.', 'flow.']
    const known = (fact: string) => producers.has(fact) || derivedPrefixes.some((p) => fact.startsWith(p))
    const conditions = [
      ...kb.questions.flatMap((q) => [q.askWhen, ...(q.options ?? []).flatMap((o) => [o.feasibleWhen, ...(o.score ?? []).map((s) => s.when)])]),
      ...kb.components.map((c) => c.when),
      ...kb.edges.map((e) => e.when),
      ...kb.validations.map((v) => v.when),
      ...kb.questions.flatMap((q) => (q.defaultWhen ?? []).map((d) => d.when)),
      ...(kb.derived ?? []).map((d) => d.when),
      ...kb.services.map((o) => o.when),
    ]
    const unknown = conditions.flatMap((c) => [...referencedFacts(c)]).filter((fact) => !known(fact))
    expect(unknown).toEqual([])
    const products = linearSizings().flatMap((sizing) => [...sizing.product, ...(sizing.floor ?? [])].filter((x): x is string => typeof x === 'string'))
    expect(products.filter((fact) => !known(fact))).toEqual([])
  })

  it('offers services for defined components and cloud providers, with a price date', () => {
    const ids = new Set(kb.components.flatMap((c) => [c.id, ...(c.group ? [`@${c.group}`] : [])]))
    const providers = new Set(['any', ...(kb.questions.find((q) => q.id === 'infra.cloud')?.options ?? []).map((o) => o.id)])
    for (const o of kb.services) {
      const label = `${o.component}/${o.provider}/${o.name}`
      expect(ids.has(o.component), label).toBe(true)
      expect(providers.has(o.provider), label).toBe(true)
      expect(o.asOf, label).toMatch(/^\d{4}-\d{2}$/)
    }
  })

  it('references only defined components', () => {
    const ids = new Set(kb.components.map((c) => c.id))
    const groups = new Set(kb.components.flatMap((c) => (c.group ? [`@${c.group}`] : [])))
    const conditions = [...kb.components.map((c) => c.when), ...kb.edges.map((e) => e.when), ...kb.validations.map((v) => v.when)]
    for (const id of conditions.flatMap((c) => [...referencedComponents(c)])) expect(ids.has(id)).toBe(true)
    for (const edge of kb.edges) {
      for (const ref of [edge.from, ...edge.to]) expect(ids.has(ref) || groups.has(ref), `${edge.id}: ${ref}`).toBe(true)
    }
  })

  it('maps techFrom values to real option ids', () => {
    for (const c of kb.components) {
      if (!c.techFrom) continue
      const q = kb.questions.find((x) => x.id === c.techFrom!.fact)
      expect(q, c.id).toBeDefined()
      const options = new Set(q!.options!.map((o) => o.id))
      for (const key of Object.keys(c.techFrom.map)) expect(options.has(key), `${c.id}: ${key}`).toBe(true)
    }
    for (const c of kb.components) {
      for (const suffix of c.techSuffixFrom ?? []) {
        const options = new Set(kb.questions.find((x) => x.id === suffix.fact)!.options!.map((o) => o.id))
        for (const key of Object.keys(suffix.map)) expect(options.has(key), `${c.id}: ${key}`).toBe(true)
      }
    }
  })

  it.skipIf(!hasRepos)('cites files that exist in the analyzed repositories, within their line count', () => {
    for (const s of allSources()) {
      if (s.repo === 'general') {
        expect(s.title.trim(), `general source ${s.path}`).not.toBe('')
        continue
      }
      const file = resolve(ROOT, REPO_DIRS[s.repo], s.path)
      expect(existsSync(file), file).toBe(true)
      if (s.lines) {
        const end = Number(s.lines.split('-').pop())
        expect(readFileSync(file, 'utf8').split('\n').length, `${s.path}:${s.lines}`).toBeGreaterThanOrEqual(end)
      }
    }
  })

  it.skipIf(!hasRepos)('ends each main README case study range before the next top-level section', () => {
    const lines = readFileSync(resolve(ROOT, 'system-design-main/README.md'), 'utf8').split('\n')
    for (const s of allSources().filter((x) => x.repo === 'system-design-main' && x.title.endsWith('case study'))) {
      const [from, to] = s.lines!.split('-').map(Number)
      const later = lines.slice(from, to).filter((text) => text.startsWith('# '))
      expect(later, `${s.title} ${s.lines}`).toEqual([])
    }
  })

  it('gives every decision at least two alternatives with trade-offs', () => {
    for (const q of kb.questions.filter((x) => x.isDecision)) {
      expect(q.options!.length, q.id).toBeGreaterThanOrEqual(2)
      for (const o of q.options!) expect(o.pros.length + o.cons.length, `${q.id}.${o.id}`).toBeGreaterThan(0)
    }
  })

  it('uses scenario answers that match question options', () => {
    for (const scenario of kb.scenarios) {
      for (const [id, answer] of Object.entries(scenario.answers)) {
        const q = kb.questions.find((x) => x.id === id)
        expect(q, `${scenario.id}: ${id}`).toBeDefined()
        if (answer.kind !== 'value' || !q!.options) continue
        const values = Array.isArray(answer.value) ? answer.value : [answer.value]
        for (const value of values) expect(q!.options.some((o) => o.id === value), `${scenario.id}: ${id}=${value}`).toBe(true)
      }
    }
  })

  it('keeps scenario number answers within their question bounds', () => {
    for (const scenario of kb.scenarios) {
      for (const [id, answer] of Object.entries(scenario.answers)) {
        const spec = kb.questions.find((x) => x.id === id)?.number
        if (!spec || answer.kind !== 'value' || typeof answer.value !== 'number') continue
        expect(answer.value, `${scenario.id}: ${id}`).toBeGreaterThanOrEqual(spec.min)
        expect(answer.value, `${scenario.id}: ${id}`).toBeLessThanOrEqual(spec.max)
      }
    }
  })

  it.skipIf(!hasRepos)('cites 101 guides that state the claims they back', () => {
    const guideText = (sources: SourceRef[]) =>
      sources.filter((s) => s.repo === 'system-design-101').map((s) => readFileSync(resolve(ROOT, REPO_DIRS['system-design-101'], s.path), 'utf8')).join('\n')
    const component = (id: string) => kb.components.find((c) => c.id === id)!.sources
    const question = (id: string) => kb.questions.find((q) => q.id === id)!
    const technology = (id: string) => kb.technologies.find((t) => t.id === id)!.sources
    const claims: [string, SourceRef[], RegExp][] = [
      ['warehouse', component('warehouse'), /Columnar databases/],
      ['data.analytics', question('data.analytics').sources, /Columnar databases/],
      ['snowflake', technology('snowflake'), /Columnar databases/],
      ['functions', component('functions'), /runs functions in response to events/],
      ['infra.compute', question('infra.compute').sources, /runs functions in response to events/],
      ['lambda', technology('lambda'), /runs functions in response to events/],
      ['serverless-sustained', kb.validations.find((v) => v.id === 'serverless-sustained')!.sources, /not cost-effective/],
      ['peer-region', component('peer-region'), /active-active/],
      ['reliability.multi_region', question('reliability.multi_region').sources, /active-active/],
      ['llm-api', component('llm-api'), /RAG/],
      ['ml.serving rag', question('ml.serving').sources, /RAG/],
      ['ml.serving batch', question('ml.serving').sources, /every night/],
      ['arch.style', question('arch.style').sources, /only 9 on-premise web servers/],
    ]
    for (const [id, sources, claim] of claims) expect(guideText(sources), id).toMatch(claim)
    expect(question('arch.style').help).toContain('9 on-premise web servers')
  })

  it.skipIf(!hasRepos)('cites every architecture section of the main README and the primer, and every primer solution', () => {
    const cited = allSources()
    const covered = (repo: SourceRef['repo'], line: number) =>
      cited.some((s) => s.repo === repo && s.path === 'README.md' && s.lines && line >= Number(s.lines.split('-')[0]) && line <= Number(s.lines.split('-')[1]))
    const headings = (dir: string, re: RegExp, from: number, to: number) =>
      readFileSync(resolve(ROOT, dir, 'README.md'), 'utf8')
        .split('\n')
        .map((text, i) => ({ text, line: i + 1 }))
        .filter((h) => re.test(h.text) && h.line >= from && h.line <= to && !/Source\(s\)/.test(h.text))
    const mainMissing = headings('system-design-main', /^# /, 100, 3600).filter((h) => !covered('system-design-main', h.line))
    const primerMissing = headings('system-design-primer-master', /^## |^### /, 412, 1647).filter((h) => !covered('system-design-primer', h.line))
    expect(mainMissing.map((h) => h.text)).toEqual([])
    expect(primerMissing.map((h) => h.text)).toEqual([])
    const solutions = ['mint', 'pastebin', 'query_cache', 'sales_rank', 'scaling_aws', 'social_graph', 'twitter', 'web_crawler']
    for (const name of solutions) expect(cited.some((s) => s.path.includes(`/${name}/`)), name).toBe(true)
  })

  it.skipIf(!hasRepos)('indexes every system-design-101 guide', () => {
    const files = readdirSync(resolve(ROOT, 'system-design-101-main/data/guides')).filter((f) => f.endsWith('.md'))
    expect(kb.guides!.map((g) => `${g.id}.md`).sort()).toEqual(files.sort())
    const cited = new Set(allSources().filter((s) => s.repo === 'system-design-101').map((s) => s.path))
    for (const g of kb.guides!) expect(g.usedBy.length > 0, g.id).toBe(cited.has(g.source.path))
  })

  it('cites the Netflix nightly precompute for the batch job, not for refresh-ahead', () => {
    // The guide files the nightly home pages under EVCache as a primary store that a batch job writes.
    const netflix = 'data/guides/4-ways-netflix-uses-caching-to-hold-user-attention.md'
    const refresh = kb.questions.find((q) => q.id === 'perf.cache')!.options!.find((o) => o.id === 'refresh_ahead')!
    expect((refresh.sources ?? []).map((s) => s.path)).not.toContain(netflix)
    expect(refresh.score!.map((s) => s.reason).join(' ')).not.toMatch(/Netflix|precompute/)
    expect(kb.components.find((c) => c.id === 'ml-batch')!.sources.map((s) => s.path)).toContain(netflix)
  })

  it('justifies the 10:1 read/write option with a ten-to-one reason', () => {
    const balanced = kb.questions.find((q) => q.id === 'traffic.read_write')!.options!.find((o) => o.id === 'balanced')!
    expect(balanced.sets?.['traffic.readRatio']).toBe(10)
    expect(balanced.score!.map((s) => s.reason).join(' ')).toMatch(/ten times/)
  })

  it('cites a general source as general practice, linked when its path is a URL, and a repository source by file and lines', () => {
    expect(cite(S.generalFabric)).toBe(`General practice: ${S.generalFabric.title}`)
    expect(sourceUrl(S.generalFabric)).toBe('https://learn.microsoft.com/fabric/')
    expect(cite(S.generalEgress)).not.toMatch(/^general\//)
    expect(sourceUrl(S.generalEgress)).toBeUndefined()
    expect(cite(S.backOfEnvelope)).toBe(`system-design-primer/solutions/system_design/scaling_aws/README.md:49-61 (${S.backOfEnvelope.title})`)
    expect(sourceUrl(S.backOfEnvelope)).toBeUndefined()
  })
})
