/**
 * No access yet: a signed-in person with no account class, or a class but no project. One card saying which, naming
 * who can fix it, with Copy request. They never see an empty Home.
 */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Copy, LogOut } from 'lucide-react'
import { toast } from 'sonner'
import { AuthCard } from '@/components/auth-card'
import { Button } from '@/components/ui/button'
import { bootstrap, signOut, useAuth } from '@/lib/auth'

export const Route = createFileRoute('/no-access')({
  beforeLoad: () => bootstrap(),
  component: NoAccess,
})

export function requestText(email: string, hasClass: boolean): string {
  return hasClass
    ? `Hi, could you add me (${email}) to a project in trace? I can sign in, but I am not on any project yet. Thank you.`
    : `Hi, could you give me (${email}) access to trace? I can sign in, but my account has no access yet. Thank you.`
}

function NoAccess() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const email = user?.email ?? 'your email'
  const hasClass = !!user?.class
  return (
    <AuthCard
      title={hasClass ? "You're not on a project yet" : "Your account doesn't have access yet"}
      description={
        hasClass
          ? 'You can sign in, but no one has added you to a project. An admin on your team can add you.'
          : 'You are signed in, but an admin has not given your account access to trace yet.'
      }
    >
      <div className="space-y-3">
        <p className="text-sm">Ask an admin on your team. This message has what they need:</p>
        <blockquote className="rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">{requestText(email, hasClass)}</blockquote>
        <Button className="w-full" onClick={() => void navigator.clipboard?.writeText(requestText(email, hasClass)).then(() => toast('Request copied. Paste it to an admin.'))}>
          <Copy /> Copy request
        </Button>
        <Button variant="ghost" className="w-full" onClick={() => void signOut().then(() => navigate({ to: '/sign-in' }))}>
          <LogOut /> Sign in as someone else
        </Button>
      </div>
    </AuthCard>
  )
}
