/**
 * The custom resource that builds the agent's container image: CloudFormation can't wait for a CodeBuild build by
 * itself, so `onEvent` starts the build and `isComplete` polls it until the image is in ECR. The image is tagged with
 * the source asset's hash, so an unchanged source never rebuilds and a changed one always does.
 *
 * `Wait: 'false'` (the GPU image, src/infra/gpu.ts) starts the build and does not wait for it: a failed GPU image
 * build then cannot fail the deploy and roll back the core with it. The installer waits for that build afterwards
 * (its id is the resource's BuildId) and starts it again if it failed (src/installer/aws.ts ensureGpuImage).
 */
import { BatchGetBuildsCommand, CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild'
import type { CloudFormationCustomResourceEvent } from 'aws-lambda'

const cb = new CodeBuildClient({})

interface Props { ProjectName: string; ImageUri: string; SourceHash: string; Wait: boolean }

const props = (e: CloudFormationCustomResourceEvent): Props => {
  const p = e.ResourceProperties as unknown as Partial<Props>
  if (!p.ProjectName || !p.ImageUri || !p.SourceHash) throw new Error('ProjectName, ImageUri and SourceHash are required')
  return { ProjectName: p.ProjectName, ImageUri: p.ImageUri, SourceHash: p.SourceHash, Wait: String(p.Wait ?? 'true') !== 'false' }
}

export async function onEvent(event: CloudFormationCustomResourceEvent): Promise<{ PhysicalResourceId: string; Data?: Record<string, string> }> {
  const p = props(event)
  if (event.RequestType === 'Delete') return { PhysicalResourceId: event.PhysicalResourceId }
  const r = await cb.send(new StartBuildCommand({ projectName: p.ProjectName, environmentVariablesOverride: [{ name: 'IMAGE_TAG', value: p.SourceHash }] }))
  const id = r.build?.id
  if (!id) throw new Error('CodeBuild started no build')
  return { PhysicalResourceId: `${p.ImageUri}#${id}`, Data: { ImageUri: p.ImageUri, BuildId: id } }
}

export async function isComplete(event: CloudFormationCustomResourceEvent & { PhysicalResourceId?: string }): Promise<{ IsComplete: boolean; Data?: Record<string, string> }> {
  if (event.RequestType === 'Delete') return { IsComplete: true }
  const buildId = (event.PhysicalResourceId ?? '').split('#')[1]
  if (!buildId) throw new Error('no build id on the resource')
  if (!props(event).Wait) return { IsComplete: true, Data: { ImageUri: props(event).ImageUri, BuildId: buildId } }
  const b = (await cb.send(new BatchGetBuildsCommand({ ids: [buildId] }))).builds?.[0]
  const status = b?.buildStatus
  if (status === 'IN_PROGRESS' || !status) return { IsComplete: false }
  if (status !== 'SUCCEEDED') {
    const phase = b?.phases?.find((ph) => ph.phaseStatus && ph.phaseStatus !== 'SUCCEEDED')
    throw new Error(`the image build ${status.toLowerCase()} in ${phase?.phaseType ?? 'an unknown phase'}: ${phase?.contexts?.map((c) => c.message).join('; ') ?? ''} (logs: ${b?.logs?.deepLink ?? 'CodeBuild console'})`)
  }
  return { IsComplete: true, Data: { ImageUri: props(event).ImageUri, BuildId: buildId } }
}
