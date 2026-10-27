/**
 * The web backend's reach outside itself, as narrow interfaces: each is one AWS client (or fetch) in production
 * (src/web/aws.ts) and a fake in the tests. Their inputs and outputs are the AWS SDK's own types, so a fake cannot
 * drift from what the SDK sends.
 */
import type {
  AssociateSoftwareTokenCommandInput, AssociateSoftwareTokenCommandOutput,
  CompleteWebAuthnRegistrationCommandInput, ConfirmForgotPasswordCommandInput,
  DeleteWebAuthnCredentialCommandInput, ForgotPasswordCommandInput,
  InitiateAuthCommandInput, InitiateAuthCommandOutput,
  ListWebAuthnCredentialsCommandInput, ListWebAuthnCredentialsCommandOutput,
  RespondToAuthChallengeCommandInput, RespondToAuthChallengeCommandOutput,
  RevokeTokenCommandInput, SetUserMFAPreferenceCommandInput,
  StartWebAuthnRegistrationCommandInput, StartWebAuthnRegistrationCommandOutput,
  VerifySoftwareTokenCommandInput, VerifySoftwareTokenCommandOutput,
} from '@aws-sdk/client-cognito-identity-provider'
import type { ConverseStreamCommandInput, ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime'
import type { DescribeVoicesCommandInput, SynthesizeSpeechCommandInput, Voice } from '@aws-sdk/client-polly'
import type { MetricAlarm, MetricDataQuery, MetricDataResult } from '@aws-sdk/client-cloudwatch'
import type { AwsCredentialIdentity } from '@smithy/types'

/** Cognito's user-pool API: public calls (no IAM), or calls made with the person's own access token. */
export interface CognitoPort {
  initiateAuth(i: InitiateAuthCommandInput): Promise<InitiateAuthCommandOutput>
  respondToAuthChallenge(i: RespondToAuthChallengeCommandInput): Promise<RespondToAuthChallengeCommandOutput>
  revokeToken(i: RevokeTokenCommandInput): Promise<void>
  forgotPassword(i: ForgotPasswordCommandInput): Promise<void>
  confirmForgotPassword(i: ConfirmForgotPasswordCommandInput): Promise<void>
  startWebAuthnRegistration(i: StartWebAuthnRegistrationCommandInput): Promise<StartWebAuthnRegistrationCommandOutput>
  completeWebAuthnRegistration(i: CompleteWebAuthnRegistrationCommandInput): Promise<void>
  listWebAuthnCredentials(i: ListWebAuthnCredentialsCommandInput): Promise<ListWebAuthnCredentialsCommandOutput>
  deleteWebAuthnCredential(i: DeleteWebAuthnCredentialCommandInput): Promise<void>
  associateSoftwareToken(i: AssociateSoftwareTokenCommandInput): Promise<AssociateSoftwareTokenCommandOutput>
  verifySoftwareToken(i: VerifySoftwareTokenCommandInput): Promise<VerifySoftwareTokenCommandOutput>
  setUserMfaPreference(i: SetUserMFAPreferenceCommandInput): Promise<void>
}

/** Bedrock's ConverseStream: the events of one model turn. */
export interface BedrockPort {
  converseStream(i: ConverseStreamCommandInput, signal?: AbortSignal): AsyncIterable<ConverseStreamOutput>
}

export interface PollyPort {
  describeVoices(i: DescribeVoicesCommandInput): Promise<Voice[]>
  /** The synthesised bytes (an MP3, or speech marks as JSON lines). */
  synthesize(i: SynthesizeSpeechCommandInput): Promise<Uint8Array>
}

/** The voice cache: one bucket, keys under the configured prefix. */
export interface StorePort {
  exists(bucket: string, key: string): Promise<boolean>
  getText(bucket: string, key: string): Promise<string>
  put(bucket: string, key: string, body: Uint8Array | string, contentType: string): Promise<void>
  presignGet(bucket: string, key: string, seconds: number): Promise<string>
}

export interface CloudWatchPort {
  /** The dashboard's body (JSON text). */
  getDashboard(name: string): Promise<string>
  getMetricData(queries: MetricDataQuery[], start: Date, end: Date): Promise<MetricDataResult[]>
  /** Metric and composite alarms in ALARM or INSUFFICIENT_DATA whose names start with the prefix. */
  describeAlarms(prefix: string): Promise<MetricAlarm[]>
}

/** The Lambda role's credentials, for SigV4 (AppSync publish, the Transcribe URL). */
export type Credentials = () => Promise<AwsCredentialIdentity>
