/**
 * How the two images (the agent image, agent/Dockerfile, arm64; the GPU/CPU job image, agent/Dockerfile.gpu, amd64)
 * get into the account's ECR, fastest first:
 *
 *   prebuilt   images.source 'prebuilt' (the default): CodeBuild pulls trace's published image for exactly this
 *              source (`<images.registry>-agent:<content tag>`, `-gpu:`), re-tags it and pushes it to the
 *              installation's repository. Minutes instead of the build's 20–60. When there is no published image for
 *              this source (a local change, or nothing published yet), the pull fails and it builds instead.
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

/** Where trace's release workflow publishes its images (.github/workflows/release-images.yml): `<registry>-agent`
 * and `<registry>-gpu`. Nothing is published there until that workflow has run with its role; until then every pull
 * misses and the images are built, as before. */
export const PREBUILT_REGISTRY = 'public.ecr.aws/mteichtahl/trace'

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

export type ImageKind = 'agent' | 'gpu'

/** The published image for this content tag. */
export const prebuiltImage = (registry: string, kind: ImageKind, tag: string): string => `${registry}-${kind}:${tag}`

/**
 * The CodeBuild buildspec of one image: the published image when PREBUILT_IMAGE names one that exists, else a
 * cached build. REPOSITORY_URI and IMAGE_TAG come from the project and the build (src/infra/lambda/image-build.ts).
 */
export function imageBuildSpec(o: { dockerfile: string; platform: 'linux/arm64' | 'linux/amd64' }): Record<string, unknown> {
  const build = [
    'export DOCKER_BUILDKIT=1',
    'if [ -n "${PREBUILT_IMAGE:-}" ] && docker pull --platform ' + o.platform + ' "$PREBUILT_IMAGE"; then',
    '  echo "trace: using the published image $PREBUILT_IMAGE (no build needed)"',
    '  docker tag "$PREBUILT_IMAGE" "$REPOSITORY_URI:$IMAGE_TAG"',
    'else',
    '  [ -n "${PREBUILT_IMAGE:-}" ] && echo "trace: no published image $PREBUILT_IMAGE for this source: building it"',
    `  docker build --platform ${o.platform} --build-arg BUILDKIT_INLINE_CACHE=1 --cache-from "$REPOSITORY_URI:cache" -f ${o.dockerfile} -t "$REPOSITORY_URI:$IMAGE_TAG" -t "$REPOSITORY_URI:cache" .`,
    '  docker push "$REPOSITORY_URI:cache"',
    'fi',
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
  return { PREBUILT_IMAGE: { value: images.source === 'prebuilt' ? prebuiltImage(images.registry, kind, tag) : '' } }
}
