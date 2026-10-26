import { it } from 'vitest'
import { InfraPropsSchema } from '../../src/infra/props.js'
import { synth } from './templates.js'
const repos = (n: number): string[] => Array.from({ length: n }, (_, i) => `owner-${i}/repository-${i}`)
it('count', () => {
  for (const n of [1, 2, 24]) {
    const s = synth(InfraPropsSchema.parse({ account: '123456789012', region: 'us-east-1', repositories: repos(n), model: 'm', adminEmail: 'a@example.com', layout: 'flat', runners: { connectionArn: 'arn:aws:codeconnections:us-east-1:123456789012:connection/00000000-0000-0000-0000-000000000000' } }), `C${n}`)
    const j = s.parent.toJSON() as { Resources: object; Outputs: object }
    console.log(n, Object.keys(j.Resources).length, Object.keys(j.Outputs).length)
  }
}, 600000)
