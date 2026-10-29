/** The .npmrc without its credentials (comments and blank lines kept), and how many lines were dropped (scripts/npmrc.mjs). */
export function withoutCredentials(text: string): { text: string; dropped: number }
