/** The File viewer at card size inside a chat message: Open goes to the full page. */
import { useNavigate } from '@tanstack/react-router'
import { type FileRef, fileHref } from './data'
import { FileViewer } from './file-viewer'

export default function ChatFile({ file }: { file: FileRef }) {
  const navigate = useNavigate()
  return <FileViewer file={file} size="card" onOpenPage={() => void navigate({ to: fileHref(file) })} />
}
