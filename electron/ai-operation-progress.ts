export type AiOperationProgressStage = 'processing' | 'downloading' | 'saving'

export interface AiOperationProgressUpdate {
  value?: number
  mode?: 'determinate' | 'indeterminate'
  health?: 'normal' | 'delayed'
}

export interface AiOperationProgressObserver {
  onStage(stage: AiOperationProgressStage): void | Promise<void>
  onProgress?(update: AiOperationProgressUpdate): void | Promise<void>
}
