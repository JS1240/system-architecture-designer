import { describe, expect, it } from 'vitest'
import { declutterLabels, type LabelBox } from './labels'

const box = (id: string, x: number, y: number, depth: number, pinned = false): LabelBox => ({ id, x, y, width: 150, height: 40, nameWidth: 120, nameHeight: 20, depth, pinned })

describe('scene labels', () => {
  it('keeps apart labels full and lets the nearer of two overlapping labels win', () => {
    const apart = declutterLabels([box('a', 0, 100, 10), box('b', 400, 100, 12)])
    expect([...apart.values()]).toEqual([{ compact: false, dy: 0 }, { compact: false, dy: 0 }])
    // 'Primary database' and 'Read replicas' on one row (the Oracle migration view): the farther label drops its tech line and moves above.
    const crowded = declutterLabels([box('replicas', 80, 256, 30), box('primary', 0, 256, 20)])
    expect(crowded.get('primary')).toEqual({ compact: false, dy: 0 })
    const moved = crowded.get('replicas')!
    expect(moved.compact).toBe(true)
    // Its name now ends where the primary's box starts, so the two no longer overlap.
    expect(256 + moved.dy).toBeLessThanOrEqual(256 - 40)
  })

  it('shows the selected or hovered label in full even when it is farther', () => {
    const placed = declutterLabels([box('near', 0, 100, 5), box('picked', 20, 100, 50, true)])
    expect(placed.get('picked')).toEqual({ compact: false, dy: 0 })
    expect(placed.get('near')!.compact).toBe(true)
  })
})
