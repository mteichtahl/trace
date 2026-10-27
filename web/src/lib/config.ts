/** What the app needs to start (GET /api/config, no secrets), fetched once. */
import { request } from './http'
import type { AppConfig } from './types'

let cached: Promise<AppConfig> | null = null

export function loadConfig(): Promise<AppConfig> {
  cached ??= request<AppConfig>('/api/config').catch((e) => {
    cached = null
    throw e
  })
  return cached
}
