/** A component label projected on screen: anchored at its bottom centre (x, y), in pixels after scaling. */
export interface LabelBox {
  id: string
  x: number
  y: number
  width: number
  height: number
  /** Size of the label without its technology line, still anchored at its bottom centre. */
  nameWidth: number
  nameHeight: number
  /** Distance to the camera; nearer labels win a collision. */
  depth: number
  /** The selected or hovered label: always shown in full, first. */
  pinned?: boolean
}

export interface LabelPlacement {
  /** Hide the technology line. */
  compact: boolean
  /** Upward nudge in pixels (negative is up). */
  dy: number
}

interface Rect {
  left: number
  right: number
  top: number
  bottom: number
}

const MAX_NUDGES = 6
const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/**
 * Keeps labels readable where components stand close together: pinned and nearer labels keep their full box; a label that collides drops its
 * technology line, and if its name still collides it moves up above the label in the way.
 */
export function declutterLabels(boxes: LabelBox[]): Map<string, LabelPlacement> {
  const placed: Rect[] = []
  const out = new Map<string, LabelPlacement>()
  const order = [...boxes].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.depth - b.depth)
  for (const box of order) {
    const full: Rect = { left: box.x - box.width / 2, right: box.x + box.width / 2, top: box.y - box.height, bottom: box.y }
    if (box.pinned || !placed.some((r) => overlaps(r, full))) {
      placed.push(full)
      out.set(box.id, { compact: false, dy: 0 })
      continue
    }
    // Without the technology line the label shrinks to its name, still standing on the anchor.
    const name: Rect = { left: box.x - box.nameWidth / 2, right: box.x + box.nameWidth / 2, top: box.y - box.nameHeight, bottom: box.y }
    let dy = 0
    for (let i = 0; i < MAX_NUDGES; i++) {
      const shifted = { ...name, top: name.top + dy, bottom: name.bottom + dy }
      const hit = placed.find((r) => overlaps(r, shifted))
      if (!hit) break
      dy += hit.top - shifted.bottom
    }
    placed.push({ ...name, top: name.top + dy, bottom: name.bottom + dy })
    out.set(box.id, { compact: true, dy })
  }
  return out
}
