import ProjectImportDialog, { type ProjectImportDialogProps } from './project-import-dialog'

export function CanvasProjectImportDialog(props: Omit<ProjectImportDialogProps, 'appearance'>) {
  return <ProjectImportDialog {...props} appearance="canvas" />
}
