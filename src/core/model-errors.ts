/**
 * Why the model could not be called, in plain words (potroller-carrier-m20 import test, 17 Nov 2026). Every agent job
 * and every chat reply on the live installation ended in 8 seconds with
 *
 *   Claude Code returned an error result: API Error: 400 data retention mode 'default' is not available for this model
 *
 * and the app said only "that work ended without meeting it" (the Overview) and nothing at all (the chat). The cause is
 * the installation's, not the project's: the model the installer was given is one Amazon Bedrock runs only for
 * accounts that have chosen a data retention mode the model allows (Anthropic's Mythos-class models, Claude Mythos and
 * Claude Fable: AWS's "data retention" setting, account-wide or per Bedrock project), and this account has not. No
 * retry mends it, and no project can do any agent work until an admin changes the model or the account's setting.
 *
 *   modelProblem(text)   the problem an error text names, or null when it is not one of these: what happened and what
 *                        to do, for a person, with no API or setting names beyond the one they must look for
 *   explainModelError    the text with the plain words in front (the raw error kept after them, for the log viewer)
 *   needsRetentionMode   whether a model id is one Bedrock runs only under a chosen data retention mode
 *   RETENTION_OK         the account modes those models run under
 *
 * Pure. The agent runtime (src/agents/runtime/job.ts), the chat agent (src/web/agui.ts), the installer's preflight
 * (src/installer/preflight.ts) and the installation's health (src/api/model-health.ts) all read it.
 */

export type ModelProblemKind = 'data-retention' | 'no-access' | 'not-found' | 'busy'

export interface ModelProblem {
  kind: ModelProblemKind
  /** what happened, one sentence, no trailing full stop */
  what: string
  /** what an admin does about it, one sentence, no trailing full stop */
  todo: string
  /** whether trying again later can work with nothing changed */
  retry: boolean
}

/** AWS's page on the setting. */
export const RETENTION_LINK = 'https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html'

/** The account data retention modes Bedrock's retention-gated models run under. */
export const RETENTION_OK: readonly string[] = ['aws_review', 'provider_data_share']

/** A model or inference profile id Bedrock runs only under a chosen data retention mode (Anthropic's Mythos class). */
export const needsRetentionMode = (model: string): boolean => /anthropic\.claude-(fable|mythos)/i.test(model)

const PROBLEMS: readonly { kind: ModelProblemKind; test: RegExp; what: string; todo: string; retry: boolean }[] = [
  {
    kind: 'data-retention', test: /data retention mode\b[^.]*\bnot available for this model|not available under data retention mode/i,
    what: 'the AWS account\'s data retention setting for Amazon Bedrock does not allow the model this installation uses',
    todo: 'an admin runs the installer again and chooses another model, or changes the account\'s Bedrock data retention setting in AWS',
    retry: false,
  },
  {
    kind: 'no-access', test: /don't have access to the model|not authorized to perform: bedrock:InvokeModel|model access is denied|AccessDeniedException[^.]*bedrock/i,
    what: 'the AWS account has no access to the model this installation uses',
    todo: 'an admin runs the installer again: its checks say what the model still needs (Anthropic\'s form, or the model\'s agreement)',
    retry: false,
  },
  {
    kind: 'not-found', test: /model identifier is invalid|The provided model identifier|inference profile[^.]*(not found|does not exist)|end of its life/i,
    what: 'the model this installation uses does not exist in its region any more',
    todo: 'an admin runs the installer again and chooses one of the models it lists',
    retry: false,
  },
  {
    kind: 'busy', test: /ThrottlingException|Too many (requests|tokens)|ServiceQuotaExceeded|ModelNotReadyException|\b(429|529)\b[^.]*(rate|overload)/i,
    what: 'the model is busy: AWS turned the request away',
    todo: 'try again in a few minutes',
    retry: true,
  },
]

/** The problem an error text names, or null. */
export function modelProblem(text: string | null | undefined): ModelProblem | null {
  if (!text) return null
  const p = PROBLEMS.find((x) => x.test.test(text))
  return p ? { kind: p.kind, what: p.what, todo: p.todo, retry: p.retry } : null
}

const upper = (s: string): string => s.replace(/^./, (c) => c.toUpperCase())

/** A problem as two sentences: "The AWS account's … . An admin … ." */
export const problemWords = (p: ModelProblem): string => `${upper(p.what)}. ${upper(p.todo)}.`

/** The marker between the plain words and the raw error they explain. */
const RAW = ' (The model said: '

/**
 * An error text with its plain words in front, and the raw error after them for whoever reads the log. A text that is
 * no model problem, or one explained already, is answered as it is.
 */
export function explainModelError(text: string): string {
  if (text.includes(RAW)) return text
  const p = modelProblem(text)
  return p ? `trace could not reach its model: ${p.what}. ${upper(p.todo)}.${RAW}${text.replace(/\.$/, '')}.)` : text
}
