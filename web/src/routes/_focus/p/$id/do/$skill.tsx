/**
 * A guided skill in Focus mode (/p/:id/do/:skill). This is the pattern each of the nineteen skills follows: its
 * steps, the picture for the step and its items in the centre, trace beside it (EmbeddedChat with the step's summary
 * as intro), the quality bar from the checker, and Escape or Close returning to where the person was. The skill
 * screens themselves are not built yet; this draws the frame with the skill's name so links from Home work.
 */
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { EmbeddedChat } from '@/components/chat/embedded-chat'
import { useTraceContext } from '@/components/chat/context'
import { FocusLayout, type FocusStep } from '@/components/focus/focus-layout'
import type { QualityCheck } from '@/components/quality-bar'
import { projectName, repoOf } from '@/lib/api'
import { useJourney } from '@/lib/queries'

export const Route = createFileRoute('/_focus/p/$id/do/$skill')({ component: Skill })

const title = (slug: string) => slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' ')

function Skill() {
  const { id, skill } = Route.useParams()
  const repo = repoOf(id)
  const router = useRouter()
  const j = useJourney(repo)
  const [step, setStep] = useState('read')
  const [savedAt] = useState(() => Date.now())
  const stage = j.data?.stages.find((s) => s.state === 'current')
  const steps: FocusStep[] = [
    { id: 'read', title: 'Read what trace prepared', state: step === 'read' ? 'current' : 'done' },
    { id: 'decide', title: 'Decide', state: step === 'decide' ? 'current' : step === 'read' ? 'todo' : 'done' },
    { id: 'submit', title: 'Submit', state: step === 'submit' ? 'current' : 'todo' },
  ]
  const checks: QualityCheck[] = [
    { id: 'c1', text: 'Every item resolved', status: step === 'read' ? 'not_met' : 'met' },
    { id: 'c2', text: 'Every change has a reason', status: 'met' },
  ]
  useTraceContext({ label: title(skill), description: 'The guided skill the person is doing', value: { skill, repo, step } }, 'skill')
  return (
    <FocusLayout
      title={title(skill)}
      context={[j.data?.name ?? projectName(repo), j.data?.revision, stage?.name].filter(Boolean).join(' · ')}
      steps={steps}
      onStep={setStep}
      checks={checks}
      onSubmit={() => { toast('Submitted') }}
      onClose={() => router.history.back()}
      draftSavedAt={savedAt}
      trace={<EmbeddedChat repo={repo} intro={<p className="text-sm text-muted-foreground">You are on {steps.find((s) => s.state === 'current')?.title.toLowerCase()}. Ask anything about this step.</p>} />}
    >
      <h1 className="text-xl font-semibold">{title(skill)}</h1>
      <p className="mt-2 text-sm text-muted-foreground">This skill's screen is designed (docs/ui-design.md, “Focus mode: guided skills”) but not built yet.</p>
    </FocusLayout>
  )
}
