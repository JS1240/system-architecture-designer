import { Grid, OrbitControls } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { Architecture, ComponentInstance, Tier } from '../domain/types'
import { Building } from './Building'
import { Flow } from './Flow'
import { declutterLabels, type LabelBox } from './labels'
import { layoutComponents, sceneExtent, TIER_COLOR, TIER_LABEL, TIER_Z, type Vec3 } from './layout'
import { PALETTE } from './palette'

interface SceneProps {
  architecture: Architecture
  selected: string | null
  onSelect: (id: string | null) => void
  /** Increment to trigger a camera reset. */
  resetSignal: number
}

interface Leaving {
  instance: ComponentInstance
  position: Vec3
}

interface Anchor {
  id: string
  position: Vec3
}

const EXIT_MS = 700

/** Components removed by the last change, kept briefly so they can shrink out. */
function useLeavingComponents(components: ComponentInstance[]): Leaving[] {
  const [previous, setPrevious] = useState(components)
  const [leaving, setLeaving] = useState<Leaving[]>([])
  if (previous !== components) {
    // Adjusting state while rendering (React docs pattern) avoids an extra effect pass.
    const current = new Set(components.map((c) => c.def.id))
    const oldPositions = layoutComponents(previous)
    const removed = previous.filter((c) => !current.has(c.def.id)).map((instance) => ({ instance, position: oldPositions.get(instance.def.id)! }))
    setLeaving((l) => [...l.filter((r) => !current.has(r.instance.def.id)), ...removed])
    setPrevious(components)
  }
  useEffect(() => {
    if (leaving.length === 0) return
    const timer = setTimeout(() => setLeaving([]), EXIT_MS)
    return () => clearTimeout(timer)
  }, [leaving])
  return leaving
}

const projected = new THREE.Vector3()

interface Measured {
  text: string
  width: number
  height: number
  nameWidth: number
  nameHeight: number
}

/** A label's unscaled size in full and without its technology line; measured in full, so a compact label is opened up for the read. */
function measure(el: HTMLElement): Omit<Measured, 'text'> {
  el.classList.remove('label-compact')
  const name = el.firstElementChild as HTMLElement | null
  const tech = el.lastElementChild as HTMLElement | null
  const nameWidth = name?.offsetWidth ?? el.offsetWidth
  const techWidth = tech && tech !== name ? tech.offsetWidth : 0
  const techHeight = tech && tech !== name ? tech.offsetHeight : 0
  return { width: el.offsetWidth, height: el.offsetHeight, nameWidth: el.offsetWidth - Math.max(nameWidth, techWidth) + nameWidth, nameHeight: el.offsetHeight - techHeight }
}

/** Positions DOM labels over their 3D anchors every frame, without a React render; labels that collide drop their tech line or move up (declutterLabels). */
function LabelProjector({ anchors, elements, pinned }: { anchors: Anchor[]; elements: React.RefObject<Map<string, HTMLElement>>; pinned: ReadonlySet<string> }) {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  // Unscaled label sizes, measured again only when the text changes, so the frame loop does not force a layout per label.
  const measured = useRef(new WeakMap<HTMLElement, Measured>())
  useFrame(() => {
    const shown: { id: string; el: HTMLElement; x: number; y: number; scale: number }[] = []
    const boxes: LabelBox[] = []
    for (const a of anchors) {
      const el = elements.current.get(a.id)
      if (!el) continue
      projected.set(a.position[0], a.position[1], a.position[2])
      const distance = camera.position.distanceTo(projected)
      projected.project(camera)
      const visible = projected.z < 1 && Math.abs(projected.x) < 1.2 && Math.abs(projected.y) < 1.2
      el.style.display = visible ? '' : 'none'
      if (!visible) continue
      const x = ((projected.x + 1) / 2) * size.width
      const y = ((1 - projected.y) / 2) * size.height
      const scale = THREE.MathUtils.clamp(26 / distance, 0.45, 1.25)
      shown.push({ id: a.id, el, x, y, scale })
      if (a.id.startsWith('tier:')) continue
      const text = el.textContent ?? ''
      let m = measured.current.get(el)
      if (!m || m.text !== text || m.width === 0) {
        m = { text, ...measure(el) }
        measured.current.set(el, m)
      }
      // The label is scaled about its bottom centre (app.css), which sits on the anchor.
      boxes.push({ id: a.id, x, y, width: m.width * scale, height: m.height * scale, nameWidth: m.nameWidth * scale, nameHeight: m.nameHeight * scale, depth: distance, pinned: pinned.has(a.id) })
    }
    const placement = declutterLabels(boxes)
    for (const { id, el, x, y, scale } of shown) {
      const p = placement.get(id)
      el.classList.toggle('label-compact', !!p?.compact)
      el.classList.toggle('label-raised', pinned.has(id))
      el.style.transform = `translate(-50%, -100%) translate(${x}px, ${y + (p?.dy ?? 0)}px) scale(${scale})`
    }
  })
  return null
}

function CameraRig({ focus, extent, resetSignal }: { focus: Vec3 | null; extent: { width: number; depth: number; center: Vec3 }; resetSignal: number }) {
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null
  const camera = useThree((s) => s.camera)
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height))
  const goal = useRef<{ target: THREE.Vector3; position: THREE.Vector3 | null }>({ target: new THREE.Vector3(), position: null })

  useEffect(() => {
    // Portrait viewports see less width, so pull back in proportion.
    // A deeper scene (the existing-systems row behind the data tier) pulls back and recentres, so the back row clears the HUD.
    const distance = Math.max(34, extent.width * 1.3, extent.depth * 1.15) / Math.min(1, aspect * 0.85)
    const targetZ = extent.center[2] - 1.5
    goal.current = {
      target: new THREE.Vector3(extent.center[0], 0, targetZ),
      position: new THREE.Vector3(extent.center[0], distance * 0.78, targetZ + 1 + distance * 0.82),
    }
  }, [extent.width, extent.depth, extent.center, resetSignal, aspect])

  useEffect(() => {
    if (!focus) return
    const target = new THREE.Vector3(focus[0], 0.5, focus[2])
    const offset = camera.position.clone().sub(controls?.target ?? new THREE.Vector3()).setLength(18)
    goal.current = { target, position: target.clone().add(offset) }
  }, [focus, camera, controls])

  useFrame((_, dt) => {
    if (!controls) return
    const k = 1 - Math.exp(-3 * dt)
    controls.target.lerp(goal.current.target, k)
    if (goal.current.position) {
      camera.position.lerp(goal.current.position, k)
      if (camera.position.distanceTo(goal.current.position) < 0.05) goal.current.position = null
    }
    controls.update()
  })
  return null
}

function TierDistricts({ tiers, width }: { tiers: Tier[]; width: number }) {
  const span = Math.max(width + 5, 14)
  return (
    <group>
      {tiers
        .filter((t): t is Exclude<Tier, 'ops'> => t !== 'ops')
        .map((tier) => (
          <group key={tier} position={[0, 0, TIER_Z[tier]]}>
            <mesh position={[0, -0.05, 0]} receiveShadow>
              <boxGeometry args={[span, 0.1, 4.6]} />
              <meshStandardMaterial color={TIER_COLOR[tier]} transparent opacity={0.06} emissive={TIER_COLOR[tier]} emissiveIntensity={0.08} />
            </mesh>
            <mesh position={[-span / 2, 0.01, 0]}>
              <boxGeometry args={[0.12, 0.02, 4.6]} />
              <meshBasicMaterial color={TIER_COLOR[tier]} toneMapped={false} />
            </mesh>
          </group>
        ))}
    </group>
  )
}

export function ArchitectureScene({ architecture, selected, onSelect, resetSignal }: SceneProps) {
  const [hovered, setHovered] = useState<string | null>(null)
  const leaving = useLeavingComponents(architecture.components)
  const positions = useMemo(() => layoutComponents(architecture.components), [architecture.components])
  const extent = useMemo(() => sceneExtent(positions), [positions])
  const labelElements = useRef(new Map<string, HTMLElement>())
  const labelRef = (id: string) => (el: HTMLElement | null) => {
    if (el) labelElements.current.set(id, el)
    else labelElements.current.delete(id)
  }

  const focusId = selected
  const neighbors = useMemo(() => {
    const id = focusId ?? hovered
    if (!id) return null
    const set = new Set([id])
    for (const e of architecture.edges) {
      if (e.from === id) set.add(e.to)
      if (e.to === id) set.add(e.from)
    }
    return set
  }, [focusId, hovered, architecture.edges])

  const pinned = useMemo(() => new Set([selected, hovered].filter((id): id is string => !!id)), [selected, hovered])
  const tiers = useMemo(() => [...new Set(architecture.components.map((c) => c.def.tier))], [architecture.components])
  const focus = focusId ? (positions.get(focusId) ?? null) : null
  const span = Math.max(extent.width + 5, 14)
  const anchors = useMemo<Anchor[]>(
    () => [
      ...architecture.components.map((c) => {
        const p = positions.get(c.def.id)!
        return { id: c.def.id, position: [p[0], 3.4, p[2]] as Vec3 }
      }),
      ...tiers.filter((t): t is Exclude<Tier, 'ops'> => t !== 'ops').map((t) => ({ id: `tier:${t}`, position: [-span / 2 - 0.6, 0.6, TIER_Z[t]] as Vec3 })),
    ],
    [architecture.components, positions, tiers, span],
  )

  return (
    <div className="scene-root" role="img" aria-label="3D architecture diagram. Component details are in the inspector and the generated documentation.">
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ position: [0, 30, 34], fov: 42, near: 0.5, far: 400 }}
      gl={{ preserveDrawingBuffer: true, antialias: true }}
      onPointerMissed={() => onSelect(null)}
      style={{ cursor: hovered ? 'pointer' : 'grab' }}
    >
      <color attach="background" args={[PALETTE.ground]} />
      <fog attach="fog" args={[PALETTE.ground, 60, 140]} />
      <ambientLight intensity={0.35} />
      <hemisphereLight args={[PALETTE.sky, PALETTE.ground, 0.45]} />
      <directionalLight position={[18, 30, 14]} intensity={1.4} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-45} shadow-camera-right={45} shadow-camera-top={45} shadow-camera-bottom={-45} />
      <pointLight position={[-20, 10, -20]} intensity={60} color={PALETTE.accentLight} distance={80} />

      <Grid position={[0, -0.11, 0]} args={[200, 200]} cellSize={1} cellThickness={0.5} cellColor={PALETTE.grid} sectionSize={5} sectionThickness={1} sectionColor={PALETTE.gridSection} fadeDistance={110} fadeStrength={1.5} infiniteGrid />
      <TierDistricts tiers={tiers} width={extent.width} />

      {architecture.edges.map((edge) => {
        const from = positions.get(edge.from)
        const to = positions.get(edge.to)
        if (!from || !to) return null
        const highlighted = !!neighbors && neighbors.has(edge.from) && neighbors.has(edge.to) && (edge.from === (focusId ?? hovered) || edge.to === (focusId ?? hovered))
        return <Flow key={edge.id} edge={edge} from={from} to={to} highlighted={highlighted} dimmed={!!neighbors && !highlighted} />
      })}

      {architecture.components.map((instance) => {
        const id = instance.def.id
        return (
          <Building
            key={id}
            instance={instance}
            position={positions.get(id)!}
            leaving={false}
            selected={selected === id}
            hovered={hovered === id}
            dimmed={!!neighbors && !neighbors.has(id)}
            onSelect={onSelect}
            onHover={setHovered}
          />
        )
      })}
      {leaving.map(({ instance, position }) => (
        <Building key={instance.def.id} instance={instance} position={position} leaving selected={false} hovered={false} dimmed={false} onSelect={onSelect} onHover={setHovered} />
      ))}

      <LabelProjector anchors={anchors} elements={labelElements} pinned={pinned} />

      <OrbitControls makeDefault enableDamping dampingFactor={0.08} maxPolarAngle={Math.PI / 2.15} minDistance={8} maxDistance={140} screenSpacePanning={false} />
      <CameraRig focus={focus} extent={extent} resetSignal={resetSignal} />
      <EffectComposer multisampling={0}>
        <Bloom luminanceThreshold={0.55} luminanceSmoothing={0.3} intensity={0.9} mipmapBlur />
        <Vignette offset={0.25} darkness={0.6} />
      </EffectComposer>
    </Canvas>
      <div className="label-layer" aria-hidden="true">
        {architecture.components.map((c) => {
          const id = c.def.id
          const dimmed = !!neighbors && !neighbors.has(id)
          return (
            <div key={id} ref={labelRef(id)} className={`label ${selected === id ? 'label-selected' : ''} ${dimmed ? 'label-dimmed' : ''}`}>
              <span className="label-name">
                {c.def.label}
                {c.replicas > 1 && <b> x{c.replicas}</b>}
              </span>
              <span className="label-tech">{c.tech}</span>
            </div>
          )
        })}
        {tiers
          .filter((t) => t !== 'ops')
          .map((t) => (
            <div key={t} ref={labelRef(`tier:${t}`)} className="tier-label" style={{ color: TIER_COLOR[t] }}>
              {TIER_LABEL[t]}
            </div>
          ))}
      </div>
    </div>
  )
}
