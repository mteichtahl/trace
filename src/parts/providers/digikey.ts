/**
 * Digi-Key Product Information v4 (api.digikey.com): an OAuth2 client-credentials token, then
 * `products/v4/search/keyword`. Needs a Digi-Key API application ($DIGIKEY_CLIENT_ID, $DIGIKEY_CLIENT_SECRET);
 * without one the provider is skipped. Tokens are kept until a minute before they expire.
 */
import { z } from 'zod'
import { mpnLoose } from '../../datasheets/mpn.js'
import { jsonOf, ProviderError, type PartOffer, type Provider, type ProviderContext } from '../types.js'

export const DIGIKEY_TOKEN_URL = 'https://api.digikey.com/v1/oauth2/token'
export const DIGIKEY_SEARCH_URL = 'https://api.digikey.com/products/v4/search/keyword'

const Token = z.object({ access_token: z.string(), expires_in: z.number().optional() })

const Variation = z.object({
  DigiKeyProductNumber: z.string().nullish(),
  QuantityAvailableforPackageType: z.number().nullish(),
  MinimumOrderQuantity: z.number().nullish(),
  PackageType: z.object({ Name: z.string().nullish() }).nullish(),
  StandardPricing: z.array(z.object({ BreakQuantity: z.number(), UnitPrice: z.number() })).nullish(),
})
const DkProduct = z.object({
  ManufacturerProductNumber: z.string().nullish(),
  Manufacturer: z.object({ Name: z.string().nullish() }).nullish(),
  Description: z.object({ ProductDescription: z.string().nullish(), DetailedDescription: z.string().nullish() }).nullish(),
  QuantityAvailable: z.number().nullish(),
  ProductUrl: z.string().nullish(),
  DatasheetUrl: z.string().nullish(),
  ProductStatus: z.object({ Status: z.string().nullish() }).nullish(),
  Parameters: z.array(z.object({ ParameterText: z.string(), ValueText: z.string() })).nullish(),
  ProductVariations: z.array(Variation).nullish(),
})
export const DigikeyAnswer = z.object({
  Products: z.array(DkProduct).nullish(),
  ExactMatches: z.array(DkProduct).nullish(),
  ProductsCount: z.number().nullish(),
})
export type DigikeyAnswer = z.input<typeof DigikeyAnswer>

export function digikeyOffers(answer: unknown, currency: string): PartOffer[] {
  const a = DigikeyAnswer.safeParse(answer)
  if (!a.success) throw new ProviderError(`digikey: an unexpected answer (${a.error.issues[0]?.message ?? 'shape'})`)
  const seen = new Set<string>()
  const out: PartOffer[] = []
  for (const p of [...(a.data.ExactMatches ?? []), ...(a.data.Products ?? [])]) {
    if (!p.ManufacturerProductNumber) continue
    const attributes: Record<string, string> = {}
    for (const x of p.Parameters ?? []) attributes[x.ParameterText] = x.ValueText
    const pkg = attributes['Package / Case'] ?? attributes['Supplier Device Package'] ?? null
    const variations = p.ProductVariations?.length ? p.ProductVariations : [null]
    for (const v of variations) {
      const id = `${p.ManufacturerProductNumber}|${v?.DigiKeyProductNumber ?? ''}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({
        mpn: p.ManufacturerProductNumber,
        manufacturer: p.Manufacturer?.Name ?? null,
        description: p.Description?.DetailedDescription ?? p.Description?.ProductDescription ?? null,
        provider: 'digikey',
        seller: 'Digi-Key',
        provider_part: v?.DigiKeyProductNumber ?? null,
        stock: v?.QuantityAvailableforPackageType ?? p.QuantityAvailable ?? null,
        moq: v?.MinimumOrderQuantity ?? null,
        price_breaks: (v?.StandardPricing ?? []).map((b) => ({ qty: b.BreakQuantity, price: b.UnitPrice, currency })).sort((x, y) => x.qty - y.qty),
        lifecycle: p.ProductStatus?.Status ?? null,
        datasheet_url: p.DatasheetUrl ?? null,
        package: pkg,
        attributes: { ...attributes, ...(v?.PackageType?.Name ? { Packaging: v.PackageType.Name } : {}) },
        url: p.ProductUrl ?? null,
      })
    }
  }
  return out
}

let token: { value: string; until: number; id: string } | null = null

export async function digikeyToken(ctx: ProviderContext): Promise<string> {
  const id = ctx.env.DIGIKEY_CLIENT_ID ?? ''
  if (token && token.id === id && token.until > Date.now()) return token.value
  const r = await ctx.fetch(DIGIKEY_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: id, client_secret: ctx.env.DIGIKEY_CLIENT_SECRET ?? '', grant_type: 'client_credentials' }).toString(),
    signal: AbortSignal.timeout(20_000),
  })
  const t = Token.safeParse(await jsonOf(r, 'digikey token'))
  if (!t.success) throw new ProviderError('digikey: the token answer has no access_token')
  token = { value: t.data.access_token, until: Date.now() + Math.max(0, (t.data.expires_in ?? 600) - 60) * 1000, id }
  return token.value
}

export function resetDigikeyToken(): void {
  token = null
}

async function keyword(q: string, ctx: ProviderContext, limit: number): Promise<PartOffer[]> {
  const bearer = await digikeyToken(ctx)
  const r = await ctx.fetch(DIGIKEY_SEARCH_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${bearer}`,
      'X-DIGIKEY-Client-Id': ctx.env.DIGIKEY_CLIENT_ID ?? '', 'X-DIGIKEY-Locale-Currency': ctx.currency,
    },
    body: JSON.stringify({ Keywords: q, Limit: Math.min(limit, 50), Offset: 0 }),
    signal: AbortSignal.timeout(20_000),
  })
  return digikeyOffers(await jsonOf(r, 'digikey'), ctx.currency)
}

export const digikey: Provider = {
  name: 'digikey',
  unavailable: (env) => (env.DIGIKEY_CLIENT_ID && env.DIGIKEY_CLIENT_SECRET ? null : 'no DIGIKEY_CLIENT_ID / DIGIKEY_CLIENT_SECRET set'),
  async lookup(mpn, ctx) {
    const want = mpnLoose(mpn)
    return (await keyword(mpn, ctx, 10)).filter((o) => mpnLoose(o.mpn).startsWith(want))
  },
  search: keyword,
}
