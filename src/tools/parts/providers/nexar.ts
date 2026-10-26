/**
 * Nexar (Octopart's data, api.nexar.com/graphql): every distributor Octopart knows, through `supSearchMpn` for a
 * lookup and `supSearch` for a search. Needs a Nexar application ($NEXAR_CLIENT_ID, $NEXAR_CLIENT_SECRET; the free
 * plan answers a limited number of parts a month, so answers are kept in the parts database). Without one it is
 * skipped. One offer per seller listing; the seller is named.
 */
import { z } from 'zod'
import { mpnLoose } from '../../datasheets/mpn.js'
import { jsonOf, ProviderError, type PartOffer, type Provider, type ProviderContext } from '../types.js'

export const NEXAR_TOKEN_URL = 'https://identity.nexar.com/connect/token'
export const NEXAR_API_URL = 'https://api.nexar.com/graphql'

const PART_FIELDS = `
  mpn
  manufacturer { name }
  shortDescription
  bestDatasheet { url }
  category { name }
  specs { attribute { name shortname } displayValue }
  sellers(authorizedOnly: false) {
    company { name }
    isAuthorized
    offers { sku inventoryLevel moq packaging clickUrl prices { quantity price currency convertedPrice convertedCurrency } }
  }`

export const NEXAR_MPN_QUERY = `query TraceLookup($q: String!, $currency: String!) {
  supSearchMpn(q: $q, limit: 5, currency: $currency) { results { part { ${PART_FIELDS} } } }
}`
export const NEXAR_SEARCH_QUERY = `query TraceSearch($q: String!, $limit: Int!, $currency: String!) {
  supSearch(q: $q, limit: $limit, currency: $currency) { results { part { ${PART_FIELDS} } } }
}`

const Offer = z.object({
  sku: z.string().nullish(),
  inventoryLevel: z.number().nullish(),
  moq: z.number().nullish(),
  packaging: z.string().nullish(),
  clickUrl: z.string().nullish(),
  prices: z.array(z.object({
    quantity: z.number(), price: z.number().nullish(), currency: z.string().nullish(),
    convertedPrice: z.number().nullish(), convertedCurrency: z.string().nullish(),
  })).nullish(),
})
const NexarPart = z.object({
  mpn: z.string().nullish(),
  manufacturer: z.object({ name: z.string().nullish() }).nullish(),
  shortDescription: z.string().nullish(),
  bestDatasheet: z.object({ url: z.string().nullish() }).nullish(),
  category: z.object({ name: z.string().nullish() }).nullish(),
  specs: z.array(z.object({ attribute: z.object({ name: z.string(), shortname: z.string().nullish() }), displayValue: z.string() })).nullish(),
  sellers: z.array(z.object({ company: z.object({ name: z.string().nullish() }).nullish(), isAuthorized: z.boolean().nullish(), offers: z.array(Offer).nullish() })).nullish(),
})
const Results = z.object({ results: z.array(z.object({ part: NexarPart.nullish() })).nullish() }).nullish()
export const NexarAnswer = z.object({
  data: z.object({ supSearchMpn: Results.optional(), supSearch: Results.optional() }).nullish(),
  errors: z.array(z.object({ message: z.string().nullish() })).nullish(),
})
export type NexarAnswer = z.input<typeof NexarAnswer>

export function nexarOffers(answer: unknown, currency: string): PartOffer[] {
  const a = NexarAnswer.safeParse(answer)
  if (!a.success) throw new ProviderError(`nexar: an unexpected answer (${a.error.issues[0]?.message ?? 'shape'})`)
  if (a.data.errors?.length) throw new ProviderError(`nexar: ${a.data.errors.map((e) => e.message ?? 'error').join('; ')}`)
  const results = a.data.data?.supSearchMpn?.results ?? a.data.data?.supSearch?.results ?? []
  const out: PartOffer[] = []
  for (const r of results) {
    const p = r.part
    if (!p?.mpn) continue
    const attributes: Record<string, string> = {}
    for (const s of p.specs ?? []) attributes[s.attribute.name] = s.displayValue
    if (p.category?.name) attributes['Category'] = p.category.name
    const pkg = attributes['Case/Package'] ?? attributes['Package'] ?? null
    const lifecycle = attributes['Lifecycle Status'] ?? null
    const base = {
      mpn: p.mpn, manufacturer: p.manufacturer?.name ?? null, description: p.shortDescription ?? null, provider: 'nexar' as const,
      lifecycle, datasheet_url: p.bestDatasheet?.url ?? null, package: pkg,
    }
    for (const s of p.sellers ?? []) {
      for (const o of s.offers ?? []) {
        const breaks = (o.prices ?? []).flatMap((x) => {
          // Prefer the price converted to the configured currency; otherwise keep the seller's own currency, labelled.
          if (typeof x.convertedPrice === 'number' && x.convertedPrice > 0) return [{ qty: x.quantity, price: x.convertedPrice, currency: x.convertedCurrency ?? currency }]
          if (typeof x.price === 'number' && x.price > 0 && x.currency) return [{ qty: x.quantity, price: x.price, currency: x.currency }]
          return []
        }).sort((x, y) => x.qty - y.qty)
        out.push({
          ...base,
          seller: s.company?.name ?? 'unknown seller',
          provider_part: o.sku ?? null,
          stock: typeof o.inventoryLevel === 'number' && o.inventoryLevel >= 0 ? o.inventoryLevel : null,
          moq: typeof o.moq === 'number' && o.moq > 0 ? o.moq : null,
          price_breaks: breaks,
          attributes: { ...attributes, ...(o.packaging ? { Packaging: o.packaging } : {}), ...(typeof s.isAuthorized === 'boolean' ? { Authorized: s.isAuthorized ? 'yes' : 'no' } : {}) },
          url: o.clickUrl ?? null,
        })
      }
    }
  }
  return out
}

const Token = z.object({ access_token: z.string(), expires_in: z.number().optional() })
let token: { value: string; until: number; id: string } | null = null

export function resetNexarToken(): void {
  token = null
}

async function nexarToken(ctx: ProviderContext): Promise<string> {
  const id = ctx.env.NEXAR_CLIENT_ID ?? ''
  if (token && token.id === id && token.until > Date.now()) return token.value
  const r = await ctx.fetch(NEXAR_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: ctx.env.NEXAR_CLIENT_SECRET ?? '', scope: 'supply.domain' }).toString(),
    signal: AbortSignal.timeout(20_000),
  })
  const t = Token.safeParse(await jsonOf(r, 'nexar token'))
  if (!t.success) throw new ProviderError('nexar: the credentials were refused (no access_token)')
  token = { value: t.data.access_token, until: Date.now() + Math.max(0, (t.data.expires_in ?? 3600) - 60) * 1000, id }
  return token.value
}

async function gql(query: string, variables: Record<string, string | number>, ctx: ProviderContext): Promise<PartOffer[]> {
  const bearer = await nexarToken(ctx)
  const r = await ctx.fetch(NEXAR_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(25_000),
  })
  return nexarOffers(await jsonOf(r, 'nexar'), ctx.currency)
}

export const nexar: Provider = {
  name: 'nexar',
  unavailable: (env) => (env.NEXAR_CLIENT_ID && env.NEXAR_CLIENT_SECRET ? null : 'no NEXAR_CLIENT_ID / NEXAR_CLIENT_SECRET set'),
  async lookup(mpn, ctx) {
    const want = mpnLoose(mpn)
    return (await gql(NEXAR_MPN_QUERY, { q: mpn, currency: ctx.currency }, ctx)).filter((o) => mpnLoose(o.mpn).startsWith(want))
  },
  search: (q, ctx, limit) => gql(NEXAR_SEARCH_QUERY, { q, limit: Math.min(limit, 20), currency: ctx.currency }, ctx),
}
