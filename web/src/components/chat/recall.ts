/**
 * Up and Down recall what you sent, like a terminal's history (docs/ui-design.md, "Up and down recall"):
 *
 * - Up recalls only when the cursor is on the first line of the box (or the box is empty); Down only when it is on
 *   the last line, so arrows still move the cursor inside a long, multi-line message.
 * - The list is the person's own sent messages, newest first (from chats.recall, so it survives reloads and devices),
 *   without duplicates in a row.
 * - Down past the newest returns the unsent draft exactly as it was; Escape leaves recall and restores the draft.
 * - A recalled message can be edited before sending; editing never changes the original.
 */

export interface RecallState {
  /** -1: the draft; 0: the newest sent message; … */
  index: number
  /** the unsent text as it was when recall began */
  draft: string
}

export const initialRecall: RecallState = { index: -1, draft: '' }

/** Newest first, consecutive duplicates removed, blanks dropped. */
export function dedupe(history: readonly string[]): string[] {
  const out: string[] = []
  for (const h of history) {
    if (!h.trim()) continue
    if (out[out.length - 1] === h) continue
    out.push(h)
  }
  return out
}

export const onFirstLine = (value: string, cursor: number): boolean => !value.slice(0, cursor).includes('\n')
export const onLastLine = (value: string, cursor: number): boolean => !value.slice(cursor).includes('\n')

export interface RecallResult {
  state: RecallState
  /** the box's new text, or null when the key should do its normal thing */
  value: string | null
}

export function up(state: RecallState, history: readonly string[], value: string, cursor: number): RecallResult {
  const list = dedupe(history)
  if (value !== '' && !onFirstLine(value, cursor)) return { state, value: null }
  if (state.index + 1 >= list.length) return { state, value: null }
  const draft = state.index === -1 ? value : state.draft
  const index = state.index + 1
  return { state: { index, draft }, value: list[index]! }
}

export function down(state: RecallState, history: readonly string[], value: string, cursor: number): RecallResult {
  if (state.index === -1) return { state, value: null }
  if (!onLastLine(value, cursor)) return { state, value: null }
  const list = dedupe(history)
  const index = state.index - 1
  if (index === -1) return { state: { index: -1, draft: '' }, value: state.draft }
  return { state: { ...state, index }, value: list[index]! }
}

export function escape(state: RecallState): RecallResult {
  if (state.index === -1) return { state, value: null }
  return { state: { index: -1, draft: '' }, value: state.draft }
}

/** After sending: the sent text goes to the top of the history (unless it repeats the newest), recall resets. */
export function afterSend(history: readonly string[], sent: string): string[] {
  return dedupe([sent, ...history])
}
