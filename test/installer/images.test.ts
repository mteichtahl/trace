/**
 * The image builds' caching and published images (src/infra/images.ts), with the lock file an installed trace bundles
 * from (src/infra/lockfile.ts), and onboarding's git without the gh CLI (src/installer/onboard-api.ts).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_IMAGE_MAX_BYTES, CRANE, imageBuildEnv, imageBuildSpec, imageContentTag, prebuiltImage } from '../../src/infra/images.js'
import { lockFile } from '../../src/infra/lockfile.js'
import { gitEnv } from '../../src/installer/onboard-api.js'
import { InfraPropsSchema, PUBLISHED_REGISTRY } from '../../src/infra/props.js'
import { AnswersSchema } from '../../src/installer/answers.js'
import { infraInput } from '../../src/installer/bootstrap.js'
import { ACCEPT, parseRef, resolveImage } from '../../scripts/resolve-image.mjs'
import { withoutCredentials } from '../../scripts/npmrc.mjs'
import { SOURCE_EXCLUDE } from '../../src/infra/stack.js'

const ROOT = join(import.meta.dirname, '..', '..')

describe('the images', () => {
  it('are copied from trace\'s published image for this exact source, pinned by digest, else built from the cache', () => {
    const spec = JSON.stringify(imageBuildSpec({ dockerfile: 'agent/Dockerfile', platform: 'linux/arm64' }))
    // the tag resolved to its digest first, the pull by that digest, and the digest checked again after it
    expect(spec).toContain('PINNED=\\"$(node scripts/resolve-image.mjs \\"$PREBUILT_IMAGE\\" || true)\\"')
    expect(spec).toContain('docker pull --platform linux/arm64 \\"$PINNED\\"')
    expect(spec).toContain('grep -qF \\"${PINNED##*@}\\"')
    expect(spec).toContain('docker tag \\"$PINNED\\" \\"$REPOSITORY_URI:$IMAGE_TAG\\"')
    // the fallback: a cached build
    expect(spec).toContain('--build-arg BUILDKIT_INLINE_CACHE=1 --cache-from \\"$REPOSITORY_URI:cache\\"')
    expect(spec).toContain('docker push \\"$REPOSITORY_URI:cache\\"')
    expect(prebuiltImage('public.ecr.aws/x', 'agent', 't')).toBe('public.ecr.aws/x/trace-agent:t')
  })

  it('copy a published image without a size limit registry to registry with a pinned, checked crane, else as before', () => {
    const spec = imageBuildSpec({ dockerfile: 'agent/Dockerfile.tools', platform: 'linux/arm64' }) as { phases: { build: { commands: string[] }; post_build: { commands: string[] } } }
    const build = spec.phases.build.commands.join('\n')
    // crane from its pinned release, used only once its SHA-256 matches, for both architectures the builds run on
    expect(build).toContain(`/releases/download/${CRANE.version}/go-containerregistry_Linux_$A.tar.gz`)
    expect(build).toContain('sha256sum -c --quiet -')
    for (const sum of Object.values(CRANE.sha256)) expect(sum).toMatch(/^[0-9a-f]{64}$/)
    expect(build).toContain(CRANE.sha256.arm64)
    expect(build).toContain(CRANE.sha256.x86_64)
    // just that platform's image, from the pinned digest, straight to the repository
    expect(build).toContain('crane copy --platform linux/arm64 "$PINNED" "$REPOSITORY_URI:$IMAGE_TAG"')
    // crane first, then docker's pull, then the build
    const at = (s: string): number => build.indexOf(s)
    expect(at('crane copy')).toBeLessThan(at('docker pull'))
    expect(at('docker pull')).toBeLessThan(at('docker build'))
    // nothing local to push after a copy; a pull or a build is pushed as before
    expect(spec.phases.post_build.commands).toEqual(['[ "$CODEBUILD_BUILD_SUCCEEDING" = 1 ] && { [ -f /tmp/trace-image-copied ] || docker push "$REPOSITORY_URI:$IMAGE_TAG"; }'])
    // the shell is POSIX (CodeBuild's Ubuntu images run it with dash)
    const sh = spawnSync('sh', ['-n'], { input: `${build}\n${spec.phases.post_build.commands.join('\n')}`, encoding: 'utf8' })
    expect(sh.status, sh.stderr).toBe(0)
    // the agent image's size is measured on a local image, so it is still pulled with docker
    const agent = JSON.stringify(imageBuildSpec({ dockerfile: 'agent/Dockerfile', platform: 'linux/arm64', maxBytes: AGENT_IMAGE_MAX_BYTES }))
    expect(agent).not.toContain('crane')
    expect(agent).toContain('docker pull --platform linux/arm64')
  })

  it('look for a published image only with images.source prebuilt and a registry to look in', () => {
    expect(imageBuildEnv({ source: 'prebuilt', registry: 'public.ecr.aws/x' }, 'gpu', 'v1-abc')).toEqual({ PREBUILT_IMAGE: { value: 'public.ecr.aws/x/trace-gpu:v1-abc' } })
    expect(imageBuildEnv({ source: 'build', registry: 'public.ecr.aws/x' }, 'gpu', 'v1-abc')).toEqual({ PREBUILT_IMAGE: { value: '' } })
    // nothing published yet (PUBLISHED_REGISTRY empty): always built
    expect(imageBuildEnv({ source: 'prebuilt', registry: '' }, 'agent', 'v1-abc')).toEqual({ PREBUILT_IMAGE: { value: '' } })
    const props = (images: unknown) => InfraPropsSchema.parse({ account: '123456789012', region: 'us-east-1', repositories: [], model: 'm.x', adminEmail: 'a@example.com', images }).images
    expect(props({})).toEqual({ source: 'prebuilt', registry: PUBLISHED_REGISTRY })
    expect(props({ registry: 'public.ecr.aws/a1b2c3d4' }).registry).toBe('public.ecr.aws/a1b2c3d4')
    expect(() => props({ registry: 'not a registry' })).toThrow(/public\.ecr\.aws\/<alias>/)
    // the installer's override (answers agents.imageRegistry), else the constant
    expect(infraInput(AnswersSchema.parse({ agents: { imageRegistry: 'public.ecr.aws/me' } })).images).toEqual({ source: 'prebuilt', registry: 'public.ecr.aws/me' })
    expect(infraInput(AnswersSchema.parse({ agents: { imageSource: 'build' } })).images).toEqual({ source: 'build' })
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

  it('build with build:image: the whole build but the installer page, whose web app components the image leaves out', () => {
    // scripts/bundle-ui.mjs bundles the installer page from web/src, which the image's source excludes (web/**) and an
    // installed trace never has: in the image it fails ("Could not resolve ./components/ui/badge"), and only
    // `tracectl install` serves the page
    const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    expect(scripts['build:image']).not.toContain('bundle-ui')
    // the same steps as build, which only adds the page, so the two never drift apart
    expect(scripts.build).toBe(`${scripts['build:image']} && node scripts/bundle-ui.mjs`)
    for (const f of ['Dockerfile', 'Dockerfile.tools', 'Dockerfile.gpu']) {
      const dockerfile = readFileSync(join(ROOT, 'agent', f), 'utf8')
      expect(dockerfile, f).toMatch(/^RUN npm run build:image\b/m)
      // no command runs the full build (a comment may still name it)
      expect(dockerfile, f).not.toMatch(/^RUN .*npm run build(?!:image)\b/m)
    }
  })

  it('keep each file of the agent image once, within what AgentCore Runtime accepts', () => {
    // AgentCore Runtime refuses an image over 2 GB ("maxImageSizeMb limit exceeded"). Two layers once stored
    // node_modules again: npm ci's, with the dev dependencies (about 1.4 GB, kept under the prune's deletions), and a
    // final `chown -R trace:trace /app` (which rewrites every file into a layer of its own, about 1.2 GB)
    const dockerfile = readFileSync(join(ROOT, 'agent', 'Dockerfile'), 'utf8')
    const stages = dockerfile.split(/^FROM /m).slice(1)
    expect(stages.map((x) => x.split('\n')[0])).toEqual(['--platform=linux/arm64 public.ecr.aws/docker/library/ubuntu:24.04 AS tools', 'tools AS build', 'tools'])
    const [, build, final] = stages as [string, string, string]
    // npm ci and the build happen in the build stage only
    expect(build).toMatch(/^RUN npm ci\b/m)
    expect(final).not.toMatch(/npm (ci|install|run)\b/)
    // the final stage copies the built app in already owned by trace, and never chowns it after
    expect(final).toContain('COPY --from=build --chown=trace:trace /app /app')
    expect(final).toContain('COPY --from=build /opt/trace-venv /opt/trace-venv')
    expect(dockerfile.split('\n').filter((l) => !l.trim().startsWith('#') && /chown -R/.test(l))).toEqual([])
    // the musl copy of the Claude binary (about 270 MB) is dropped, and the build fails if the glibc one is missing
    expect(build).toContain('rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl')
    expect(build).toContain('test -x node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude')
    // what runs it is in the final stage
    expect(final).toMatch(/^USER trace$/m)
    expect(final).toMatch(/^CMD \["node", "--require", .*"\/app\/dist\/agents\/runtime\/main\.js"\]$/m)
  })

  it('build cocotb from source on arm64, with the Python headers it needs, in the tools image', () => {
    // cocotb publishes no arm64 Linux wheel, so the tools image (linux/arm64) builds it from source, and its C++
    // extensions include Python.h: without python3-dev the build fails ("fatal error: Python.h: No such file or
    // directory", then "Could not build wheels for cocotb") and so does the deploy
    const dockerfile = readFileSync(join(ROOT, 'agent', 'Dockerfile.tools'), 'utf8')
    const headers = dockerfile.search(/apt-get install[^\n]*(\\\n[^\n]*)*\bpython3-dev\b/)
    expect(headers).toBeGreaterThan(-1)
    expect(dockerfile.indexOf("'cocotb==")).toBeGreaterThan(headers)
    // and no longer the agent image, whose venv is trace's own Python only
    expect(readFileSync(join(ROOT, 'agent', 'Dockerfile'), 'utf8')).not.toContain("'cocotb==")
  })

  it('leave the large programs out of the agent image, for the tools image, which has every one the jobs name', () => {
    const agent = readFileSync(join(ROOT, 'agent', 'Dockerfile'), 'utf8')
    const tools = readFileSync(join(ROOT, 'agent', 'Dockerfile.tools'), 'utf8')
    const installs = (d: string): string => d.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    for (const big of ['kicad', 'blender', 'yosys', 'nextpnr', 'calculix-ccx', 'ffmpeg', 'z3', 'fpga-icestorm']) {
      expect(installs(agent), big).not.toMatch(new RegExp(`\\b${big}\\b`))
      expect(installs(tools), big).toMatch(new RegExp(`\\b${big}\\b`))
    }
    // the co-simulation builds a Verilator model here (src/tools/ams/mixed.ts): Verilator and g++ stay
    expect(installs(agent)).toMatch(/\bverilator\b/)
    expect(installs(agent)).toMatch(/\bbuild-essential\b/)
    // the agent image says where they went, so its jobs of those kinds go to the queue without a tools function
    expect(agent).toMatch(/TRACE_TOOLS_ELSEWHERE=1/)
    // the CDK is dropped from both, and the build checks nothing they run imports it
    for (const d of [agent, tools]) {
      expect(d).toMatch(/rm -rf [^\n]*node_modules\/aws-cdk-lib node_modules\/aws-cdk node_modules\/@aws-cdk node_modules\/constructs/)
      expect(d).toMatch(/node scripts\/check-imports\.mjs /)
    }
    // the tools function runs the Lambda runtime, everything under /tmp (Lambda's only writable folder)
    expect(tools).toMatch(/^CMD \["node", "\/app\/dist\/gpu\/lambda\.js"\]$/m)
    expect(tools).toMatch(/HOME=\/tmp/)
    expect(tools.split(/^FROM /m).slice(1).map((x) => x.split('\n')[0])).toEqual(['--platform=linux/arm64 public.ecr.aws/docker/library/ubuntu:24.04 AS tools', 'tools AS build', 'tools'])
  })

  it('give the tools image every program the verification jobs take it to have (TOOLS_IMAGE_PROGRAMS)', async () => {
    const { TOOLS_IMAGE_PROGRAMS } = await import('../../src/tools/verify/job.js')
    const tools = readFileSync(join(ROOT, 'agent', 'Dockerfile.tools'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    const from: Record<string, string> = {
      yosys: 'yosys', 'yosys-smtbmc': 'yosys', 'yosys-abc': 'yosys', z3: 'z3', verilator: 'verilator',
      iverilog: 'iverilog', vvp: 'iverilog', 'cocotb-config': "'cocotb==", 'nextpnr-ice40': 'nextpnr-ice40',
      'nextpnr-ecp5': 'nextpnr-ecp5', 'nextpnr-gowin': 'nextpnr-gowin', icepack: 'fpga-icestorm', ecppack: 'fpga-trellis',
      gowin_pack: "'apycula==", ccx: 'calculix-ccx',
    }
    expect(Object.keys(from).sort()).toEqual([...TOOLS_IMAGE_PROGRAMS].sort())
    for (const [program, source] of Object.entries(from)) expect(tools, program).toContain(source)
  })

  it('fail the agent image\'s build over AgentCore\'s 2 GB, and only that image\'s', () => {
    const agent = JSON.stringify(imageBuildSpec({ dockerfile: 'agent/Dockerfile', platform: 'linux/arm64', maxBytes: AGENT_IMAGE_MAX_BYTES }))
    expect(agent).toContain('docker image inspect --format \\"{{.Size}}\\"')
    expect(agent).toContain(`-gt ${AGENT_IMAGE_MAX_BYTES} ]`)
    expect(AGENT_IMAGE_MAX_BYTES).toBeLessThanOrEqual(2_000_000_000)
    expect(JSON.stringify(imageBuildSpec({ dockerfile: 'agent/Dockerfile.tools', platform: 'linux/arm64' }))).not.toContain('{{.Size}}')
  })

  it('get the .npmrc\'s settings, never a credential in it, and the source sent to AWS leaves .npmrc out', () => {
    // a clone's .npmrc with a person's token: in the image it would sit in the build's layers, and once it expires
    // every npm ci there fails with E401 (public packages too)
    const local = ['legacy-peer-deps=true', '//registry.npmjs.org/:_authToken=npm_EXAMPLEEXAMPLEEXAMPLE', 'fund=false',
      '_auth = dXNlcjpwYXNz', '//npm.pkg.github.com/:_authToken=ghp_EXAMPLE', '@acme:registry=https://npm.pkg.github.com', 'email=me@example.com', '# a comment', ''].join('\n')
    const r = withoutCredentials(local)
    expect(r.text.split('\n')).toEqual(['legacy-peer-deps=true', 'fund=false', '@acme:registry=https://npm.pkg.github.com', '# a comment', ''])
    expect(r.dropped).toBe(4)
    expect(r.text).not.toMatch(/npm_EXAMPLE|ghp_EXAMPLE|dXNlcjpwYXNz|_auth/)
    // the repository's own .npmrc has no credential: staged as it is
    const own = readFileSync(join(ROOT, '.npmrc'), 'utf8')
    expect(withoutCredentials(own)).toEqual({ text: own, dropped: 0 })
    expect(readFileSync(join(ROOT, 'agent', 'npmrc'), 'utf8')).toBe(own)
    expect(SOURCE_EXCLUDE).toEqual(expect.arrayContaining(['.npmrc', '**/.npmrc']))
  })

  it('get trace\'s committed .npmrc, not a clone\'s local registry or token', () => {
    // a clone whose .npmrc a person pointed at a private registry with a token (CodeArtifact, a proxy): in the image
    // build npm would go there without the token and every npm ci fails with E401
    const clone = mkdtempSync(join(tmpdir(), 'trace-clone-'))
    try {
      mkdirSync(join(clone, 'scripts'))
      mkdirSync(join(clone, 'agent'))
      for (const f of ['stage-image.mjs', 'npmrc.mjs']) cpSync(join(ROOT, 'scripts', f), join(clone, 'scripts', f))
      writeFileSync(join(clone, 'package-lock.json'), '{}')
      writeFileSync(join(clone, '.npmrc'), 'legacy-peer-deps=true\nfund=false\n')
      const git = (...a: string[]): void => { execFileSync('git', ['-C', clone, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { stdio: 'ignore' }) }
      git('init', '-q')
      git('add', '.')
      git('commit', '-q', '-m', 'trace')
      writeFileSync(join(clone, '.npmrc'), 'legacy-peer-deps=true\nfund=false\nregistry=https://acme-123456789012.d.codeartifact.us-east-1.amazonaws.com/npm/shared/\n//acme-123456789012.d.codeartifact.us-east-1.amazonaws.com/npm/shared/:_authToken=eyJEXAMPLE\n')
      const r = spawnSync(process.execPath, [join(clone, 'scripts', 'stage-image.mjs')], { encoding: 'utf8' })
      expect(r.status).toBe(0)
      expect(r.stderr).toMatch(/local changes; the images get trace's committed .npmrc/)
      expect(readFileSync(join(clone, 'agent', 'npmrc'), 'utf8')).toBe('legacy-peer-deps=true\nfund=false\n')
      expect(readFileSync(join(clone, 'agent', 'package-lock.json'), 'utf8')).toBe('{}')
    } finally { rmSync(clone, { recursive: true, force: true }) }
  })

  it('get the committed lock while package.json is as committed, and warn of a lock resolving from a private registry', () => {
    // npm install with a private registry in ~/.npmrc rewrites the lock's resolved URLs to it: npm ci in the image build
    // then fetches from there without a token (E401)
    const clone = mkdtempSync(join(tmpdir(), 'trace-clone-'))
    const PUBLIC = '{"packages":{"node_modules/zod":{"resolved":"https://registry.npmjs.org/zod/-/zod-4.0.0.tgz"}}}\n'
    const PRIVATE = PUBLIC.replace('https://registry.npmjs.org/', 'https://acme-123456789012.d.codeartifact.us-east-1.amazonaws.com/npm/shared/')
    try {
      mkdirSync(join(clone, 'scripts'))
      mkdirSync(join(clone, 'agent'))
      for (const f of ['stage-image.mjs', 'npmrc.mjs']) cpSync(join(ROOT, 'scripts', f), join(clone, 'scripts', f))
      writeFileSync(join(clone, 'package.json'), '{"name":"t","dependencies":{"zod":"4.0.0"}}\n')
      writeFileSync(join(clone, 'package-lock.json'), PUBLIC)
      writeFileSync(join(clone, '.npmrc'), 'fund=false\n')
      const git = (...a: string[]): void => { execFileSync('git', ['-C', clone, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { stdio: 'ignore' }) }
      git('init', '-q')
      git('add', '.')
      git('commit', '-q', '-m', 'trace')
      const stage = (): { status: number | null; stderr: string } => spawnSync(process.execPath, [join(clone, 'scripts', 'stage-image.mjs')], { encoding: 'utf8' })
      // the lock rewritten locally, package.json as committed: the committed lock
      writeFileSync(join(clone, 'package-lock.json'), PRIVATE)
      let r = stage()
      expect(r.status).toBe(0)
      expect(r.stderr).toMatch(/package-lock.json has local changes; the images get the committed lock/)
      expect(r.stderr).not.toMatch(/WARNING/)
      expect(readFileSync(join(clone, 'agent', 'package-lock.json'), 'utf8')).toBe(PUBLIC)
      // dependencies changed locally: the clone's own lock, and a warning that names the registry
      writeFileSync(join(clone, 'package.json'), '{"name":"t","dependencies":{"zod":"4.0.1"}}\n')
      r = stage()
      expect(r.status).toBe(0)
      expect(r.stderr).toMatch(/WARNING agent\/package-lock.json resolves packages from https:\/\/acme-123456789012\.d\.codeartifact/)
      expect(readFileSync(join(clone, 'agent', 'package-lock.json'), 'utf8')).toBe(PRIVATE)
    } finally { rmSync(clone, { recursive: true, force: true }) }
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

describe('pinning a published image to its digest (scripts/resolve-image.mjs)', () => {
  const REF = 'public.ecr.aws/a1b2c3d4/trace-agent:v0.1.0-0123456789abcdef'
  const MANIFEST = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] }))
  const DIGEST = `sha256:${createHash('sha256').update(MANIFEST).digest('hex')}`
  /** ECR Public's registry API: a pull token, then the tag's manifest (or a 404), stating `stated` as its digest */
  const registry = (o: { status?: number; stated?: string; down?: boolean } = {}) => {
    const asked: { url: string; headers: Record<string, string> }[] = []
    const f = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (o.down) throw new Error('getaddrinfo ENOTFOUND public.ecr.aws')
      asked.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
      if (String(url).includes('/token/')) return new Response(JSON.stringify({ token: 'anon' }), { status: 200 })
      if (o.status && o.status !== 200) return new Response('{}', { status: o.status })
      return new Response(MANIFEST, { status: 200, headers: { 'docker-content-digest': o.stated ?? DIGEST } })
    }
    return { asked, fetch: f as typeof fetch }
  }

  it('resolves the tag to the digest its manifest hashes to, asking anonymously for every manifest kind', async () => {
    const r = registry()
    expect(await resolveImage(REF, r.fetch)).toEqual({ digest: DIGEST, pinned: `public.ecr.aws/a1b2c3d4/trace-agent@${DIGEST}` })
    expect(r.asked[0]?.url).toBe('https://public.ecr.aws/token/?scope=repository:a1b2c3d4/trace-agent:pull')
    expect(r.asked[1]?.url).toBe('https://public.ecr.aws/v2/a1b2c3d4/trace-agent/manifests/v0.1.0-0123456789abcdef')
    expect(r.asked[1]?.headers).toEqual({ Accept: ACCEPT, Authorization: 'Bearer anon' })
    expect(ACCEPT).toContain('application/vnd.oci.image.index.v1+json')
  })

  it('refuses a digest that does not match the manifest, and reports an unpublished tag or an unreachable registry (then it builds)', async () => {
    expect(await resolveImage(REF, registry({ stated: `sha256:${'0'.repeat(64)}` }).fetch)).toEqual({ missing: expect.stringMatching(/states sha256:0+ but its manifest hashes to sha256:/) })
    expect(await resolveImage(REF, registry({ status: 404 }).fetch)).toEqual({ missing: `${REF} is not published` })
    expect(await resolveImage(REF, registry({ status: 500 }).fetch)).toEqual({ missing: expect.stringMatching(/answered 500/) })
    expect(await resolveImage(REF, registry({ down: true }).fetch)).toEqual({ missing: expect.stringMatching(/can't be reached/) })
    expect(parseRef('public.ecr.aws/a/trace-gpu@sha256:abc')).toBeNull()
    expect(parseRef(REF)).toEqual({ host: 'public.ecr.aws', repository: 'a1b2c3d4/trace-agent', tag: 'v0.1.0-0123456789abcdef' })
  })
})
