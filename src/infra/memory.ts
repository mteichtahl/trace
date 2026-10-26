/**
 * The agents' memory: one Amazon Bedrock AgentCore Memory per project (made by its ProjectStack, src/infra/project.ts),
 * each with the three built-in long-term strategies, and least-privilege access for the runtimes that use it.
 *
 *   name     <prefix>_m_<hash>  (src/core/project.ts memoryName; CfnMemory Name ^[a-zA-Z][a-zA-Z0-9_]{0,47}$)
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
 *   the API                records under /trace/ of every project's memory (memory.list and memory.recall, after its
 *                          access check), read only, and no events (grantReadRecords)
 *   the OIDC role          none
 */
import { RemovalPolicy } from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import { CfnMemory } from 'aws-cdk-lib/aws-bedrockagentcore'
import { Construct } from 'constructs'
import { NAMESPACE_TEMPLATES, ROOT } from '../agents/runtime/memory.js'

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

/** Let `grantee` (the API) recall and list the records of every project's memory, and nothing else of them. */
export function grantReadRecords(grantee: iam.IGrantable, memories: readonly TraceMemory[]): void {
  if (!memories.length) return
  grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'TraceMemoryRecordsRead',
    actions: [...RECORD_ACTIONS],
    resources: memories.map((m) => m.memoryArn),
    conditions: { StringLike: { 'bedrock-agentcore:namespace': NAMESPACE_PATTERN } },
  }))
}
