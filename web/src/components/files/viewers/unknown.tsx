/** Anything else: its name, its size and Download. Nothing in it is opened or run. */
import { Download, FileQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { eng } from '@/lib/format'
import { cn } from '@/lib/utils'
import { downloadFile } from '../data'
import { baseName } from '../kinds'
import type { ViewerProps } from './common'

export function UnknownViewer({ file, size, commit }: ViewerProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 p-6 text-center', size === 'card' ? 'py-6' : 'py-16')}>
      <FileQuestion className="size-8 text-muted-foreground" aria-hidden />
      <p className="font-mono text-sm">{baseName(file.path)}</p>
      <p className="text-sm text-muted-foreground">{file.size !== undefined ? `${eng(file.size, 'B')} · ` : ''}trace has no viewer for this kind of file.</p>
      <Button variant="outline" size="sm" onClick={() => void downloadFile(file, commit)}>
        <Download /> Download
      </Button>
    </div>
  )
}
