/**
 * The library gateway (gateway.enabled; README "Library gateway"): one AgentCore Gateway for the installation, in
 * front of the shared library only (the datasheets and parts tools of src/core/gateway.ts LIBRARY_TOOLS).
 *
 *   gateway      AWS_IAM inbound auth: a caller signs with SigV4, and only roles granted bedrock-agentcore:InvokeGateway
 *                on it may call (each project's worker role, src/infra/project.ts). MCP protocol
 *   target       `library`: a Lambda target whose tool schema is generated from the tools' zod inputs, without their
 *                local inputs (file, path, library). The gateway calls it with its own role (GATEWAY_IAM_ROLE)
 *   Lambda       src/library/lambda.ts, bundled with esbuild (pdfjs-dist shipped beside it for page text). Its role
 *                reads central/* and writes it only with a conditional put (as the central store always writes), and
 *                reads the distributor-keys secret; nothing of any project, access/* or prompts/*
 *   keys secret  `<prefix>/library-keys`: a JSON object of MOUSER_API_KEY, DIGIKEY_CLIENT_ID/_SECRET,
 *                NEXAR_CLIENT_ID/_SECRET, written by the installer (never by CloudFormation). Only the Lambda reads it
 *
 * A Lambda target runs with the gateway's role, not the caller's, and is not told who called: so nothing per project
 * is put behind it. The central database is shared by every project already, so this role reaches nothing a worker
 * can't.
 */
import { cpSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { AssetHashType, DockerImage, Duration, RemovalPolicy, Size, Stack } from 'aws-cdk-lib'
import { CfnGateway, CfnGatewayTarget } from 'aws-cdk-lib/aws-bedrockagentcore'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import * as secrets from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'
import { LIBRARY_TARGET, libraryToolDefinitions } from '../core/gateway.js'
import { libraryRegistry } from '../library/lambda.js'
import { CENTRAL_PREFIX, grantPrefixes } from './project.js'

/** What a project needs of the gateway: its ARN (for the worker role's grant) and its URL (TRACE_GATEWAY_URL). */
export interface GatewayRef { arn: string; url: string }

/** The gateway's name: letters and digits, single dashes between, at most 48 groups (CloudFormation's pattern). */
export const gatewayName = (prefix: string): string => `${prefix}-library`

/** Bundle the Lambda with esbuild into `out` (index.mjs), with the parts of pdfjs-dist page text needs beside it. */
export function bundleLibraryLambda(root: string, out: string): void {
  const req = createRequire(join(root, 'package.json'))
  const esbuild = req('esbuild') as typeof import('esbuild')
  esbuild.buildSync({
    entryPoints: [join(root, 'src', 'library', 'lambda.ts')],
    outfile: join(out, 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'error',
    // pdfjs-dist is loaded at run time from node_modules beside the bundle (its worker and fonts are files it finds
    // there); the rest is bundled. CommonJS dependencies get a require.
    external: ['pdfjs-dist', 'pdfjs-dist/*', '@napi-rs/canvas'],
    banner: { js: "import { createRequire as __traceRequire } from 'node:module'; const require = __traceRequire(import.meta.url);" },
  })
  const pdfjs = dirname(req.resolve('pdfjs-dist/package.json'))
  const to = join(out, 'node_modules', 'pdfjs-dist')
  mkdirSync(join(to, 'legacy', 'build'), { recursive: true })
  cpSync(join(pdfjs, 'package.json'), join(to, 'package.json'))
  for (const f of ['pdf.mjs', 'pdf.worker.mjs']) cpSync(join(pdfjs, 'legacy', 'build', f), join(to, 'legacy', 'build', f))
  cpSync(join(pdfjs, 'standard_fonts'), join(to, 'standard_fonts'), { recursive: true })
}

export interface LibraryGatewayProps {
  prefix: string
  bucket: s3.IBucket
  /** TRACE_HOME (s3://<bucket>/central) */
  traceHome: string
  /** the repository root (src/ and node_modules/ are bundled from it) */
  root: string
}

export class LibraryGateway extends Construct {
  readonly gateway: CfnGateway
  readonly target: CfnGatewayTarget
  readonly function: lambda.Function
  readonly keys: secrets.Secret
  readonly ref: GatewayRef

  constructor(scope: Construct, id: string, p: LibraryGatewayProps) {
    super(scope, id)
    const { region, account, partition } = Stack.of(this)

    this.keys = new secrets.Secret(this, 'Keys', {
      secretName: `${p.prefix}/library-keys`,
      description: 'Distributor API keys for the shared parts library (MOUSER_API_KEY, DIGIKEY_CLIENT_ID/_SECRET, NEXAR_CLIENT_ID/_SECRET as JSON), written by `trace install`; read only by the library gateway\'s Lambda.',
      // an empty object until the installer writes it (CloudFormation never holds a key)
      generateSecretString: { secretStringTemplate: '{}', generateStringKey: 'unused', passwordLength: 8, excludePunctuation: true },
      removalPolicy: RemovalPolicy.DESTROY,
    })

    const role = new iam.Role(this, 'FunctionRole', {
      roleName: `${p.prefix}-library-${region}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'The library gateway\'s Lambda: the central database (conditional writes) and the distributor keys; nothing per project',
    })
    grantPrefixes(role, p.bucket, { conditional: [CENTRAL_PREFIX] })
    this.keys.grantRead(role)
    const logGroup = new logs.LogGroup(this, 'FunctionLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY })
    logGroup.grantWrite(role)

    this.function = new lambda.Function(this, 'Function', {
      functionName: `${p.prefix}-library`,
      description: 'trace: the shared datasheets and parts library behind AgentCore Gateway (src/library/lambda.ts)',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(join(p.root, 'src', 'library'), {
        assetHashType: AssetHashType.OUTPUT,
        bundling: {
          image: DockerImage.fromRegistry('public.ecr.aws/sam/build-nodejs22.x'),
          local: { tryBundle: (out) => { bundleLibraryLambda(p.root, out); return true } },
        },
      }),
      role,
      memorySize: 2048,
      ephemeralStorageSize: Size.mebibytes(4096),
      timeout: Duration.minutes(5),
      logGroup,
      environment: {
        TRACE_HOME: p.traceHome,
        TRACE_LIBRARY_KEYS_SECRET_ARN: this.keys.secretArn,
        // the function's file system is read-only but /tmp: the central database's copy and the documents go there
        HOME: '/tmp',
        XDG_CACHE_HOME: '/tmp/cache',
        TRACE_CACHE_DB: '/tmp/cache/cache.db',
      },
    })

    const gatewayRole = new iam.Role(this, 'GatewayRole', {
      roleName: `${p.prefix}-gateway-${region}`,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:${partition}:bedrock-agentcore:${region}:${account}:*` },
        },
      }),
      description: 'Run by the library gateway: invokes the library Lambda only',
    })
    this.function.grantInvoke(gatewayRole)

    this.gateway = new CfnGateway(this, 'Gateway', {
      name: gatewayName(p.prefix),
      description: 'trace: the shared datasheets and parts library (MCP). Callers sign with SigV4; each project\'s worker role may call it',
      authorizerType: 'AWS_IAM',
      protocolType: 'MCP',
      roleArn: gatewayRole.roleArn,
      tags: { 'trace:installation': p.prefix },
    })
    this.gateway.node.addDependency(gatewayRole)

    this.target = new CfnGatewayTarget(this, 'Target', {
      gatewayIdentifier: this.gateway.attrGatewayIdentifier,
      name: LIBRARY_TARGET,
      description: 'The datasheets and parts tools, on the central database',
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: this.function.functionArn,
            toolSchema: { inlinePayload: libraryToolDefinitions(libraryRegistry()) },
          },
        },
      },
    })
    this.target.node.addDependency(this.function)

    this.ref = { arn: this.gateway.attrGatewayArn, url: this.gateway.attrGatewayUrl }
  }
}
