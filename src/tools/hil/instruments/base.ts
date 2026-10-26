/**
 * What every instrument driver shares: which dialect an instrument speaks, worked out from its configured `model` or
 * from *IDN?, and a session that opens the transport, runs the driver, drains the error queue and closes.
 *
 * A dialect is a table of SCPI command builders (psu.ts, scope.ts, dmm.ts): the same operation ("set channel 2 to
 * 3.3 V") is different text on a Rigol, a Keysight, a Siglent or an R&S, and keeping them as data makes the command
 * text testable without an instrument.
 */
import { ToolError } from '../../../core/registry.js'
import type { Instrument } from '../resources.js'
import { drainErrors, idn, openTransport, type Identity, type Transport } from '../scpi.js'

export interface DialectMatch {
  readonly id: string
  /** matched against "<manufacturer>,<model>" from *IDN? */
  readonly idn: RegExp
}

export function pickDialect<D extends DialectMatch>(table: readonly D[], kind: string, model: string | undefined, identity: Identity | null): D {
  const generic = table.find((d) => d.id === 'generic')
  if (!generic) throw new Error(`${kind} dialect table has no generic entry`)
  if (model) {
    const byId = table.find((d) => d.id === model.toLowerCase())
    if (byId) return byId
    // a model number ("DP832", "SDS1104X-E") rather than a dialect id
    const byModel = table.find((d) => d.id !== 'generic' && d.idn.test(model))
    if (byModel) return byModel
    throw new ToolError(`unknown ${kind} model ${JSON.stringify(model)}: use one of ${table.map((d) => d.id).join(', ')}, or omit it to identify from *IDN?`)
  }
  if (identity) {
    const key = `${identity.manufacturer},${identity.model}`
    return table.find((d) => d.id !== 'generic' && d.idn.test(key)) ?? generic
  }
  return generic
}

export interface Session<D> {
  t: Transport
  dialect: D
  identity: Identity
  /** SCPI errors the instrument reported during the session */
  errors: string[]
  /** every command sent, for the run record */
  log: string[]
}

/** A transport that logs what is sent and received. */
function logging(t: Transport, log: string[]): Transport {
  return {
    address: t.address,
    write: async (c) => { log.push(`> ${c}`); await t.write(c) },
    query: async (c, ms) => { log.push(`> ${c}`); const r = await t.query(c, ms); log.push(`< ${r.slice(0, 200)}`); return r },
    queryBinary: async (c, ms) => { log.push(`> ${c}`); const r = await t.queryBinary(c, ms); log.push(`< <block ${r.length} bytes>`); return r },
    close: () => t.close(),
  }
}

/** Open the instrument, identify it, choose the dialect, run `fn`, collect errors, close. */
export async function session<D extends DialectMatch, R>(inst: Instrument, table: readonly D[], kind: string,
  fn: (s: Session<D>) => Promise<R>): Promise<{ value: R; s: Session<D> }> {
  const raw = await openTransport(inst.address, inst.timeout_s * 1000)
  const log: string[] = []
  const t = logging(raw, log)
  try {
    const identity = await idn(t)
    const dialect = pickDialect(table, kind, inst.model, identity)
    const s: Session<D> = { t, dialect, identity, errors: [], log }
    // stale errors from before this session are not ours
    await drainErrors(t).catch(() => [])
    const value = await fn(s)
    s.errors = await drainErrors(t).catch(() => [])
    return { value, s }
  } finally {
    await raw.close()
  }
}

export const round = (v: number, digits = 6): number => Number(v.toPrecision(digits))
