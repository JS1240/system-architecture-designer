import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { ComponentInstance, ComponentShape } from '../domain/types'
import { TIER_COLOR, type Vec3 } from './layout'
import { PALETTE, utilizationColor } from './palette'

interface BuildingProps {
  instance: ComponentInstance
  position: Vec3
  leaving: boolean
  selected: boolean
  dimmed: boolean
  hovered: boolean
  onSelect: (id: string) => void
  onHover: (id: string | null) => void
}

const MAX_VISIBLE_REPLICAS = 9

function replicaOffsets(count: number, spacing: number): Vec3[] {
  const n = Math.min(count, MAX_VISIBLE_REPLICAS)
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  return Array.from({ length: n }, (_, i) => {
    const c = i % cols
    const r = Math.floor(i / cols)
    return [(c - (cols - 1) / 2) * spacing, 0, (r - (rows - 1) / 2) * spacing]
  })
}

function Mat({ color, emissive = 0.15, opacity = 1 }: { color: string; emissive?: number; opacity?: number }) {
  return (
    <meshStandardMaterial
      color={color}
      emissive={color}
      emissiveIntensity={emissive}
      metalness={0.35}
      roughness={0.45}
      transparent={opacity < 1}
      opacity={opacity}
    />
  )
}

/** Animated detail that makes a building read as its role (spinning balancer, sliding queue items). */
function Spinner({ radius, color, speed = 1 }: { radius: number; color: string; speed?: number }) {
  const ref = useRef<THREE.Mesh>(null)
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.z += dt * speed
  })
  return (
    <mesh ref={ref} rotation={[Math.PI / 2, 0, 0]}>
      <torusGeometry args={[radius, 0.06, 8, 32]} />
      <Mat color={color} emissive={1.2} />
    </mesh>
  )
}

function Conveyor({ length, color, lanes = 1 }: { length: number; color: string; lanes?: number }) {
  const group = useRef<THREE.Group>(null)
  const items = 5
  useFrame(({ clock }) => {
    group.current?.children.forEach((child, i) => {
      const lane = Math.floor(i / items)
      const t = (clock.elapsedTime * 0.35 + (i % items) / items + lane * 0.13) % 1
      child.position.x = (t - 0.5) * length
    })
  })
  return (
    <group ref={group}>
      {Array.from({ length: items * lanes }, (_, i) => (
        <mesh key={i} position={[0, 0.42, (Math.floor(i / items) - (lanes - 1) / 2) * 0.55]}>
          <boxGeometry args={[0.28, 0.22, 0.28]} />
          <Mat color={color} emissive={1.4} />
        </mesh>
      ))}
    </group>
  )
}

function ShapeModel({ shape, color, replicas, utilization }: { shape: ComponentShape; color: string; replicas: number; utilization: number }) {
  const height = 1.2 + Math.min(2.4, Math.log10(replicas + 1) * 1.6)
  switch (shape) {
    case 'client':
      return (
        <group>
          <mesh position={[-0.7, 0.45, 0]} castShadow>
            <boxGeometry args={[0.5, 0.9, 0.08]} />
            <Mat color={color} emissive={0.4} />
          </mesh>
          <mesh position={[0.4, 0.35, 0]} rotation={[-0.25, 0, 0]} castShadow>
            <boxGeometry args={[1.3, 0.8, 0.06]} />
            <Mat color={color} emissive={0.4} />
          </mesh>
          <mesh position={[0.4, 0.03, 0.35]} castShadow>
            <boxGeometry args={[1.3, 0.05, 0.7]} />
            <Mat color={PALETTE.base} />
          </mesh>
        </group>
      )
    case 'globe':
      return (
        <group position={[0, 1.2, 0]}>
          <mesh castShadow>
            <icosahedronGeometry args={[0.9, 1]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35} wireframe />
          </mesh>
          <mesh>
            <sphereGeometry args={[0.75, 24, 24]} />
            <Mat color={PALETTE.screen} opacity={0.85} />
          </mesh>
          <Spinner radius={1.15} color={color} speed={0.6} />
        </group>
      )
    case 'shield':
      return (
        <group>
          <mesh position={[0, 0.5, 0]} castShadow>
            <cylinderGeometry args={[1.1, 1.2, 1, 6]} />
            <Mat color={color} emissive={0.3} />
          </mesh>
          <mesh position={[0, 1.02, 0]}>
            <cylinderGeometry args={[0.9, 0.9, 0.05, 6]} />
            <Mat color={color} emissive={1.5} />
          </mesh>
        </group>
      )
    case 'balancer':
      return (
        <group>
          <mesh position={[0, 0.35, 0]} castShadow>
            <cylinderGeometry args={[1.2, 1.3, 0.7, 32]} />
            <Mat color={color} emissive={0.25} />
          </mesh>
          <group position={[0, 0.85, 0]}>
            <Spinner radius={0.8} color={color} speed={2} />
          </group>
        </group>
      )
    case 'gateway':
      return (
        <group>
          {[-0.85, 0.85].map((x) => (
            <mesh key={x} position={[x, 0.9, 0]} castShadow>
              <boxGeometry args={[0.45, 1.8, 0.9]} />
              <Mat color={color} emissive={0.25} />
            </mesh>
          ))}
          <mesh position={[0, 1.95, 0]} castShadow>
            <boxGeometry args={[2.3, 0.35, 1]} />
            <Mat color={color} emissive={0.5} />
          </mesh>
          <mesh position={[0, 0.9, 0]}>
            <planeGeometry args={[1.2, 1.6]} />
            <meshBasicMaterial color={color} transparent opacity={0.25} side={THREE.DoubleSide} />
          </mesh>
        </group>
      )
    case 'tower':
    case 'worker': {
      const offsets = replicaOffsets(replicas, 0.85)
      const w = shape === 'tower' ? 0.6 : 0.55
      const h = shape === 'tower' ? height : height * 0.6
      return (
        <group>
          {offsets.map((o, i) => (
            <group key={i} position={o}>
              <mesh position={[0, h / 2, 0]} castShadow>
                <boxGeometry args={[w, h, w]} />
                <Mat color={color} emissive={0.2} />
              </mesh>
              <mesh position={[0, h * 0.75, w / 2 + 0.01]}>
                <planeGeometry args={[w * 0.7, h * 0.08]} />
                <meshBasicMaterial color={utilizationColor(utilization)} />
              </mesh>
            </group>
          ))}
          {shape === 'worker' && (
            <group position={[0, h + 0.4, 0]}>
              <Spinner radius={0.45} color={color} speed={3} />
            </group>
          )}
        </group>
      )
    }
    case 'queue':
      return (
        <group>
          <mesh position={[0, 0.15, 0]} castShadow>
            <boxGeometry args={[3, 0.3, 0.9]} />
            <Mat color={PALETTE.base} />
          </mesh>
          <mesh position={[0, 0.31, 0]}>
            <boxGeometry args={[3, 0.02, 0.7]} />
            <Mat color={color} emissive={0.6} />
          </mesh>
          <Conveyor length={2.8} color={color} />
        </group>
      )
    case 'stream': {
      const lanes = Math.min(4, Math.max(2, replicas))
      return (
        <group>
          <mesh position={[0, 0.15, 0]} castShadow>
            <boxGeometry args={[3.2, 0.3, lanes * 0.55 + 0.3]} />
            <Mat color={PALETTE.base} />
          </mesh>
          <Conveyor length={3} color={color} lanes={lanes} />
        </group>
      )
    }
    case 'cache': {
      const offsets = replicaOffsets(replicas, 0.9)
      return (
        <group>
          {offsets.map((o, i) => (
            <mesh key={i} position={[o[0], 0.35, o[2]]} castShadow>
              <cylinderGeometry args={[0.38, 0.38, 0.7, 24]} />
              <Mat color={color} emissive={0.9} />
            </mesh>
          ))}
        </group>
      )
    }
    case 'database': {
      const offsets = replicaOffsets(replicas, 1.0)
      return (
        <group>
          {offsets.map((o, i) => (
            <group key={i} position={o}>
              {[0, 1, 2].map((d) => (
                <mesh key={d} position={[0, 0.25 + d * 0.42, 0]} castShadow>
                  <cylinderGeometry args={[0.42, 0.42, 0.34, 28]} />
                  <Mat color={color} emissive={0.25 + d * 0.1} />
                </mesh>
              ))}
            </group>
          ))}
        </group>
      )
    }
    case 'storage':
      return (
        <group>
          <mesh position={[0, 0.5, 0]} castShadow>
            <boxGeometry args={[2.4, 1, 1.6]} />
            <Mat color={color} emissive={0.2} />
          </mesh>
          {[-0.8, -0.4, 0, 0.4, 0.8].map((x) => (
            <mesh key={x} position={[x, 1.03, 0]}>
              <boxGeometry args={[0.18, 0.06, 1.4]} />
              <Mat color={color} emissive={1} />
            </mesh>
          ))}
        </group>
      )
    case 'search': {
      const offsets = replicaOffsets(replicas, 1)
      return (
        <group>
          {offsets.map((o, i) => (
            <mesh key={i} position={[o[0], 0.5, o[2]]} castShadow>
              <cylinderGeometry args={[0.35, 0.45, 1, 6]} />
              <Mat color={color} emissive={0.3} />
            </mesh>
          ))}
          <group position={[0, 1.5, 0]}>
            <Spinner radius={0.5} color={color} speed={1.5} />
          </group>
        </group>
      )
    }
    case 'warehouse':
      return (
        <group>
          <mesh position={[0, 0.7, 0]} castShadow>
            <boxGeometry args={[2.6, 1.4, 1.8]} />
            <Mat color={color} emissive={0.15} />
          </mesh>
          <mesh position={[0, 1.6, 0]} rotation={[0, 0, Math.PI / 4]} castShadow>
            <boxGeometry args={[0.9, 0.9, 1.8]} />
            <Mat color={color} emissive={0.35} />
          </mesh>
        </group>
      )
    case 'external':
      return (
        <group position={[0, 1.3, 0]}>
          <mesh castShadow>
            <octahedronGeometry args={[0.75, 0]} />
            <Mat color={color} emissive={0.5} opacity={0.75} />
          </mesh>
          <Spinner radius={1} color={color} speed={-0.8} />
        </group>
      )
    case 'monitor':
      return (
        <group>
          <mesh position={[0, 0.5, 0]}>
            <boxGeometry args={[0.15, 1, 0.15]} />
            <Mat color={PALETTE.stand} />
          </mesh>
          <mesh position={[0, 1.35, 0]} castShadow>
            <boxGeometry args={[1.8, 1, 0.1]} />
            <Mat color={PALETTE.screen} />
          </mesh>
          <mesh position={[0, 1.35, 0.06]}>
            <planeGeometry args={[1.6, 0.8]} />
            <meshBasicMaterial color={color} transparent opacity={0.55} />
          </mesh>
        </group>
      )
    case 'region':
      return (
        <group>
          <mesh position={[0, 0.08, 0]}>
            <boxGeometry args={[3, 0.16, 2.4]} />
            <Mat color={color} opacity={0.35} />
          </mesh>
          {[-0.8, 0, 0.8].map((x, i) => (
            <mesh key={x} position={[x, 0.5 + i * 0.15, 0]} castShadow>
              <boxGeometry args={[0.5, 0.8 + i * 0.3, 0.5]} />
              <Mat color={color} emissive={0.3} opacity={0.6} />
            </mesh>
          ))}
        </group>
      )
  }
}

export function Building({ instance, position, leaving, selected, dimmed, hovered, onSelect, onHover }: BuildingProps) {
  const group = useRef<THREE.Group>(null)
  const ring = useRef<THREE.Mesh>(null)
  const target = useMemo(() => new THREE.Vector3(...position), [position])
  const color = TIER_COLOR[instance.def.tier]
  const overloaded = instance.utilization > 0.9

  useFrame((state, dt) => {
    const g = group.current
    if (!g) return
    const goal = leaving ? 0.001 : 1
    const s = THREE.MathUtils.damp(g.scale.x, goal, leaving ? 8 : 5, dt)
    g.scale.setScalar(s)
    g.position.lerp(target, 1 - Math.exp(-6 * dt))
    g.position.y = selected ? Math.sin(state.clock.elapsedTime * 2) * 0.08 + 0.1 : THREE.MathUtils.damp(g.position.y, 0, 6, dt)
    if (ring.current) {
      const pulse = overloaded ? 1 + Math.sin(state.clock.elapsedTime * 6) * 0.08 : 1
      ring.current.scale.setScalar(pulse)
    }
  })

  return (
    <group
      ref={group}
      scale={0.001}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(instance.def.id)
      }}
      onPointerOver={(e) => {
        e.stopPropagation()
        onHover(instance.def.id)
      }}
      onPointerOut={() => onHover(null)}
    >
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[1.85, 40]} />
        <meshStandardMaterial color={selected ? color : PALETTE.pad} emissive={color} emissiveIntensity={selected ? 0.35 : hovered ? 0.18 : 0.05} transparent opacity={dimmed ? 0.35 : 0.9} />
      </mesh>
      <mesh ref={ring} position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.85, 2, 48, 1, 0, Math.PI * 2 * Math.min(1, Math.max(0.04, instance.utilization))]} />
        <meshBasicMaterial color={instance.utilization > 0 ? utilizationColor(instance.utilization) : color} transparent opacity={dimmed ? 0.2 : 0.9} />
      </mesh>
      <group visible={!dimmed || hovered}>
        <ShapeModel shape={instance.def.shape} color={color} replicas={instance.replicas} utilization={instance.utilization} />
      </group>
      {dimmed && !hovered && (
        <group scale={[1, 1, 1]}>
          <ShapeModel shape={instance.def.shape} color={PALETTE.stand} replicas={instance.replicas} utilization={0} />
        </group>
      )}
    </group>
  )
}
