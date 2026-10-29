#!/usr/bin/env node
/**
 * Fails when an entry point's static imports reach a package the image leaves out (agent/Dockerfile,
 * agent/Dockerfile.tools remove the CDK, and the tools image the Agent SDK, after the build):
 *
 *   node scripts/check-imports.mjs [--without a,b,…] <entry.js>…
 *
 * It follows `import … from './x.js'` and `export … from` through the built files (dynamic `import()` is not
 * followed: those load on demand, as the installer's CDK does, and never in a runtime). A bare import names a package;
 * one of --without (default: the CDK's) is a failure, with the chain of files that leads to it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const args = process.argv.slice(2)
let without = ['aws-cdk-lib', 'aws-cdk', 'constructs']
const wi = args.indexOf('--without')
if (wi >= 0) { without = (args[wi + 1] ?? '').split(',').filter(Boolean); args.splice(wi, 2) }
if (!args.length) { console.error('usage: check-imports.mjs [--without a,b] <entry.js>…'); process.exit(2) }

const STATIC = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"()]*?\sfrom\s+)?['"]([^'"]+)['"]/gm
/** The text with its comments blanked (strings and template literals kept as they are), so a comment inside an import's
 * braces (tsc keeps comments), or a quote in one, can't hide the import from STATIC. */
function stripComments(t) {
  let out = ''
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < t.length && t[j] !== c) j += t[j] === '\\' ? 2 : 1
      out += t.slice(i, j + 1)
      i = j
    } else if (c === '/' && t[i + 1] === '/') {
      while (i < t.length && t[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && t[i + 1] === '*') {
      const end = t.indexOf('*/', i + 2)
      const body = t.slice(i, end < 0 ? t.length : end + 2)
      out += body.replace(/[^\n]/g, ' ')
      i = end < 0 ? t.length : end + 1
    } else out += c
  }
  return out
}
const pkg = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
const seen = new Map()
const bad = []
const walk = (file, from) => {
  if (seen.has(file)) return
  seen.set(file, from)
  const text = stripComments(readFileSync(file, 'utf8'))
  for (const m of text.matchAll(STATIC)) {
    const spec = m[1]
    if (spec.startsWith('.')) {
      const target = resolve(dirname(file), spec)
      if (existsSync(target)) walk(target, file)
    } else if (!spec.startsWith('node:') && without.includes(pkg(spec))) {
      bad.push({ file, spec })
    }
  }
}
for (const e of args) {
  const f = resolve(e)
  if (!existsSync(f)) { console.error(`no such entry: ${e}`); process.exit(2) }
  walk(f, null)
}
if (bad.length) {
  for (const b of bad) {
    const chain = []
    for (let f = b.file; f; f = seen.get(f)) chain.unshift(relative(process.cwd(), f))
    console.error(`${b.spec} is imported by ${chain.join(' → ')}`)
  }
  console.error(`these images leave ${without.join(', ')} out: import it with import() where it is needed, or keep it`)
  process.exit(1)
}
console.log(`${seen.size} files from ${args.join(', ')}: none imports ${without.join(', ')}`)
