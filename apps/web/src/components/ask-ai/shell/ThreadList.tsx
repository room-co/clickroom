import { SkeletonList } from '@/components/skeletons'
import { type Conversation, type RenameControls, ThreadListItem } from './ThreadListItem'

interface ThreadListProps {
  conversations: Conversation[]
  isLoading: boolean
  selectedId: string | null
  rename: RenameControls
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}

export function ThreadList({
  conversations,
  isLoading,
  selectedId,
  rename,
  onSelect,
  onDelete,
}: ThreadListProps) {
  if (isLoading && conversations.length === 0) {
    return <SkeletonList rows={5} className="px-2 py-1" />
  }
  if (conversations.length === 0) {
    return <p className="px-2 text-xs text-muted-foreground">No conversations yet.</p>
  }
  return (
    <ul className="space-y-0.5">
      {conversations.map((conv) => (
        <li key={conv.id}>
          <ThreadListItem
            conv={conv}
            selected={selectedId === conv.id}
            rename={rename}
            onSelect={onSelect}
            onDelete={onDelete}
          />
        </li>
      ))}
    </ul>
  )
}
