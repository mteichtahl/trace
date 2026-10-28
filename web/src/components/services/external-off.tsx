/** What Admin › Connected systems shows when the installation has not turned external access on: not an error. */
import { PlugZap } from 'lucide-react'

export function ExternalOff({ message }: { message?: string }) {
  return (
    <div className="rounded-xl border border-dashed p-6 text-sm" data-testid="external-off">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><PlugZap className="size-4" aria-hidden /></span>
        <div className="min-w-0 space-y-3">
          <div>
            <h2 className="font-semibold">External access is off for this installation</h2>
            <p className="mt-1 text-muted-foreground">Until it is on, no other system can reach trace, and there is nothing to set up here.</p>
          </div>
          <div>
            <p className="font-medium">To turn it on</p>
            <ol className="mt-1 list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>Run <code className="rounded bg-muted px-1 font-mono text-[13px] text-foreground">tracectl install</code> on the machine that installed trace.</li>
              <li>Open <span className="text-foreground">External access</span>, switch it on, and deploy.</li>
              <li>Come back here and connect your first system.</li>
            </ol>
          </div>
          <p className="text-xs text-muted-foreground">It adds a sign-in for systems and two addresses (one for scripts, one for AI agents). Both cost nothing while nobody calls them.{message && !/external access is off/i.test(message) ? ` ${message}` : ''}</p>
        </div>
      </div>
    </div>
  )
}
