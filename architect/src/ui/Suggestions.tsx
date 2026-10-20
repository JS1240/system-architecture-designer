import type { ReactNode } from 'react'
import type { Answers } from '../domain/types'
import { suggestionKey, suggestionValues, unmappedTerms } from '../engine/explore'
import { kb } from '../knowledge'

const questionOf = (id: string) => kb.questions.find((q) => q.id === id)

/** Detected answers as toggle chips grouped by question; `actions` adds buttons to each group. */
export function SuggestionChips({
  suggestions,
  off,
  setOff,
  actions,
  dimmed,
}: {
  suggestions: Answers
  /** Chip keys toggled off (suggestionKey). */
  off: ReadonlySet<string>
  setOff: (off: ReadonlySet<string>) => void
  actions?: (questionId: string) => ReactNode
  dimmed?: (questionId: string) => boolean
}) {
  return (
    <div className="suggestion-groups">
      {Object.entries(suggestions).map(([id, a]) => {
        const q = questionOf(id)
        return (
          <div key={id} className={`suggestion-group ${dimmed?.(id) ? 'dimmed' : ''}`}>
            <span className="faint">{q?.title ?? id}</span>
            {suggestionValues(a).map((v) => {
              const key = suggestionKey(id, v)
              return (
                <button key={key} type="button" className={`chip-btn ${off.has(key) ? '' : 'active'}`} aria-pressed={!off.has(key)} onClick={() => setOff(off.has(key) ? new Set([...off].filter((k) => k !== key)) : new Set([...off, key]))}>
                  {q?.options?.find((o) => o.id === v)?.label ?? v}
                </button>
              )
            })}
            {actions?.(id)}
          </div>
        )
      })}
    </div>
  )
}

export function UnmappedTerms({ description }: { description: string }) {
  const terms = unmappedTerms(kb, description)
  if (terms.length === 0) return null
  return <p className="faint">Not mapped yet: {terms.join(', ')}. No question covers them, so they set nothing.</p>
}
