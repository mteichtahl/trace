/**
 * A guided skill in Focus mode (/p/:id/do/:skill): one route for all twenty, drawn from the skill table
 * (components/skills/definitions.ts). The variant picks the screen: conversational (Intent builder, Question
 * answer), checklist on a picture (Bench setup, Bring-up run, Incoming inspection), the KiCad skills (Schematic
 * finish, Placement adjust, Board setup), the form skills (Waiver, Change request), and the rest stepped from the
 * table alone. `?about=<id>` names what a Waiver or Change request is about.
 */
import { Link, createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { ChecklistSkill } from '@/components/skills/checklist-skill'
import { IntentBuilder, QuestionAnswer } from '@/components/skills/conversation-skills'
import { SKILL_BY_ID, SKILLS } from '@/components/skills/definitions'
import { ChangeSkill, WaiverSkill } from '@/components/skills/form-skills'
import { KicadSkill } from '@/components/skills/kicad-skill'
import { SteppedSkill } from '@/components/skills/stepped-skill'
import { NotShared } from '@/components/states'
import { ApiError, repoOf } from '@/lib/api'
import { useJourney } from '@/lib/queries'

export const Route = createFileRoute('/_focus/p/$id/do/$skill')({
  validateSearch: z.object({ about: z.string().optional() }),
  component: Skill,
})

function Skill() {
  const { id, skill } = Route.useParams()
  const { about } = Route.useSearch()
  const repo = repoOf(id)
  const j = useJourney(repo)
  const def = SKILL_BY_ID[skill]
  if (j.isError && j.error instanceof ApiError && j.error.noAccess) return <NotShared />
  if (!def)
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="text-lg font-semibold">There is no guided task called “{skill}”</h1>
        <p className="mt-2 text-sm text-muted-foreground">trace has {SKILLS.length} guided tasks; the project's next step opens the one that is due.</p>
        <Button asChild variant="outline" className="mt-4"><Link to="/p/$id" params={{ id }}>Back to the project</Link></Button>
      </div>
    )
  switch (def.id) {
    case 'intent-builder': return <IntentBuilder repo={repo} def={def} />
    case 'question-answer': return <QuestionAnswer repo={repo} def={def} />
    case 'waiver': return <WaiverSkill repo={repo} def={def} about={about} />
    case 'change-request': return <ChangeSkill repo={repo} def={def} about={about} />
  }
  if (def.variant === 'checklist') return <ChecklistSkill repo={repo} def={def} />
  if (def.kicad) return <KicadSkill repo={repo} def={def} />
  return <SteppedSkill repo={repo} def={def} />
}
