/**
 * What the CDK stack needs to know, collected by the installer (or given by hand). Passed to the CDK app in the
 * TRACE_INFRA environment variable as JSON text — never as a file, and never containing a secret: tokens go straight
 * into Secrets Manager and GitHub after the deploy.
 */
import { z } from 'zod'

/** OWNER/REPO, optionally @BRANCH (its default branch; main when omitted). */
const repoSlug = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+(@[A-Za-z0-9._\/-]+)?$/, 'expected OWNER/REPO or OWNER/REPO@BRANCH')

export const InfraPropsSchema = z.object({
  /** A short name prefixed to every resource: lets two installations share an account. */
  prefix: z.string().regex(/^[a-z][a-z0-9-]{1,20}$/, 'lower-case letters, digits and dashes, 2–21 characters').default('trace'),
  account: z.string().regex(/^\d{12}$/, 'a 12-digit AWS account id'),
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'an AWS region such as us-east-1'),
  /** The repositories whose default-branch workflows may assume the actions role (OIDC subject
   * `repo:OWNER/REPO:ref:refs/heads/BRANCH`). */
  repositories: z.array(repoSlug).min(1),
  /** Create the account's GitHub OIDC provider (there can be only one per account), or use the existing one. */
  createOidcProvider: z.boolean().default(true),
  /** The Bedrock model or inference profile the agents use, e.g. us.anthropic.claude-sonnet-4-6. */
  model: z.string().min(3),
  /** Bucket for the central database (datasheets, parts); empty: one is created and named after the stack. */
  centralBucketName: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).optional(),
  /** AgentCore session limits (seconds). */
  maxLifetimeSeconds: z.number().int().min(900).max(28_800).default(28_800),
  idleTimeoutSeconds: z.number().int().min(60).max(28_800).default(900),
  /** The first administrator: Cognito emails them a temporary password. Admins grant everyone else access. */
  adminEmail: z.string().email(),
  /** Local ports the CLI and the installer listen on for the Cognito sign-in redirect. */
  callbackPorts: z.array(z.number().int().min(1024).max(65535)).min(1).default([47821, 47822]),
  /** Keep the central bucket and the image repository when the stack is deleted. */
  retainData: z.boolean().default(true),
}).strict()

export type InfraProps = z.output<typeof InfraPropsSchema>
export type InfraInput = z.input<typeof InfraPropsSchema>

export function infraPropsFromEnv(env: NodeJS.ProcessEnv = process.env): InfraProps {
  const raw = env.TRACE_INFRA
  if (!raw) throw new Error('TRACE_INFRA is not set: run `trace install`, or set it to the stack settings as JSON')
  return InfraPropsSchema.parse(JSON.parse(raw))
}

/** AgentCore runtime names: a letter, then letters, digits and underscores, at most 48 characters. */
export const runtimeName = (prefix: string): string => `${prefix.replace(/-/g, '_')}_agent`.slice(0, 48)

/** The CloudFormation stack name for a prefix: trace → TraceStack, my-lab → MyLabStack. */
export const stackName = (prefix: string): string =>
  prefix.split('-').map((p) => (p[0]?.toUpperCase() ?? '') + p.slice(1)).join('') + 'Stack'
