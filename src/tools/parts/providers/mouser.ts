/**
 * Mouser Search API v1 (api.mouser.com): `search/partnumber` for a lookup, `search/keyword` for a search. Needs an
 * API key ($MOUSER_API_KEY, from mouser.com → My Account → APIs); without one the provider is skipped.
 */
import { z } from 'zod'
import { mpnLoose } from '../../datasheets/mpn.js'
import { intOrNull, jsonOf, priceOrNull, ProviderError, type PartOffer, type Provider, type ProviderContext } from '../types.js'

export const MOUSER_URL = 'https://api.mouser.com/api/v1/search'

const MouserPart = z.object({
  MouserPartNumber: z.string().nullish(),
  ManufacturerPartNumber: z.string().nullish(),
  Manufacturer: z.string().nullish(),
  Description: z.string().nullish(),
  DataSheetUrl: z.string().nullish(),
  ProductDetailUrl: z.string().nullish(),
  Availability: z.string().nullish(),
  AvailabilityInStock: z.string().nullish(),
  Min: z.string().nullish(),
  LifecycleStatus: z.string().nullish(),
  Category: z.string().nullish(),
  PriceBreaks: z.array(z.object({ Quantity: z.number(), Price: z.string(), Currency: z.string() })).nullish(),
  ProductAttributes: z.array(z.object({ AttributeName: z.string(), AttributeValue: z.string() })).nullish(),
})
export const MouserAnswer = z.object({
  Errors: z.array(z.object({ Code: z.string().nullish(), Message: z.string().nullish() })).nullish(),
  SearchResults: z.object({ NumberOfResult: z.number().nullish(), Parts: z.array(MouserPart).nullish() }).nullish(),
})
export type MouserAnswer = z.input<typeof MouserAnswer>

export function mouserOffers(answer: unknown): PartOffer[] {
  const a = MouserAnswer.safeParse(answer)
  if (!a.success) throw new ProviderError(`mouser: an unexpected answer (${a.error.issues[0]?.message ?? 'shape'})`)
  if (a.data.Errors?.length) throw new ProviderError(`mouser: ${a.data.Errors.map((e) => e.Message ?? e.Code ?? 'error').join('; ')}`)
  return (a.data.SearchResults?.Parts ?? []).filter((p) => p.ManufacturerPartNumber).map((p): PartOffer => {
    const attributes: Record<string, string> = {}
    for (const x of p.ProductAttributes ?? []) attributes[x.AttributeName] = attributes[x.AttributeName] ? `${attributes[x.AttributeName]}; ${x.AttributeValue}` : x.AttributeValue
    if (p.Category) attributes['Category'] = p.Category
    const pkg = attributes['Package / Case'] ?? attributes['Package'] ?? null
    return {
      mpn: p.ManufacturerPartNumber ?? '',
      manufacturer: p.Manufacturer ?? null,
      description: p.Description ?? null,
      provider: 'mouser',
      seller: 'Mouser',
      provider_part: p.MouserPartNumber ?? null,
      stock: intOrNull(p.AvailabilityInStock ?? p.Availability),
      moq: intOrNull(p.Min),
      price_breaks: (p.PriceBreaks ?? []).flatMap((b) => {
        const price = priceOrNull(b.Price)
        return price === null ? [] : [{ qty: b.Quantity, price, currency: b.Currency }]
      }).sort((x, y) => x.qty - y.qty),
      lifecycle: p.LifecycleStatus ?? null,
      datasheet_url: p.DataSheetUrl || null,
      package: pkg,
      attributes,
      url: p.ProductDetailUrl ?? null,
    }
  })
}

async function post(path: string, body: unknown, ctx: ProviderContext): Promise<PartOffer[]> {
  const key = ctx.env.MOUSER_API_KEY ?? ''
  const r = await ctx.fetch(`${MOUSER_URL}/${path}?apiKey=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  return mouserOffers(await jsonOf(r, 'mouser'))
}

export const mouser: Provider = {
  name: 'mouser',
  unavailable: (env) => (env.MOUSER_API_KEY ? null : 'no MOUSER_API_KEY set'),
  async lookup(mpn, ctx) {
    const offers = await post('partnumber', { SearchByPartRequest: { mouserPartNumber: mpn, partSearchOptions: 'None' } }, ctx)
    const want = mpnLoose(mpn)
    return offers.filter((o) => mpnLoose(o.mpn).startsWith(want))
  },
  search: (q, ctx, limit) => post('keyword', { SearchByKeywordRequest: { keyword: q, records: Math.min(limit, 50), startingRecord: 0, searchOptions: 'InStock' } }, ctx),
}
