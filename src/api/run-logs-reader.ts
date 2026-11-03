/**
 * Reading the runs log group (src/core/run-logs.ts) for the API: one stream's lines from a cursor, its newest line, and
 * the streams under a prefix. The API runtime's role may only read this group (src/infra/api-grants.ts).
 *
 * The interface is all run.log, change.runs and activity.list use, so tests give them a fake (memoryRunLogs) and never
 * need AWS.
 */
import { CloudWatchLogsClient, DescribeLogStreamsCommand, GetLogEventsCommand, ResourceNotFoundException } from '@aws-sdk/client-cloudwatch-logs'

export interface RawEvent { at: number; text: string }
export interface StreamInfo { name: string; lastEventAt: number | null; firstEventAt: number | null }

export interface RunLogsReader {
  /** The log group's name, for the admins' console link. */
  readonly group: string
  readonly region: string
  /** Lines after the cursor (from the start without one), oldest first; `next` the cursor to carry on from. A stream
   * that does not exist answers no lines and a null cursor. */
  read(stream: string, o: { after?: string | null | undefined; limit: number }): Promise<{ events: RawEvent[]; next: string | null; exists: boolean }>
  /** The stream's newest line, or null. */
  newest(stream: string): Promise<RawEvent | null>
  /** The streams whose names start with `prefix`, by name (descending: newest name first). */
  streams(prefix: string, o: { limit: number; descending?: boolean }): Promise<StreamInfo[]>
}

const missing = (e: unknown): boolean => e instanceof ResourceNotFoundException || (e instanceof Error && e.name === 'ResourceNotFoundException')

export function cloudWatchRunLogs(group: string, region: string, client: CloudWatchLogsClient = new CloudWatchLogsClient({ region })): RunLogsReader {
  return {
    group,
    region,
    async read(stream, o) {
      let token = o.after ?? undefined
      const events: RawEvent[] = []
      // GetLogEvents pages by time: a page may come back empty with a new token while later events exist
      for (let i = 0; i < 4; i++) {
        let out
        try {
          out = await client.send(new GetLogEventsCommand({ logGroupName: group, logStreamName: stream, startFromHead: true, limit: o.limit, ...(token ? { nextToken: token } : {}) }))
        } catch (e) {
          if (missing(e)) return { events: [], next: o.after ?? null, exists: false }
          throw e
        }
        for (const ev of out.events ?? []) events.push({ at: ev.timestamp ?? 0, text: ev.message ?? '' })
        const next = out.nextForwardToken ?? token
        const moved = next !== token
        token = next
        if (events.length || !moved) break
      }
      return { events, next: token ?? null, exists: true }
    },
    async newest(stream) {
      try {
        const out = await client.send(new GetLogEventsCommand({ logGroupName: group, logStreamName: stream, startFromHead: false, limit: 1 }))
        const ev = out.events?.[out.events.length - 1]
        return ev ? { at: ev.timestamp ?? 0, text: ev.message ?? '' } : null
      } catch (e) {
        if (missing(e)) return null
        throw e
      }
    },
    async streams(prefix, o) {
      try {
        const out = await client.send(new DescribeLogStreamsCommand({ logGroupName: group, logStreamNamePrefix: prefix, orderBy: 'LogStreamName', descending: o.descending ?? false, limit: Math.min(50, o.limit) }))
        return (out.logStreams ?? []).map((s) => ({ name: s.logStreamName ?? '', lastEventAt: s.lastEventTimestamp ?? s.lastIngestionTime ?? null, firstEventAt: s.firstEventTimestamp ?? null })).filter((s) => s.name)
      } catch (e) {
        if (missing(e)) return []
        throw e
      }
    },
  }
}

/** A reader over streams held in memory, for tests and the local API: cursors are line offsets. */
export function memoryRunLogs(streams: Map<string, RawEvent[]> = new Map(), group = '/trace/test/runs', region = 'us-east-1'): RunLogsReader & { streamsData: Map<string, RawEvent[]> } {
  return {
    group,
    region,
    streamsData: streams,
    async read(stream, o) {
      const all = streams.get(stream)
      if (!all) return { events: [], next: o.after ?? null, exists: false }
      const from = o.after ? Number(o.after) || 0 : 0
      const events = all.slice(from, from + o.limit)
      return { events, next: String(from + events.length), exists: true }
    },
    async newest(stream) {
      const all = streams.get(stream)
      return all?.length ? all[all.length - 1]! : null
    },
    async streams(prefix, o) {
      const names = [...streams.keys()].filter((n) => n.startsWith(prefix)).sort()
      if (o.descending) names.reverse()
      return names.slice(0, o.limit).map((name) => {
        const ev = streams.get(name) ?? []
        return { name, lastEventAt: ev.length ? ev[ev.length - 1]!.at : null, firstEventAt: ev.length ? ev[0]!.at : null }
      })
    },
  }
}

/** The CloudWatch console's page for one stream (admins only, decision D). */
export function consoleLink(r: Pick<RunLogsReader, 'group' | 'region'>, stream: string): string {
  // the console's own escaping of the group and stream in its hash route: '/' as $252F
  const esc = (s: string): string => encodeURIComponent(s).replace(/%/g, '$25')
  return `https://${r.region}.console.aws.amazon.com/cloudwatch/home?region=${r.region}#logsV2:log-groups/log-group/${esc(r.group)}/log-events/${esc(stream)}`
}
