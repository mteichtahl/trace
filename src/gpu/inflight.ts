/**
 * The AWS Batch jobs this process has submitted and is still waiting on (src/gpu/batch.ts registers each one while it
 * waits). A job's tools run in its own tool server (`tracectl mcp`), so when the job is cancelled Claude stops, the
 * server's stdin ends, and terminateInFlight() terminates what it left running on the queue: a cancelled job never
 * leaves a graphics card job running (and billing) for hours. Nothing here loads the AWS SDK.
 */
export interface InFlight { jobId: string; terminate(reason: string): Promise<unknown> }

const open = new Map<string, InFlight>()

/** Register a submitted job; returns the function that forgets it (when its wait ends, however it ends). */
export function trackInFlight(j: InFlight): () => void {
  open.set(j.jobId, j)
  return () => { open.delete(j.jobId) }
}

export const inFlight = (): string[] => [...open.keys()]

/** Terminate every job still in flight (best effort; a failure is reported, never thrown). Returns the ids asked. */
export async function terminateInFlight(reason: string, log: (line: string) => void = () => undefined): Promise<string[]> {
  const all = [...open.values()]
  open.clear()
  await Promise.all(all.map((j) => j.terminate(reason).catch((e: unknown) => log(`could not terminate Batch job ${j.jobId}: ${e instanceof Error ? e.message : String(e)}`))))
  return all.map((j) => j.jobId)
}
