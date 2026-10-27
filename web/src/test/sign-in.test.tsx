import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async (orig) => ({ ...(await orig<typeof import('@tanstack/react-router')>()), useNavigate: () => navigate }))
const navigate = vi.fn()

const { safeNext } = await import('@/routes/sign-in/index')
const { Invite } = await import('@/routes/invite')

afterEach(() => { vi.restoreAllMocks(); navigate.mockReset() })

describe('where to go after signing in', () => {
  const o = 'https://trace.example.com'
  it('keeps paths inside the app', () => {
    expect(safeNext('/p/acme~board/gates/define?x=1#c', o)).toBe('/p/acme~board/gates/define?x=1#c')
    expect(safeNext(undefined, o)).toBe('/')
  })
  it('refuses anything that could reach another host, and the sign-in pages', () => {
    for (const bad of ['//evil.example', '/\\evil.example', '/\\\\evil.example', '/\tevil', '/ evil', 'https://evil.example', 'evil', '/%0a/evil', '\\/evil', '/sign-in', '/sign-in/code', '/invite', 'javascript:alert(1)', '/\u0000x']) {
      const r = safeNext(bad, o)
      // an encoded character stays a path on this origin (/%0a/evil is just a path here); everything else goes home
      if (bad.startsWith('/%0a')) expect(r).toBe('/%0a/evil')
      else expect(r, bad).toBe('/')
    }
  })
})

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('accepting an invitation', () => {
  it('email and temporary password, then a password of their own, then a passkey or an app; nothing in the address', async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      calls.push({ path, body })
      if (path === '/api/auth/start') return reply({ session: 's1', choices: ['passkey', 'password'] })
      if (path === '/api/auth/respond' && body.kind === 'password') return reply({ signedIn: false, next: 'new_password', session: 's2' })
      if (path === '/api/auth/respond' && body.kind === 'new_password') return reply({ signedIn: true, accessToken: 'a', idToken: 'i', expiresIn: 3600, user: { sub: 's', email: 'new@example.com', class: 'user' } })
      if (path === '/api/auth/totp/start') return reply({ secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/trace:x?secret=JBSWY3DPEHPK3PXP&issuer=trace' })
      return reply({ ok: false, error: 'no' }, 404)
    })
    render(<Invite />)
    await userEvent.type(screen.getByLabelText('Email'), 'new@example.com')
    await userEvent.type(screen.getByLabelText('Temporary password'), 'Temp-Pass-1234')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByText('Choose your password')
    expect(calls.map((c) => [c.path, c.body.kind])).toEqual([['/api/auth/start', undefined], ['/api/auth/respond', 'password']])
    expect(calls[1]!.body).toMatchObject({ email: 'new@example.com', session: 's1', answer: 'Temp-Pass-1234' })
    await userEvent.type(screen.getByLabelText('New password'), 'short')
    await userEvent.click(screen.getByRole('button', { name: 'Save and sign in' }))
    expect(screen.getByText('At least 12 characters.')).toBeInTheDocument()
    await userEvent.clear(screen.getByLabelText('New password'))
    await userEvent.type(screen.getByLabelText('New password'), 'A-good-password-42')
    await userEvent.click(screen.getByRole('button', { name: 'Save and sign in' }))
    await screen.findByText(/Make signing in safer/)
    expect(calls[2]!.body).toEqual({ email: 'new@example.com', session: 's2', kind: 'new_password', answer: 'A-good-password-42' })
    await userEvent.click(screen.getByRole('button', { name: /authenticator app/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Set up the app' }))
    await screen.findByText('Add trace to your authenticator app')
    expect(window.location.href).not.toMatch(/Temp-Pass|A-good-password/)
  })

  it('a wrong temporary password says so, plainly', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => (String(input) === '/api/auth/start' ? reply({ session: 's1', choices: ['password'] }) : reply({ ok: false, error: 'that did not work', code: 'not_authorized' }, 401)))
    render(<Invite />)
    await userEvent.type(screen.getByLabelText('Email'), 'new@example.com')
    await userEvent.type(screen.getByLabelText('Temporary password'), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(screen.getByText(/do not match/)).toBeInTheDocument())
  })
})
