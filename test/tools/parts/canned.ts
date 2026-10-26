/**
 * Canned provider answers in each provider's documented shape (trimmed to the fields trace reads), as TypeScript
 * objects, and a fake fetch that routes requests to them. The part: a TI TPS62130 buck converter in VQFN-16 (RGT),
 * with a packaging variant (…RGTT), plus an alternative of the same package and ratings (TPS62133RGTR) and one that
 * differs in output (TPS62130A).
 */
import type { DigikeyAnswer } from '../../../src/tools/parts/providers/digikey.js'
import type { JlcAnswer } from '../../../src/tools/parts/providers/lcsc.js'
import type { MouserAnswer } from '../../../src/tools/parts/providers/mouser.js'
import type { NexarAnswer } from '../../../src/tools/parts/providers/nexar.js'

export const jlcAnswer: JlcAnswer = {
  code: 200,
  message: null,
  data: {
    componentPageInfo: {
      total: 2,
      list: [
        {
          componentCode: 'C116592', stockCount: 1520, componentLibraryType: 'expand', leastPatchNumber: 1, lossNumber: 3,
          componentPrices: [
            { startNumber: 1, endNumber: 9, productPrice: 1.92 },
            { startNumber: 10, endNumber: 29, productPrice: 1.71 },
            { startNumber: 30, endNumber: -1, productPrice: 1.55 },
          ],
          componentModelEn: 'TPS62130RGTR', componentBrandEn: 'Texas Instruments', componentSpecificationEn: 'VQFN-16(3x3)',
          describe: '3V~17V 3A Step-down buck VQFN-16', dataManualUrl: 'https://www.lcsc.com/datasheet/lcsc_datasheet_TPS62130.pdf',
          lcscGoodsUrl: 'https://www.lcsc.com/product-detail/C116592.html',
          attributes: [{ attribute_name_en: 'Output Current', attribute_value_name: '3A' }],
        },
        {
          componentCode: 'C2869962', stockCount: 0, componentLibraryType: 'expand', leastPatchNumber: 1,
          componentPrices: [{ startNumber: 1, endNumber: -1, productPrice: 2.4 }],
          componentModelEn: 'TPS62130RGTT', componentBrandEn: 'Texas Instruments', componentSpecificationEn: 'VQFN-16(3x3)',
          describe: '3V~17V 3A Step-down buck VQFN-16 (small reel)',
        },
      ],
    },
  },
}

export const jlcError: JlcAnswer = { code: 500, message: 'system busy', data: null }

export const mouserAnswer: MouserAnswer = {
  Errors: [],
  SearchResults: {
    NumberOfResult: 1,
    Parts: [{
      MouserPartNumber: '595-TPS62130RGTR', ManufacturerPartNumber: 'TPS62130RGTR', Manufacturer: 'Texas Instruments',
      Description: 'Switching Voltage Regulators 3-17V 3A Step-Down Converter', DataSheetUrl: 'https://www.ti.com/lit/ds/symlink/tps62130.pdf',
      ProductDetailUrl: 'https://www.mouser.com/ProductDetail/595-TPS62130RGTR', Availability: '4,210 In Stock', AvailabilityInStock: '4210',
      Min: '1', LifecycleStatus: null, Category: 'Switching Voltage Regulators',
      PriceBreaks: [
        { Quantity: 1, Price: '$3.41', Currency: 'USD' },
        { Quantity: 10, Price: '$2.55', Currency: 'USD' },
        { Quantity: 100, Price: '$1.93', Currency: 'USD' },
      ],
      ProductAttributes: [{ AttributeName: 'Package / Case', AttributeValue: 'VQFN-16' }, { AttributeName: 'Packaging', AttributeValue: 'Reel' }],
    }],
  },
}

export const mouserError: MouserAnswer = { Errors: [{ Code: 'Invalid', Message: 'Invalid unique identifier.' }], SearchResults: null }

export const digikeyAnswer: DigikeyAnswer = {
  ProductsCount: 1,
  ExactMatches: [{
    ManufacturerProductNumber: 'TPS62130RGTR',
    Manufacturer: { Name: 'Texas Instruments' },
    Description: { ProductDescription: 'IC REG BUCK ADJ 3A 16VQFN', DetailedDescription: 'Buck Switching Regulator IC Positive Adjustable 0.9V 1 Output 3A 16-VFQFN Exposed Pad' },
    QuantityAvailable: 9000,
    ProductUrl: 'https://www.digikey.com/en/products/detail/texas-instruments/TPS62130RGTR/3032276',
    DatasheetUrl: 'https://www.ti.com/lit/ds/symlink/tps62130.pdf',
    ProductStatus: { Status: 'Active' },
    Parameters: [{ ParameterText: 'Package / Case', ValueText: '16-VFQFN Exposed Pad' }, { ParameterText: 'Voltage - Input (Max)', ValueText: '17V' }],
    ProductVariations: [
      { DigiKeyProductNumber: '296-38544-1-ND', QuantityAvailableforPackageType: 9000, MinimumOrderQuantity: 1, PackageType: { Name: 'Cut Tape (CT)' },
        StandardPricing: [{ BreakQuantity: 1, UnitPrice: 3.36 }, { BreakQuantity: 10, UnitPrice: 2.42 }, { BreakQuantity: 100, UnitPrice: 1.86 }] },
      { DigiKeyProductNumber: '296-38544-2-ND', QuantityAvailableforPackageType: 6000, MinimumOrderQuantity: 3000, PackageType: { Name: 'Tape & Reel (TR)' },
        StandardPricing: [{ BreakQuantity: 3000, UnitPrice: 1.21 }] },
    ],
  }],
  Products: [],
}

export const digikeyToken = { access_token: 'dk-token', expires_in: 599, token_type: 'Bearer' }
export const nexarToken = { access_token: 'nx-token', expires_in: 86400, token_type: 'Bearer', scope: 'supply.domain' }

export const nexarAnswer: NexarAnswer = {
  data: {
    supSearchMpn: {
      results: [{
        part: {
          mpn: 'TPS62130RGTR', manufacturer: { name: 'Texas Instruments' }, shortDescription: '3A step-down converter, VQFN-16',
          bestDatasheet: { url: 'https://www.ti.com/lit/ds/symlink/tps62130.pdf' }, category: { name: 'DC-DC converters' },
          specs: [{ attribute: { name: 'Case/Package', shortname: 'case_package' }, displayValue: 'VQFN-16' }, { attribute: { name: 'Lifecycle Status', shortname: 'lifecyclestatus' }, displayValue: 'Production (Last Updated: 1 month ago)' }],
          sellers: [
            { company: { name: 'Arrow Electronics' }, isAuthorized: true, offers: [{ sku: 'TPS62130RGTR', inventoryLevel: 12000, moq: 1, packaging: 'Cut Tape', clickUrl: 'https://octopart.com/click/arrow', prices: [{ quantity: 1, price: 2.9, currency: 'USD', convertedPrice: 2.9, convertedCurrency: 'USD' }, { quantity: 100, price: 1.7, currency: 'USD', convertedPrice: 1.7, convertedCurrency: 'USD' }] }] },
            { company: { name: 'Farnell' }, isAuthorized: true, offers: [{ sku: '2401234', inventoryLevel: 50, moq: 5, packaging: null, clickUrl: null, prices: [{ quantity: 5, price: 2.6, currency: 'GBP', convertedPrice: null, convertedCurrency: null }] }] },
          ],
        },
      }],
    },
  },
}

export const nexarSearchAnswer: NexarAnswer = {
  data: {
    supSearch: {
      results: [
        { part: { mpn: 'TPS62133RGTR', manufacturer: { name: 'Texas Instruments' }, shortDescription: '3A step-down converter, 3.3 V fixed',
          specs: [{ attribute: { name: 'Case/Package', shortname: 'case_package' }, displayValue: 'VQFN-16' }, { attribute: { name: 'Voltage - Input (Max)', shortname: 'vin' }, displayValue: '17V' }],
          sellers: [{ company: { name: 'Mouser' }, isAuthorized: true, offers: [{ sku: '595-TPS62133RGTR', inventoryLevel: 800, moq: 1, prices: [{ quantity: 1, convertedPrice: 3.1, convertedCurrency: 'USD' }] }] }] } },
        { part: { mpn: 'TPS62130A', manufacturer: { name: 'Texas Instruments' }, shortDescription: 'variant',
          specs: [{ attribute: { name: 'Case/Package', shortname: 'case_package' }, displayValue: 'VQFN-16' }, { attribute: { name: 'Voltage - Input (Max)', shortname: 'vin' }, displayValue: '5.5V' }],
          sellers: [] } },
        { part: { mpn: 'LMR33630', manufacturer: { name: 'Texas Instruments' }, specs: [{ attribute: { name: 'Case/Package', shortname: 'case_package' }, displayValue: 'SOIC-8' }], sellers: [] } },
        { part: { mpn: 'TPS62130RGTT', manufacturer: { name: 'Texas Instruments' }, specs: [{ attribute: { name: 'Case/Package', shortname: 'case_package' }, displayValue: 'VQFN-16' }], sellers: [] } },
      ],
    },
  },
}

export const nexarError: NexarAnswer = { data: null, errors: [{ message: 'Monthly part limit exceeded' }] }

export interface Recorded {
  url: string
  method: string
  headers: Headers
  body: string
}

/** A fetch that answers from a route table and records every request. */
export function fakeFetch(routes: Record<string, unknown | ((req: Recorded) => unknown)>, calls: Recorded[] = []) {
  const f = async (url: string, init: RequestInit): Promise<Response> => {
    const req: Recorded = { url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: typeof init.body === 'string' ? init.body : '' }
    calls.push(req)
    const key = Object.keys(routes).find((k) => url.startsWith(k))
    if (!key) return new Response('not found', { status: 404 })
    const v = routes[key]
    const body = typeof v === 'function' ? (v as (r: Recorded) => unknown)(req) : v
    if (body instanceof Response) return body
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetch: f, calls }
}
