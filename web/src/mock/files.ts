/**
 * Mock answers for the File viewer and the Files screen: files.list, files.url (a short-lived local blob: link to the
 * fixture's bytes, standing in for the signed S3 link), artifact (a run's output as base64) and the firmware.size tool.
 */
import { FILE_LIST, FILE_THREAD, FILE_THREAD_MESSAGES, FIRMWARE_SIZE, fileContent } from './fixtures-files'

const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } })
const fail = (error: string) => new Response(JSON.stringify({ ok: false, error }), { headers: { 'content-type': 'application/json' } })

const urls = new Map<string, string>()
function blobUrl(path: string, commit?: string): string | null {
  const key = `${path}@${commit ?? ''}`
  const have = urls.get(key)
  if (have) return have
  const c = fileContent(path, commit)
  if (!c) return null
  const url = URL.createObjectURL(new Blob([c.bytes as BlobPart], { type: c.mime }))
  urls.set(key, url)
  return url
}

const toB64 = (b: Uint8Array | string): string => {
  const u8 = typeof b === 'string' ? new TextEncoder().encode(b) : b
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return btoa(s)
}

/** An answer for the files actions, or undefined for any other action. */
export function filesAction(name: string, a: Record<string, unknown>): Response | undefined {
  const repo = String(a.repo ?? '')
  switch (name) {
    case 'files.list':
      return FILE_LIST[repo] ? ok(FILE_LIST[repo]) : repo === 'acme/motor-driver' || repo === 'acme/panel-controller' ? ok([]) : fail('no access')
    case 'files.url': {
      const url = blobUrl(String(a.path), a.commit as string | undefined)
      return url ? ok({ url }) : fail(`no file ${String(a.path)}`)
    }
    case 'artifact': {
      const path = `runs/${String(a.id)}/${String(a.name)}`
      const c = fileContent(path)
      return c ? ok({ id: a.id, name: a.name, mime: c.mime, size: typeof c.bytes === 'string' ? c.bytes.length : c.bytes.length, base64: toB64(c.bytes) }) : fail(`no artifact ${String(a.name)} on run ${String(a.id)}`)
    }
    // one extra conversation whose tool results are files, so the chat's File card shows in mock mode
    case 'chats.get':
      return a.id === FILE_THREAD.id ? ok({ thread: FILE_THREAD, messages: FILE_THREAD_MESSAGES }) : undefined
    case 'tool':
      if (a.name === 'firmware.size') return ok({ status: 'pass', summary: 'flash 87616 B, RAM 11080 B', result: FIRMWARE_SIZE })
      return undefined
    default:
      return undefined
  }
}

/** Soil sensor's thread list with the file conversation added (handlers.ts passes its list through). */
export const withFileThread = <T extends { id: string; repo: string }>(repo: string, list: T[]): T[] =>
  repo === FILE_THREAD.repo && !list.some((t) => t.id === FILE_THREAD.id) ? [...list, FILE_THREAD as unknown as T] : list
