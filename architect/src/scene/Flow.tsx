import { Line } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { EdgeInstance } from '../domain/types'
import { particleCount, PROTOCOL_COLOR, type Vec3 } from './layout'

const SPEED: Record<EdgeInstance['protocol'], number> = {
  http: 0.55,
  grpc: 0.7,
  ws: 0.4,
  async: 0.25,
  replication: 0.3,
  query: 0.6,
  cdc: 0.25,
  telemetry: 0.15,
  dns: 0.5,
}

const DASHED = new Set<EdgeInstance['protocol']>(['async', 'replication', 'cdc', 'telemetry', 'dns'])

interface FlowProps {
  edge: EdgeInstance
  from: Vec3
  to: Vec3
  highlighted: boolean
  dimmed: boolean
}

export function Flow({ edge, from, to, highlighted, dimmed }: FlowProps) {
  const color = PROTOCOL_COLOR[edge.protocol]
  const curve = useMemo(() => {
    const a = new THREE.Vector3(from[0], 0.6, from[2])
    const b = new THREE.Vector3(to[0], 0.6, to[2])
    const lift = 1.2 + a.distanceTo(b) * 0.12
    const mid = a.clone().lerp(b, 0.5).setY(lift)
    return new THREE.QuadraticBezierCurve3(a, mid, b)
  }, [from, to])
  const points = useMemo(() => curve.getPoints(32), [curve])
  const count = particleCount(edge.qps)
  const particles = useRef<THREE.Group>(null)
  const speed = SPEED[edge.protocol] * (highlighted ? 1.6 : 1)

  useFrame(({ clock }) => {
    particles.current?.children.forEach((p, i) => {
      const t = (clock.elapsedTime * speed + i / count) % 1
      p.position.copy(curve.getPoint(t))
    })
  })

  return (
    <group>
      <Line
        points={points}
        color={color}
        lineWidth={highlighted ? 2.6 : 1.2}
        transparent
        opacity={dimmed ? 0.08 : highlighted ? 0.95 : 0.4}
        dashed={DASHED.has(edge.protocol)}
        dashSize={0.4}
        gapSize={0.25}
      />
      {!dimmed && (
        <group ref={particles}>
          {Array.from({ length: count }, (_, i) => (
            <mesh key={i}>
              <sphereGeometry args={[highlighted ? 0.16 : 0.11, 10, 10]} />
              <meshBasicMaterial color={color} toneMapped={false} />
            </mesh>
          ))}
        </group>
      )}
    </group>
  )
}
