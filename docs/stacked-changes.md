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
| A worker a specialist delegates to on a new branch, when the specialist's branch is an open change | the specialist's branch, as on GitHub | the specialist's branch |
| A follow-up task given `stack_on` (API `task`, `tracectl remote task --stack-on`) | that open change's branch | that branch |
| A revision asked for with "Ask for changes" | the same branch | (the same pull request: no new one) |
| A carry-on after a question is answered, when the asking job's branch is its specialist's own work | the asking job's branch | (the same pull request) |
| A carry-on after a question is answered, when another specialist started the asking job's branch (the asker only checked a hand-off's answer there) | the asking job's branch, as on GitHub | that branch: a change of its own, never more commits in theirs |
| An edit made in the app (prompts, settings, files, hand-ins) | the default branch | the default branch: edits stay independent |

A change can only stack on an **open** change: a branch with an open pull request in the repository itself. A branch
that has none (not pushed yet, pushed without its pull request, merged, closed) is never stacked on, and the work
starts from the default branch as before, so nothing unaccepted can ride along into another change.

## How a stack is built

Nothing extra is recorded: git's history is the stack.

- **Branching.** A dependent job checks out a new branch from its parent's branch (`checkoutBranch` with `base`,
  `src/agents/runtime/job.ts`), fetching the parent first, since a clone holds only the default branch.
- **Opening the pull request.** `open-pr` (`src/harness/prs.ts`, `src/harness/stack.ts parentOf`) decides by commit
  membership: an open pull request is built on when one of its own commits is among the pushed branch's commits that
  the default branch lacks. That holds even when the open change moved on after the branch was made from it (a
  revision, the default branch merged in). Of a chain, the nearest is the parent, and the new pull request targets it.
  People get the same behaviour: build a branch on someone's open branch and its pull request is stacked. Setting
  `prs.stack` (default on) turns it off.
- **Fail closed.** When `open-pr` cannot tell (a GitHub lookup failed, the branch holds two open changes not stacked on
  each other, or it has more commits than GitHub lists), it opens no pull request and says why in the run: a pull
  request to the default branch that carried another change's commits would merge them unaccepted.
- **Diffs.** GitHub diffs a pull request against its base, so a stacked change shows only its own commits, and the
  app's diff (whose "before" side is the base's head) already did the same.

## How a stack lands

- **Only the bottom merges.** Auto-merge is set only on a pull request to the default branch (`automerge`), so a
  change stacked on another waits.
- **Merge commits under a stack.** A change others are stacked on merges with a merge commit, in the harness and when
  accepted in the app, whatever `prs.merge_method` says: squashed or rebased, the changes above would hold commits the
  default branch no longer has, and conflict with them.
- **Restacking** (`restack`, run first in every `update-queue` run, sharing its three pushes a run with the database
  merges, since each push starts a build):
  - The change below **merged**: the change is held, retargeted to where it went (the default branch), brought up to
    date, and let go; letting go starts `automerge`, so it then lands on its own passing checks against the default
    branch's latest. Only a merge that is sure counts: the change below closed after this one opened, and its branch
    is gone or still at that change's head (a reused branch name says nothing).
    (Repositories trace onboards delete merged branches, and GitHub then retargets for us; restack does the same when
    GitHub did not.)
  - The change below **moved on** (a revision, a fix, its own base merged in): its new commits are merged into the
    change, so the change always builds on its parent's latest. Merge commits only: nothing is rebased or force-pushed.
  - The change below was **closed without merging**: the change still carries that work, so retargeting it would land
    the abandoned work too. It is held (the hold label) with a comment saying why: discard it, and ask trace for the
    work again on the default branch if it is still wanted.
  - Without the `TRACE_TOKEN` secret it writes nothing and says what it would have done.
- **Conflicts.** A stacked change that conflicts with its base is resolved like any other: a `.trace/project.db`-only
  conflict by the database merge, anything else by the worker, whose conflict prompt now merges the change's own base
  (`worker.item.conflict`, the `base` variable, only ever a plain branch name) instead of always the default branch.
  An installation's own override of that prompt that still says `{{default_branch}}` merges the default branch:
  update it to `{{base}}`.

## In the app

The words stay "change"; "stack" and "pull request" do not appear outside admin views.

- **Changes list and review page.** A stacked change says what it builds on ("Builds on: Pin plan for the OLED") and a
  change with others on it says so ("2 changes build on this").
- **Accepting.** Accepting a stacked change would merge it into the change below, not into the design, so it is
  refused while the change below is open, with the reason and the change to accept first. Its page names that change
  one tap away ("Builds on <title>, which is accepted first").
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
