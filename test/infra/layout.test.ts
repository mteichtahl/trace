import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { InfraPropsSchema, PARENT_PROJECT_OUTPUTS, projectHash, projectOutputs } from '../../src/infra/props.js'
import { TraceStack } from '../../src/infra/stack.js'
import { nestedOf, nestedResourceId, synth } from './templates.js'

const A = 'mteichtahl/trace'
const B = 'pokeys-toolkit/potroller'
const HA = projectHash(A)
const HB = projectHash(B)

const base = {
  account: '123456789012', region: 'us-east-1', repositories: [A, `${B}@develop`],
  model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com',
}
const repos = (n: number): string[] => Array.from({ length: n }, (_, i) => `owner-${i}/repository-${i}`)

type Res = { Type: string; Properties?: Record<string, unknown>; DeletionPolicy?: string; UpdateReplacePolicy?: string }
type Tpl = { Resources: Record<string, Res>; Outputs?: Record<string, unknown>; Parameters?: Record<string, unknown> }
const json = (t: Template): Tpl => t.toJSON() as Tpl
const count = (o: object | undefined): number => Object.keys(o ?? {}).length

/** Every Ref and Fn::GetAtt target in a value. */
function targets(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) targets(x, out)
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'Ref' && typeof x === 'string') out.add(x)
      else if (k === 'Fn::GetAtt' && Array.isArray(x)) out.add(String(x[0]))
      else targets(x, out)
    }
  }
  return out
}

/**
 * What a resource is, apart from the names of what it refers to: its type, policies, and properties, with every
 * reference replaced by the type and attribute of what it reaches. A nested stack's parameter is followed to the
 * parent's value for it, so a flat GetAtt of the bucket and a nested Ref of the bucket's parameter compare equal.
 */
function shape(r: Res, tpl: Tpl, parent?: { tpl: Tpl; params: Record<string, unknown> }): string {
  const target = (v: unknown, t: Tpl, up?: typeof parent): unknown => {
    const o = v as Record<string, unknown>
    if (typeof o.Ref === 'string') {
      if (o.Ref.startsWith('AWS::')) return o
      if (t.Resources[o.Ref]) return { to: t.Resources[o.Ref]?.Type, attr: 'Ref' }
      if (up && o.Ref in up.params) return target(up.params[o.Ref], up.tpl)
      return { unresolved: o.Ref }
    }
    const [id = '', attr = ''] = o['Fn::GetAtt'] as string[]
    return { to: t.Resources[id]?.Type ?? `?${id}`, attr }
  }
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip)
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (Object.keys(o).length === 1 && ('Ref' in o || 'Fn::GetAtt' in o)) return target(o, tpl, parent)
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, strip(x)]))
    }
    return v
  }
  return JSON.stringify({ Type: r.Type, DeletionPolicy: r.DeletionPolicy, UpdateReplacePolicy: r.UpdateReplacePolicy, Properties: strip(r.Properties) })
}

describe('the nested layout', () => {
  it('keeps the parent to one resource and three outputs per project, so 60 fit, and each nested stack is small', () => {
    // every option that adds to the parent on: memory, GPU, observability, dashboard, and the legacy memory
    const cfg = (n: number) => InfraPropsSchema.parse({ ...base, repositories: repos(n), memory: { legacySharedMemory: true } })
    const sizes = [1, 24, 60].map((n) => {
      const s = synth(cfg(n), `Count${n}`)
      const p = json(s.parent)
      expect(s.nested.size).toBe(n)
      for (const t of s.nested.values()) {
        const j = json(t)
        expect(count(j.Resources)).toBe(17)
        expect(count(j.Outputs)).toBeLessThanOrEqual(200)
        expect(count(j.Parameters)).toBeLessThanOrEqual(200)
      }
      // CDK moves what no longer fits the API role's inline policy (every memory's ARN) into a managed policy
      const overflow = Object.keys(s.parent.findResources('AWS::IAM::ManagedPolicy'))
      for (const id of overflow) expect(id).toMatch(/^ApiRuntimeRoleOverflowPolicy/)
      return { n, resources: count(p.Resources) - overflow.length, outputs: count(p.Outputs), stacks: count(s.parent.findResources('AWS::CloudFormation::Stack')), overflow: overflow.length }
    })
    const one = sizes[0]
    for (const z of sizes) {
      expect(z.stacks).toBe(z.n)
      // one resource per project (its AWS::CloudFormation::Stack), three outputs per project
      expect(z.resources - z.n).toBe((one?.resources ?? 0) - 1)
      expect(z.outputs - 3 * z.n).toBe((one?.outputs ?? 0) - 3)
      expect(z.resources).toBeLessThan(500)
      expect(z.outputs).toBeLessThanOrEqual(200)
    }
    expect(sizes.map((z) => `${z.n}:${z.resources + z.overflow}/${z.outputs}`)).toEqual(['1:83/20', '24:106/89', '60:143/197'])
    expect(PARENT_PROJECT_OUTPUTS).toHaveLength(3)
  }, 900_000)

  it('refuses at synth time a flat stack CloudFormation would refuse, and says why', () => {
    expect(() => synth(InfraPropsSchema.parse({ ...base, layout: 'flat', repositories: repos(24) }), 'Flat24')).not.toThrow()
    expect(() => synth(InfraPropsSchema.parse({ ...base, layout: 'flat', repositories: repos(60) }), 'Flat60')).toThrow(/would have \d+ resources \(CloudFormation allows 500 per template\): with layout 'flat' about 24 projects fit/)
  }, 900_000)

  it("joins each nested stack to the parent by parameters, and a project's stack reaches only that project's resources", () => {
    const s = synth(InfraPropsSchema.parse(base), 'Isolated')
    const parent = json(s.parent)
    for (const [repo, h, other, oh] of [[A, HA, B, HB], [B, HB, A, HA]] as const) {
      const n = json(nestedOf(s, repo))
      const own = new Set([...Object.keys(n.Resources), ...Object.keys(n.Parameters ?? {})])
      // every reference inside it is to its own resources or its parameters (and pseudo parameters)
      for (const tgt of targets(n.Resources)) if (!tgt.startsWith('AWS::')) expect(own.has(tgt), `${h}: ${tgt}`).toBe(true)
      // its parameters are the parent's shared resources only: never the other project's nested stack
      const params = (parent.Resources[nestedResourceId(s, h)]?.Properties?.Parameters ?? {}) as Record<string, unknown>
      const from = [...targets(params)]
      expect(from.length).toBeGreaterThan(0)
      for (const tgt of from) {
        expect(parent.Resources[tgt], tgt).toBeDefined()
        expect(parent.Resources[tgt]?.Type).not.toBe('AWS::CloudFormation::Stack')
      }
      expect(JSON.stringify(params)).not.toContain(oh)
      // its roles' policies name nothing of the other project
      const policies = JSON.stringify(Object.values(n.Resources).filter((r) => r.Type === 'AWS::IAM::Policy'))
      expect(policies).not.toContain(oh)
      expect(policies).not.toContain(other)
      expect(policies).toContain(`/projects/${repo}/*`)
    }
    // the parent holds nothing of any project but its nested stack
    for (const t of ['AWS::BedrockAgentCore::Memory', 'AWS::Batch::JobDefinition', 'AWS::Logs::DeliverySource', 'AWS::Logs::Delivery']) s.parent.resourceCountIs(t, 0)
    s.parent.resourceCountIs('AWS::SecretsManager::Secret', 1) // the API's
    s.parent.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1) // the API
    expect(Object.keys(parent.Resources).filter((id) => /^Project[0-9a-f]{8}/.test(id) && parent.Resources[id]?.Type !== 'AWS::CloudFormation::Stack')).toEqual([])
  }, 300_000)

  it('makes every project resource the same as the flat layout does: names, IAM, removal policies', () => {
    for (const retainData of [true, false]) {
      const nested = synth(InfraPropsSchema.parse({ ...base, retainData }), `SameNested${retainData}`)
      const flat = synth(InfraPropsSchema.parse({ ...base, retainData, layout: 'flat' }), `SameFlat${retainData}`)
      expect(flat.nested.size).toBe(0)
      const fp = json(flat.parent)
      for (const [repo, h] of [[A, HA], [B, HB]] as const) {
        // flat: the project's construct, and its memory's delivery under Observability
        const flatOwn = Object.entries(fp.Resources).filter(([id]) => id.startsWith(`Project${h}`) || id.startsWith(`ObservabilityProject${h}`))
        const nt = json(nestedOf(nested, repo))
        const nestedOwn = Object.entries(nt.Resources)
        const params = (json(nested.parent).Resources[nestedResourceId(nested, h)]?.Properties?.Parameters ?? {}) as Record<string, unknown>
        expect(nestedOwn.length).toBe(flatOwn.length)
        expect(nestedOwn.map(([, r]) => shape(r, nt, { tpl: json(nested.parent), params })).sort()).toEqual(flatOwn.map(([, r]) => shape(r, fp)).sort())
        // and the logical ids inside the nested template are the flat ones, but for the delivery's
        const strip = (id: string): string => id.replace(/^Observability/, '')
        expect(nestedOwn.map(([id]) => id.replace(/[0-9A-F]{8}$/, '')).sort()).toEqual(flatOwn.map(([id]) => strip(id).replace(/[0-9A-F]{8}$/, '')).sort())
      }
      // the memories and their deliveries follow retainData inside the nested stacks
      for (const t of nested.nested.values()) {
        for (const kind of ['AWS::BedrockAgentCore::Memory', 'AWS::Logs::DeliverySource', 'AWS::Logs::DeliveryDestination', 'AWS::Logs::Delivery', 'AWS::Logs::LogGroup']) {
          for (const r of Object.values(t.findResources(kind) as Record<string, Res>)) expect(r.DeletionPolicy, kind).toBe(retainData ? 'Retain' : 'Delete')
        }
        for (const r of Object.values(t.findResources('AWS::SecretsManager::Secret') as Record<string, Res>)) expect(r.DeletionPolicy).toBe('Delete')
      }
      // removing a project deletes its nested stack (whose resources then follow their own policies)
      for (const r of Object.values(nested.parent.findResources('AWS::CloudFormation::Stack') as Record<string, Res>)) expect(r.DeletionPolicy).toBe('Delete')
    }
  }, 900_000)

  it('ships each nested template as a file asset in the CDK bootstrap bucket, as the agent source already is', () => {
    const out = mkdtempSync(join(tmpdir(), 'trace-cdk-out-'))
    const app = new App({ outdir: out })
    new TraceStack(app, 'TraceStack', InfraPropsSchema.parse(base))
    app.synth()
    const assets = JSON.parse(readFileSync(join(out, 'TraceStack.assets.json'), 'utf8')) as { files: Record<string, { source: { path: string; packaging: string }; destinations: Record<string, { bucketName: string; assumeRoleArn: string }> }> }
    const nested = Object.values(assets.files).filter((f) => f.source.path.endsWith('.nested.template.json'))
    expect(nested).toHaveLength(2)
    const source = Object.values(assets.files).find((f) => f.source.packaging === 'zip' || !f.source.path.endsWith('.json'))
    for (const f of nested) {
      const d = Object.values(f.destinations)[0]
      expect(d?.bucketName).toBe('cdk-hnb659fds-assets-123456789012-us-east-1')
      expect(d?.assumeRoleArn).toContain('cdk-hnb659fds-file-publishing-role-123456789012-us-east-1')
      expect(Object.values(source?.destinations ?? {})[0]?.bucketName).toBe(d?.bucketName)
    }
    // the same bootstrap version as before nested stacks
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { artifacts: Record<string, { properties?: { requiresBootstrapStackVersion?: number } }> }
    expect(manifest.artifacts.TraceStack?.properties?.requiresBootstrapStackVersion).toBe(6)
  }, 300_000)
})

describe('the flat layout and the move to nested stacks', () => {
  it('keeps every project in the parent, with every output, for installations made before nested stacks', () => {
    const s = synth(InfraPropsSchema.parse({ ...base, layout: 'flat' }), 'Flat')
    expect(s.nested.size).toBe(0)
    const outputs = json(s.parent).Outputs ?? {}
    expect((outputs as Record<string, { Value: unknown }>).Layout?.Value).toBe('flat')
    for (const repo of [A, B]) for (const o of Object.values(projectOutputs(repo))) expect(outputs).toHaveProperty(o)
    s.parent.resourceCountIs('AWS::BedrockAgentCore::Runtime', 3)
    s.parent.resourceCountIs('AWS::BedrockAgentCore::Memory', 2)
  }, 300_000)

  it("release: the same stack, each project's memory and delivery now Delete, its log group as retainData says", () => {
    const flat = json(synth(InfraPropsSchema.parse({ ...base, layout: 'flat' })).parent)
    const rel = json(synth(InfraPropsSchema.parse({ ...base, layout: 'flat', layoutMigration: 'release' })).parent)
    expect(Object.keys(rel.Resources).sort()).toEqual(Object.keys(flat.Resources).sort())
    for (const [id, r] of Object.entries(rel.Resources)) {
      const was = flat.Resources[id]
      const released = ['AWS::BedrockAgentCore::Memory', 'AWS::Logs::DeliverySource', 'AWS::Logs::DeliveryDestination', 'AWS::Logs::Delivery'].includes(r.Type) && !id.startsWith('AgentMemory')
      if (released) {
        expect(was?.DeletionPolicy, id).toBe('Retain')
        expect(r.DeletionPolicy, id).toBe('Delete')
      } else {
        expect(JSON.stringify(r).replace(/[0-9a-f]{64}/g, 'H'), id).toBe(JSON.stringify(was).replace(/[0-9a-f]{64}/g, 'H'))
      }
    }
    const groups = Object.entries(rel.Resources).filter(([id]) => /MemoryLogs[0-9A-F]{8}$/.test(id))
    expect(groups).toHaveLength(2)
    for (const [, g] of groups) expect(g.DeletionPolicy).toBe('Retain')
  }, 300_000)

  it('drain: every project out of the stack, the API told none, the shared parts unchanged', () => {
    const s = synth(InfraPropsSchema.parse({ ...base, layout: 'flat', layoutMigration: 'drain' }), 'Drain')
    const j = json(s.parent)
    expect(Object.keys(j.Resources).filter((id) => /^(Observability)?Project[0-9a-f]{8}/.test(id))).toEqual([])
    s.parent.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1)
    s.parent.resourceCountIs('AWS::BedrockAgentCore::Memory', 0)
    s.parent.resourceCountIs('AWS::SecretsManager::Secret', 1)
    for (const repo of [A, B]) for (const o of Object.values(projectOutputs(repo))) expect(j.Outputs ?? {}).not.toHaveProperty(o)
    const api = Object.values(j.Resources).find((r) => r.Properties?.AgentRuntimeName === 'trace_api')
    const env = api?.Properties?.EnvironmentVariables as Record<string, unknown>
    expect(env.TRACE_WORKER_RUNTIMES).toBe('')
    expect(env.TRACE_PROJECT_MEMORIES).toBeUndefined()
    expect(j.Resources.Central7FB44904).toBeDefined()
    // a migration step is only for a flat stack
    expect(() => InfraPropsSchema.parse({ ...base, layoutMigration: 'drain' })).toThrow(/needs layout flat/)
  }, 300_000)
})
