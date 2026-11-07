/**
 * Which specialist owns a record, for a request that changes one. Pure, with no specialist definitions imported: the
 * API's task action (src/api/actions.ts) and the router (router.ts) both use it.
 */
import type { SpecialistKind } from './kinds.js'

/**
 * A request to change one of the records only one specialist writes: a requirement (its words, its acceptance
 * criterion, its method or kind), the test plan, or an intent statement. The Verification specialist keeps them
 * (verify.requirements, verify.plan, design.intent add and link); the others read them only, and an Implementation
 * job asked to change a criterion reported it was not its work and stopped (test log R26).
 *
 * A change verb whose object is the record ("change REQ-7ec888's acceptance criterion", "reword the requirement",
 * "add a test plan item"), not a design change made to meet it ("change the layout so REQ-1 is met").
 */
const RECORD = String.raw`(?:REQ-[0-9a-z]{3,12}|INT-[0-9a-z]{3,12}|requirements?|(?:acceptance\s+)?criteri(?:on|a)|test\s+plan|plan\s+items?|intent\s+statements?)\b`
const CHANGE_VERB = String.raw`\b(?:change|edit|update|reword|rewrite|amend|revise|correct|relax|tighten|loosen|replace|add|remove|delete|drop|strike|waive|split|merge|rename)\b`
// up to three words between the verb and the record, none of them a preposition (then the record is not its object)
const BETWEEN = String.raw`(?:(?!(?:per|for|to|in|on|into|with|so|of|from|by|at|that|which|against|until|under)\b)[\w'’-]+\s+){0,3}`
const RECORD_CHANGE = new RegExp(`${CHANGE_VERB}\\s+${BETWEEN}${RECORD}`, 'i')
/** the record is what the design must meet, not what is changed */
const TO_MEET = /\b(?:to|so(?: that)?|until)\b[^.?!\n]{0,60}?\b(?:meets?|satisf(?:y|ies)|pass(?:es)?|compl(?:y|ies)(?: with)?)\b|\b(?:is|are|gets?|get) met\b/i

/** What a record change is, in words, for the route's reason. */
function recordWords(text: string): string {
  if (/\bcriteri(on|a)\b/i.test(text)) return 'a requirement\'s acceptance criterion'
  if (/\b(test plan|plan items?)\b/i.test(text)) return 'the test plan'
  if (/\b(INT-[0-9a-z]{3,12}|intent statements?)\b/i.test(text)) return 'an intent statement'
  return 'a requirement'
}

/**
 * The specialist that owns the record the request changes, or null when it changes none. Pure: the API's task action
 * uses it to send such a request to its owner, and route() to keep it there.
 */
export function recordOwner(text: string | undefined): { kind: SpecialistKind; what: string } | null {
  if (!text) return null
  const m = RECORD_CHANGE.exec(text)
  if (!m || TO_MEET.test(text)) return null
  return { kind: 'verify', what: recordWords(text) }
}
