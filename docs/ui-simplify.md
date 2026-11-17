# Simpler web app: one place for each thing

Nov 17, 2026 · @Marc Teichtahl

The journey (docs/user-journey.md) is unchanged. What changes is how many places the web app shows each part of it. A
review of every screen found the same three questions (what needs me, what is trace doing, what does the gate need)
each answered in three to five places, and every exception drawn with a card and a position of its own. This note
gives each question one place, and every exception one shape. Where it disagrees with docs/ui-design.md on what a
person sees, this note wins.

## Decisions (Marc, 17 November 2026)

All eight recommendations, built as a stack of pull requests in this order.

| # | Decision | Built in |
| --- | --- | --- |
| 1 | One queue: Next is Home and the only list of what needs a person | `claude/ui-one-queue` |
| 2 | The project Overview uses the phone's structure on every screen size | `claude/ui-overview` |
| 3 | Five project tabs (Overview, Design, Proof, Changes, More) instead of thirteen | `claude/ui-five-tabs` |
| 4 | One exception card | `claude/ui-overview` |
| 5 | Changes: yours first, three states, a stack accepted in one tap | `claude/ui-changes` |
| 6 | One gate checklist | `claude/ui-overview` |
| 7 | One place for running work; Agents, Operations and Admin under System | `claude/ui-system` |
| 8 | Project Settings split into sub-pages | `claude/ui-settings` |

## 1. One queue

**Before:** Home's Needs you, the Next page, the bell's list, a count on every pinned project and the project's Next
step card all listed what needs a person, with counts that could disagree.

**Now:**

- **Home is Next.** `/` shows the greeting line, the queue (`web/src/components/next-queue.tsx`: one item large and
  acted on in place, the rest under Up next), then Your projects. `/next` and `/inbox` redirect to it, keeping
  `?item=` so a tapped notification still opens its item at the front.
- **One count.** The left rail's first item is Next, with the count. A pinned project that has something in the queue
  shows a dot, not a second number. The phone's tab bar is Next, Projects, Ask.
- **The bell is a shortcut.** It opens Next and shows a dot while something there is unread. It lists nothing.
- **Only what can be acted on.** The queue holds the API's inbox kinds only (`inbox`: a gate ready to sign, a question,
  spend, a stuck agent, a change to review, renders ready). The API already lists a gate only once it is ready
  (src/core/journey.ts); the mock fixtures now do the same.
- **Running work is not listed on Home.** The greeting line says how many jobs trace is working on; the list is the
  top bar's "trace is working" (section 7).

The project's Next step card stays: it is the same item, on the project it belongs to.

## 2. The Overview, on every screen size

**Before:** on a wide screen the Overview stacked fourteen blocks, about five screens tall, and said "step 3 of 5"
three times before the first scroll.

**Now:** one column, the phone's structure (web/src/routes/_app/p/$id/index.tsx): the stage rail, the Next step card,
the exception card (section 4), then folded rows: the gate's checklist (section 6),
Changes from trace, Waiting on people, trace is working, Recently, Requirements and cost. A row shows its count and
opens in place (in a drawer on a phone). The stage guide (purpose, steps) opens from the rail and from "What happens
in Capture" instead of sitting open above the card.

## 3. Five tabs

| Tab | Sections | Shown from |
| --- | --- | --- |
| Overview | where it is, the next step | always |
| Design | Requirements, Design (block diagram, sheets, pin plan, board, case), Build, Renders | Define, Architect, Release, Release |
| Proof | Evidence, Decisions, Documents | Capture (or Prove), the first signed gate, Architect |
| Changes | changes from trace, with the counts for you and being checked | always |
| More | Files, Cost and time (admins), Memory, Settings | always |

A tab opens on its first section and, when it has more than one, lists them as a short row under the tab row
(`tabGroups`, `inSection` in web/src/routes/_app/p/$id.tsx). Every old address keeps working: the routes do not move,
only the tab each belongs to (a run's page belongs to Evidence, a change's to Changes). A section a project has not
reached yet is not shown, as before, and a tab with no section yet is left out. On a phone the Sections sheet lists
the same sections under the tab names.

## 4. One exception card

**Before:** a failing build, fixes asked for, a lost job, evidence out of date, gates to sign again, a spend warning
and a stuck agent each had their own card and position.

**Now:** one card shape (web/src/components/exception-card.tsx), under the Next step card: what happened, what it
sent back (the stage, when it reopened one), the one thing to do, and the detail folded behind it. The failing build,
gates to sign again, checks out of date and the cloud-work allowance warning all draw through it. When there are
several, the most blocking shows and the rest fold under "N more things to know". A reopened stage is marked on the
stage rail in amber with a turn-back arrow, so going back shows in one place whatever caused it. Fixes asked for and
"Ask trace to fix something" moved into the "trace is working" row; a job that ended without finishing is listed
there too, and is the Next step card itself when it is what holds the project.

## 5. Changes

- **Yours first.** The list opens on the changes waiting for this person; "All" is one tap away.
- **Three states.** Yours (ready for you), trace's (still being made or checked), blocked (cannot go on without
  something). The five older words map onto these.
- **A stack in one tap.** Accepting a change that others build on offers "Accept all N", in order, when every one of
  them is ready.
- **Record and documents on their own.** A change with no design content (only the project's record, or only its
  documents: src/core/change-contents.ts) applies once its checks pass, as a revision's renders already do. It never
  held a gate; now it does not ask for a tap either.

## 6. One gate checklist

The stage guide's "To pass the gate" list is no longer a panel that is always open beside the steps. It is one row
on the Overview ("To pass the Capture gate · 4 of 7 met", `GateChecklist` in web/src/components/stage-guide.tsx): the
meter, each criterion with what its check found (waivable there), and one way on. That is Review and sign once every
line is met, for an admin; otherwise Open the gate and its evidence, which is the same list with each line's evidence
behind it. Evidence coverage (Proof) stays the per-requirement view. The stage's steps live in the stage sheet.

## 7. Running work, and System

- **One list of running work:** the top bar's "trace is working" and its sheet (docs/progress-and-logs.md). Home's In
  progress is gone; a project's own jobs stay in its "trace is working" row.
- **System:** Agents, Operations and Admin sit under one System heading in the rail, below the things a person does
  every day (Next, Projects, Knowledge).

## 8. Project Settings

The Settings page keeps what is changed often: name and icon, people, build and budget. Documents (logo), Project
rules, Where it lives, Later stages and Agent instructions each get a sub-page, listed as rows with their current
value.
