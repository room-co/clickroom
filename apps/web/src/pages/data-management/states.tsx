import { AlertCircle } from 'lucide-react'
import { SkeletonTable } from '@/components/skeletons'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

export function TableLoading({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return <SkeletonTable rows={rows} cols={cols} />
}

export function TableError({ message }: { message: string }) {
  return (
    <Alert variant="destructive" className="m-4 w-auto">
      <AlertCircle className="size-4" />
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

export function TableEmpty({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 p-12 text-center">
      <p className="text-sm font-medium">Nothing here yet</p>
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  )
}
