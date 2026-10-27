#!/usr/bin/env node
/**
 * The `tracectl` executable. node:sqlite is solid but still prints an "experimental" warning when first loaded; the
 * filter has to be in place before any module that imports it is evaluated, so this entry installs it and only then
 * loads the CLI.
 */
const emit = process.emitWarning.bind(process) as (warning: string | Error, ...rest: unknown[]) => void
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === 'string' ? warning : warning.message
  if (message.includes('SQLite is an experimental feature')) return
  emit(warning, ...rest)
}) as typeof process.emitWarning

await import('./cli.js')
