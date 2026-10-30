// Conversation list + selection + CRUD + rename state for the Ask AI page.
// Keeps `AskAIPage.tsx` a thin gating + layout shell. Wraps the `ai.*` tRPC
// procedures (`apps/api/src/trpc/routers/ai.router.ts`), which are project +
// user scoped and return the full (unpaginated) recent list — unlike
// the reference implementation's incident-scoped equivalent there is no `page`/`pageSize` here.
import { useEffect, useState } from 'react'
import { trpc } from '@/lib/trpc'
import type { RenameControls } from './shell/ThreadListItem'

export function useAskAIConversations(projectId: string | undefined, available: boolean) {
  const utils = trpc.useUtils()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const listQuery = trpc.ai.listConversations.useQuery(
    { projectId: projectId ?? '' },
    { enabled: available && !!projectId },
  )
  const conversations = listQuery.data ?? []

  // Reset selection when the project changes so a stale id from another
  // project's thread list never leaks across a project switch. `projectId`
  // is deliberately the only dependency even though it isn't read in the
  // body — the effect's whole purpose is to fire on that transition.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — see comment above
  useEffect(() => {
    setSelectedId(null)
  }, [projectId])

  useEffect(() => {
    const first = conversations[0]
    if (!selectedId && first) setSelectedId(first.id)
  }, [selectedId, conversations])

  const createMutation = trpc.ai.createConversation.useMutation({
    onSuccess: (conv) => {
      utils.ai.listConversations.invalidate()
      setSelectedId(conv.id)
    },
  })
  const renameMutation = trpc.ai.renameConversation.useMutation({
    onSuccess: () => {
      utils.ai.listConversations.invalidate()
      setRenamingId(null)
    },
  })
  const deleteMutation = trpc.ai.deleteConversation.useMutation({
    onSuccess: (_data, vars) => {
      utils.ai.listConversations.invalidate()
      setSelectedId((current) => (current === vars.id ? null : current))
    },
  })

  const rename: RenameControls = {
    renamingId,
    value: renameValue,
    onChange: setRenameValue,
    onSubmit: () => {
      if (!renamingId || !projectId) return
      const title = renameValue.trim()
      if (title) renameMutation.mutate({ projectId, id: renamingId, title })
      else setRenamingId(null)
    },
    onCancel: () => setRenamingId(null),
    onStart: (id, current) => {
      setRenamingId(id)
      setRenameValue(current ?? '')
    },
  }

  return {
    conversations,
    isLoading: listQuery.isLoading,
    selectedId,
    setSelectedId,
    createConversation: (title?: string) => {
      if (!projectId) return
      createMutation.mutate({ projectId, title })
    },
    creating: createMutation.isPending,
    deleteConversation: (id: string) => {
      if (!projectId) return
      deleteMutation.mutate({ projectId, id })
    },
    rename,
  }
}
