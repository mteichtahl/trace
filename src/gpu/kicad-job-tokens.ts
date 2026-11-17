/**
 * The names the KiCad job script (src/gpu/kicad-job.ts) and its caller (src/tools/kicad/remote.ts) share. Apart from
 * the script, so the caller, which is bundled as CommonJS into the harness, does not pull the script in (its
 * `import.meta` run-as-main check is empty in a CommonJS bundle, and esbuild warns of it on every build).
 */
export const PROJECT_TOKEN = '@PROJECT@'
export const OUT_TOKEN = '@OUT@'
/** In out.tar: the folders this run used, { project, out } */
export const SIDECAR = '.trace-kicad-job.json'
