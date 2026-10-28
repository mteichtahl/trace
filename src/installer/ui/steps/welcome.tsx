import { Clock, GitPullRequest, KeyRound, ShieldCheck, Cloud, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { Note } from '../parts.js'
import { useStore } from '../store.js'

function Item({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/50 text-muted-foreground [&_svg]:size-4">{icon}</span>
      <div className="grid gap-0.5">
        <p className="font-medium">{title}</p>
        <div className="text-muted-foreground">{children}</div>
      </div>
    </li>
  )
}

export function WelcomeStep() {
  const s = useStore()
  const env = s.env
  const saved = env?.saved
  const installed = env?.installed
  const profiles = env?.profiles.names ?? []
  return (
    <>
      {installed ? (
        <Note tone="info" title={`Updating the installation ${installed.stack} in ${installed.region}`}>
          Your earlier choices are filled in{saved?.projects?.length ? ` (${saved.projects.length} project${saved.projects.length === 1 ? '' : 's'})` : ''}. Tokens and keys are never saved, so paste them again. The plan shows only what changes.
        </Note>
      ) : null}
      <section className="grid gap-3">
        <h3 className="text-sm font-semibold">What you need</h3>
        <ul className="grid gap-4">
          <Item icon={<GitPullRequest />} title="A GitHub personal access token">
            Fine-grained (recommended) or classic, from the account that owns your repositories. The next step shows exactly which permissions and links to the page that makes one.
          </Item>
          <Item icon={<KeyRound />} title="AWS credentials that may create IAM roles">
            An administrator profile on this computer is simplest (single sign-on works).{' '}
            {profiles.length
              ? <>This computer has {profiles.length} AWS profile{profiles.length === 1 ? '' : 's'}: {profiles.slice(0, 4).join(', ')}{profiles.length > 4 ? ', …' : ''}.</>
              : <>No AWS profiles were found on this computer: you can paste access keys instead.</>}
          </Item>
        </ul>
      </section>
      <section className="grid gap-3">
        <h3 className="text-sm font-semibold">What happens</h3>
        <ul className="grid gap-4">
          <Item icon={<ShieldCheck />} title="Everything is checked before anything is created">
            The account, region, quotas, Bedrock model access and each repository's permissions. Anything that would fail is shown with how to fix it, often with a button that does it.
          </Item>
          <Item icon={<Clock />} title="About 20 to 40 minutes">
            Most of it is AWS CloudFormation. You can leave the page open and walk away; only one step may need you (authorising the AWS connection to GitHub, if you choose that).
          </Item>
          <Item icon={<Cloud />} title="Into your own AWS account">
            Agents on Amazon Bedrock AgentCore, build runners on AWS CodeBuild, graphics card and CPU jobs on AWS Batch (scaling to zero), and the web app on CloudFront. You pay AWS for what it uses.
          </Item>
          <Item icon={<RefreshCw />} title="Safe to run again">
            Every step can be repeated. Run the installer again to add projects or people, or to pick up where a failed install stopped.
          </Item>
        </ul>
      </section>
    </>
  )
}
