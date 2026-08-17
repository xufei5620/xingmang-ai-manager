export type AiOperationProgressStage = 'processing' | 'downloading' | 'saving'

export interface AiOperationProgressObserver {
  onStage(stage: AiOperationProgressStage): void | Promise<void>
}
