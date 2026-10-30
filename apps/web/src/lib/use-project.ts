import { useSyncExternalStore } from 'react'
import { trpc } from '@/lib/trpc'

const STORAGE_KEY = 'ckrm_ui_project_id'
const CHANGE_EVENT = 'ckrm:project-changed'

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

function getStored(): string | null {
  return typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null
}

/**
 * Persist the active project id and notify subscribers so dependent queries
 * re-read the new selection and refetch.
 */
export function setProjectId(id: string): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, id)
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

/**
 * Resolve the active project id. Prefers a persisted selection in localStorage,
 * otherwise falls back to the first project returned by `projects.list`.
 * Returns `undefined` until at least one project is known so callers can gate
 * queries with `{ enabled: !!projectId }`.
 *
 * Subscribes to `ckrm:project-changed` and `storage` events so a selection
 * change (from `setProjectId`) triggers a re-render and re-read.
 */
export function useProjectId(): string | undefined {
  const { data } = trpc.projects.list.useQuery()

  const stored = useSyncExternalStore(subscribe, getStored, () => null)

  if (stored && data?.some((p) => p.id === stored)) return stored
  return data?.[0]?.id
}
