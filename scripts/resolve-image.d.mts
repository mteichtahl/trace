// Types of scripts/resolve-image.mjs, for the tests.
export const ACCEPT: string
export function parseRef(ref: string): { host: string; repository: string; tag: string } | null
export function resolveImage(ref: string, fetchImpl?: typeof fetch): Promise<{ digest: string; pinned: string; missing?: undefined } | { missing: string; digest?: undefined; pinned?: undefined }>
