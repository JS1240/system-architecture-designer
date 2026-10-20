// Builds a machine-readable index of every system-design-101 guide (title, category, tags) and the knowledge-base
// entries that cite it. It keeps no guide text: the guides are CC BY-NC-ND. Run with: npm run kb:guides
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { GuideEntry } from '../src/domain/types'
import { kbCore } from '../src/knowledge/core'

const root = resolve(import.meta.dirname, '../..')
const guidesDir = resolve(root, 'system-design-101-main/data/guides')

const RELEVANCE: Record<string, GuideEntry['relevance']> = {
  'api-web-development': 'high',
  'cloud-distributed-systems': 'high',
  'database-and-storage': 'high',
  security: 'high',
  'real-world-case-studies': 'high',
  'caching-performance': 'high',
  'devops-cicd': 'high',
  'software-architecture': 'high',
  'payment-and-fintech': 'high',
  'how-it-works': 'medium',
  'computer-fundamentals': 'medium',
  'ai-machine-learning': 'low',
  'software-development': 'low',
  'devtools-productivity': 'low',
  'technical-interviews': 'low',
}

function frontmatter(text: string) {
  const block = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
  const scalar = (key: string) => block.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1].trim().replace(/^['"]|['"]$/g, '') ?? ''
  const list = (key: string) => {
    const m = block.match(new RegExp(`^${key}:\\n((?:\\s+- .*\\n?)*)`, 'm'))
    return m ? m[1].split('\n').map((l) => l.replace(/^\s+- /, '').trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : []
  }
  return { title: scalar('title'), categories: list('categories'), tags: list('tags') }
}

const citedBy = (file: string) => {
  const path = `data/guides/${file}.md`
  const hits: string[] = []
  const add = (kind: string, id: string, sources: { path: string }[] | undefined) => sources?.some((s) => s.path === path) && hits.push(`${kind}:${id}`)
  for (const q of kbCore.questions) {
    add('question', q.id, q.sources)
    for (const o of q.options ?? []) add('option', `${q.id}.${o.id}`, o.sources)
  }
  for (const c of kbCore.components) add('component', c.id, c.sources)
  for (const v of kbCore.validations) add('validation', v.id, v.sources)
  for (const t of kbCore.technologies) add('technology', t.id, t.sources)
  for (const p of kbCore.patterns) add('pattern', p.id, p.sources)
  for (const o of kbCore.services) add('offer', `${o.component}:${o.provider}:${o.name}`, o.sources)
  return hits
}

const entries: GuideEntry[] = readdirSync(guidesDir)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => {
    const id = f.replace(/\.md$/, '')
    const fm = frontmatter(readFileSync(resolve(guidesDir, f), 'utf8'))
    const category = fm.categories[0] ?? 'uncategorized'
    return {
      id,
      title: fm.title,
      category,
      tags: fm.tags,
      relevance: RELEVANCE[category] ?? 'low',
      usedBy: citedBy(id),
      source: { repo: 'system-design-101', path: `data/guides/${f}`, title: fm.title },
    }
  })

writeFileSync(resolve(import.meta.dirname, '../src/knowledge/guides.generated.json'), JSON.stringify(entries, null, 1) + '\n')
const high = entries.filter((e) => e.relevance === 'high')
console.log(`Indexed ${entries.length} guides; high relevance ${high.length}; ${entries.filter((e) => e.usedBy.length).length} used by KB entries`)
