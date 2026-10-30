// Scrollable transcript container with "stick to bottom" auto-scroll.
//
// Deliberately dependency-free (no `use-stick-to-bottom`, unlike the reference implementation's
// port): a plain scroll container plus a MutationObserver on its content is
// enough for this surface, and keeps this package's dependency footprint
// aligned with the rest of `apps/web` (shadcn + hand-rolled, not a grab-bag
// of chat-widget libraries).
import { ArrowDown } from 'lucide-react'
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const NEAR_BOTTOM_PX = 64

interface ConversationCtx {
  isAtBottom: boolean
  scrollToBottom: (behavior?: ScrollBehavior) => void
}

const ConversationContext = createContext<ConversationCtx | null>(null)

function useConversationContext(): ConversationCtx {
  const ctx = useContext(ConversationContext)
  if (!ctx) throw new Error('Conversation components must be used within <Conversation>')
  return ctx
}

export function Conversation({ className, children, ...props }: ComponentProps<'div'>) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const stickyRef = useRef(true)

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let rafId = 0
    const onScroll = () => {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
        stickyRef.current = atBottom
        setIsAtBottom((prev) => (prev === atBottom ? prev : atBottom))
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [])

  // Streamed tokens append DOM nodes many times per frame; batch to one
  // (instant, non-animated) scroll per frame so the resulting `scroll`
  // events can't re-trigger this observer mid-animation and runaway.
  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    let rafId = 0
    const observer = new MutationObserver(() => {
      if (!stickyRef.current || rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        scrollToBottom('auto')
      })
    })
    observer.observe(content, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [scrollToBottom])

  return (
    <ConversationContext.Provider value={{ isAtBottom, scrollToBottom }}>
      <div
        ref={scrollRef}
        role="log"
        className={cn('relative flex-1 overflow-y-auto overflow-x-hidden', className)}
        {...props}
      >
        <div ref={contentRef}>{children}</div>
      </div>
    </ConversationContext.Provider>
  )
}

export function ConversationContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-6 p-4', className)} {...props} />
}

export function ConversationScrollButton({ className }: { className?: string }): ReactNode {
  const { isAtBottom, scrollToBottom } = useConversationContext()
  if (isAtBottom) return null
  return (
    <Button
      type="button"
      size="icon"
      variant="outline"
      onClick={() => scrollToBottom()}
      className={cn(
        'absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-background shadow-md',
        className,
      )}
    >
      <ArrowDown className="h-4 w-4" />
    </Button>
  )
}
