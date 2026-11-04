# Large run outputs

The run record (`.trace/project.db`) is committed to the project's repository. Most run outputs are small: a report,
a netlist, a log. A few are not. A revision's photographic renders are about 5 MB a picture at release quality, and a
printed document can be several megabytes, so keeping them in the record would grow every project's repository by tens
of megabytes a revision, for good.

So on an installation, large outputs are kept in the installation's bucket, and the run record keeps a reference.

## Where they are kept

```
s3://<bucket>/projects/<owner>/<repo>/artifacts/<sha256>    the bytes, written once, never changed
artifacts row (run_id, name, mime, bytes)                    mime ends `; trace-stored=<sha256>:<size>`, bytes is empty
```

- **Content-addressed.** The key is the SHA-256 of the bytes and the write is conditional (`If-None-Match`), so the
  same picture rendered twice is stored once, and an object is never overwritten.
- **Lineage is unchanged.** The run's `artifact_hashes` row is written as for any output, so freshness and the
  evidence behind a decision work as before.
- **What is stored.** Outputs over 512 KB, from tools that make large outputs: `render.*` (renders, frames,
  turntables), `render.showcase`, and `docs.publish` (the PDFs). Smaller outputs stay in the record.
- **When.** Only in a job on an installation whose project home is the bucket (`TRACE_JOB_ID` and an `s3://`
  `TRACE_PROJECT_HOME`). A person's own checkout, and the tests, keep every output in the record as before.

## Who can reach them

- **The worker** writes them: it may already write anything under its own project's prefix.
- **The API** reads them, and only reads (`src/infra/api-grants.ts`). The app's `artifact` and `files.url` actions
  fetch a stored output from the bucket and answer with it as they do for one in the record.
- **Tools in a job** read them back with `readOutput` (Scribe's figures, `runs.artifact`).
- **A person's checkout** cannot reach the bucket. `trace artifact` and `runs.artifact` say the output is kept in
  the installation's storage rather than failing silently.

## Older outputs

Outputs already in a run record stay there and remain readable. Nothing is moved.

## Code

- `src/core/artifact-store.ts`: `keepOutput`, `readOutput`, the bucket key.
- `src/core/store.ts`: `Work.storeArtifact` and the reference in the mime (`storedMime`, `storedRef`).
- `src/api/artifact-read.ts`: the API's read.
