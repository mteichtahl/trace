/**
 * How the three images (the agent image, agent/Dockerfile, arm64; the tools image, agent/Dockerfile.tools, arm64, run
 * by each project's tools function; the GPU/CPU job image, agent/Dockerfile.gpu, amd64) get into the account's ECR,
 * fastest first:
 *
 *   prebuilt   images.source 'prebuilt' (the default): CodeBuild copies trace's published image for exactly this
 *              source (`<images.registry>/trace-agent:<content tag>`, `/trace-tools:`, `/trace-gpu:`, on Amazon ECR Public) into the
 *              installation's own private repository: scripts/resolve-image.mjs reads the tag's digest from the
 *              registry and checks it against the manifest's bytes, the image is pulled by that digest (pinned: a tag
 *              moved meanwhile can't change what is copied), its digest checked again after the pull, re-tagged and
 *              pushed. Minutes instead of the build's 20–60. When the tag is not published (an unreleased commit, a
 *              fork, or nothing published yet: no registry found) it builds instead.
 *
 *              Copied rather than run from ECR Public, although AgentCore's containerUri accepts public.ecr.aws: the
 *              runtimes and the Batch jobs then pull from the account's own registry in their region (no public pull
 *              rate limits, no dependence on the public registry at every cold start, and the image stays when a
 *              release is withdrawn), and the repository keeps its lifecycle rule (the last 10 images).
 *   build      docker build, with BuildKit's inline cache: the previous image (`:cache`) is the cache, so a rebuild
 *              after an upgrade redoes only the layers whose inputs changed (the apt layers stay), and CodeBuild's
 *              local Docker layer cache helps a build soon after another on the same host.
 *
 * The content tag is a hash of what goes into the images (imageContentTag), computed the same way by the stack (at
 * synth time) and by trace's release workflow (scripts/image-tag.mjs) before it publishes, so an installed trace
 * finds its own version's images and a modified one never takes an image that is not its own.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type * as codebuild from 'aws-cdk-lib/aws-codebuild'

/** What the images are built from, relative to the repository root, in both a clone and an installed trace. */
export const IMAGE_INPUTS = ['package.json', 'tsconfig.json', 'agent', 'src', 'python', 'scripts', 'harness', 'templates'] as const
const SKIP = new Set(['node_modules', 'dist', '__pycache__', '.venv', '.pytest_cache', 'tests', '.git'])

function files(root: string, rel: string, out: string[]): void {
  const p = join(root, rel)
  if (!existsSync(p)) return
  if (statSync(p).isDirectory()) {
    for (const name of readdirSync(p).sort()) {
      if (SKIP.has(name) || name.endsWith('.pyc') || name.endsWith('.egg-info')) continue
      files(root, rel ? `${rel}/${name}` : name, out)
    }
  } else out.push(rel)
}

/** The content tag of the images built from `root`: `v<version>-<16 hex of sha256 over every input's path and bytes>`. */
export function imageContentTag(root: string): string {
  const list: string[] = []
  for (const r of IMAGE_INPUTS) files(root, r, list)
  const h = createHash('sha256')
  for (const f of list.sort()) {
    h.update(`${relative(root, join(root, f)).split('\\').join('/')}\0`)
    h.update(readFileSync(join(root, f)))
    h.update('\0')
  }
  const version = String((JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }).version ?? '0.0.0')
  return `v${version}-${h.digest('hex').slice(0, 16)}`
}

export type ImageKind = 'agent' | 'gpu' | 'tools'

/** AgentCore Runtime refuses an image over 2 GB (not adjustable): the agent image's build fails first, with its size,
 * instead of the deploy failing after it. Docker's size is the unpacked one, larger than the registry's compressed
 * size, so an image under this is under AgentCore's limit whichever of the two it counts. */
export const AGENT_IMAGE_MAX_BYTES = 2_000_000_000

/** The published image for this content tag (the repositories of src/infra/release.ts). */
export const prebuiltImage = (registry: string, kind: ImageKind, tag: string): string => `${registry}/trace-${kind}:${tag}`

/**
 * The CodeBuild buildspec of one image: the published image when PREBUILT_IMAGE names one that exists, else a
 * cached build. REPOSITORY_URI and IMAGE_TAG come from the project and the build (src/infra/lambda/image-build.ts).
 */
export function imageBuildSpec(o: { dockerfile: string; platform: 'linux/arm64' | 'linux/amd64'; maxBytes?: number }): Record<string, unknown> {
  const build = [
    'export DOCKER_BUILDKIT=1',
    // the tag's digest, checked against the published manifest (exit 3: not published, so build)
    'PINNED=""',
    '[ -n "${PREBUILT_IMAGE:-}" ] && PINNED="$(node scripts/resolve-image.mjs "$PREBUILT_IMAGE" || true)"',
    'if [ -n "$PINNED" ] && docker pull --platform ' + o.platform + ' "$PINNED" && docker image inspect --format "{{json .RepoDigests}}" "$PINNED" | grep -qF "${PINNED##*@}"; then',
    '  echo "trace: copying the published image $PREBUILT_IMAGE, pinned to $PINNED (no build needed)"',
    '  docker tag "$PINNED" "$REPOSITORY_URI:$IMAGE_TAG"',
    'else',
    '  [ -n "${PREBUILT_IMAGE:-}" ] && echo "trace: no published image $PREBUILT_IMAGE for this source (or its digest did not match): building it"',
    `  docker build --platform ${o.platform} --build-arg BUILDKIT_INLINE_CACHE=1 --cache-from "$REPOSITORY_URI:cache" -f ${o.dockerfile} -t "$REPOSITORY_URI:$IMAGE_TAG" -t "$REPOSITORY_URI:cache" .`,
    '  docker push "$REPOSITORY_URI:cache"',
    'fi',
    ...(o.maxBytes ? [
      'SIZE="$(docker image inspect --format "{{.Size}}" "$REPOSITORY_URI:$IMAGE_TAG")"',
      `echo "trace: the image is $SIZE bytes unpacked (at most ${o.maxBytes})"`,
      `if [ "$SIZE" -gt ${o.maxBytes} ]; then echo "trace: the image is over ${o.maxBytes} bytes, more than AgentCore Runtime accepts (2 GB): move the largest programs to agent/Dockerfile.tools"; docker history --no-trunc --format "{{.Size}}\t{{.CreatedBy}}" "$REPOSITORY_URI:$IMAGE_TAG" | head -20 | cut -c1-200; exit 1; fi`,
    ] : []),
  ].join('\n')
  return {
    version: '0.2',
    phases: {
      pre_build: { commands: ['aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${REPOSITORY_URI%%/*}"'] },
      build: { commands: [build] },
      post_build: { commands: ['[ "$CODEBUILD_BUILD_SUCCEEDING" = 1 ] && docker push "$REPOSITORY_URI:$IMAGE_TAG"'] },
    },
  }
}

/** The project environment variables for an image's build: where to look for the published image (or none). */
export function imageBuildEnv(images: { source: 'prebuilt' | 'build'; registry: string }, kind: ImageKind, tag: string): Record<string, codebuild.BuildEnvironmentVariable> {
  return { PREBUILT_IMAGE: { value: images.source === 'prebuilt' && images.registry ? prebuiltImage(images.registry, kind, tag) : '' } }
}
