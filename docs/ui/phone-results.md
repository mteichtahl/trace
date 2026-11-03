# Test results and run traces on a phone

Marc's ask (Nov 2026): on a phone there was no way to see test results and traces. Approved proposal: the
"Phone Test Results" artifact. Choices made: show Evidence from the first run (not only from Prove); a run's steps are
visible to everyone on the project, while costs and CloudWatch/GitHub links stay admin-only.

## What changes for people

1. **Change page: checks first.** On a phone, one line under the title says how the checks went
   ("7 of 7 checks passed", "1 failing", "3 still running") and opens the checks list. The files fold into one row
   ("Files · 4 changed") that opens the file viewer, so the decision stays on the first screen. Wide screens keep
   their layout, but each check row there opens the same sheet.
2. **Every check opens.** A sheet (bottom drawer on a phone, side sheet when wide) with the result first, then tabs:
   Result (summary text as markdown, annotations as findings), Log (the end of the build job's log, when the check is
   a GitHub Actions job), and a "next / previous check" control. Admins get the GitHub link under More.
3. **A run shows its steps.** The run page gets tabs on a phone: Result, Steps, Log, Files. Steps are the tool calls
   of the same agent job, in order, each with its time; the one this page is about is marked; a failed step opens to
   show what went in and what came out (args / result, pretty JSON, cut short). Files open in trace's file viewer.
4. **Evidence reads like a list.** On a phone, coverage rows become one line each: status pill first, id, text,
   chevron; quick filter chips (All, Failing, Untested, Verified, Waived) replace the table controls. Runs list the
   same way with a status dot. Evidence shows from Capture on (when checks start running), not only from Prove.
5. **Cards look tappable.** The data table's phone cards get a chevron and a pressed state when they open something.

## Contract between the API and the web app

### `CheckLine` (change.get `checks_list`)
Adds `id: string | null`: an opaque id for change.check. `"cr:<check run id>"` for a check run, `"job:<actions job
id>"` when it came from a workflow run's job, null for a commit status (nothing more to open).

### `change.check` (read), args `{ repo, number, id }`
Answers `CheckDetail`:
```ts
interface CheckDetail {
  id: string; name: string; state: 'passed' | 'failed' | 'running' | 'skipped'
  summary: string | null            // one line, as in checks_list
  text: string | null               // the check's own report: output.summary + output.text, markdown, at most 60 kB
  started_at: string | null; completed_at: string | null
  annotations: { path: string; line: number | null; level: 'failure' | 'warning' | 'notice'; title: string | null; message: string }[] // at most 50
  log: { text: string; truncated: boolean } | null   // the Actions job's log end (cleaned), when there is one
  url?: string                       // admins only: the check on GitHub
}
```
The id must belong to the change's head commit (refuse otherwise). It counts against the GitHub budget like
change.get. Reviewers may read it.

### Runs carry their job
`runs.job TEXT` (migration like `agent`): TRACE_JOB_ID, else `gh-<GITHUB_RUN_ID>`, else null. `RunSummary.job`.

### `run` answers its session
`run` adds `session: { job: string; agent: string | null; steps: SessionStep[] } | null` (null when the run has no
job), where
```ts
interface SessionStep { id: string; kind: string; summary: string | null; status: RunStatus; started: number; finished: number | null; args?: Json; result?: Json }
```
are every run with the same job, oldest first, at most 200; `args` and `result` only for this run, a failed or errored
step, and at most 20 others nearest this run (each JSON cut to 4 kB as text with `…` when longer).

## Every result type opens in trace

Marc's follow-up (Nov 2026): a person must be able to view every kind of result trace keeps, simulations and traces
included. Every run file opens through the shared file viewer, chosen by its name. Added or checked:

| Result | Files | Shown as |
| --- | --- | --- |
| Circuit simulation | `*.raw` (ngspice) | Chart: transient against time, AC as gain and phase on a log frequency axis, DC sweeps; operating point as a table |
| S-parameters | `*.s1p` … `*.sNp` | Chart of each S-parameter in dB against frequency, phase on a switch |
| Captures and sweeps | numeric `*.csv` / `*.tsv` (scope channels, loop gain, transient, temperature, Monte Carlo, corners) | Chart or table, chart first when the first column is time or frequency |
| Digital traces | `*.vcd` | Waveform viewer, scrolls inside its own box on a phone |
| Compressed outputs | single-file `*.gz` | Unpacked in the browser, then shown with the inner file's viewer |
| Logs, netlists, models | `.log`, `.cir`, `.xml`, `.vtu`, `.inp`, `.edif`, `.asc`, `.trc` … | Text with highlighting |
| Images, drawings, 3D | `.png`, `.svg`, `.glb`, `.step` | As before |
| Binary CAN logs | `.blf` | Named and described, for download |
