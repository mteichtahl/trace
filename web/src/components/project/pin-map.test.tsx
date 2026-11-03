/**
 * The pin map: which peripheral a pin belongs to, how pins, peripherals and nets are placed and linked, what a
 * selection lights (peripheral → its pins → their nets; a net → its pins → their peripherals), and the drawing
 * rendering through React Flow.
 */
import { render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import { chainOf } from '@/components/canvas/flow'
import type { PinView } from '@/lib/types-s1'
import { PinMap, layoutPins, peripheralOf, pinElements } from './pin-map'

const pin = (p: string, net: string, fn: string, status: PinView['status'] = 'ok', extra: Partial<PinView> = {}): PinView => ({ pin: p, net, fn, status, ...extra })
const pins: PinView[] = [
  pin('PA0', 'SENSE_EXC', 'TIM2_CH1'),
  pin('PA2', 'UART_TX', 'USART2_TX'),
  pin('PA3', 'UART_RX', 'USART2_RX'),
  pin('PA13', 'SWDIO', 'SWDIO'),
  pin('PB6', 'I2C_SCL', 'I2C1_SCL', 'conflict'),
  pin('PB8', 'TP_SPARE1', 'Spare', 'spare'),
  pin('PA4', 'UART_TX', 'GPIO'), // a second pin on UART_TX: a net shared by two peripherals
]
const l = layoutPins(pins)
const sorted = (s: Set<string>) => [...s].sort()

describe('peripheral of a pin', () => {
  it('reads it from the function, or takes the plan\'s own word', () => {
    expect(peripheralOf(pin('PA2', 'X', 'USART2_TX'))).toBe('USART2')
    expect(peripheralOf(pin('PA1', 'X', 'ADC_IN6'))).toBe('ADC')
    expect(peripheralOf(pin('PB6', 'X', 'i2c1_scl'))).toBe('I2C1')
    expect(peripheralOf(pin('PA13', 'X', 'SWDIO'))).toBe('SWD')
    expect(peripheralOf(pin('PB3', 'X', 'GPIO'))).toBe('GPIO')
    expect(peripheralOf(pin('PA9', 'X', 'TX', 'ok', { peripheral: 'LPUART1' }))).toBe('LPUART1')
  })
  it('a spare pin has none', () => {
    expect(peripheralOf(pin('PB8', 'X', 'Spare', 'spare'))).toBeNull()
    expect(peripheralOf(pin('PB9', 'X', 'spare'))).toBeNull()
  })
})

describe('layout', () => {
  it('groups pins by peripheral, in the order peripherals first appear, spares last', () => {
    expect(l.pins.map((r) => r.pin.pin)).toEqual(['PA0', 'PA2', 'PA3', 'PA13', 'PB6', 'PA4', 'PB8'])
    expect(l.pers.map((p) => p.name)).toEqual(['TIM2', 'USART2', 'SWD', 'I2C1', 'GPIO'])
  })
  it('never stacks two peripherals or two nets on one row', () => {
    for (const col of [l.pers, l.nets]) for (let i = 1; i < col.length; i++) expect(col[i]!.y).toBeGreaterThanOrEqual(col[i - 1]!.y + 52)
  })
  it('one net box for a net several pins share, counting them', () => {
    expect(l.nets.filter((n) => n.name === 'UART_TX')).toEqual([expect.objectContaining({ pins: 2 })])
  })
  it('marks a conflict red along its path, and dashes a spare\'s net link', () => {
    expect(l.pers.find((p) => p.name === 'I2C1')!.bad).toBe(true)
    expect(l.links.filter((k) => k.bad).map((k) => k.id).sort()).toEqual(['per:I2C1>pin:.PB6', 'pin:.PB6>net:I2C_SCL'])
    expect(l.links.find((k) => k.id === 'pin:.PB8>net:TP_SPARE1')!.dashed).toBe(true)
    expect(l.links.some((k) => k.target === 'pin:.PB8' && k.source.startsWith('per:'))).toBe(false)
  })
})

describe('a selection lights its whole path', () => {
  it('a peripheral: its pins and their nets', () => {
    expect(sorted(chainOf(l.links, 'per:USART2').nodes)).toEqual(['net:UART_RX', 'net:UART_TX', 'per:USART2', 'pin:.PA2', 'pin:.PA3'])
  })
  it('a net: every pin on it and their peripherals, not the other pins of those peripherals', () => {
    const c = chainOf(l.links, 'net:UART_TX')
    expect(sorted(c.nodes)).toEqual(['net:UART_TX', 'per:GPIO', 'per:USART2', 'pin:.PA2', 'pin:.PA4'])
    expect(c.nodes.has('pin:.PA3')).toBe(false)
  })
  it('a pin: its peripheral and its net', () => {
    expect(sorted(chainOf(l.links, 'pin:.PA3').nodes)).toEqual(['net:UART_RX', 'per:USART2', 'pin:.PA3'])
  })
  it('fades what is off the path', () => {
    const { nodes, edges } = pinElements(l, 'per:USART2', false)
    const lit = (id: string) => (nodes.find((n) => n.id === id)!.data as { lit: string }).lit
    expect(lit('per:USART2')).toBe('selected')
    expect(lit('pin:.PA2')).toBe('lit')
    expect(lit('pin:.PA0')).toBe('dim')
    expect(edges.find((e) => e.id === 'per:TIM2>pin:.PA0')!.style!.opacity).toBe(0.15)
  })
})

describe('the drawing', () => {
  it('renders through React Flow with a labelled box for each peripheral, pin and net', () => {
    render(
      <ReactFlowProvider>
        <div style={{ width: 800, height: 400 }}><PinMap pins={pins} /></div>
      </ReactFlowProvider>,
    )
    expect(screen.getByRole('group', { name: /Pin map/ })).toBeTruthy()
    expect(screen.getByTestId('rf__node-per:USART2')).toHaveAttribute('aria-label', 'Peripheral USART2, 2 pins')
    expect(screen.getByTestId('rf__node-pin:.PB6')).toHaveTextContent('Conflict')
    expect(screen.getByTestId('rf__node-net:UART_TX')).toHaveTextContent('2 pins')
  })
})
