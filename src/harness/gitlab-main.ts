// The GitLab pipeline job's entry (bundled to harness/dist/gitlab.cjs): run the task, fail the job on an error.
import { consoleCore, main } from './gitlab.js'

main().catch((e: unknown) => { consoleCore.setFailed(e instanceof Error ? e.message : String(e)) })
