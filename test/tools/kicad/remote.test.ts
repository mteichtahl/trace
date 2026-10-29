/**
 * kicad-cli where it is not installed (src/tools/kicad/remote.ts): the project's KiCad files go as one archive, the
 * run happens in src/gpu/kicad-job.ts, and the output lands where the caller asked, with the caller's own paths in it.
 * runJob is replaced by one that stages the job as a remote runner would and runs kicad-job in this process, with a
 * fake kicad-cli (a shell script) that records its arguments and writes its input's path into its output.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const jobs: { kind: string; argv: string[]; timeoutSeconds?: number }[] = []
// a machine with KiCad installed (CI's runner) must look like one without it where a test says so: kicad-cli's install
// paths (src/tools/kicad/project.ts INSTALL_PATHS) are hidden while hideInstalledKicad is set
const hide = vi.hoisted(() => ({ on: false }))
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  const existsSync = (p: import('node:fs').PathLike): boolean => (hide.on && /[\\/]kicad-cli(\.exe)?$/.test(String(p)) && !String(p).includes('fakecli-') ? false : real.existsSync(p))
  return { ...real, existsSync, default: { ...real, existsSync } }
})
let fakeCli = ''

vi.mock('../../../src/gpu/jobs.js', async (orig) => {
  const real = await orig<typeof import('../../../src/gpu/jobs.js')>()
  const kj = await import('../../../src/gpu/kicad-job.js')
  const { copyFileSync: cp, mkdirSync: md, mkdtempSync: mt } = await import('node:fs')
  const { join: j, dirname: dn } = await import('node:path')
  const { tmpdir: td } = await import('node:os')
  return {
    ...real,
    runJob: async (spec: { kind: string; argv: string[]; inputs?: Record<string, string>; outputs?: string[]; timeoutSeconds?: number }) => {
      jobs.push({ kind: spec.kind, argv: spec.argv, ...(spec.timeoutSeconds ? { timeoutSeconds: spec.timeoutSeconds } : {}) })
      // stage as a runner does: inputs under {dir}/in, outputs to {dir}/out
      const dir = mt(j(td(), 'kjob-'))
      const ins: Record<string, string> = {}
      for (const [n, p] of Object.entries(spec.inputs ?? {})) { ins[n] = j(dir, 'in', n); md(dn(ins[n]), { recursive: true }); cp(p, ins[n]) }
      md(j(dir, 'out'), { recursive: true })
      const outs = Object.fromEntries((spec.outputs ?? []).map((n) => [n, j(dir, 'out', n)]))
      const argv = real.substitute(spec.argv, ins, outs, dir)
      if (argv[0] !== 'node') throw new Error(`unexpected job ${argv.join(' ')}`)
      const code = await kj.run(kj.parseArgs(argv.slice(2)), { kicadCli: fakeCli })
      const outputs = Object.fromEntries(Object.entries(outs).filter(([, f]) => existsSync(f)))
      return { exitCode: code, stdout: '', stderr: '', outputs, where: 'function', seconds: 0 }
    },
  }
})

const { packBase, packFiles, plan, restorePaths, runKicadRemote, PACK_MAX_BYTES } = await import('../../../src/tools/kicad/remote.js')
const { kicadRun, kicadWhere } = await import('../../../src/tools/kicad/project.js')

/** A repository with a KiCad project in hw/ (names with spaces), a library outside the project folder, and noise. */
function repo(): { root: string; sch: string; pcb: string } {
  const root = mkdtempSync(join(tmpdir(), 'kremote-'))
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, 'hw', 'My Board-backups'), { recursive: true })
  mkdirSync(join(root, 'lib', 'parts.pretty'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  mkdirSync(join(root, 'firmware'), { recursive: true })
  writeFileSync(join(root, 'hw', 'My Board.kicad_pro'), '{}')
  writeFileSync(join(root, 'hw', 'My Board.kicad_sch'), '(kicad_sch (sheet (property "Sheetfile" "power supply.kicad_sch")))')
  writeFileSync(join(root, 'hw', 'power supply.kicad_sch'), '(kicad_sch)')
  writeFileSync(join(root, 'hw', 'My Board.kicad_pcb'), '(kicad_pcb)')
  writeFileSync(join(root, 'hw', 'sym-lib-table'), '(sym_lib_table (lib (uri "${KIPRJMOD}/../lib/parts.kicad_sym")))')
  writeFileSync(join(root, 'hw', 'My Board-backups', 'old.kicad_sch'), 'old')
  writeFileSync(join(root, 'lib', 'parts.kicad_sym'), '(kicad_symbol_lib)')
  writeFileSync(join(root, 'lib', 'parts.pretty', 'R_0603.kicad_mod'), '(footprint)')
  writeFileSync(join(root, 'node_modules', 'x', 'a.kicad_sym'), 'never')
  writeFileSync(join(root, 'firmware', 'main.c'), 'int main(){}')
  return { root, sch: join(root, 'hw', 'My Board.kicad_sch'), pcb: join(root, 'hw', 'My Board.kicad_pcb') }
}

/** A kicad-cli that records its arguments and writes its input's path (the last argument) into its -o output. */
function makeFakeCli(): { cli: string; log: string } {
  const d = mkdtempSync(join(tmpdir(), 'fakecli-'))
  const log = join(d, 'args.log')
  const cli = join(d, 'kicad-cli')
  writeFileSync(cli, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > ${JSON.stringify(log)}`,
    'out=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; last="$a"; done',
    'if [ "$1" = "version" ]; then echo "10.0.7"; exit 0; fi',
    // a folder output: two files in it; a file output: the input's path and whether the input's sibling sheet came along
    'if [ -d "$out" ]; then echo "one $last" > "$out/a.svg"; echo two > "$out/b.svg"; exit 0; fi',
    'sib="$(dirname "$last")/power supply.kicad_sch"; [ -f "$sib" ] && s=yes || s=no',
    'printf \'<source>%s</source>\\n<sibling>%s</sibling>\\n\' "$last" "$s" > "$out"',
  ].join('\n'))
  chmodSync(cli, 0o755)
  return { cli, log }
}

afterEach(() => { jobs.length = 0; hide.on = false; vi.unstubAllEnvs() })

describe('what goes with a remote kicad-cli run', () => {
  it('sends the repository\'s KiCad files, names as they are, without backups, hidden folders or node_modules', () => {
    const r = repo()
    expect(packBase(r.sch)).toBe(r.root)
    expect(packFiles(r.root)).toEqual([
      'hw/My Board.kicad_pcb', 'hw/My Board.kicad_pro', 'hw/My Board.kicad_sch', 'hw/power supply.kicad_sch', 'hw/sym-lib-table',
      'lib/parts.kicad_sym', 'lib/parts.pretty/R_0603.kicad_mod',
    ])
    // outside a repository, the project's own folder
    const lone = mkdtempSync(join(tmpdir(), 'klone-'))
    writeFileSync(join(lone, 'x.kicad_sch'), '(kicad_sch)')
    expect(packBase(join(lone, 'x.kicad_sch'))).toBe(lone)
    // and refuses a project too big to send
    expect(() => packFiles(r.root, 10)).toThrow(/too much to send/)
    expect(PACK_MAX_BYTES).toBe(1024 ** 3)
  })

  it('puts the project\'s paths and the output in the job\'s terms', () => {
    const r = repo()
    const out = join(mkdtempSync(join(tmpdir(), 'kout-')), 'report.json')
    const p = plan(['pcb', 'drc', '--format', 'json', '-o', out, r.pcb])
    expect(p.base).toBe(r.root)
    expect(p.out).toEqual({ local: out, name: 'report.json', kind: 'file' })
    expect(p.args).toEqual(['pcb', 'drc', '--format', 'json', '-o', '@OUT@/report.json', '@PROJECT@/hw/My Board.kicad_pcb'])
    // a folder output (made by the caller first) is a folder there too; no arguments, nothing to send
    const dir = mkdtempSync(join(tmpdir(), 'kdir-'))
    expect(plan(['sch', 'export', 'svg', '-o', dir, r.sch]).out?.kind).toBe('dir')
    expect(plan(['version'])).toEqual({ base: null, args: ['version'], out: null })
  })

  it('puts the caller\'s folders back in the text files written', () => {
    const d = mkdtempSync(join(tmpdir(), 'krestore-'))
    writeFileSync(join(d, 'net.xml'), '<source>/tmp/job-1/project/hw/a.kicad_sch</source>')
    writeFileSync(join(d, 'bin.pdf'), Buffer.from([0x25, 0x50, 0, 0x2f, 0x74, 0x6d, 0x70]))
    restorePaths(d, [['/tmp/job-1/project', '/work/repo']])
    expect(readFileSync(join(d, 'net.xml'), 'utf8')).toBe('<source>/work/repo/hw/a.kicad_sch</source>')
    expect(readFileSync(join(d, 'bin.pdf'))).toEqual(Buffer.from([0x25, 0x50, 0, 0x2f, 0x74, 0x6d, 0x70]))
  })
})

describe('a kicad-cli run on the tools function', () => {
  it('runs as a kicad job and comes back where the caller asked, its paths the caller\'s', async () => {
    const r = repo()
    const f = makeFakeCli()
    fakeCli = f.cli
    const out = join(mkdtempSync(join(tmpdir(), 'kout-')), 'netlist.xml')
    const res = await runKicadRemote(['sch', 'export', 'netlist', '--format', 'kicadxml', '-o', out, r.sch], { timeoutMs: 300_000 })
    expect(res.code).toBe(0)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ kind: 'kicad', timeoutSeconds: 300 })
    // the netlist names the caller's schematic, not the job's copy, and the other sheet travelled with it
    expect(readFileSync(out, 'utf8')).toBe(`<source>${r.sch}</source>\n<sibling>yes</sibling>\n`)
    // kicad-cli saw the job's folders
    const seen = readFileSync(f.log, 'utf8').split('\n')
    expect(seen.slice(0, 5)).toEqual(['sch', 'export', 'netlist', '--format', 'kicadxml'])
    expect(seen[6]).toMatch(/\/kicad-out\/netlist\.xml$/)
    expect(seen[7]).toMatch(/\/project\/hw\/My Board\.kicad_sch$/)
  })

  it('fills a folder output, and answers a run with no files (version)', async () => {
    const r = repo()
    fakeCli = makeFakeCli().cli
    const dir = join(mkdtempSync(join(tmpdir(), 'kout-')), 'schematic-svg')
    mkdirSync(dir)
    expect((await runKicadRemote(['sch', 'export', 'svg', '-o', dir, r.sch])).code).toBe(0)
    expect(readdirSync(dir).sort()).toEqual(['a.svg', 'b.svg'])
    expect(readFileSync(join(dir, 'a.svg'), 'utf8')).toBe(`one ${r.sch}\n`)
  })
})

describe('where kicad-cli runs', () => {
  it('here when installed, else on the tools function when the project has one, else nowhere', async () => {
    const f = makeFakeCli()
    hide.on = true
    vi.stubEnv('PATH', '/nonexistent')
    vi.stubEnv('KICAD_CLI', '')
    vi.stubEnv('TRACE_TOOLS_FUNCTION', '')
    vi.stubEnv('TRACE_GPU_QUEUE', '')
    expect(kicadWhere()).toBeNull()
    await expect(kicadRun(['version'])).rejects.toThrow(/kicad-cli \(KiCad 7 or newer\)/)
    vi.stubEnv('TRACE_TOOLS_FUNCTION', 'trace-tools-abc')
    expect(kicadWhere()).toBe('function')
    vi.stubEnv('KICAD_CLI', f.cli)
    expect(kicadWhere()).toBe('local')
    expect((await kicadRun(['version'])).stdout.trim()).toBe('10.0.7')
    expect(jobs).toHaveLength(0)
  })
})
