/**
 * Everything the installer works out instead of asking (src/installer/answers.ts): from the credentials, the token,
 * and what the preflight found (src/installer/preflight.ts). Pure: the facts come in, the answers go out.
 *
 *   region         the answer, else the profile's region, else us-east-1
 *   account        STS GetCallerIdentity (a saved account that differs stops the install: the wrong profile)
 *   github.login   GET /user with the token
 *   adminEmail     the token's verified primary email (GET /user/emails, which needs the `user:email` scope on a
 *                  classic token or "Email addresses: read" on a fine-grained one); asked for only when not visible
 *   model          the newest Claude Sonnet inference profile active in the region, else the newest Claude one, else
 *                  the geography's Sonnet 4.6 profile id
 *   gpu / cpu      on when the account's quotas allow one job (G and VT instances for the GPU queue, standard
 *                  instances for the CPU queue); off at 0, with how to raise it
 *   knowledgeBase  on where the region has Amazon S3 Vectors
 *   publishImages  on when the token administers trace's source repository: its owner's install publishes trace's
 *                  images (src/installer/release.ts), with no prework
 *   imageRegistry  where trace's images are published: the source's trace-images release (src/installer/release.ts
 *                  publishedRegistry), unless props.ts PUBLISHED_REGISTRY pins one; none yet, so they are built
 */
import { SOURCE } from '../core/onboard.js'
import { PUBLISHED_REGISTRY } from '../infra/props.js'
import type { Answers } from './answers.js'

/** What the installer found out (each fact may be missing when its check could not run). */
export interface Facts {
  account?: string
  profileRegion?: string
  login?: string
  /** the token's verified primary email, or null when it is not visible to the token */
  email?: string | null
  models?: readonly { id: string; name: string }[]
  /** vCPUs the account may run at once (Service Quotas), null when unknown */
  gpuQuota?: number | null
  cpuQuota?: number | null
  /** whether the region has Amazon S3 Vectors, null when unknown */
  s3vectors?: boolean | null
  /** whether the GitHub token administers trace's source repository (its owner installing: publish its images) */
  sourceAdmin?: boolean | null
  /** where the source's images are published (its trace-images release: src/installer/release.ts), null when nowhere */
  publishedRegistry?: string | null
}

export const DEFAULT_REGION = 'us-east-1'

/** vCPUs one GPU job asks for (props.ts GPU_JOB_VCPUS: g6/g5/g4dn .xlarge). */
const GPU_JOB_VCPUS = 4

/** A region's cross-region inference geography (the prefix of its system inference profiles). */
export function geography(region: string): 'us' | 'eu' | 'apac' | 'ca' | 'us-gov' {
  if (region.startsWith('us-gov-')) return 'us-gov'
  if (region.startsWith('eu-') || region.startsWith('il-') || region.startsWith('me-')) return 'eu'
  if (region.startsWith('ap-')) return 'apac'
  if (region.startsWith('ca-')) return 'ca'
  return 'us'
}

/** The model the agents use when none was chosen. */
export function pickModel(models: readonly { id: string }[], region: string): string {
  const ids = models.map((m) => m.id)
  const claude = ids.filter((id) => /anthropic\.claude/.test(id))
  const sonnet = claude.filter((id) => /sonnet/.test(id))
  // newest first: the ids carry the version (claude-sonnet-4-6, claude-sonnet-4-5-2025…); of the same model, the
  // region's geography's profile before the global one, so requests stay in that geography unless chosen otherwise
  const bare = (id: string): string => id.replace(/^[a-z-]+\./, '')
  const global = (id: string): number => (id.startsWith('global.') ? 1 : 0)
  const newest = (xs: string[]): string | undefined => [...xs].sort((a, b) => bare(b).localeCompare(bare(a)) || global(a) - global(b))[0]
  return newest(sonnet) ?? newest(claude) ?? `${geography(region) === 'ca' ? 'us' : geography(region)}.anthropic.claude-sonnet-4-6`
}

export interface Resolved { answers: Answers; derived: string[]; missing: string[] }

/** The answers with every empty value filled from the facts. `missing`: what could not be derived (asked for). */
export function resolveAnswers(a: Answers, f: Facts): Resolved {
  const derived: string[] = []
  const missing: string[] = []
  const region = a.aws.region || f.profileRegion || DEFAULT_REGION
  if (!a.aws.region) derived.push(`region ${region}${f.profileRegion ? ' (the profile\'s)' : ' (the default)'}`)
  let account = a.aws.account
  if (f.account) {
    if (account && account !== f.account) missing.push(`these credentials are for account ${f.account}, not ${account} (the installation's): use the right profile, or clear the saved account`)
    if (!account) derived.push(`account ${f.account} (the credentials')`)
    account = f.account
  } else if (!account) missing.push('the AWS account (the credentials could not be checked)')
  const login = a.github.login || f.login || ''
  if (!login) missing.push('the GitHub login (the token could not be checked)')
  let adminEmail = a.adminEmail
  if (!adminEmail) {
    if (f.email) { adminEmail = f.email; derived.push(`first administrator ${f.email} (the token's primary email)`) }
    else missing.push('the first administrator\'s email: the token cannot see its account\'s email (give a classic token `user:email`, or a fine-grained one "Email addresses: read"), so enter it under Advanced')
  }
  let model = a.agents.model
  if (!model) { model = pickModel(f.models ?? [], region); derived.push(`model ${model}`) }
  const gpuEnabled = a.agents.gpuEnabled ?? (f.gpuQuota === undefined || f.gpuQuota === null ? true : f.gpuQuota >= GPU_JOB_VCPUS)
  if (a.agents.gpuEnabled === null) derived.push(`GPU jobs ${gpuEnabled ? 'on' : `off (the account may run ${f.gpuQuota ?? 0} G and VT vCPUs; one job needs ${GPU_JOB_VCPUS})`}`)
  const cpuEnabled = a.agents.cpuEnabled ?? (gpuEnabled && (f.cpuQuota === undefined || f.cpuQuota === null || f.cpuQuota >= a.agents.cpuVcpus))
  if (a.agents.cpuEnabled === null) derived.push(`CPU jobs ${cpuEnabled ? 'on' : gpuEnabled ? `off (the account may run ${f.cpuQuota ?? 0} standard vCPUs; one job asks for ${a.agents.cpuVcpus})` : 'off (they share the GPU side\'s image)'}`)
  const knowledgeBase = a.agents.knowledgeBase ?? (f.s3vectors !== false)
  if (a.agents.knowledgeBase === null) derived.push(`knowledge bases ${knowledgeBase ? 'on' : `off (Amazon S3 Vectors is not available in ${region})`}`)
  // publishing trace's images is part of its owner's install: on when the token administers the source repository
  const publishImages = a.agents.publishImages ?? f.sourceAdmin === true
  if (a.agents.publishImages === null && publishImages) derived.push(`publishing trace's images from this account (the token administers ${SOURCE})`)
  // the published images: the answers' registry, else props.ts PUBLISHED_REGISTRY when set (infraInput), else the
  // source's trace-images release; none: the images are built in this account
  let imageRegistry = a.agents.imageRegistry
  if (a.agents.imageSource === 'prebuilt' && !imageRegistry && !PUBLISHED_REGISTRY) {
    if (f.publishedRegistry) { imageRegistry = f.publishedRegistry; derived.push(`images copied from ${imageRegistry} (${SOURCE}'s published images), or built when this version is not there`) }
    else if (f.publishedRegistry === null) derived.push(`images built in this account (${SOURCE} has published none yet)`)
  }
  return {
    answers: {
      ...a,
      github: { ...a.github, login },
      aws: { ...a.aws, region, account },
      agents: { ...a.agents, model, gpuEnabled, cpuEnabled, knowledgeBase, publishImages, imageRegistry },
      adminEmail,
    },
    derived, missing,
  }
}
