import { UserCog } from 'lucide-react'
import { useState } from 'react'
import { SkeletonTable } from '@/components/skeletons'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatTimestamp } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { ImpersonateDialog } from './ImpersonateDialog'

const ROLE_OPTIONS = ['org_admin', 'member', 'viewer'] as const
type OrgRole = (typeof ROLE_OPTIONS)[number]

/** Members tab: role changes (`setMemberRole`, confirm-gated) + per-member Impersonate. */
export function MembersTab({ orgId }: { orgId: string }) {
  const utils = trpc.useUtils()
  const membersQuery = trpc.admin.orgs.listMembers.useQuery({ orgId })
  const setMemberRole = trpc.admin.orgs.setMemberRole.useMutation({
    onSuccess: () => utils.admin.orgs.listMembers.invalidate({ orgId }),
  })

  if (membersQuery.isPending) {
    return <SkeletonTable rows={5} cols={5} />
  }
  if (membersQuery.isError) {
    return <p className="p-4 text-sm text-destructive">Failed to load members.</p>
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Joined</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {membersQuery.data.map((member) => (
            <TableRow key={member.userId}>
              <TableCell>
                <div className="font-medium text-foreground">{member.name ?? member.email}</div>
                <div className="text-xs text-muted-foreground">{member.email}</div>
              </TableCell>
              <TableCell>
                <RoleSelect
                  orgId={orgId}
                  userId={member.userId}
                  currentRole={member.role as OrgRole}
                  onChange={(role) =>
                    setMemberRole.mutateAsync({ orgId, userId: member.userId, role })
                  }
                  pending={
                    setMemberRole.isPending && setMemberRole.variables?.userId === member.userId
                  }
                />
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {formatTimestamp(member.joinedAt)}
              </TableCell>
              <TableCell className="text-right">
                <ImpersonateDialog
                  orgId={orgId}
                  userId={member.userId}
                  userEmail={member.email}
                  trigger={
                    <Button type="button" variant="outline" size="sm" className="gap-1.5">
                      <UserCog className="size-3.5" />
                      Impersonate
                    </Button>
                  }
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/**
 * Role changes are confirm-gated. Picking a new role in the `Select` stages it as
 * `pendingRole` and opens a controlled `AlertDialog` — confirming applies it, canceling/closing
 * reverts the trigger back to the current role (the `Select` itself always displays
 * `currentRole`, never the staged pick, so there's no visual lag between "picked" and "applied").
 */
function RoleSelect({
  currentRole,
  onChange,
  pending,
}: {
  orgId: string
  userId: string
  currentRole: OrgRole
  onChange: (role: OrgRole) => Promise<unknown>
  pending: boolean
}) {
  const [pendingRole, setPendingRole] = useState<OrgRole | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleConfirm() {
    if (!pendingRole) return
    setConfirming(true)
    setError(null)
    try {
      await onChange(pendingRole)
      setPendingRole(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setConfirming(false)
    }
  }

  return (
    <>
      <Select
        value={currentRole}
        disabled={pending}
        onValueChange={(value) => setPendingRole(value as OrgRole)}
      >
        <SelectTrigger size="sm" className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROLE_OPTIONS.map((role) => (
            <SelectItem key={role} value={role}>
              {role}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <AlertDialog
        open={pendingRole !== null}
        onOpenChange={(next) => {
          if (!next && !confirming) {
            setPendingRole(null)
            setError(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change member role</AlertDialogTitle>
            <AlertDialogDescription>
              Change this member's role from {currentRole} to {pendingRole}?
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirming}>Cancel</AlertDialogCancel>
            <Button type="button" disabled={confirming} onClick={handleConfirm}>
              {confirming ? 'Working…' : 'Change role'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
