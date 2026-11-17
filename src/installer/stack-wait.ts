/**
 * Waiting for the trace stack to be free before deploying it. CloudFormation refuses an update while another is running
 * ("is in UPDATE_IN_PROGRESS state and can not be updated"), and two things deploy the stack: the installer and the
 * installation's self-update (a ci run after each merge to trace's main). So each waits for the other: before a deploy,
 * the stack's status is read, and while it is busy (any *_IN_PROGRESS but a change set waiting for review) the deploy
 * waits, saying so, and goes ahead once the stack has settled. A stack that settles in a state it cannot be updated
 * from is left to the deploy, whose error says what to do. Waiting longer than the timeout (default 60 minutes) stops
 * with an error saying which update is still running.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation'
import type { AwsCredentialIdentity } from '@smithy/types'

/** Whether a stack in this status is being changed right now. Pure. */
export const stackBusy = (status: string | null): boolean => !!status && status.endsWith('_IN_PROGRESS') && status !== 'REVIEW_IN_PROGRESS'

export interface StackWaitDeps {
  /** the stack's status, or null when there is no stack */
  status: () => Promise<string | null>
  log: (line: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** how often to look again (ms) */
  every?: number
  /** how long to wait at most (ms) */
  timeout?: number
}

/** Wait until the stack is not being changed. Answers how long it waited (ms); 0 when it was free. */
export async function waitForStack(stack: string, d: StackWaitDeps): Promise<number> {
  const now = d.now ?? Date.now
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const every = d.every ?? 20_000
  const timeout = d.timeout ?? 60 * 60_000
  const start = now()
  let last: string | null = null
  for (;;) {
    let status: string | null
    try { status = await d.status() } catch (e) {
      // not knowing is no reason to wait: the deploy says what is wrong
      d.log(`Could not read ${stack}'s status (${e instanceof Error ? e.message : String(e)}); deploying anyway.`)
      return now() - start
    }
    if (!stackBusy(status)) {
      if (last) d.log(`${stack} is ${status ?? 'gone'} now: deploying.`)
      return now() - start
    }
    if (status !== last) {
      d.log(last
        ? `${stack} is ${status} now; still waiting.`
        : `${stack} is ${status}: another update is running (the installer, or trace updating itself after a change to its main branch). Waiting for it to finish before deploying.`)
      last = status
    }
    const waited = now() - start
    if (waited >= timeout) throw new Error(`${stack} was still ${status} after ${Math.round(waited / 60_000)} minutes: see its events in the CloudFormation console, and run the installer again once it has finished`)
    await sleep(every)
  }
}

/** The stack's status from CloudFormation, or null when it does not exist. */
export function cfnStackStatus(creds: AwsCredentialIdentity, region: string, stack: string): () => Promise<string | null> {
  const cfn = new CloudFormationClient({ region, credentials: creds })
  return async () => {
    try {
      return (await cfn.send(new DescribeStacksCommand({ StackName: stack }))).Stacks?.[0]?.StackStatus ?? null
    } catch (e) {
      if (/does not exist/i.test(e instanceof Error ? e.message : String(e))) return null
      throw e
    }
  }
}

/**
 * A `cdk` runner that waits for the named stack to be free before each `cdk deploy <stack>` (other commands, and
 * deploys of other stacks, go straight through).
 */
export function waitingCdk<E>(
  cdk: (args: string[], env: E, onLine: (l: string) => void) => Promise<number>,
  stack: () => string,
  wait: (stack: string, onLine: (l: string) => void) => Promise<unknown>,
): (args: string[], env: E, onLine: (l: string) => void) => Promise<number> {
  return async (args, env, onLine) => {
    if (args[0] === 'deploy' && args[1] === stack()) await wait(args[1], onLine)
    return cdk(args, env, onLine)
  }
}
