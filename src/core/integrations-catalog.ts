/**
 * The optional integrations' catalog: names, the keys each takes, what it enables and where to get one. Plain data
 * and pure helpers, so the installer page (browser code) uses the same list as the tools and the CLI. The rest (the
 * store, the checks, loading at run time) is src/core/integrations.ts.
 */
export interface Integration {
  readonly name: IntegrationName
  readonly title: string
  /** the environment names the tools read, in the order the page asks for them */
  readonly keys: readonly string[]
  /** what it enables, in one sentence */
  readonly enables: string
  /** where to get the credentials */
  readonly url: string
  /** who reads it: the tools (loaded into a worker's environment), or trace's own order watch only (never a worker) */
  readonly usedBy: 'tools' | 'order-watch'
}

export const INTEGRATION_NAMES = ['nexar', 'mouser', 'digikey', 'dhl'] as const
export type IntegrationName = (typeof INTEGRATION_NAMES)[number]

export const INTEGRATIONS: Readonly<Record<IntegrationName, Integration>> = {
  nexar: {
    name: 'nexar', title: 'Nexar (Octopart)', keys: ['NEXAR_CLIENT_ID', 'NEXAR_CLIENT_SECRET'],
    enables: 'Stock, prices and lifecycle from every distributor Octopart lists, for the parts tools and BOM checks (the free plan answers a limited number of parts a month).',
    url: 'https://portal.nexar.com/', usedBy: 'tools',
  },
  mouser: {
    name: 'mouser', title: 'Mouser', keys: ['MOUSER_API_KEY'],
    enables: 'Mouser stock, prices, lifecycle and datasheet links for the parts tools and BOM checks.',
    url: 'https://www.mouser.com/api-hub/', usedBy: 'tools',
  },
  digikey: {
    name: 'digikey', title: 'Digi-Key', keys: ['DIGIKEY_CLIENT_ID', 'DIGIKEY_CLIENT_SECRET'],
    enables: 'Digi-Key stock, prices, lifecycle and datasheet links for the parts tools and BOM checks (a production app on developer.digikey.com).',
    url: 'https://developer.digikey.com/', usedBy: 'tools',
  },
  dhl: {
    name: 'dhl', title: 'DHL tracking', keys: ['DHL_API_KEY'],
    enables: 'Follows a shipped order\'s DHL parcel on a timer (Shipment Tracking - Unified, free on its starting plan of 250 calls a day), so the Build tab shows where the boards are; JLCPCB itself gives order status to partner companies only.',
    url: 'https://developer.dhl.com/api-reference/shipment-tracking', usedBy: 'order-watch',
  },
}

/** Every environment name an integration may set (what the tools read). */
export const INTEGRATION_KEYS: readonly string[] = INTEGRATION_NAMES.flatMap((n) => INTEGRATIONS[n].keys)
/** The integrations the tools read (loaded into a worker), and their keys. */
export const TOOL_INTEGRATIONS: readonly IntegrationName[] = INTEGRATION_NAMES.filter((n) => INTEGRATIONS[n].usedBy === 'tools')
export const TOOL_INTEGRATION_KEYS: readonly string[] = TOOL_INTEGRATIONS.flatMap((n) => INTEGRATIONS[n].keys)

/** The integration that supplies an environment name, if any. */
export const integrationOf = (key: string): IntegrationName | null => INTEGRATION_NAMES.find((n) => INTEGRATIONS[n].keys.includes(key)) ?? null

/** The prefix of an installation's integration secrets (the worker's TRACE_INTEGRATIONS_PREFIX). */
export const integrationsPrefix = (prefix: string): string => `${prefix}/integrations/`
/** The prefix of the secrets only trace's order watch reads (never a worker's or the gateway's grant: they cover
 * integrationsPrefix only). */
export const orderWatchSecretsPrefix = (prefix: string): string => `${prefix}/order-watch/`
export const integrationSecretName = (prefix: string, name: IntegrationName): string =>
  INTEGRATIONS[name].usedBy === 'order-watch' ? `${orderWatchSecretsPrefix(prefix)}${name}` : `${integrationsPrefix(prefix)}${name}`

/** The message a tool gives when an integration's credentials are missing. */
export const addKeyHint = (name: IntegrationName): string =>
  `no ${INTEGRATIONS[name].title} credentials (${INTEGRATIONS[name].keys.join(' / ')}): add them with \`tracectl integrations set ${name}\` (${INTEGRATIONS[name].url})`

/** One integration's values: every key it needs, each non-empty. */
export function valuesFor(name: IntegrationName, raw: Record<string, unknown>): Record<string, string> {
  const want = INTEGRATIONS[name].keys
  const out: Record<string, string> = {}
  for (const k of want) {
    const v = raw[k]
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${name}: ${k} is required (${want.join(', ')})`)
    out[k] = v.trim()
  }
  const extra = Object.keys(raw).filter((k) => !want.includes(k))
  if (extra.length) throw new Error(`${name}: unknown ${extra.length === 1 ? 'key' : 'keys'} ${extra.join(', ')} (it takes ${want.join(', ')})`)
  return out
}

