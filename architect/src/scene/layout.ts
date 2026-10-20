import type { ComponentInstance, Protocol, Tier } from '../domain/types'
import { PALETTE } from './palette'

export type Vec3 = [number, number, number]

export const TIER_Z: Record<Exclude<Tier, 'ops'>, number> = {
  client: 15,
  edge: 9.5,
  ingress: 4,
  compute: -2,
  async: -8,
  data: -14,
  // The existing systems sit behind the new data tier, where their data leaves from.
  legacy: -20,
}

export const TIER_LABEL: Record<Tier, string> = {
  client: 'Clients',
  edge: 'Edge',
  ingress: 'Ingress',
  compute: 'Compute',
  async: 'Async',
  data: 'Data',
  ops: 'Operations',
  legacy: 'Existing systems',
}

// ds-allow-hardcode: WebGL tier and protocol colors; legend chips reuse these values.
export const TIER_COLOR: Record<Tier, string> = {
  client: '#5eead4',
  edge: '#60a5fa',
  ingress: '#a78bfa',
  compute: '#38bdf8',
  async: '#fbbf24',
  data: '#f472b6',
  ops: '#94a3b8',
  legacy: PALETTE.legacy,
}

export const PROTOCOL_COLOR: Record<Protocol, string> = {
  http: '#38bdf8',
  grpc: '#22d3ee',
  ws: '#34d399',
  async: '#fbbf24',
  replication: '#c084fc',
  query: '#f472b6',
  cdc: '#fb923c',
  telemetry: '#64748b',
  dns: '#93c5fd',
}

export const PROTOCOL_LABEL: Record<Protocol, string> = {
  http: 'HTTP request',
  grpc: 'gRPC',
  ws: 'Persistent connection',
  async: 'Async message',
  replication: 'Replication',
  query: 'Data query',
  cdc: 'Change data capture',
  telemetry: 'Telemetry / control',
  dns: 'DNS',
}

const SPACING = 4.6

/** Deterministic positions: one row per tier, ops in a column on the right. */
export function layoutComponents(components: ComponentInstance[]): Map<string, Vec3> {
  const positions = new Map<string, Vec3>()
  const rows = new Map<Tier, ComponentInstance[]>()
  for (const c of components) rows.set(c.def.tier, [...(rows.get(c.def.tier) ?? []), c])
  let widest = 0
  for (const [tier, members] of rows) {
    if (tier === 'ops') continue
    widest = Math.max(widest, members.length)
    members.forEach((c, i) => positions.set(c.def.id, [(i - (members.length - 1) / 2) * SPACING, 0, TIER_Z[tier]]))
  }
  const opsX = (Math.max(widest, 3) / 2) * SPACING + 4
  ;(rows.get('ops') ?? []).forEach((c, i) => positions.set(c.def.id, [opsX + (i % 2) * 4, 0, TIER_Z.ingress - Math.floor(i / 2) * 5]))
  return positions
}

export function sceneExtent(positions: Map<string, Vec3>): { width: number; depth: number; center: Vec3 } {
  const xs = [...positions.values()].map((p) => p[0])
  const zs = [...positions.values()].map((p) => p[2])
  if (xs.length === 0) return { width: 20, depth: 0, center: [0, 0, 0] }
  const min = Math.min(...xs)
  const max = Math.max(...xs)
  return { width: max - min, depth: Math.max(...zs) - Math.min(...zs), center: [(min + max) / 2, 0, (Math.min(...zs) + Math.max(...zs)) / 2] }
}

/** Particle count grows with log10 of requests per second so 10 and 100k req/s stay readable. */
export function particleCount(qps: number): number {
  if (qps <= 0) return 1
  return Math.max(1, Math.min(8, Math.round(Math.log10(qps + 1) * 1.6)))
}
