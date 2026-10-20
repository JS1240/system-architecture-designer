import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { Project } from '../domain/types'
import { activeSuggestions, newSuggestions, pickSuggestions, suggestFromDescription } from '../engine/explore'
import { kb } from '../knowledge'
import { type Panel, useProjects } from '../store/projectStore'
import { CostPanel } from './CostPanel'
import { DocsPanel } from './DocsPanel'
import { ExplorePanel } from './ExplorePanel'
import { ChangeToast, Hud, Inspector, Legend, WhatIfBanner } from './Overlays'
import { isTypingTarget } from './input'
import { Sidebar } from './Sidebar'
import { SuggestionChips, UnmappedTerms } from './Suggestions'
import { targetView, useEvaluation } from './useEvaluation'

const ArchitectureScene = lazy(() => import('../scene/ArchitectureScene').then((m) => ({ default: m.ArchitectureScene })))

const PANEL_TITLE = { explore: 'Explore alternatives and versions', docs: 'Generated documentation', cost: 'Cost breakdown' } as const
const PANEL_LABEL = { explore: 'Explore and versions', docs: 'Documentation', cost: 'Cost' } as const
type Phase = 'transition' | 'target'

/** Edits the name and description; re-detected answers that differ from the current ones preview as a what-if before they apply. */
function Brief({ project, onClose }: { project: Project; onClose: () => void }) {
  const renameProject = useProjects((s) => s.renameProject)
  const setDescription = useProjects((s) => s.setDescription)
  const applySuggestions = useProjects((s) => s.applySuggestions)
  // Detections dismissed on the Welcome page start toggled off.
  const [off, setOff] = useState<ReadonlySet<string>>(() => new Set(project.dismissed ?? []))
  // Only values the answers lack: Apply adds them to a multi-choice and keeps what is already chosen there.
  const fresh = useMemo(() => newSuggestions(kb, project.answers, suggestFromDescription(kb, project.description)), [project.description, project.answers])
  const picked = useMemo(() => pickSuggestions(kb, fresh, off), [fresh, off])
  const n = Object.keys(picked).length
  // Apply sets every picked answer, but only those of active questions change the design now.
  const relevant = useMemo(() => activeSuggestions(kb, project.answers, picked).length, [project.answers, picked])
  return (
    <div className="popover brief" role="dialog" aria-label="Project brief">
      <label className="field">
        <span>Name</span>
        <input className="input" value={project.name} onChange={(e) => renameProject(e.target.value)} />
      </label>
      <label className="field">
        <span>Description</span>
        <textarea className="textarea" value={project.description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {Object.keys(fresh).length > 0 ? (
        <>
          <span className="faint">Detected in the description and not in your answers yet; Apply adds them (multi-choice answers keep what you chose). Untick any you do not want.</span>
          <SuggestionChips suggestions={fresh} off={off} setOff={setOff} />
        </>
      ) : (
        <p className="faint">The description suggests nothing your answers do not already say.</p>
      )}
      <UnmappedTerms description={project.description} />
      <div className="row">
        <button
          className="btn btn-primary"
          disabled={n === 0}
          title="Preview the change as a what-if, then apply or discard it"
          onClick={() => {
            applySuggestions(picked)
            onClose()
          }}
        >
          Apply {relevant}
          {n > relevant && ` (+${n - relevant} when relevant)`}
        </button>
        <button className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}

export function Workspace() {
  const { project, base, current, preview } = useEvaluation()
  const closeProject = useProjects((s) => s.closeProject)
  const renameProject = useProjects((s) => s.renameProject)
  const selected = useProjects((s) => s.selectedComponent)
  const select = useProjects((s) => s.select)
  const undo = useProjects((s) => s.undo)
  const redo = useProjects((s) => s.redo)
  const undoLabel = useProjects((s) => (s.activeId ? s.history[s.activeId]?.past.at(-1)?.label : undefined))
  const redoLabel = useProjects((s) => (s.activeId ? s.history[s.activeId]?.future.at(-1)?.label : undefined))
  const panel = useProjects((s) => s.panel)
  const setPanel = useProjects((s) => s.setPanel)
  const [briefOpen, setBriefOpen] = useState(false)
  // The Explore section to scroll to, e.g. the provider comparison opened from its question card.
  const [focus, setFocus] = useState<string | null>(null)
  const toggle = (p: Exclude<Panel, null>) => {
    setFocus(null)
    setPanel(panel === p ? null : p)
  }
  // An opened panel takes the focus at its heading, and gives it back to the control that opened it when it closes.
  const panelHeading = useRef<HTMLHeadingElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!panel) {
      opener.current?.focus()
      opener.current = null
      return
    }
    // Switching panels keeps the first opener.
    if (!opener.current) opener.current = document.activeElement as HTMLElement | null
    panelHeading.current?.focus()
  }, [panel])
  const [resetSignal, setResetSignal] = useState(0)
  const [phase, setPhase] = useState<Phase>('transition')
  const migrating = !!current?.architecture.components.some((c) => c.phase === 'transition')
  const shown = useMemo(() => (current && phase === 'target' ? targetView(current) : current), [current, phase])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLInputElement | null
      // Text fields keep their own undo; sliders, buttons and checkboxes do not have one.
      const typing = isTypingTarget(target)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      // Escape in a field (a unit price being typed, an open select) cancels that field, not the whole panel.
      if (e.key === 'Escape' && !typing && target?.tagName !== 'SELECT') {
        if (briefOpen) setBriefOpen(false)
        else if (panel) setPanel(null)
        else select(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel, briefOpen, select, undo, redo, setPanel])

  if (!project || !base || !current || !shown) return null
  const inspecting = shown.architecture.components.some((c) => c.def.id === selected)

  return (
    <div className={`workspace ${panel ? 'has-panel' : ''} ${inspecting ? 'has-inspector' : ''}`}>
      <header className="topbar">
        <button className="btn btn-ghost" onClick={closeProject} aria-label="Back to projects">
          Projects
        </button>
        <input className="title-input" value={project.name} onChange={(e) => renameProject(e.target.value)} aria-label="Project name" />
        <span className="brief-anchor">
          <button className={`btn ${briefOpen ? 'btn-primary' : 'btn-ghost'}`} aria-expanded={briefOpen} onClick={() => setBriefOpen((o) => !o)}>
            Brief
          </button>
          {briefOpen && <Brief project={project} onClose={() => setBriefOpen(false)} />}
        </span>
        <span className="faint saved">Saved locally</span>
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={undo} disabled={!undoLabel} title={undoLabel ? `Undo ${undoLabel} (Cmd/Ctrl+Z)` : 'Nothing to undo'} aria-label={undoLabel ? `Undo ${undoLabel}` : 'Undo'}>
          Undo
        </button>
        <button className="btn btn-ghost" onClick={redo} disabled={!redoLabel} title={redoLabel ? `Redo ${redoLabel} (Shift+Cmd/Ctrl+Z)` : 'Nothing to redo'} aria-label={redoLabel ? `Redo ${redoLabel}` : 'Redo'}>
          Redo
        </button>
        {(['cost', 'explore', 'docs'] as const).map((p) => (
          <button key={p} className={`btn ${panel === p ? 'btn-primary' : ''}`} onClick={() => toggle(p)}>
            {PANEL_LABEL[p]}
          </button>
        ))}
      </header>

      <div className="main">
        <Sidebar
          evaluation={base}
          onOpenDocs={() => setPanel('docs')}
          onCompare={(questionId) => {
            setFocus(`compare-${questionId}`)
            setPanel('explore')
          }}
        />
        <div className="stage">
          <Suspense fallback={<div className="stage-loading">Loading 3D view</div>}>
            <ArchitectureScene architecture={shown.architecture} selected={selected} onSelect={select} resetSignal={resetSignal} />
          </Suspense>
          <Hud evaluation={shown} onOpenCost={() => toggle('cost')} />
          {/* An open panel covers the stage centre, so the preview's Apply and Discard move into the panel. */}
          {preview && !panel && <WhatIfBanner base={base} preview={preview} />}
          {/* An open panel covers the stage, so the summary of what its Apply changed shows inside the panel. */}
          {!panel && <ChangeToast evaluation={base} hidden={!!preview} />}
          <Inspector evaluation={shown} />
          <div className="stage-tools">
            <Legend />
            {migrating && (
              <div role="group" aria-label="Migration phase shown in the scene">
                {(['transition', 'target'] as const).map((p) => (
                  <button key={p} className={`btn ${phase === p ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={phase === p} onClick={() => setPhase(p)}>
                    {p === 'transition' ? 'Transition' : 'Target'}
                  </button>
                ))}
              </div>
            )}
            <button className="btn btn-ghost" onClick={() => setResetSignal((n) => n + 1)}>
              Reset camera
            </button>
          </div>
          {panel && (
            <div className="panel" role="dialog" aria-label={PANEL_LABEL[panel]}>
              <header className="panel-head">
                <h2 ref={panelHeading} tabIndex={-1}>
                  {PANEL_TITLE[panel]}
                </h2>
                <button className="btn btn-ghost" onClick={() => setPanel(null)}>
                  Close
                </button>
              </header>
              {preview && <WhatIfBanner base={base} preview={preview} />}
              <ChangeToast evaluation={base} hidden={!!preview} />
              {panel === 'docs' && <DocsPanel project={project} evaluation={base} />}
              {panel === 'explore' && <ExplorePanel base={base} focus={focus} />}
              {panel === 'cost' && <CostPanel base={base} />}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
