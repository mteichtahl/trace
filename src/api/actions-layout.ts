/**
 * Where this installation keeps each project's cloud resources, in words the app shows on New project and Admin ›
 * Installation (src/infra/props.ts `layout`, README "Stack layout and limits").
 *
 *   installation.layout   any class   { layout, projects: { max, updateMax }, has: { knowledgeBase, cpuQueue,
 *                                     answerEvents }, note, move? }: 'nested' (one nested stack per project: 60
 *                                     projects, everything) or 'flat' (every project in the one stack, as installations
 *                                     before nested stacks: about 20 projects, an update adds web-app projects only up
 *                                     to FLAT_UPDATE_MAX, no knowledge bases or CPU queue, and an agent waiting for a
 *                                     person's answer checks on a timer), with how to move (`move`: the installer's
 *                                     three deploys, and what they cost)
 *
 * Why the move is recommended rather than giving the flat layout what nested has: each project in a flat stack is about
 * 21 of its 500 resources, and the knowledge base (5 more), the CPU job definition (1) and the answer events (3) would
 * bring 20 projects past the limit; and the self-update does not move a layout itself, because the move deletes every
 * project's memory records, which is a person's call. TRACE_LAYOUT is the stack's (src/infra/stack.ts).
 */
import { z } from 'zod'
import { AccessDenied, classOf } from '../core/access.js'
import { FLAT_UPDATE_MAX } from '../installer/pending.js'
import { type Context, NO_ACCESS, def } from './action-kit.js'

export const LAYOUT_MOVE = {
  how: 'Run the installer (`tracectl install` or `tracectl upgrade`) and choose "Move to one nested stack per project" under Advanced.',
  steps: [
    'With "keep data" on, a first deploy marks each project\'s memory and its log delivery for deletion; nothing else changes.',
    'The next deploy removes every project from the stack: their agents, roles, token secrets and memories go, every memory record with them. The projects are offline from here.',
    'The last deploy creates every project again, each in its own nested stack, with an empty memory; then the installer sets each repository\'s variables again.',
  ],
  costs: 'Every project\'s memory records are deleted (AgentCore cannot copy them), and the projects are offline for the two deploys (about 30 to 60 minutes); workflows that run in between fail and need running again. Journeys, chats, settings, runs and the knowledge in the repositories are kept.',
  gives: 'Room for 60 projects, projects created in the web app added by every update, a knowledge base per project, the CPU queue, and agents told at once when a person answers their question.',
} as const

export function layoutView(layout: 'flat' | 'nested'): Record<string, unknown> {
  if (layout === 'nested') {
    return { layout, projects: { max: 60, updateMax: 60 }, has: { knowledgeBase: true, cpuQueue: true, answerEvents: true }, note: 'Each project has its own nested stack: up to 60 projects, each with its knowledge base.' }
  }
  return {
    layout, projects: { max: 20, updateMax: FLAT_UPDATE_MAX }, has: { knowledgeBase: false, cpuQueue: false, answerEvents: false },
    note: `This installation keeps every project in one stack (the flat layout, from before nested stacks). About 20 projects fit; a project created here is added by the self-update only while there are fewer than ${FLAT_UPDATE_MAX}, and otherwise by the next installer run. Projects have no knowledge base or CPU queue, and an agent waiting for a person's answer checks on a timer rather than being told at once.`,
    recommendation: 'Move to one nested stack per project when losing the agents\' memory records is acceptable: it is the only way to more projects and the features above, and it is a one-off.',
    move: LAYOUT_MOVE,
  }
}

export const LAYOUT_ACTIONS = {
  'installation.layout': def('signed-in', z.object({}), async (_a, ctx: Context) => {
    if (classOf(ctx.principal) === null) throw new AccessDenied(NO_ACCESS)
    const raw = ctx.deps.layout ?? process.env.TRACE_LAYOUT
    return layoutView(raw === 'flat' ? 'flat' : 'nested')
  }),
}
