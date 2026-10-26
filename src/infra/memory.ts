/**
 * The agents' memory: one Amazon Bedrock AgentCore Memory for the installation, with the three built-in long-term
 * strategies, and least-privilege access for the runtimes that use it.
 *
 *   strategy          name                namespace template
 *   semantic          trace_facts         /trace/{actorId}/facts/
 *   summary           trace_sessions      /trace/{actorId}/sessions/{sessionId}/   ({sessionId} is required here)
 *   user preference   trace_preferences   /trace/{actorId}/preferences/
 *
 * actorId is `<owner>/<repo>/<agent>` (worker, ci-doctor, conflict, render, …) or `<owner>/<repo>/person/<hash16>`
 * for the person who asked, so every namespace starts with its project: `/trace/<owner>/<repo>/`. The scheme, and the
 * escaping that keeps it one-to-one, is in src/agent/memory.ts. Short-term events expire after eventExpiryDays.
 *
 * Access: only data-plane calls, on this memory only. No control plane, no deletes, no direct record writes: long-term
 * records come only from the strategies' extraction.
 *
 *   each project's worker  events of its own actors (`<owner>/<repo>/*`, bedrock-agentcore:actorId) and records of
 *                          its own namespaces (`/trace/<owner>/<repo>/*`, bedrock-agentcore:namespace): src/infra/project.ts
 *   the API                records under /trace/ (every project: memory.list and memory.recall, after its access
 *                          check), read only, and no events (grantReadRecords)
 */
import * as iam from 'aws-cdk-lib/aws-iam'
import { CfnMemory } from 'aws-cdk-lib/aws-bedrockagentcore'
import { Construct } from 'constructs'
import { NAMESPACE_TEMPLATES, ROOT } from '../agent/memory.js'

/** AgentCore memory and strategy names: a letter, then letters, digits and underscores, at most 48 characters. */
export const memoryName = (prefix: string): string => `${prefix.replace(/-/g, '_')}_memory`.slice(0, 48)

export const STRATEGY_NAMES = { facts: `${ROOT}_facts`, sessions: `${ROOT}_sessions`, preferences: `${ROOT}_preferences` } as const

/** The data-plane actions the agents use: events (short term) and records (long term), read and recall only. */
export const EVENT_ACTIONS = ['bedrock-agentcore:CreateEvent', 'bedrock-agentcore:ListEvents'] as const
export const RECORD_ACTIONS = ['bedrock-agentcore:RetrieveMemoryRecords', 'bedrock-agentcore:ListMemoryRecords'] as const

/** IAM pattern for every trace namespace (the normalised form: leading and trailing slash). */
export const NAMESPACE_PATTERN = `/${ROOT}/*`

export interface TraceMemoryProps {
  prefix: string
  /** Days short-term events are kept (3–365). */
  eventExpiryDays: number
}

export class TraceMemory extends Construct {
  readonly memory: CfnMemory

  constructor(scope: Construct, id: string, props: TraceMemoryProps) {
    super(scope, id)
    if (!Number.isInteger(props.eventExpiryDays) || props.eventExpiryDays < 3 || props.eventExpiryDays > 365) {
      throw new Error(`memory.eventExpiryDays must be a whole number of days from 3 to 365, not ${props.eventExpiryDays}`)
    }
    this.memory = new CfnMemory(this, 'Memory', {
      name: memoryName(props.prefix),
      description: 'trace: the agents\' memory, by project and agent (actor <owner>/<repo>/<agent>)',
      eventExpiryDuration: props.eventExpiryDays,
      memoryStrategies: [
        { semanticMemoryStrategy: { name: STRATEGY_NAMES.facts, description: 'Facts about the project, per agent', namespaceTemplates: [NAMESPACE_TEMPLATES.facts] } },
        { summaryMemoryStrategy: { name: STRATEGY_NAMES.sessions, description: 'One summary per session (work item or task), per agent', namespaceTemplates: [NAMESPACE_TEMPLATES.sessions] } },
        { userPreferenceMemoryStrategy: { name: STRATEGY_NAMES.preferences, description: 'How the project (or the person who asked) wants things done', namespaceTemplates: [NAMESPACE_TEMPLATES.preferences] } },
      ],
    })
  }

  get memoryId(): string { return this.memory.attrMemoryId }
  get memoryArn(): string { return this.memory.attrMemoryArn }

  /** Let `grantee` (the API) recall and list the records of every project, and nothing else of the memory. */
  grantReadRecords(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'TraceMemoryRecordsRead',
      actions: [...RECORD_ACTIONS],
      resources: [this.memoryArn],
      conditions: { StringLike: { 'bedrock-agentcore:namespace': NAMESPACE_PATTERN } },
    }))
  }
}
