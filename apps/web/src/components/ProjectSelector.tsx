import { ChevronDown, Globe } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { trpc } from '@/lib/trpc'
import { setProjectId, useProjectId } from '@/lib/use-project'

export function ProjectSelector() {
  const { data, isError, isPending } = trpc.projects.list.useQuery()
  const projectId = useProjectId()

  if (isPending) return <Skeleton className="h-8 w-40" />

  const projects = isError ? [] : (data ?? [])
  const current = projects.find((p) => p.id === projectId)
  const projectName = current?.name ?? 'Select project'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-muted-foreground hover:bg-muted/30 transition-colors group">
        <Globe className="w-3 h-3 shrink-0" />
        <span className="flex-1 text-left truncate">
          {projectName} <span className="text-muted-foreground/60">· production</span>
        </span>
        <ChevronDown className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {projects.length === 0 ? (
          <DropdownMenuItem disabled>No projects</DropdownMenuItem>
        ) : (
          projects.map((project) => (
            <DropdownMenuItem key={project.id} onSelect={() => setProjectId(project.id)}>
              {project.name}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
