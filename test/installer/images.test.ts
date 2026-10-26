/**
 * The image builds' caching and published images (src/infra/images.ts), with the lock file an installed trace bundles
 * from (src/infra/lockfile.ts), and onboarding's git without the gh CLI (src/installer/onboard-api.ts).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { imageBuildEnv, imageBuildSpec, imageContentTag, prebuiltImage } from '../../src/infra/images.js'
import { lockFile } from '../../src/infra/lockfile.js'
import { gitEnv } from '../../src/installer/onboard-api.js'

const ROOT = join(import.meta.dirname, '..', '..')

describe('the images', () => {
  it('are copied from trace\'s published image for this exact source when there is one, else built from the cache', () => {
    const spec = JSON.stringify(imageBuildSpec({ dockerfile: 'agent/Dockerfile', platform: 'linux/arm64' }))
    expect(spec).toContain('docker pull --platform linux/arm64 \\"$PREBUILT_IMAGE\\"')
    expect(spec).toContain('--build-arg BUILDKIT_INLINE_CACHE=1 --cache-from \\"$REPOSITORY_URI:cache\\"')
    expect(spec).toContain('docker push \\"$REPOSITORY_URI:cache\\"')
    expect(imageBuildEnv({ source: 'prebuilt', registry: 'public.ecr.aws/x/trace' }, 'gpu', 'v1-abc')).toEqual({ PREBUILT_IMAGE: { value: 'public.ecr.aws/x/trace-gpu:v1-abc' } })
    expect(imageBuildEnv({ source: 'build', registry: 'public.ecr.aws/x/trace' }, 'gpu', 'v1-abc')).toEqual({ PREBUILT_IMAGE: { value: '' } })
    expect(prebuiltImage('r', 'agent', 't')).toBe('r-agent:t')
  })

  it('tag the published images by a hash of what goes into them, the same in a clone and an installed copy', () => {
    const tag = imageContentTag(ROOT)
    expect(tag).toMatch(/^v\d+\.\d+\.\d+-[0-9a-f]{16}$/)
    expect(imageContentTag(ROOT)).toBe(tag)
    // a copy with only what npm packs (no tests, no docs) has the same tag; a changed source file changes it
    const copy = mkdtempSync(join(tmpdir(), 'trace-pack-'))
    try {
      for (const f of ['package.json', 'tsconfig.json']) cpSync(join(ROOT, f), join(copy, f))
      for (const d of ['agent', 'python', 'scripts', 'harness', 'templates']) cpSync(join(ROOT, d), join(copy, d), { recursive: true, filter: (p) => !/node_modules|__pycache__|\/dist(\/|$)/.test(p) })
      mkdirSync(join(copy, 'src'))
      cpSync(join(ROOT, 'src'), join(copy, 'src'), { recursive: true })
      writeFileSync(join(copy, 'README.md'), 'not an image input')
      expect(imageContentTag(copy)).toBe(tag)
      writeFileSync(join(copy, 'src', 'cli.ts'), `${readFileSync(join(copy, 'src', 'cli.ts'), 'utf8')}\n// changed`)
      expect(imageContentTag(copy)).not.toBe(tag)
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })

  it('build from the lock file npm leaves out of an installed trace', () => {
    // scripts/stage-image.mjs (npm run build) copies it, and .npmrc, into agent/, which npm does pack
    expect(existsSync(join(ROOT, 'agent', 'package-lock.json'))).toBe(true)
    expect(existsSync(join(ROOT, 'agent', 'npmrc'))).toBe(true)
    for (const f of ['Dockerfile', 'Dockerfile.gpu']) expect(readFileSync(join(ROOT, 'agent', f), 'utf8')).toContain('COPY package.json agent/package-lock.json agent/npmrc ./')
    const installed = mkdtempSync(join(tmpdir(), 'trace-installed-'))
    try {
      mkdirSync(join(installed, 'agent'))
      expect(() => lockFile(installed)).toThrow(/no package-lock.json/)
      writeFileSync(join(installed, 'agent', 'package-lock.json'), '{}')
      expect(lockFile(installed)).toBe(join(installed, 'agent', 'package-lock.json'))
      writeFileSync(join(installed, 'package-lock.json'), '{}')
      expect(lockFile(installed)).toBe(join(installed, 'package-lock.json'))
    } finally {
      rmSync(installed, { recursive: true, force: true })
    }
  })
})

describe('onboarding without the gh CLI', () => {
  it('gives git the token in its environment only, and no credential helper', () => {
    const env = gitEnv('secret-token-value', 'marc')
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
    expect(Buffer.from((env.GIT_CONFIG_VALUE_0 ?? '').replace('AUTHORIZATION: basic ', ''), 'base64').toString()).toBe('x-access-token:secret-token-value')
    expect(env).toMatchObject({ GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_EMAIL: 'marc@users.noreply.github.com' })
  })
})
