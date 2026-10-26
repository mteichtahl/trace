/**
 * The templates of one synthesized trace stack: the parent's, each project's nested stack's (layout nested), and
 * `all`, the parent's with every nested stack's resources and outputs merged in (their logical ids are distinct:
 * `Project<hash>…` in each nested stack), for assertions that do not care which stack a resource is in.
 */
import { App, NestedStack } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { type InfraProps, projectHash } from '../../src/infra/props.js'
import { TraceStack } from '../../src/infra/stack.js'

export interface Synth {
  stack: TraceStack
  parent: Template
  /** by project hash */
  nested: Map<string, Template>
  nestedStacks: Map<string, NestedStack>
  all: Template
}

export function synth(cfg: InfraProps, id = 'TraceStack'): Synth {
  const stack = new TraceStack(new App(), id, cfg)
  const parent = Template.fromStack(stack)
  const nested = new Map<string, Template>()
  const nestedStacks = new Map<string, NestedStack>()
  for (const n of stack.node.findAll().filter((c): c is NestedStack => c instanceof NestedStack)) {
    const h = /^Project([0-9a-f]{8})Stack$/.exec(n.node.id)?.[1] ?? n.node.id
    nested.set(h, Template.fromStack(n))
    nestedStacks.set(h, n)
  }
  const p = parent.toJSON() as { Resources: Record<string, unknown>; Outputs?: Record<string, unknown> }
  const resources: Record<string, unknown> = { ...p.Resources }
  const outputs: Record<string, unknown> = {}
  for (const t of nested.values()) {
    const j = t.toJSON() as { Resources: Record<string, unknown>; Outputs?: Record<string, unknown> }
    for (const [k, v] of Object.entries(j.Resources)) {
      if (k in resources) throw new Error(`logical id ${k} is in two templates`)
      resources[k] = v
    }
    Object.assign(outputs, j.Outputs ?? {})
  }
  Object.assign(outputs, p.Outputs ?? {})
  const all = Template.fromJSON({ ...p, Resources: resources, Outputs: outputs }, { skipCyclicalDependenciesCheck: true })
  return { stack, parent, nested, nestedStacks, all }
}

/** A project's nested template (throws if it has none). */
export function nestedOf(s: Synth, repository: string): Template {
  const t = s.nested.get(projectHash(repository))
  if (!t) throw new Error(`no nested stack for ${repository}`)
  return t
}

/**
 * How the parent refers to an attribute of a resource in project `h`'s nested stack: `Fn::GetAtt` of the nested stack
 * resource's `Outputs.<name>`, where that nested output is `Fn::GetAtt [<the resource>, attr]`.
 */
export function parentRef(s: Synth, h: string, resourcePrefix: string, attr: string): { 'Fn::GetAtt': [string, string] } {
  const n = s.nested.get(h)
  if (!n) throw new Error(`no nested stack for ${h}`)
  const outputs = (n.toJSON() as { Outputs: Record<string, { Value: unknown }> }).Outputs
  // the output CDK made for the reference (named after the construct path), not the project's own Project<hash>… ones
  const name = Object.entries(outputs).filter(([k]) => !/^Project[0-9a-f]{8}/.test(k)).find(([, o]) => {
    const g = (o.Value as { 'Fn::GetAtt'?: [string, string] })['Fn::GetAtt']
    return g && g[0].startsWith(resourcePrefix) && g[1] === attr
  })?.[0]
  if (!name) throw new Error(`no output of ${resourcePrefix}.${attr} in ${h}'s nested stack`)
  return { 'Fn::GetAtt': [nestedResourceId(s, h), `Outputs.${name}`] }
}

/** The logical id, in the parent, of project `h`'s AWS::CloudFormation::Stack. */
export function nestedResourceId(s: Synth, h: string): string {
  const ids = Object.keys(s.parent.findResources('AWS::CloudFormation::Stack')).filter((id) => id.startsWith(`Project${h}Stack`))
  if (ids.length !== 1) throw new Error(`expected one nested stack resource for ${h}, found ${ids.length}`)
  return ids[0] ?? ''
}
