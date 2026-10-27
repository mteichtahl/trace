/**
 * The viewer for each kind, each its own lazily loaded chunk: a kind's code (and its library: KiCanvas, PDF.js,
 * three.js, tracespace, WaveDrom, Shiki's grammars) loads only when a file of that kind first appears.
 */
import { lazy, Suspense, type ComponentType, type ReactNode } from 'react'
import type { FileRef } from '../data'
import { viewerKind, type ViewerKind } from '../kinds'
import { ViewerLoading, type ViewerProps } from './common'
import { UnknownViewer } from './unknown'

type Lazy = ComponentType<ViewerProps & { renderInner?: (f: FileRef) => ReactNode; onOpenEntry?: (f: FileRef) => void }>

const VIEWERS: Record<ViewerKind, Lazy> = {
  schematic: lazy(() => import('./kicad')),
  board: lazy(() => import('./kicad')),
  gerber: lazy(() => import('./gerber')),
  'gerber-zip': lazy(() => import('./gerber')),
  model: lazy(() => import('./model')),
  step: lazy(() => import('./model')),
  image: lazy(() => import('./image').then((m) => ({ default: m.ImageViewer }))),
  video: lazy(() => import('./image').then((m) => ({ default: m.VideoViewer }))),
  svg: lazy(() => import('./svg')),
  pdf: lazy(() => import('./pdf')),
  table: lazy(() => import('./table')),
  vcd: lazy(() => import('./waveform')),
  plot: lazy(() => import('./plot').then((m) => ({ default: m.PlotViewer }))),
  wavedrom: lazy(() => import('./plot').then((m) => ({ default: m.WaveDromViewer }))),
  code: lazy(() => import('./code')),
  markdown: lazy(() => import('./markdown')),
  firmware: lazy(() => import('./firmware')),
  archive: lazy(() => import('./archive')),
  unknown: UnknownViewer as Lazy,
}

/** Draw a file with its kind's viewer. `kind` overrides the one worked out from the name. */
export function ViewerFor({ file, size, commit, kind, onOpenEntry }: ViewerProps & { kind?: ViewerKind; onOpenEntry?: (f: FileRef) => void }) {
  const k = kind ?? viewerKind(file.path)
  const V = VIEWERS[k]
  return (
    <Suspense fallback={<ViewerLoading size={size} />}>
      <V
        key={`${file.path}@${commit ?? ''}`}
        file={file}
        size={size}
        commit={commit}
        onOpenEntry={onOpenEntry}
        renderInner={(f) => <ViewerFor file={f} size={size} onOpenEntry={onOpenEntry} />}
      />
    </Suspense>
  )
}
