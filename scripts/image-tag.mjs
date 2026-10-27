// Prints the content tag of the images this source builds (src/infra/images.ts imageContentTag): what the release
// workflow tags its published images, and what an installation of this exact source looks for. Needs `npm run build`.
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { imageContentTag } = await import(pathToFileURL(join(root, 'dist', 'infra', 'images.js')).href)
process.stdout.write(`${imageContentTag(root)}\n`)
