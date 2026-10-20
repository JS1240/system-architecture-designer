export function downloadText(filename: string, text: string, type = 'text/plain') {
  downloadUrl(filename, URL.createObjectURL(new Blob([text], { type })))
}

export function downloadUrl(filename: string, url: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'architecture'

/** The 3D view as a PNG: the WebGL frame with the HTML label layer (names, technologies, replica counts, tiers) drawn where it shows. */
export function sceneSnapshot(canvas: HTMLCanvasElement): string {
  const out = document.createElement('canvas')
  out.width = canvas.width
  out.height = canvas.height
  const ctx = out.getContext('2d')
  if (!ctx) return canvas.toDataURL('image/png')
  ctx.drawImage(canvas, 0, 0)
  const frame = canvas.getBoundingClientRect()
  const scale = canvas.width / Math.max(1, frame.width)
  // Image coordinates of a box on screen.
  const box = (r: DOMRect) => ({ x: (r.left - frame.left) * scale, y: (r.top - frame.top) * scale, w: r.width * scale, h: r.height * scale })
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const label of canvas.closest('.scene-root')?.querySelectorAll<HTMLElement>('.label-layer > *') ?? []) {
    const style = getComputedStyle(label)
    if (style.display === 'none') continue
    const outer = label.getBoundingClientRect()
    // The projector scales each label with its distance (a CSS transform), which the computed font size does not include.
    const zoom = label.offsetWidth > 0 ? outer.width / label.offsetWidth : 1
    ctx.globalAlpha = Number(style.opacity) || 1
    const b = box(outer)
    if (style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
      ctx.fillStyle = style.backgroundColor
      ctx.fillRect(b.x, b.y, b.w, b.h)
    }
    for (const part of label.children.length > 0 ? [...label.children] : [label]) {
      const ps = getComputedStyle(part)
      const p = box(part.getBoundingClientRect())
      const text = ps.textTransform === 'uppercase' ? (part.textContent ?? '').toUpperCase() : (part.textContent ?? '')
      ctx.font = `${ps.fontWeight} ${parseFloat(ps.fontSize) * zoom * scale}px ${ps.fontFamily}`
      ctx.fillStyle = ps.color
      ctx.fillText(text, p.x + p.w / 2, p.y + p.h / 2)
    }
  }
  ctx.globalAlpha = 1
  return out.toDataURL('image/png')
}
