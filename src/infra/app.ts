/**
 * The CDK app. Run by the installer as `cdk deploy --app "node dist/infra/app.js"` with the stack's settings in the
 * TRACE_INFRA environment variable (see props.ts), so there is no cdk.json and no settings file. With the web app's
 * WAF and a region other than us-east-1 it also has `<prefix>-edge` (src/infra/edge.ts), which the tools deploy by
 * name before the main stack; the two share no reference.
 */
import { App } from 'aws-cdk-lib'
import { TraceEdgeStack, edgeNeeded } from './edge.js'
import { infraPropsFromEnv, stackName } from './props.js'
import { TraceStack } from './stack.js'

const props = infraPropsFromEnv()
const app = new App()
new TraceStack(app, stackName(props.prefix), props)
if (edgeNeeded(props)) new TraceEdgeStack(app, props)
app.synth()
