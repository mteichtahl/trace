/**
 * Written by the scheduled capability check (../mech/capsync.ts, the `capabilities` workflow), not by hand: the figures the
 * capability pages now state differently from ./capabilities.ts, and the day every figure was last found stated.
 * ./capabilities.ts applies them on top of its reviewed table. Each change arrives on a pull request a person reviews;
 * to fold an update into the base table, edit ./capabilities.ts and remove the entry here in the same change.
 */
import type { CapabilityUpdates } from '../mech/capabilities.js'

export const UPDATES: CapabilityUpdates = {
  checked: "2026-11-14",
  figures: {
    "track_mm.multilayer": { text: "0.10 / 0.10 mm", read: "2026-11-14" },
  },
}
