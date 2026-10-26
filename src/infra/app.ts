/**
 * The CDK app. Run by the installer as `cdk deploy --app "node dist/infra/app.js"` with the stack's settings in the
 * TRACE_INFRA environment variable (see props.ts), so there is no cdk.json and no settings file.
 */
import { App } from 'aws-cdk-lib'
import { infraPropsFromEnv, stackName } from './props.js'
import { TraceStack } from './stack.js'

const props = infraPropsFromEnv()
const app = new App()
new TraceStack(app, stackName(props.prefix), props)
app.synth()
