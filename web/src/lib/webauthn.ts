/**
 * Passkeys: turn the backend's JSON options into the browser's WebAuthn calls and the results back into JSON
 * (base64url for every buffer), as Cognito's USER_AUTH WEB_AUTHN challenge and StartWebAuthnRegistration expect.
 */
import type { PublicKeyCredentialCreationOptionsJSONish, PublicKeyCredentialRequestOptionsJSONish } from './types'

export const b64urlToBuf = (s: string): ArrayBuffer => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

export const bufToB64url = (b: ArrayBuffer): string => {
  const bytes = new Uint8Array(b)
  let s = ''
  for (const x of bytes) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const passkeysSupported = (): boolean => typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials

/** Sign in with a passkey: returns the assertion as JSON for /api/auth/respond (kind passkey). */
export async function getAssertion(o: PublicKeyCredentialRequestOptionsJSONish): Promise<Record<string, unknown>> {
  const publicKey: PublicKeyCredentialRequestOptions = {
    ...(o as object),
    challenge: b64urlToBuf(o.challenge),
    allowCredentials: o.allowCredentials?.map((c) => ({ ...c, type: 'public-key' as const, id: b64urlToBuf(c.id), transports: c.transports as AuthenticatorTransport[] | undefined })),
  } as PublicKeyCredentialRequestOptions
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null
  if (!cred) throw new Error('No passkey was chosen.')
  const r = cred.response as AuthenticatorAssertionResponse
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: bufToB64url(r.clientDataJSON),
      authenticatorData: bufToB64url(r.authenticatorData),
      signature: bufToB64url(r.signature),
      userHandle: r.userHandle ? bufToB64url(r.userHandle) : undefined,
    },
  }
}

/** Make a passkey: returns the credential as JSON for /api/auth/passkeys/finish. */
export async function createCredential(o: PublicKeyCredentialCreationOptionsJSONish): Promise<Record<string, unknown>> {
  const publicKey = {
    ...(o as object),
    challenge: b64urlToBuf(o.challenge),
    user: { ...o.user, id: b64urlToBuf(o.user.id) },
    excludeCredentials: o.excludeCredentials?.map((c) => ({ ...c, type: 'public-key' as const, id: b64urlToBuf(c.id) })),
  } as PublicKeyCredentialCreationOptions
  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null
  if (!cred) throw new Error('No passkey was made.')
  const r = cred.response as AuthenticatorAttestationResponse
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: bufToB64url(r.clientDataJSON),
      attestationObject: bufToB64url(r.attestationObject),
      transports: r.getTransports?.() ?? [],
    },
  }
}
