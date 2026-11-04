# Stacked changes

Status: built, November 2026. Decided 4 November 2026: pull requests move to stacked pull requests, for trace's
agents in project repositories and for trace's own development, on GitHub's own base branches (no Graphite or other
tool, so an installation still needs only AWS credentials and a GitHub token). Work that depends on an unmerged change
stacks on it; unrelated work still starts from the default branch.

## Why

Every job used to start from the default branch and open its pull request against it. Work that needed another
unmerged change had two bad choices: wait for that change to be accepted, or start from the default branch without it
and conflict later. A hand-off, for example, was answered on a branch of its own cut from the default branch, so the
answer could not see the work that asked the question. Merge conflicts between dependent changes were the most common
reason a change stalled.

A stacked change starts from the change it depends on. It shows only its own work, is reviewed on its own, and lands
straight after the change below it, without conflicting with it.

## What stacks on what

| Work | Starts from | Its pull request targets |
| --- | --- | --- |
| A task, a sweep, an agent-fix issue, a ci-red fix of the default branch | the default branch | the default branch |
| A hand-off answered for a job whose branch is an open change | the asking job's branch | the asking job's branch |
| A worker a specialist delegates to on a new branch | the specialist's branch | the specialist's branch |
| A follow-up task given `stack_on` (API `task`, `tracectl`) | that open change's branch | that branch |
| A revision asked for with "Ask for changes" | the same branch | (the same pull request: no new one) |
| A carry-on after a question is answered | the asking job's branch | (the same pull request) |
| An edit made in the app (prompts, settings, files, hand-ins) | the default branch | the default branch: edits stay independent |

A change can only stack on an **open** change. When the change below has merged, new work starts from the default
branch as before.

## How a stack is built

Nothing extra is recorded: git's history is the stack.

- **Branching.** A dependent job checks out a new branch from its parent's branch (`checkoutBranch` with `base`,
  `src/agents/runtime/job.ts`), fetching the parent first, since a clone holds only the default branch.
- **Opening the pull request.** `open-pr` (`src/harness/prs.ts`, `src/harness/stack.ts parentOf`) looks for an open
  pull request whose head branch the pushed branch holds every commit of, and is ahead of; of those, the nearest (the
  fewest commits between them) is the parent, and the new pull request targets it. A parent already on the default
  branch is history, not a stack. People get the same behaviour: build a branch on someone's open branch and its pull
  request is stacked. Setting `prs.stack` (default on) turns it off.
- **Diffs.** GitHub diffs a pull request against its base, so a stacked change shows only its own commits, and the
  app's diff (whose "before" side is the base's head) already did the same.

## How a stack lands

- **Only the bottom merges.** Auto-merge is set only on a pull request to the default branch (`automerge`), so a
  change stacked on another waits.
- **Restacking** (`restack`, run first in every `update-queue` run, at most three pushes a run since each push starts
  a build):
  - The change below **merged**: the change is retargeted to where it went (the default branch) and brought up to
    date. The retarget is a base change, which starts `automerge`, so it then lands on its own passing checks.
    (Repositories trace onboards delete merged branches, and GitHub then retargets for us; restack does the same when
    GitHub did not.)
  - The change below **moved on** (a revision, a fix, its own base merged in): its new commits are merged into the
    change, so the change always builds on its parent's latest. Merge commits only: nothing is rebased or force-pushed.
  - The change below was **closed without merging**: the change still carries that work, so retargeting it would land
    the abandoned work too. It is held (the hold label) with a comment saying why: ask for changes to rebuild it on the
    default branch, or discard it.
- **Conflicts.** A stacked change that conflicts with its base is resolved like any other: a `.trace/project.db`-only
  conflict by the database merge, anything else by the worker, whose conflict prompt now merges the change's own base
  (`worker.item.conflict`, the `base` variable) instead of always the default branch.

## In the app

The words stay "change"; "stack" and "pull request" do not appear outside admin views.

- **Changes list and review page.** A stacked change says what it builds on ("Builds on: Pin plan for the OLED") and a
  change with others on it says so ("2 changes build on this").
- **Accepting.** Accepting a stacked change would merge it into the change below, not into the design, so it is
  refused while the change below is open (`change.accept` blocker `stacked`), with the reason and the change to accept
  first. The decision bar shows "Accept <title> first" with that change one tap away.
- **Next step and gates.** The open changes still block Fabricate and a stage's gate. The next step offers the bottom of
  each stack first, since that is the one that can be accepted.

## Trace's own development

The repository `mteichtahl/trace` is not onboarded with trace's harness, so it has its own small workflow,
`.github/workflows/stack.yml`, and the rules in `CLAUDE.md`:

- Dependent work goes on a branch made from the branch it depends on, and its pull request targets that branch
  (`gh pr create --base <parent>`). Independent work starts from `main`.
- Pull requests merge bottom first, with merge commits (never squash or rebase), so the branches above stay clean.
- When a pull request merges, the workflow retargets the ones built on it to `main` and merges `main` into them; when
  a pull request gains commits, it merges them into the ones built on it. It uses the `TRACE_TOKEN` secret when the
  repository has one, so its pushes start CI; with only `GITHUB_TOKEN` it still keeps the stack in order, and CI runs
  on the next push.

## Not done

- Accepting a whole stack in one tap. Each change is accepted on its own checks, bottom first.
- Reordering or splitting a stack from the app.
- Stacking edits made in the app.
