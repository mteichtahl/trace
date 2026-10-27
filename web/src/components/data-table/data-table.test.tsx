import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ColumnDef } from '@tanstack/react-table'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DataTable } from './data-table'
import { decodeSort, encodeSort, fromSearch, toSearch } from './view'

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), call: vi.fn(async () => ({ ok: true })) }))

interface Part { ref: string; mpn: string; stock: number; status: string }
const data: Part[] = [
  { ref: 'C2', mpn: 'CL10A225KP8NNNC', stock: 1_200_000, status: 'In stock' },
  { ref: 'D1', mpn: 'SMAJ5.0A', stock: 48_000, status: 'In stock' },
  { ref: 'J1', mpn: 'S2B-PH-K-S', stock: 21_000, status: 'Low' },
  { ref: 'U1', mpn: 'STM32WLE5JCI6', stock: 1_140, status: 'Low' },
  { ref: 'U2', mpn: 'TLV75533PDBVR', stock: 9_870, status: 'In stock' },
]
const columns: ColumnDef<Part, any>[] = [
  { accessorKey: 'ref', header: 'Ref', meta: { label: 'Ref' } },
  { accessorKey: 'mpn', header: 'MPN', meta: { label: 'MPN', mono: true } },
  { accessorKey: 'stock', header: 'In stock', meta: { label: 'In stock', kind: 'number' } },
  { accessorKey: 'status', header: 'Status', meta: { label: 'Status', kind: 'enum' } },
]

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(['me.get', {}], { prefs: {}, views: {} })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const firstColumn = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]!.textContent)

describe('DataTable', () => {
  beforeEach(() => {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  })

  it('counts rows and searches across columns with highlighted matches', async () => {
    wrap(<DataTable id="parts" data={data} columns={columns} noun="parts" persist={false} />)
    expect(screen.getByTestId('row-count')).toHaveTextContent('5 of 5 parts')
    await userEvent.type(screen.getByLabelText('Search the table'), 'tlv')
    expect(screen.getByTestId('row-count')).toHaveTextContent('1 of 5 parts')
    const mark = document.querySelector('mark.match')
    expect(mark?.textContent?.toLowerCase()).toBe('tlv')
  })

  it('sorts ascending, descending, then clears; shift-click adds a second sort', async () => {
    wrap(<DataTable id="parts" data={data} columns={columns} persist={false} />)
    const stock = screen.getByRole('button', { name: /In stock/ })
    await userEvent.click(stock)
    expect(firstColumn()).toEqual(['U1', 'U2', 'J1', 'D1', 'C2'])
    expect(screen.getByRole('columnheader', { name: /In stock/ })).toHaveAttribute('aria-sort', 'ascending')
    await userEvent.click(stock)
    expect(firstColumn()).toEqual(['C2', 'D1', 'J1', 'U2', 'U1'])
    await userEvent.click(stock)
    expect(firstColumn()).toEqual(['C2', 'D1', 'J1', 'U1', 'U2'])
    // status, then shift-click stock descending within it
    await userEvent.click(screen.getByRole('button', { name: /Status/ }))
    const user = userEvent.setup()
    await user.keyboard('{Shift>}')
    await user.click(stock)
    await user.click(stock)
    await user.keyboard('{/Shift}')
    expect(firstColumn()).toEqual(['C2', 'D1', 'U2', 'J1', 'U1'])
  })

  it('filters by kind and shows removable chips with Clear all', async () => {
    wrap(<DataTable id="parts" data={data} columns={columns} persist={false} />)
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }))
    // pick the Status column (enum) and check "Low"
    await userEvent.click(screen.getByRole('combobox'))
    await userEvent.click(await screen.findByRole('option', { name: 'Status' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Low' }))
    await userEvent.keyboard('{Escape}')
    expect(screen.getByTestId('row-count')).toHaveTextContent('2 of 5 rows')
    expect(screen.getByText('Low', { selector: 'span *, span' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(screen.getByTestId('row-count')).toHaveTextContent('5 of 5 rows')
  })

  it('hides a column from the Columns menu, but never the first', async () => {
    wrap(<DataTable id="parts" data={data} columns={columns} persist={false} />)
    await userEvent.click(screen.getByRole('button', { name: /Columns/ }))
    const ref = await screen.findByRole('menuitemcheckbox', { name: 'Ref' })
    expect(ref).toHaveAttribute('data-disabled')
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'MPN' }))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('columnheader', { name: /MPN/ })).toBeNull()
  })

  it('becomes stacked cards under 640 px', () => {
    window.matchMedia = ((q: string) => ({ matches: q.includes('max-width: 639px'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
    wrap(<DataTable id="parts" data={data} columns={columns} persist={false} />)
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('list', { name: /as cards/ }).children).toHaveLength(5)
  })

  it('writes sort, filters and search to the address and reads them back', () => {
    expect(decodeSort(encodeSort([{ id: 'a', desc: false }, { id: 'b', desc: true }]))).toEqual([{ id: 'a', desc: false }, { id: 'b', desc: true }])
    const s = toSearch('parts', { sorting: [{ id: 'stock', desc: true }], filters: [{ id: 'status', value: ['Low'] }], q: 'tlv' })
    expect(s).toEqual({ 'parts.sort': 'stock:desc', 'parts.f': '[["status",["Low"]]]', 'parts.q': 'tlv' })
    expect(fromSearch('parts', s)).toEqual({ sorting: [{ id: 'stock', desc: true }], filters: [{ id: 'status', value: ['Low'] }], q: 'tlv' })
  })

  it('starts from the view in the address', () => {
    wrap(<DataTable id="parts" data={data} columns={columns} persist={false} url={{ view: { sorting: [{ id: 'ref', desc: true }], q: '' }, set: () => {} }} />)
    expect(firstColumn()).toEqual(['U2', 'U1', 'J1', 'D1', 'C2'])
  })
})
