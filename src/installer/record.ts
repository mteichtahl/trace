/**
 * What the installer saves of an installation for the self-update job (README "Staying up to date"): the stack settings
 * it last deployed with (exactly what bootstrap.ts infraInput produced), which repository is trace's own and its default
 * branch, and the one answer the GitHub connection's choice needs again (the connection the person named, if any).
 * Saved at installation/props.json in the central bucket (src/infra/props.ts INSTALLATION_RECORD_KEY), which only the
 * installer writes and only the self-update role reads.
 *
 * Nothing secret is in it: the stack settings never hold one (src/infra/props.ts: they are the CloudFormation
 * template's input), and checkNoSecrets refuses a record in which any of the run's tokens or keys appears anyway.
 */
import { z } from 'zod'
import { type InfraInput, InfraPropsSchema } from '../infra/props.js'
import type { Secrets } from './answers.js'

export const INSTALLATION_RECORD_VERSION = 1

export const InstallationRecordSchema = z.object({
  version: z.literal(INSTALLATION_RECORD_VERSION),
  /** the CloudFormation stack (stackName(prefix)) and its region */
  stack: z.string().min(1),
  region: z.string().min(1),
  /** the stack settings of the installer's last deploy (InfraInput: parsed again by whoever deploys with them) */
  props: z.record(z.string(), z.unknown()),
  /** the GitHub connection the person named in the installer ('' when none: resolveConnection's `given`) */
  connectionArn: z.string().default(''),
  /** trace's own repository and its default branch, when the installer knew them ('' otherwise) */
  traceRepository: z.string().default(''),
  traceBranch: z.string().default(''),
  savedAt: z.string(),
}).strict()
export type InstallationRecord = z.output<typeof InstallationRecordSchema>

/** The record for this deploy. Throws when the settings are not valid stack settings. */
export function installationRecord(o: { stack: string; region: string; props: InfraInput; connectionArn: string; traceRepository: string; traceBranch: string; now?: Date }): InstallationRecord {
  InfraPropsSchema.parse(o.props)
  return {
    version: INSTALLATION_RECORD_VERSION, stack: o.stack, region: o.region, props: JSON.parse(JSON.stringify(o.props)) as Record<string, unknown>,
    connectionArn: o.connectionArn, traceRepository: o.traceRepository, traceBranch: o.traceBranch, savedAt: (o.now ?? new Date()).toISOString(),
  }
}

/** The values that must never be in a record: every token and key the installer was given. */
export const secretValues = (s: Secrets): string[] =>
  [s.githubToken, s.githubAdminToken, s.awsAccessKeyId, s.awsSecretAccessKey, s.awsSessionToken, ...Object.values(s.projectTokens), ...Object.values(s.libraryKeys)].filter((v) => v.length >= 8)

/** Refuse a record's text in which any secret value, or anything shaped like a GitHub token, appears. */
export function checkNoSecrets(text: string, s: Secrets): void {
  if (secretValues(s).some((v) => text.includes(v)) || /(gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/.test(text)) {
    throw new Error('the installation record would contain a token or key: not saved')
  }
}
