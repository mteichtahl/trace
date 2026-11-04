# Working on trace

## Pull requests: stacked

trace's own development uses stacked pull requests, as trace's agents do in project repositories
(docs/stacked-changes.md). On GitHub's own base branches: no Graphite or other tool.

- **Independent work** starts from `main`, on a `claude/<topic>` branch, and its pull request targets `main`.
- **Dependent work** (needs another pull request that is not merged yet) starts from that pull request's branch, and
  its pull request targets that branch, so it shows and is reviewed for its own commits only:

  ```sh
  git fetch origin claude/ontology-board
  git checkout -b claude/ontology-board-tests origin/claude/ontology-board
  # … commit …
  git push -u origin HEAD
  gh pr create --base claude/ontology-board
  ```

- **Big work is split into a stack** of small pull requests, each one layer that builds and passes CI on its own
  (for example: the design note and core logic, then the agents, then the app, then docs). Say in each description
  what it builds on and what follows it.
- **Merge bottom first, with a merge commit** (never squash or rebase a pull request that others build on: the
  branches above would then conflict with commits they already hold). Never force-push a branch others build on.
- **Keeping the stack in order** is automatic (`.github/workflows/stack.yml`): when a pull request merges, the ones
  built on it move onto `main` and get `main` merged in; when one gains commits, the ones built on it get them merged
  in. A conflict is reported on the run, to merge by hand.
- **Changing a lower layer** after review: commit to its branch; the workflow merges the change upward. Do not rebase
  the layers above.

## Checks before pushing

`npm run check` (typecheck and tests). After changing anything under `src/harness/` or the prompt catalog, rebuild the
committed harness bundle with `node scripts/bundle-harness.mjs` (CI checks it matches its source). For the web app,
`npm --prefix web test` and `npx --prefix web tsc -b`. For a UI change, render the screens in mock mode
(`npm --prefix web run dev:mock`) and show them before it merges.
