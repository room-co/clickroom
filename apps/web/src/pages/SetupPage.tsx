import { KeyRound, Rocket } from 'lucide-react'
import { useMemo } from 'react'
import { Link } from 'react-router'
import { CodeBlock } from '@/components/CodeBlock'
import { PageHeader } from '@/components/PageHeader'
import { SkeletonCard } from '@/components/skeletons'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { setupGuides, WRITE_KEY_PLACEHOLDER } from '@/content/setup-guides'
import { trpc } from '@/lib/trpc'
import { useProjectId } from '@/lib/use-project'

export function SetupPage() {
  const projectId = useProjectId()
  const keysQuery = trpc.projects.keys.list.useQuery(
    { projectId: projectId as string },
    { enabled: !!projectId },
  )

  // An active (non-revoked) write key carries its real plaintext value in
  // `publicToken` (unlike read keys, which are hash-only) — see
  // apps/api/src/trpc/routers/projects.router.ts. Use the most recently
  // created one so the snippets below are copy-paste ready.
  const activeWriteKey = useMemo(() => {
    const keys = keysQuery.data ?? []
    const match = keys.find((k) => k.type === 'write' && !k.revokedAt && k.publicToken)
    return match?.publicToken ?? null
  }, [keysQuery.data])

  const writeKey = activeWriteKey ?? WRITE_KEY_PLACEHOLDER

  if (!projectId) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <PageHeader title="Setup" subtitle="No project selected" />
        <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
          <Rocket className="mb-3 h-8 w-8 text-muted-foreground/30" />
          <div className="text-sm font-medium text-muted-foreground">No project selected</div>
          <div className="mt-1 text-[11px] text-muted-foreground/60">
            Select a project to see its setup instructions.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader title="Setup" subtitle="Install an SDK and start sending events in minutes" />

      <div className="flex-1 overflow-auto p-4 md:p-6">
        {keysQuery.isPending && <SkeletonCard lines={2} className="mb-5 max-w-3xl" />}

        {!keysQuery.isPending && !activeWriteKey && (
          <div className="mb-5 flex flex-col items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2.5">
              <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div>
                <div className="text-xs font-medium text-foreground">No active write key yet</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  The snippets below use a placeholder. Create a write key to get a real,
                  copy-pasteable value.
                </div>
              </div>
            </div>
            <Link
              to="/api-keys"
              className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Create a write key
            </Link>
          </div>
        )}

        <Tabs defaultValue={setupGuides[0].id} className="w-full max-w-3xl">
          <TabsList className="w-full sm:w-fit">
            {setupGuides.map((guide) => (
              <TabsTrigger key={guide.id} value={guide.id}>
                {guide.label}
              </TabsTrigger>
            ))}
          </TabsList>

          {setupGuides.map((guide) => (
            <TabsContent key={guide.id} value={guide.id} className="space-y-4">
              <p className="text-xs leading-relaxed text-muted-foreground">{guide.description}</p>
              <div className="space-y-3">
                {guide.snippets(writeKey).map((snippet) => (
                  <div key={snippet.label}>
                    <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                      {snippet.label}
                    </div>
                    <CodeBlock code={snippet.code} language={snippet.language} />
                  </div>
                ))}
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </div>
  )
}
