import { MessageSquarePlus, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { ThreadList } from './ThreadList'
import type { Conversation, RenameControls } from './ThreadListItem'

interface ThreadSidebarProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  conversations: Conversation[]
  isLoading: boolean
  selectedId: string | null
  onSelect: (id: string) => void
  onNewChat: () => void
  creating: boolean
  rename: RenameControls
  onDelete: (id: string) => void
}

function ThreadListPanel(props: Omit<ThreadSidebarProps, 'open' | 'onOpenChange'>) {
  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">Conversations</span>
        </div>
        <Button size="sm" variant="outline" onClick={props.onNewChat} disabled={props.creating}>
          <MessageSquarePlus className="h-3.5 w-3.5" />
          New chat
        </Button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-2 py-3">
        <p className="px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Recent
        </p>
        <ThreadList
          conversations={props.conversations}
          isLoading={props.isLoading}
          selectedId={props.selectedId}
          rename={props.rename}
          onSelect={props.onSelect}
          onDelete={props.onDelete}
        />
      </div>
    </div>
  )
}

/**
 * Collapsible thread rail. Below `md` it is a `Sheet` overlay (repo
 * responsiveness rule: mobile off-canvas panels go through
 * `components/ui/sheet.tsx`, never a hand-rolled fixed-width drawer); at
 * `md`+ it's an in-flow column that collapses to zero-width when closed.
 */
export function ThreadSidebar(props: ThreadSidebarProps) {
  const { open, onOpenChange } = props
  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="left" className="w-72 p-0 md:hidden">
          <SheetTitle className="sr-only">Conversations</SheetTitle>
          <ThreadListPanel {...props} />
        </SheetContent>
      </Sheet>

      <div
        className={cn(
          'hidden shrink-0 overflow-hidden border-r border-border bg-muted/20 transition-all duration-200 ease-in-out md:block',
          open ? 'w-64' : 'w-0 border-r-0',
        )}
      >
        <div className="h-full w-64">
          <ThreadListPanel {...props} />
        </div>
      </div>
    </>
  )
}
