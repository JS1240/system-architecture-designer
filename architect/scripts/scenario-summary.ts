// Prints a compact summary of every scenario design (all recommendations accepted) for review, with its cost on each provider.
import { evaluate } from '../src/engine/evaluate'
import { autoComplete, compareOver } from '../src/engine/explore'
import { providerLine, summaryLines } from '../src/docs/summary'
import { kb } from '../src/knowledge'

for (const s of kb.scenarios) {
  const e = evaluate(kb, autoComplete(kb, s.answers))
  console.log(`## ${s.id}`)
  for (const line of summaryLines(e)) console.log(line)
  console.log(`${providerLine(compareOver(kb, s.answers, 'infra.cloud', e))}\n`)
}
