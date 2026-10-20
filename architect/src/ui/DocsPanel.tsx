import { useMemo, useState } from 'react'
import type { Evaluation, Project } from '../domain/types'
import { bomCsv, generateMarkdown, mermaidDiagram, providerCostCsv } from '../docs/generate'
import { renderSafe } from '../docs/render'
import { compareOver } from '../engine/explore'
import { kb } from '../knowledge'
import { downloadText, downloadUrl, sceneSnapshot, slug } from './download'
import { useKnowledge } from './useEvaluation'

type View = 'spec' | 'mermaid'

export function DocsPanel({ project, evaluation }: { project: Project; evaluation: Evaluation }) {
  const [view, setView] = useState<View>('spec')
  const knowledge = useKnowledge(project.overrides)
  // One design per provider, shared by the spec (provider map, cloud ADR) and the cost per provider CSV.
  const providers = useMemo(() => compareOver(knowledge, project.answers, 'infra.cloud', evaluation), [knowledge, project.answers, evaluation])
  const markdown = useMemo(() => generateMarkdown(project, evaluation, kb, providers), [project, evaluation, providers])
  const html = useMemo(() => renderSafe(markdown), [markdown])
  const mermaid = useMemo(() => mermaidDiagram(evaluation), [evaluation])
  const name = slug(project.name)
  const providerCosts = () => downloadText(`${name}-cost-per-provider.csv`, providerCostCsv(providers), 'text/csv')

  const screenshot = () => {
    const canvas = document.querySelector('canvas')
    if (canvas) downloadUrl(`${name}-3d.png`, sceneSnapshot(canvas))
  }

  return (
    <div className="panel-body">
      <div className="row wrap">
        <div className="presets" role="tablist">
          <button role="tab" aria-selected={view === 'spec'} className={`chip-btn ${view === 'spec' ? 'active' : ''}`} onClick={() => setView('spec')}>
            Specification + ADRs
          </button>
          <button role="tab" aria-selected={view === 'mermaid'} className={`chip-btn ${view === 'mermaid' ? 'active' : ''}`} onClick={() => setView('mermaid')}>
            Diagram source
          </button>
        </div>
        <span className="spacer" />
        <button className="btn" onClick={() => downloadText(`${name}-architecture.md`, markdown, 'text/markdown')}>Download Markdown</button>
        <button className="btn" onClick={() => downloadText(`${name}.mmd`, mermaid)}>Download Mermaid</button>
        <button className="btn" onClick={() => downloadText(`${name}-bill-of-materials.csv`, bomCsv(evaluation), 'text/csv')}>Bill of materials (CSV)</button>
        <button className="btn" onClick={providerCosts}>Cost per provider (CSV)</button>
        <button className="btn" onClick={screenshot}>Save 3D snapshot</button>
        <button className="btn" onClick={() => downloadText(`${name}.project.json`, JSON.stringify(project, null, 2), 'application/json')}>Export project JSON</button>
      </div>
      {view === 'spec' ? <article className="markdown" tabIndex={0} aria-label="Generated specification" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="code" tabIndex={0}>{mermaid}</pre>}
    </div>
  )
}
