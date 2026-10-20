import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { kbFull as kb } from '../src/knowledge/full'

const out = resolve(import.meta.dirname, '../../docs/knowledge/kb.json')
mkdirSync(resolve(out, '..'), { recursive: true })
writeFileSync(out, JSON.stringify(kb, null, 2) + '\n')
console.log(`Wrote ${out}: ${kb.questions.length} questions, ${kb.components.length} components, ${kb.edges.length} edges, ${kb.validations.length} rules, ${kb.guides!.length} guides`)
