import { beforeAll, describe, expect, it } from 'vitest'

// The store persists to window.localStorage and listens on window, so both exist before it loads.
const saved = new Map<string, string>()
const tab = Object.assign(new EventTarget(), {
  localStorage: { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) },
})
let store: typeof import('./projectStore')
const KEY = 'sad-projects-v1'
const storedProjects = () => Object.keys(JSON.parse(saved.get(KEY)!).state.projects).sort()
// Another tab writes the whole map; the browser tells this tab with a storage event.
const otherTabWrites = async (projects: Record<string, unknown>, activeId: string) => {
  saved.set(KEY, JSON.stringify({ ...JSON.parse(saved.get(KEY)!), state: { projects, activeId } }))
  tab.dispatchEvent(Object.assign(new Event('storage'), { key: KEY }))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('several tabs', () => {
  beforeAll(async () => {
    Object.assign(globalThis, { window: tab })
    store = await import('./projectStore')
  })

  it('reloads projects another tab saved, so the next save keeps them, and keeps its own open project', async () => {
    const { blankProject, useProjects } = store
    const mine = useProjects.getState().createProject('Mine', '')
    const theirs = blankProject('Theirs', '')
    await otherTabWrites({ ...JSON.parse(saved.get(KEY)!).state.projects, [theirs.id]: theirs }, theirs.id)
    expect(useProjects.getState().activeId).toBe(mine)
    useProjects.getState().setAnswer('infra.cloud', { kind: 'value', value: 'aws' })
    expect(storedProjects()).toEqual([mine, theirs.id].sort())
    // Once the other tab deletes the open project, this tab closes it.
    await otherTabWrites({ [theirs.id]: theirs }, theirs.id)
    expect(useProjects.getState().activeId).toBeNull()
    expect(Object.keys(useProjects.getState().projects)).toEqual([theirs.id])
  })
})
