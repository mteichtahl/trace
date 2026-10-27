/**
 * The AWS price list (the Price List Query API, GetProducts) mapped onto the price table (src/core/prices.ts). Pure:
 * the products come in, the table's fetched part and plain-words notes go out; the Lambda that asks is
 * src/infra/lambda/cost-explorer.ts refreshPrices.
 *
 * What the price list has, as of its October 2026 publications (checked against the public price list files, which
 * hold the same product records GetProducts returns):
 *
 *   Claude on Bedrock   service code AmazonBedrockFoundationModels (the "Amazon Bedrock Edition" listings, one per
 *                       model and region; the older service code AmazonBedrock lists only Claude 2 to 3 Sonnet, input
 *                       tokens only). Attributes: model ("Claude Sonnet 4.6", a display name, not the model id),
 *                       provider (Anthropic), regionCode, feature ("On-demand Inference", "Batch Inference",
 *                       "Provisioned Throughput Inference"), inferenceType ("Input tokens", "Output tokens", "Prompt
 *                       cache read input tokens", "Prompt cache write input tokens"), and usagetype, which tells the
 *                       endpoint and variant apart: "USE1-MP:USE1_InputTokenCount-Units" (in-region, which the
 *                       price list calls Regional CRIS) and "…_InputTokenCount_Global-Units" (a global inference
 *                       profile); the newer models "…_input_tokens_standard-Units" and "…_input_tokens_global_standard
 *                       -Units". Variants trace does not use are left out: batch, latency optimized, long context, and
 *                       the one-hour cache write (the table's cacheWrite is the five-minute cache). Prices are per
 *                       "1M tokens" (some older records per "1K tokens", scaled here)
 *   The Batch pools     service code AmazonEC2: instanceType, regionCode, operatingSystem Linux, tenancy Shared,
 *                       preInstalledSw NA, capacitystatus Used, licenseModel "No License required", per "Hrs", with
 *                       vcpu. On demand only: the price list has no Spot prices
 *
 * What it lacks, and what happens then: a model id (only its display name: the match key is made from it, "Claude
 * Sonnet 4.6" → "claude-sonnet-4-6", and a name that makes no key a model id contains, "Claude 3.5 Sonnet v2", is left
 * out); cache prices for the older models; a model released after its publication. A field it does not give is taken
 * from the built-in entry with the same match (said in the notes and kept on the entry as `filled`), and an entry that
 * would still miss one is left out, so the built-in table or the Agent SDK's figure prices that model. No price is
 * ever made up.
 */
import { z } from 'zod'
import { DEFAULT_PRICES, type ModelPrice, ModelPriceSchema, type TokenField, bareModel } from './prices.js'

export const BEDROCK_SERVICE = 'AmazonBedrockFoundationModels'
export const EC2_SERVICE = 'AmazonEC2'
/** What the fetched table cites. */
export const PRICE_LIST_SOURCE = 'https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/price-changes.html'
/** The most models taken from the price list (the table holds 60 with the built-in ones and the overrides). */
export const MAX_FETCHED_MODELS = 40

/** The Price List Query API's endpoints (its only regions), and the one nearest an installation's region. */
export const PRICING_ENDPOINTS = ['us-east-1', 'eu-central-1', 'ap-south-1'] as const
export function pricingEndpoint(region: string | null | undefined): (typeof PRICING_ENDPOINTS)[number] {
  const r = (region ?? '').toLowerCase()
  if (/^(eu|il|me|af)-/.test(r)) return 'eu-central-1'
  if (/^ap-/.test(r)) return 'ap-south-1'
  return 'us-east-1'
}

// ------------------------------------------------------------------ the product records (one PriceList entry each)

const PriceDimension = z.object({ unit: z.string(), pricePerUnit: z.record(z.string(), z.string()), description: z.string().optional() }).loose()
const Term = z.object({ priceDimensions: z.record(z.string(), PriceDimension), effectiveDate: z.string().optional() }).loose()
export const PriceListProductSchema = z.object({
  product: z.object({ sku: z.string().optional(), attributes: z.record(z.string(), z.string()) }).loose(),
  serviceCode: z.string().optional(),
  terms: z.object({ OnDemand: z.record(z.string(), Term).optional() }).loose(),
  publicationDate: z.string().optional(),
}).loose()
export type PriceListProduct = z.output<typeof PriceListProductSchema>

/** GetProducts' PriceList (each entry a JSON string) as product records; an entry that does not parse is skipped. */
export function parsePriceList(list: readonly string[] | undefined): PriceListProduct[] {
  const out: PriceListProduct[] = []
  for (const s of list ?? []) {
    try {
      const r = PriceListProductSchema.safeParse(JSON.parse(s))
      if (r.success) out.push(r.data)
    } catch { /* not JSON: skipped */ }
  }
  return out
}

/** The product's on-demand USD price per unit, and the unit; null when it has none. */
function onDemand(p: PriceListProduct): { usd: number; unit: string } | null {
  for (const t of Object.values(p.terms.OnDemand ?? {})) {
    for (const d of Object.values(t.priceDimensions)) {
      const usd = Number(d.pricePerUnit.USD)
      if (d.pricePerUnit.USD !== undefined && Number.isFinite(usd) && usd >= 0) return { usd, unit: d.unit }
    }
  }
  return null
}

// ------------------------------------------------------------------ Claude on Bedrock

/** The match key a price list model name makes: "Claude Sonnet 4.6" → "claude-sonnet-4-6"; null when it makes none. */
export function matchKey(name: string): string | null {
  const k = name.trim().toLowerCase().replace(/[.\s]+/g, '-').replace(/-+/g, '-')
  // a key a model id can contain: "claude", a family name and version numbers in either order (no "v2", "preview")
  if (!/^claude(-[a-z]+)?(-\d+)+(-[a-z]+)?$/.test(k) && !/^claude-[a-z]+$/.test(k)) return null
  if (/-(preview|instant|v\d+)$/.test(k)) return null
  return k
}

/** A key's major version ("claude-sonnet-4-6" → 4, "claude-3-7-sonnet" → 3); 0 when it has none. */
const major = (key: string): number => Number(/^claude-(?:[a-z]+-)?(\d+)/.exec(key)?.[1] ?? 0)

/** Which field of the table an inferenceType prices. */
function fieldOf(inferenceType: string | undefined): TokenField | null {
  switch ((inferenceType ?? '').toLowerCase()) {
    case 'input tokens': return 'input'
    case 'output tokens': return 'output'
    case 'prompt cache read input tokens': return 'cacheRead'
    case 'prompt cache write input tokens': return 'cacheWrite'
    default: return null
  }
}

/** The usagetype's variant: global or in-region; null for one trace does not use (batch, long context, 1-hour cache,
 * latency optimized, a tier other than standard). */
export function variantOf(usagetype: string): 'global' | 'regional' | null {
  const u = usagetype.toLowerCase().replace(/^[a-z0-9]+-mp:[a-z0-9]+_/, '').replace(/-units$/, '')
  if (/batch|latency|long_?ctx|longcontext|1h|reserved|tpm|provisioned|customization|storage|training/.test(u)) return null
  // the newer records name their service tier: only standard is the on-demand price
  if (/_tokens(_|$)/.test(u) && !/_standard$/.test(u)) return null
  return /(^|_)global(_|$)/.test(u) ? 'global' : 'regional'
}

type Prices = Partial<Record<TokenField, number>>
const FIELDS: readonly TokenField[] = ['input', 'output', 'cacheWrite', 'cacheRead']
const FIELD_WORDS: Record<TokenField, string> = { input: 'input', output: 'output', cacheWrite: 'cache write', cacheRead: 'cache read' }

/** Whether `key` names exactly the model `id` is (not an older one it starts with: "claude-opus-4" is not
 * "claude-opus-4-8"): after the key, the id ends, or goes on with its date or version ("-20250929-v1:0", ":0"). */
export function namesModel(id: string, key: string): boolean {
  const m = bareModel(id)
  const i = m.indexOf(key)
  return i >= 0 && /^($|:|-\d{8}|-v\d)/.test(m.slice(i + key.length))
}

/** Which price list models to take: those a configured model id contains, and the current family (version 4 on). */
export function wantedKey(key: string, models: readonly string[]): boolean {
  if (models.some((m) => bareModel(m).includes(key))) return true
  return major(key) >= 4
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6

/**
 * The model entries the price list gives for `region`: per million tokens, the global price as the entry's own and
 * the in-region price as `inRegion`; a field it lacks from the built-in entry of the same match (`filled`), and an
 * entry that would still lack one left out. Notes say both, in plain words.
 */
export function modelsFromPriceList(products: readonly PriceListProduct[], o: { region: string; models: readonly string[] }): { models: ModelPrice[]; notes: string[] } {
  const found = new Map<string, { name: string; global: Prices; regional: Prices }>()
  for (const p of products) {
    const a = p.product.attributes
    if ((a.provider ?? '').toLowerCase() !== 'anthropic') continue
    if (a.regionCode && a.regionCode !== o.region) continue
    if (a.feature && a.feature !== 'On-demand Inference') continue
    const key = matchKey(a.model ?? '')
    const field = fieldOf(a.inferenceType)
    const variant = variantOf(a.usagetype ?? '')
    const price = onDemand(p)
    if (!key || !field || !variant || !price) continue
    const scale = /^1m tokens$/i.test(price.unit) ? 1 : /^1k tokens$/i.test(price.unit) ? 1000 : null
    if (scale === null) continue
    const e = found.get(key) ?? { name: a.model ?? key, global: {}, regional: {} }
    e[variant][field] = round(price.usd * scale)
    found.set(key, e)
  }
  const notes: string[] = []
  const models: ModelPrice[] = []
  const skipped = new Set<string>()
  const keys = [...found.keys()].filter((k) => wantedKey(k, o.models))
    // the configured models first, then the newest
    .sort((x, y) => Number(o.models.some((m) => bareModel(m).includes(y))) - Number(o.models.some((m) => bareModel(m).includes(x))) || major(y) - major(x) || y.localeCompare(x))
  for (const key of keys.slice(0, MAX_FETCHED_MODELS)) {
    const e = found.get(key)
    if (!e) continue
    const builtIn = DEFAULT_PRICES.models.find((m) => m.match === key && !m.regions) ?? null
    const hasGlobal = FIELDS.some((f) => e.global[f] !== undefined)
    const hasRegional = FIELDS.some((f) => e.regional[f] !== undefined)
    const filled = new Set<TokenField>()
    // a variant's missing fields from the built-in entry (in-region: times its regional premium); null: none there
    const complete = (got: Prices, inRegion: boolean): Record<TokenField, number> | null => {
      const out: Partial<Record<TokenField, number>> = {}
      for (const f of FIELDS) {
        const v = got[f] ?? (builtIn ? round(builtIn[f] * (inRegion ? builtIn.regional : 1)) : undefined)
        if (v === undefined) return null
        if (got[f] === undefined) filled.add(f)
        out[f] = v
      }
      return out as Record<TokenField, number>
    }
    const base = complete(hasGlobal ? e.global : e.regional, !hasGlobal)
    const inRegion = hasGlobal && hasRegional ? complete(e.regional, true) : null
    if (!base) {
      const missing = FIELDS.filter((f) => (hasGlobal ? e.global : e.regional)[f] === undefined).map((f) => FIELD_WORDS[f])
      notes.push(`${e.name}: the price list has no ${missing.join(' or ')} price and the built-in table has no entry for it, so it is not taken from the price list.`)
      skipped.add(key)
      continue
    }
    if (filled.size) notes.push(`${e.name}: the price list has no ${[...filled].map((f) => FIELD_WORDS[f]).join(' or ')} price; the built-in table's (${DEFAULT_PRICES.asOf}) is used for ${filled.size === 1 ? 'it' : 'them'}.`)
    models.push(ModelPriceSchema.parse({
      match: key, ...base,
      ...(inRegion ? { inRegion } : {}),
      // only in-region prices: the same for a global profile; only global ones: the built-in premium for in-region
      regional: !hasRegional && builtIn ? builtIn.regional : 1,
      ...(filled.size ? { filled: [...filled] } : {}),
    }))
  }
  if (keys.length > MAX_FETCHED_MODELS) notes.push(`The price list has ${keys.length} Claude models in ${o.region}; the ${MAX_FETCHED_MODELS} configured or newest are taken.`)
  for (const m of new Set(o.models)) {
    if (!/anthropic\.claude/.test(bareModel(m)) || models.some((x) => namesModel(m, x.match)) || [...skipped].some((k) => namesModel(m, k))) continue
    notes.push(`${m}: the price list for ${o.region} has no entry for this model, so it is priced by the closest entry the table has (the longest name it starts with), or by the Agent SDK's own figure when there is none.`)
  }
  return { models, notes }
}

// ------------------------------------------------------------------ the Batch pools (EC2 on demand)

/** The GetProducts filters for one instance type's on-demand Linux price in a region. */
export const ec2Filters = (instanceType: string, region: string): { Type: 'TERM_MATCH'; Field: string; Value: string }[] => [
  ['instanceType', instanceType], ['regionCode', region], ['operatingSystem', 'Linux'], ['tenancy', 'Shared'], ['preInstalledSw', 'NA'],
  ['capacitystatus', 'Used'], ['licenseModel', 'No License required'], ['marketoption', 'OnDemand'],
].map(([Field = '', Value = '']) => ({ Type: 'TERM_MATCH' as const, Field, Value }))

/** An instance family ("c7i") as a type to ask the price list for: its xlarge (a family's sizes cost the same per
 * vCPU); a type stays as it is. */
export const askedType = (t: string): string => (t.includes('.') ? t : `${t}.xlarge`)

/** One instance type's on-demand price per hour and its vCPUs, from its products; null when they hold none. */
export function instancePrice(products: readonly PriceListProduct[], instanceType: string, region: string): { perHour: number; vcpus: number } | null {
  for (const p of products) {
    const a = p.product.attributes
    if (a.instanceType !== instanceType || (a.regionCode && a.regionCode !== region)) continue
    if ((a.operatingSystem && a.operatingSystem !== 'Linux') || (a.tenancy && a.tenancy !== 'Shared') || (a.preInstalledSw && a.preInstalledSw !== 'NA') || (a.capacitystatus && a.capacitystatus !== 'Used')) continue
    const price = onDemand(p)
    const vcpus = Number(a.vcpu)
    if (!price || !/^hrs?$/i.test(price.unit) || !(price.usd > 0) || !(vcpus > 0)) continue
    return { perHour: round(price.usd), vcpus }
  }
  return null
}
