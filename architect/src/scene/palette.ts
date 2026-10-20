// ds-allow-hardcode: WebGL materials need literal colors; this file is the single source for scene colors and mirrors the CSS tokens in index.css.
export const PALETTE = {
  ok: '#34d399',
  warn: '#fbbf24',
  danger: '#f87171',
  pad: '#0f1a2e',
  base: '#1e293b',
  screen: '#0f172a',
  stand: '#334155',
  ground: '#070b14',
  grid: '#1e3a5f',
  gridSection: '#2563eb',
  sky: '#93c5fd',
  accentLight: '#7c3aed',
  // Muted amber for the existing systems a migration moves away from.
  legacy: '#b4935a',
}

export function utilizationColor(u: number): string {
  if (u > 0.9) return PALETTE.danger
  if (u > 0.7) return PALETTE.warn
  return PALETTE.ok
}
