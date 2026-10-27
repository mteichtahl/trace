/** Shared test fixtures: an RSA key, a fake JWKS, Cognito-shaped tokens, and fake GitHub/Cognito/jobs clients. */
import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto'
import type { CognitoAdmin, CognitoUser } from '../../src/api/aws.js'
import type { CommitSummary, GitHubApi, TreeEntry } from '../../src/api/github.js'
import { Verifier } from '../../src/api/jwt.js'

export const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST'
export const CLIENT_ID = 'client-123'
export const KID = 'key-1'

export const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
export const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })

export const jwks = (): { keys: unknown[] } => ({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] })

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')

export function sign(claims: Record<string, unknown>, o: { key?: KeyObject; kid?: string; alg?: string } = {}): string {
  const head = b64({ alg: o.alg ?? 'RS256', kid: o.kid ?? KID, typ: 'JWT' })
  const body = b64(claims)
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(o.key ?? keys.privateKey).toString('base64url')
  return `${head}.${body}.${sig}`
}

export function accessToken(sub: string, groups: string[], extra: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000)
  return sign({ sub, iss: ISSUER, token_use: 'access', client_id: CLIENT_ID, exp: now + 3600, iat: now, username: `${sub}@example.com`, 'cognito:groups': groups, ...extra })
}

export const verifier = (): Verifier => new Verifier({ issuer: ISSUER, clientId: CLIENT_ID, fetchJwks: async () => jwks() })

export class FakeCognito implements CognitoAdmin {
  users: CognitoUser[] = []
  groups = new Map<string, Set<string>>()
  calls: string[] = []
  add(email: string, sub: string, group?: string, name?: string): CognitoUser {
    const u = { sub, username: email, email, status: 'CONFIRMED', enabled: true, ...(name ? { name } : {}) }
    this.users.push(u)
    if (group) this.groups.set(email, new Set([group]))
    return u
  }
  async getUser(username: string): Promise<CognitoUser | null> { return this.users.find((u) => u.username === username || u.sub === username) ?? null }
  async find(who: string): Promise<CognitoUser | null> { return this.users.find((u) => u.email === who || u.sub === who) ?? null }
  async listUsers(): Promise<CognitoUser[]> { return [...this.users] }
  async usersInGroup(group: string): Promise<CognitoUser[]> { return this.users.filter((u) => this.groups.get(u.username)?.has(group)) }
  async createUser(email: string): Promise<CognitoUser> { this.calls.push(`create ${email}`); return this.add(email, `sub-${email}`) }
  async groupsFor(username: string): Promise<string[]> { return [...(this.groups.get(username) ?? [])] }
  async addToGroup(username: string, group: string): Promise<void> {
    this.calls.push(`add ${username} ${group}`)
    const s = this.groups.get(username) ?? new Set<string>(); s.add(group); this.groups.set(username, s)
  }
  async removeFromGroup(username: string, group: string): Promise<void> { this.calls.push(`remove ${username} ${group}`); this.groups.get(username)?.delete(group) }
  async signOut(username: string): Promise<void> { this.calls.push(`signout ${username}`) }
}

export class FakeGitHub implements GitHubApi {
  files = new Map<string, Uint8Array>()   // "repo:branch:path"
  sizes = new Map<string, number>()       // a size to report instead of the bytes' (large files)
  branches = new Map<string, string>()    // "repo:branch" → sha
  calls: string[] = []
  constructor(readonly repos: string[] = ['acme/board']) {
    for (const r of repos) this.branches.set(`${r}:main`, 'sha-main')
  }
  private has(repo: string): void { if (!this.repos.includes(repo)) throw new Error(`404 ${repo}`) }
  async defaultBranch(repo: string): Promise<{ branch: string; sha: string }> { this.calls.push(`defaultBranch ${repo}`); this.has(repo); return { branch: 'main', sha: 'sha-main' } }
  async branchSha(repo: string, branch: string): Promise<string | null> { return this.branches.get(`${repo}:${branch}`) ?? null }
  async tree(repo: string, ref: string): Promise<{ files: TreeEntry[]; truncated: boolean }> {
    this.calls.push(`tree ${repo} ${ref}`)
    const pre = `${repo}:${ref}:`
    return { truncated: false, files: [...this.files.entries()].filter(([k]) => k.startsWith(pre)).map(([k, v]) => ({ path: k.slice(pre.length), size: v.length, sha: `blob-${createHash('sha1').update(v).digest('hex').slice(0, 12)}` })) }
  }
  async fileInfo(repo: string, path: string, ref: string): Promise<{ size: number; sha: string; downloadUrl: string | null } | null> {
    const f = this.files.get(`${repo}:${ref}:${path}`)
    return f ? { size: this.sizes.get(`${repo}:${ref}:${path}`) ?? f.length, sha: 'blob-sha', downloadUrl: `https://raw.githubusercontent.com/${repo}/${ref}/${path}?token=short` } : null
  }
  async rawFile(repo: string, path: string, ref: string): Promise<Uint8Array | null> { this.calls.push(`rawFile ${repo} ${ref} ${path}`); return this.files.get(`${repo}:${ref}:${path}`) ?? null }
  async fileSha(repo: string, path: string, ref: string): Promise<string | null> { return this.files.has(`${repo}:${ref}:${path}`) ? 'blob-sha' : null }
  async createBranch(repo: string, branch: string, sha: string): Promise<void> { this.calls.push(`createBranch ${repo} ${branch} ${sha}`); this.branches.set(`${repo}:${branch}`, sha) }
  async putFile(repo: string, o: { path: string; branch: string; content: Uint8Array; message: string; sha: string | null }): Promise<{ commit: string }> {
    this.calls.push(`putFile ${repo} ${o.branch} ${o.path} ${o.sha ?? 'new'}`)
    this.files.set(`${repo}:${o.branch}:${o.path}`, o.content)
    return { commit: 'c0ffee0000000000' }
  }
  /** "repo:path" → the commits that changed it, newest first */
  history = new Map<string, CommitSummary[]>()
  async commits(repo: string, path: string, _ref: string, limit: number): Promise<CommitSummary[]> { return (this.history.get(`${repo}:${path}`) ?? []).slice(0, limit) }
  async openPulls(): Promise<never[]> { return [] }
  async openIssues(): Promise<never[]> { return [] }
  async workflowRuns(): Promise<never[]> { return [] }
  async lastDeploy(): Promise<null> { return null }
}
