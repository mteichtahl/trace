/**
 * The dependency hygiene behind .github/dependabot.yml: security updates that cannot succeed are ignored with a
 * reason, and packages that only dragged vulnerable transitive dependencies in are gone.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const root = join(import.meta.dirname, '..', '..')
const Lock = z.object({ packages: z.record(z.string(), z.object({ version: z.string().optional(), dependencies: z.record(z.string(), z.string()).optional() }).loose()) }).loose()
const Pkg = z.object({ dependencies: z.record(z.string(), z.string()), devDependencies: z.record(z.string(), z.string()) }).loose()

describe('dependencies', () => {
  const lock = Lock.parse(JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')))
  const pkg = Pkg.parse(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')))
  const dependabot = readFileSync(join(root, '.github', 'dependabot.yml'), 'utf8')

  it('no longer carries undici 5 or @fastify/busboy (they came only through the unused @actions/* packages)', () => {
    for (const name of ['@actions/core', '@actions/github']) {
      expect(pkg.devDependencies[name]).toBeUndefined()
      expect(pkg.dependencies[name]).toBeUndefined()
    }
    const names = Object.keys(lock.packages)
    expect(names.filter((p) => /node_modules\/(undici|@fastify\/busboy|@actions\/[^/]+)$/.test(p))).toEqual([])
  })

  it('ignores the OpenTelemetry instrumentations only while ADOT pins them, and groups the big families', () => {
    // the reason holds: the ADOT version in use pins auto-instrumentations-node exactly
    const adot = lock.packages['node_modules/@aws/aws-distro-opentelemetry-node-autoinstrumentation']
    expect(adot?.dependencies?.['@opentelemetry/auto-instrumentations-node']).toMatch(/^\d/)
    expect(dependabot).toContain(`@aws/aws-distro-opentelemetry-node-autoinstrumentation ${adot?.version}`)
    expect(dependabot).toMatch(/- dependency-name: '@opentelemetry\/instrumentation-\*'/)
    expect(dependabot).toMatch(/applies-to: security-updates/)
    expect(dependabot).toMatch(/open-pull-requests-limit: \d/)
    for (const eco of ['npm', 'pip', 'github-actions']) expect(dependabot).toContain(`package-ecosystem: ${eco}`)
  })

  it('installs without deprecation warnings except the three ADOT pins, each installed once', () => {
    const adot = lock.packages['node_modules/@aws/aws-distro-opentelemetry-node-autoinstrumentation']
    const overrides = z.record(z.string(), z.string()).parse((pkg as { overrides?: unknown }).overrides ?? {})
    // the overrides collapse ADOT's copies into one; they must track the version ADOT pins
    expect(overrides['@opentelemetry/sdk-trace-base']).toBe(adot?.dependencies?.['@opentelemetry/sdk-trace-base'])
    // trace's own tests use the replacement, not the deprecated package
    expect(pkg.devDependencies['@opentelemetry/sdk-trace-base']).toBeUndefined()
    expect(pkg.devDependencies['@types/libsodium-wrappers']).toBeUndefined()
    const deprecated = Object.entries(lock.packages)
      .filter(([, v]) => typeof (v as { deprecated?: unknown }).deprecated === 'string')
      .map(([k]) => k.replace(/^.*node_modules\//, ''))
      .sort()
    expect(deprecated).toEqual(['@opentelemetry/propagator-jaeger', '@opentelemetry/sdk-trace-base', '@opentelemetry/sdk-trace-node'])
    expect(dependabot).toMatch(/deprecat/i)
  })
})
