/**
 * LCSC / JLCPCB: the public parts-library search the JLCPCB website uses (no key). One search answers both an LCSC
 * code (C123456) and a part number. JLCPCB lists one part more than once (reels, cut tape, a second import), so a
 * lookup keeps every listing whose part number is the one asked for or begins with it, and marks which are exact.
 */
import { z } from 'zod'
import { mpnLoose } from '../../datasheets/mpn.js'
import { jsonOf, ProviderError, type PartOffer, type Provider, type ProviderContext } from '../types.js'

export const JLC_SEARCH_URL = 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList'
export const LCSC_CODE = /^C\d{1,10}$/i

const Hit = z.object({
  componentCode: z.string().optional(),
  stockCount: z.number().nullish(),
  componentLibraryType: z.string().nullish(),
  leastPatchNumber: z.number().nullish(),
  lossNumber: z.number().nullish(),
  componentPrices: z.array(z.object({ startNumber: z.number(), endNumber: z.number(), productPrice: z.number() })).nullish(),
  componentModelEn: z.string().nullish(),
  componentBrandEn: z.string().nullish(),
  componentSpecificationEn: z.string().nullish(),
  describe: z.string().nullish(),
  dataManualUrl: z.string().nullish(),
  lcscGoodsUrl: z.string().nullish(),
  attributes: z.array(z.object({ attribute_name_en: z.string(), attribute_value_name: z.string() })).nullish(),
})
export const JlcAnswer = z.object({
  code: z.number().optional(),
  message: z.string().nullish(),
  data: z.object({ componentPageInfo: z.object({ list: z.array(Hit).nullish(), total: z.number().nullish() }).nullish() }).nullish(),
})
export type JlcAnswer = z.input<typeof JlcAnswer>

export function jlcOffers(answer: unknown): PartOffer[] {
  const a = JlcAnswer.safeParse(answer)
  if (!a.success) throw new ProviderError(`lcsc: an unexpected answer (${a.error.issues[0]?.message ?? 'shape'})`)
  if (a.data.code !== undefined && a.data.code !== 200) throw new ProviderError(`lcsc: JLCPCB answered ${a.data.code}${a.data.message ? `: ${a.data.message}` : ''}`)
  return (a.data.data?.componentPageInfo?.list ?? []).filter((h) => h.componentCode).map((h): PartOffer => {
    const code = (h.componentCode ?? '').toUpperCase()
    const attributes: Record<string, string> = {}
    for (const x of h.attributes ?? []) attributes[x.attribute_name_en] = x.attribute_value_name
    if (h.componentLibraryType) attributes['JLC library'] = h.componentLibraryType === 'base' ? 'basic' : h.componentLibraryType === 'expand' ? 'extended' : h.componentLibraryType
    if (typeof h.lossNumber === 'number') attributes['JLC attrition'] = String(h.lossNumber)
    return {
      mpn: h.componentModelEn ?? code,
      manufacturer: h.componentBrandEn ?? null,
      description: h.describe ?? null,
      provider: 'lcsc',
      seller: 'LCSC/JLCPCB',
      provider_part: code,
      stock: typeof h.stockCount === 'number' ? h.stockCount : null,
      moq: typeof h.leastPatchNumber === 'number' && h.leastPatchNumber > 0 ? h.leastPatchNumber : null,
      price_breaks: (h.componentPrices ?? []).map((p) => ({ qty: p.startNumber, price: p.productPrice, currency: 'USD' })).sort((x, y) => x.qty - y.qty),
      lifecycle: null,
      datasheet_url: h.dataManualUrl ?? null,
      package: h.componentSpecificationEn ?? null,
      attributes,
      url: h.lcscGoodsUrl ?? `https://jlcpcb.com/partdetail/${code}`,
    }
  })
}

async function query(keyword: string, ctx: ProviderContext, pageSize: number): Promise<PartOffer[]> {
  const r = await ctx.fetch(JLC_SEARCH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Mozilla/5.0 (tracekit parts lookup)' },
    body: JSON.stringify({ keyword, currentPage: 1, pageSize, searchSource: 'search' }),
    signal: AbortSignal.timeout(20_000),
  })
  return jlcOffers(await jsonOf(r, 'lcsc'))
}

export const lcsc: Provider = {
  name: 'lcsc',
  unavailable: () => null,
  async lookup(mpn, ctx) {
    const offers = await query(mpn, ctx, 25)
    if (LCSC_CODE.test(mpn)) return offers.filter((o) => o.provider_part === mpn.toUpperCase())
    const want = mpnLoose(mpn)
    return offers.filter((o) => mpnLoose(o.mpn).startsWith(want))
  },
  search: (q, ctx, limit) => query(q, ctx, Math.min(limit, 50)),
}
