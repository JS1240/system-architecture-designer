import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { costLines } from '../docs/generate'
import { fmt, fmtUnits, unitMoney } from '../engine/architecture'
import { evaluate } from '../engine/evaluate'
import { autoComplete, diffEvaluations, runAndPeople } from '../engine/explore'
import { kb } from '../knowledge'
import { lineCost } from './costing'
import { Hud } from './Overlays'
import { targetView } from './useEvaluation'

const design = (id: string) => evaluate(kb, autoComplete(kb, kb.scenarios.find((s) => s.id === id)!.answers))

describe('overlays', () => {
  it('drops transition components and their flows from the Target view the Inspector reads', () => {
    const e = design('oracle-orders-to-aws')
    const target = targetView(e)
    expect(target.architecture.components.some((c) => c.phase === 'transition')).toBe(false)
    expect(target.architecture.edges.some((x) => x.from === 'legacy-db' || x.to === 'cdc-pipeline')).toBe(false)
    // The Inspector looks the selection up in the evaluation it gets, which Workspace now filters like the scene and HUD.
    expect(e.architecture.components.some((c) => c.def.id === 'cdc-pipeline')).toBe(true)
    expect(target.architecture.components.some((c) => c.def.id === 'cdc-pipeline')).toBe(false)
    expect(targetView(design('ecommerce'))).toEqual(design('ecommerce'))
  })

  it('shows the migration\'s copy time and cutover against the window in the HUD', () => {
    const e = design('oracle-orders-to-aws')
    const html = renderToStaticMarkup(createElement(Hud, { evaluation: e, onOpenCost: () => {} }))
    expect(html).toContain('Migration')
    expect(html).toContain(' copy')
    expect(html).toMatch(/cutover [0-9.]+ (min|h) vs [0-9.]+ (min|h) window/)
    expect(renderToStaticMarkup(createElement(Hud, { evaluation: design('ecommerce'), onOpenCost: () => {} }))).not.toContain('Migration')
  })

  it('shows only the one-off cost, with no coexistence or payback, when building on existing data', () => {
    const html = renderToStaticMarkup(createElement(Hud, { evaluation: design('crm-to-ai-insights'), onOpenCost: () => {} }))
    expect(html).toContain('One-off $')
    expect(html).not.toContain('payback')
    expect(renderToStaticMarkup(createElement(Hud, { evaluation: design('oracle-orders-to-aws'), onOpenCost: () => {} }))).toContain('payback')
  })

  it('keeps the HUD out of live regions, since previews rewrite it on every hover and its tiles are buttons', () => {
    const html = renderToStaticMarkup(createElement(Hud, { evaluation: design('ecommerce'), onOpenCost: () => {} }))
    expect(html).toContain('aria-label="Architecture metrics"')
    expect(html).not.toMatch(/role="status"|role="alert"|aria-live/)
  })

  it('shows the analytics data and its readers instead of request figures on a data platform', () => {
    const lake = design('onprem-iceberg-lakehouse')
    expect(lake.facts['profile.requestPath']).toBe(false)
    const html = renderToStaticMarkup(createElement(Hud, { evaluation: lake, onOpenCost: () => {} }))
    expect(html).not.toContain('req/s')
    expect(html).toContain('Analytics data')
    // 80 TB today with 50% growth: the lake a year ahead.
    expect(html).toContain('120.0 TB')
    expect(html).toContain('50% growth per year')
    expect(html).toContain('Report viewers')
    expect(renderToStaticMarkup(createElement(Hud, { evaluation: design('ecommerce'), onOpenCost: () => {} }))).toContain('req/s')
    // A warehouse migration counts the data it moves, not only data.history_tb.
    expect(renderToStaticMarkup(createElement(Hud, { evaluation: design('sqlserver-dw-to-fabric'), onOpenCost: () => {} }))).not.toContain('none yet')
    // A bought CRM has no data platform, so it gets no analytics tiles and no request tiles.
    const crm = renderToStaticMarkup(createElement(Hud, { evaluation: design('dynamics-crm-to-d365'), onOpenCost: () => {} }))
    for (const text of ['Analytics data', 'Report viewers', 'not set', 'req/s']) expect(crm, text).not.toContain(text)
  })

  it('prints the one-off cost once in the HUD cost tile', () => {
    for (const id of ['oracle-orders-to-aws', 'sqlserver-crm-to-azure', 'crm-to-ai-insights', 'dynamics-crm-to-d365']) {
      const e = design(id)
      expect(e.cost.oneTime, id).toBeGreaterThan(0)
      const html = renderToStaticMarkup(createElement(Hud, { evaluation: e, onOpenCost: () => {} }))
      expect(html.match(/one-off/gi), id).toHaveLength(1)
    }
  })

  it('lists one-off cost lines after the monthly ones and labels them once', () => {
    const lines = costLines(design('oracle-orders-to-aws'))
    const firstOneOff = lines.findIndex((l) => l.kind === 'one_time')
    expect(firstOneOff).toBeGreaterThan(0)
    expect(lines.slice(firstOneOff).every((l) => l.kind === 'one_time')).toBe(true)
    expect(lineCost({ kind: 'one_time', monthly: 75_000 })).toBe('$75.0k once')
    expect(lineCost({ kind: 'run', monthly: 1_200 })).toBe('$1.2k/mo')
  })

  it('headlines run plus people, so choosing on premises moves the HUD and the change toast the way the option chip says', () => {
    const answers = kb.scenarios.find((s) => s.id === 'fabric-bi-azure')!.answers
    const cloud = evaluate(kb, autoComplete(kb, answers))
    const onprem = evaluate(kb, autoComplete(kb, { ...answers, 'infra.cloud': { kind: 'value', value: 'onprem' } }))
    expect(onprem.cost.people).toBeGreaterThan(cloud.cost.people)
    const html = renderToStaticMarkup(createElement(Hud, { evaluation: onprem, onOpenCost: () => {} }))
    expect(html).toContain(`$${fmt(runAndPeople(onprem))}/mo`)
    expect(html).toContain(`Infrastructure $${fmt(onprem.monthlyCost)} + people $${fmt(onprem.cost.people)}`)
    // The budget is an infrastructure budget, so its share stays on the run cost and says so.
    if (typeof onprem.facts['infra.budgetUsd'] === 'number') expect(html).toContain('infrastructure ')
    expect(diffEvaluations(cloud, onprem).costDelta).toBeCloseTo(runAndPeople(onprem) - runAndPeople(cloud))
  })

  it('prints unit prices with two significant digits so units x price multiplies out', () => {
    expect([0.09, 0.06, 0.15, 0.023, 2, 9.5, 120].map(unitMoney)).toEqual(['$0.09', '$0.06', '$0.15', '$0.023', '$2', '$9.5', '$120'])
    expect([2, 2.5, 1_500].map(fmtUnits)).toEqual(['2', '2.5', '1.5k'])
  })
})
