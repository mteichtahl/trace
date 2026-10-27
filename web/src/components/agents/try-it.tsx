/**
 * Try it: run a read-only tool on one of the person's projects from a short form built from the tool's own input
 * schema, through the `tool` action, and show the result in its card (plot, findings, part, file, run) or as data.
 * Only read-only tools, and only on projects where the person is a contributor (or an admin): reviewers get no Try it.
 */
import { Loader2, Play } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { FileCard, FindingsCard, PartCard, PlotCard, RunCard } from '@/components/chat/cards'
import { shapeOf } from '@/components/chat/renderers'
import { ErrorState } from '@/components/states'
import { call, projectName } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useProjects } from '@/lib/queries'
import { type ToolInfo, argsFromForm, canTry, schemaFields } from '@/lib/tools-catalogue'

/** The projects this person may try tools on (contributor, or any as an admin). */
export function useTryRepos(): string[] {
  const projects = useProjects()
  const { user } = useAuth()
  return (projects.data ?? []).filter((p) => user?.class === 'admin' || (p.part ?? (p.role === 'write' ? 'contributor' : 'reviewer')) === 'contributor').map((p) => p.repo)
}

export function TryIt({ tool, onDone }: { tool: ToolInfo; onDone?: () => void }) {
  const repos = useTryRepos()
  const [repo, setRepo] = useState(repos[0] ?? '')
  const fields = useMemo(() => schemaFields(tool.input), [tool.input])
  const [values, setValues] = useState<Record<string, string | boolean | undefined>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.type === 'boolean' ? (f.default as boolean | undefined) : f.default !== undefined ? String(Array.isArray(f.default) ? f.default.join(', ') : f.default) : ''])),
  )
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: true; value: unknown } | { ok: false; error: string } | null>(null)

  if (!canTry(tool, { reviewer: repos.length === 0 }))
    return <p className="text-sm text-muted-foreground">{tool.needs === 'write' ? 'This tool changes the project, so it runs only when an agent or a guided task asks for it.' : 'You review your projects, so tools are not run from here. Contributors and admins can try read-only tools.'}</p>

  const run = async () => {
    const { args, errors: e } = argsFromForm(fields, values)
    setErrors(e)
    if (Object.keys(e).length || !repo) return
    setBusy(true)
    setResult(null)
    try {
      setResult({ ok: true, value: await call('tool', { repo, name: tool.name, args }) })
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
      onDone?.()
    }
  }

  const shape = result?.ok ? shapeOf(tool.name, {}, result.value) : null
  return (
    <div className="space-y-4">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void run()
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="try-repo">On project</Label>
          <select id="try-repo" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={repo} onChange={(e) => setRepo(e.target.value)}>
            {repos.map((r) => <option key={r} value={r}>{projectName(r)}</option>)}
          </select>
        </div>
        {fields.length === 0 && <p className="text-sm text-muted-foreground">This tool takes no input.</p>}
        {fields.map((f) => {
          const id = `try-${f.name}`
          const err = errors[f.name]
          if (f.type === 'boolean')
            return (
              <Label key={f.name} className="flex items-center gap-2 font-normal">
                <Checkbox checked={!!values[f.name]} onCheckedChange={(v) => setValues((s) => ({ ...s, [f.name]: !!v }))} />
                {f.label}
                {f.description && <span className="text-xs text-muted-foreground">· {f.description}</span>}
              </Label>
            )
          return (
            <div key={f.name} className="space-y-1">
              <Label htmlFor={id}>
                {f.label} {f.required && <span className="text-destructive">*</span>}
              </Label>
              {f.type === 'enum' ? (
                <select id={id} className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={String(values[f.name] ?? '')} onChange={(e) => setValues((s) => ({ ...s, [f.name]: e.target.value }))}>
                  {!f.required && <option value="">(default)</option>}
                  {f.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : f.type === 'json' ? (
                <Textarea id={id} rows={3} className="font-mono text-xs" value={String(values[f.name] ?? '')} onChange={(e) => setValues((s) => ({ ...s, [f.name]: e.target.value }))} placeholder="JSON" />
              ) : (
                <Input id={id} inputMode={f.type === 'number' || f.type === 'integer' ? 'decimal' : undefined} value={String(values[f.name] ?? '')} onChange={(e) => setValues((s) => ({ ...s, [f.name]: e.target.value }))} placeholder={f.type === 'string[]' ? 'comma, separated' : undefined} aria-invalid={!!err} />
              )}
              {f.description && <p className="text-xs text-muted-foreground">{f.description}</p>}
              {err && <p className="text-xs text-destructive">{err}</p>}
            </div>
          )
        })}
        <Button type="submit" disabled={busy || !repo}>
          {busy ? <Loader2 className="animate-spin" /> : <Play />} {busy ? 'Running' : 'Run it'}
        </Button>
        <p className="text-xs text-muted-foreground">Runs on {repo ? projectName(repo) : 'the project'}'s own agent, on its default branch. It reads only; nothing in the project changes.</p>
      </form>
      {result && !result.ok && <ErrorState title={`${tool.name} did not finish.`} detail={result.error} onRetry={() => void run()} />}
      {result?.ok && (
        <div>
          <h4 className="mb-2 text-sm font-semibold">Result</h4>
          {shape?.kind === 'plot' ? <PlotCard data={shape.data} /> : shape?.kind === 'findings' ? <FindingsCard data={shape.data} /> : shape?.kind === 'part' ? <PartCard data={shape.data} /> : shape?.kind === 'file' ? <FileCard data={shape.data} /> : shape?.kind === 'run' ? <RunCard data={shape.data} /> : (
            <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">{JSON.stringify(result.value, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  )
}
