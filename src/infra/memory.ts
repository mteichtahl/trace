/**
 * The agents' memory: one Amazon Bedrock AgentCore Memory per project (made by its ProjectStack, src/infra/project.ts),
 * each with the three built-in long-term strategies, and least-privilege access for the runtimes that use it.
 *
 *   name     <prefix>_m_<hash>  (src/core/project.ts memoryName; CfnMemory Name ^[a-zA-Z][a-zA-Z0-9_]{0,47}$), and
 *            <prefix>_m_<hash>_g<n> for a project added again at generation n (its earlier memory stays, orphaned)
 *
 *   strategy          name                namespace template
 *   semantic          trace_facts         /trace/{actorId}/facts/
 *   summary           trace_sessions      /trace/{actorId}/sessions/{sessionId}/   ({sessionId} is required here)
 *   user preference   trace_preferences   /trace/{actorId}/preferences/
 *
 * actorId is still `<owner>/<repo>/<agent>` (worker, ci-doctor, conflict, render, …) or `<owner>/<repo>/person/<hash16>`
 * for the person who asked, so records stay self-describing and every namespace starts with its project:
 * `/trace/<owner>/<repo>/`. The scheme, and the escaping that keeps it one-to-one, is in src/agents/runtime/memory.ts.
 * Short-term events expire after the project's eventExpiryDays (memory.eventExpiryDays unless projectSettings says).
 *
 * Its lifetime is the project's: removing the repository from `repositories` removes its memory, and deleting the
 * stack removes every one — unless retainData, which marks each memory Retain (on both) so its records stay in the
 * account, outside the stack.
 *
 * Access: only data-plane calls, on that project's memory only. No control plane, no deletes, no direct record
 * writes: long-term records come only from the strategies' extraction.
 *
 *   the project's worker   events and records of its own memory; still only its own actors (`<owner>/<repo>/*`,
 *                          bedrock-agentcore:actorId) and namespaces (`/trace/<owner>/<repo>/*`,
 *                          bedrock-agentcore:namespace), as defence in depth: src/infra/project.ts
 *   the API                records under /trace/ of every project's memory (memory.list, memory.recall, and
 *                          GetMemoryRecord to verify a record before memory.deactivate, after its access check), read
 *                          only (grantReadRecords), and its agents' events, listed only (memory.events,
 *                          grantReadEvents). Inactive marks are not written to the memory: they
 *                          are an overlay in S3 (src/agents/runtime/memory-state.ts). And one write: CreateEvent on
 *                          each project's memory, for that project's chat actor and person actors only
 *                          (`<owner>/<repo>/chat`, `<owner>/<repo>/person/*`, bedrock-agentcore:actorId; grantChatEvents):
 *                          a person's own chat turns (their person actor) and what a person confirmed Ask trace should
 *                          remember (memory.remember: the chat actor only so).
 *                          Never an agent's actor, never another project's, never a record or a delete
 *   the OIDC role          the same as its project's worker, on its own project's memory only (the worker.runner =
 *                          actions fallback is the worker in GitHub Actions): src/infra/project.ts
 */
import { RemovalPolicy } from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import { CfnMemory } from 'aws-cdk-lib/aws-bedrockagentcore'
import { Construct } from 'constructs'
import { CHAT_AGENT, NAMESPACE_TEMPLATES, ROOT, projectId } from '../agents/runtime/memory.js'
import { memoryNamePattern } from '../core/project.js'

/** The memory of installations before memory was per project (one for every project). Kept only so that it can be
 * retained on the way out (memory.legacySharedMemory): its name must not change, or CloudFormation replaces it. */
export const sharedMemoryName = (prefix: string): string => `${prefix.replace(/-/g, '_')}_memory`.slice(0, 48)

/** CfnMemory Name. */
export const MEMORY_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/

export const STRATEGY_NAMES = { facts: `${ROOT}_facts`, sessions: `${ROOT}_sessions`, preferences: `${ROOT}_preferences` } as const

/** The data-plane actions the agents use: events (short term) and records (long term), read and recall only. */
export const EVENT_ACTIONS = ['bedrock-agentcore:CreateEvent', 'bedrock-agentcore:ListEvents'] as const
export const RECORD_ACTIONS = ['bedrock-agentcore:RetrieveMemoryRecords', 'bedrock-agentcore:ListMemoryRecords'] as const

/** IAM pattern for every trace namespace (the normalised form: leading and trailing slash). */
export const NAMESPACE_PATTERN = `/${ROOT}/*`

export interface TraceMemoryProps {
  name: string
  description: string
  /** Days short-term events are kept (3–365). */
  eventExpiryDays: number
  /** RETAIN (retainData) or DESTROY: applies on stack deletion and on removal from the template alike */
  removalPolicy: RemovalPolicy
  tags?: Record<string, string>
}

export class TraceMemory extends Construct {
  readonly memory: CfnMemory

  constructor(scope: Construct, id: string, props: TraceMemoryProps) {
    super(scope, id)
    if (!Number.isInteger(props.eventExpiryDays) || props.eventExpiryDays < 3 || props.eventExpiryDays > 365) {
      throw new Error(`memory event expiry must be a whole number of days from 3 to 365, not ${props.eventExpiryDays}`)
    }
    if (!MEMORY_NAME_PATTERN.test(props.name)) throw new Error(`not an AgentCore memory name: ${JSON.stringify(props.name)}`)
    this.memory = new CfnMemory(this, 'Memory', {
      name: props.name,
      description: props.description.slice(0, 200),
      eventExpiryDuration: props.eventExpiryDays,
      memoryStrategies: [
        { semanticMemoryStrategy: { name: STRATEGY_NAMES.facts, description: 'Facts about the project, per agent', namespaceTemplates: [NAMESPACE_TEMPLATES.facts] } },
        { summaryMemoryStrategy: { name: STRATEGY_NAMES.sessions, description: 'One summary per session (work item or task), per agent', namespaceTemplates: [NAMESPACE_TEMPLATES.sessions] } },
        { userPreferenceMemoryStrategy: { name: STRATEGY_NAMES.preferences, description: 'How the project (or the person who asked) wants things done', namespaceTemplates: [NAMESPACE_TEMPLATES.preferences] } },
      ],
      ...(props.tags ? { tags: props.tags } : {}),
    })
    // An L1 resource has no DeletionPolicy unless one is applied: without this, CloudFormation deleted the memory
    // whatever retainData said.
    this.memory.applyRemovalPolicy(props.removalPolicy)
  }

  get memoryId(): string { return this.memory.attrMemoryId }
  get memoryArn(): string { return this.memory.attrMemoryArn }
}

/** What the API may do with records: recall and list them, and get one (memory.deactivate verifies a record is the
 * project's before marking it inactive; the marks are kept beside the memory, never written to it). */
export const API_RECORD_ACTIONS = [...RECORD_ACTIONS, 'bedrock-agentcore:GetMemoryRecord'] as const

/** Let `grantee` (the API) recall, list and get the records of every project's memory, and nothing else of them. */
/** The API's read of short-term memory (memory.events): list an actor's sessions and their events, never write them. */
export const API_EVENT_ACTIONS = ['bedrock-agentcore:ListSessions', 'bedrock-agentcore:ListEvents'] as const

/**
 * The API reads every project's short-term events (memory.events), read only. One short statement on this
 * installation's memories by name (`<prefix>_m_*`, src/core/project.ts memoryName), not one ARN per project, so the
 * API's policy keeps its size however many projects there are. The API's access check names the actors it reads: the
 * project's agents and the caller's own person actor (src/api/actions.ts).
 */
export function grantReadEvents(grantee: iam.IGrantable, memories: readonly TraceMemory[], at: { partition: string; region: string; account: string; prefix: string }): void {
  if (!memories.length) return
  grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'TraceMemoryEventsRead',
    actions: [...API_EVENT_ACTIONS],
    resources: [`arn:${at.partition}:bedrock-agentcore:${at.region}:${at.account}:memory/${memoryNamePattern(at.prefix)}`],
  }))
}

export function grantReadRecords(grantee: iam.IGrantable, memories: readonly TraceMemory[]): void {
  if (!memories.length) return
  grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'TraceMemoryRecordsRead',
    actions: [...API_RECORD_ACTIONS],
    resources: memories.map((m) => m.memoryArn),
    conditions: { StringLike: { 'bedrock-agentcore:namespace': NAMESPACE_PATTERN } },
  }))
}

/** What the API may write to short-term memory (the chat's events): CreateEvent, and nothing else. */
export const CHAT_EVENT_ACTIONS = ['bedrock-agentcore:CreateEvent'] as const

/** The actors the API may write events for on one project: its chat, and its people (src/agents/runtime/memory.ts). */
export const chatActorPatterns = (repository: string): string[] => [`${projectId(repository)}/${CHAT_AGENT}`, `${projectId(repository)}/person/*`]

/**
 * Let `grantee` (the people's API) record Ask trace's conversations and what a person asked it to remember: CreateEvent
 * on each project's own memory, for that project's chat actor and person actors only. One statement per project, so
 * no project's actors can be written into another project's memory (the per-project isolation of src/infra/project.ts).
 * Each memory is named by its fixed name (`<name>-*`: an id is `<name>-<10 characters>`, and no other project's name
 * starts with `<name>-`), so the statements carry no reference to the projects' stacks and stay short.
 */
export function grantChatEvents(grantee: iam.IGrantable, projects: readonly { repository: string; name: string }[], at: { partition: string; region: string; account: string }): void {
  for (const p of projects) {
    if (!MEMORY_NAME_PATTERN.test(p.name)) throw new Error(`not an AgentCore memory name: ${JSON.stringify(p.name)}`)
    // no Sid, and the ARN as one plain string: sixty of these must fit the API role's policies
    grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [...CHAT_EVENT_ACTIONS],
      resources: [`arn:${at.partition}:bedrock-agentcore:${at.region}:${at.account}:memory/${p.name}-*`],
      conditions: { StringLike: { 'bedrock-agentcore:actorId': chatActorPatterns(p.repository) } },
    }))
  }
}
