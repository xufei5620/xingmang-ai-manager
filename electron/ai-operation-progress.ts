export type AiOperationProgressStage = 'processing' | 'downloading' | 'saving'

export interface AiOperationProgressUpdate {
  value?: number
  mode?: 'determinate' | 'indeterminate'
  health?: 'normal' | 'delayed'
}

/**
 * What a paid request did, for the canvas run's 实扣 (画布完善第 2b 条第 3 步):
 * whether it left for the relay at all, and the request id the relay answered
 * with, which is how the account's usage records name the charge.
 */
export interface AiRelayBillingObserver {
  /** True once the request is on its way; false when it turned out never to have left. */
  onRelayDispatch?(sent: boolean): void
  /** The relay answered (any status); its request id when the answer carried a usable one. */
  onRelayAnswer?(relayRequestId: string | null): void
}

export interface AiOperationProgressObserver extends AiRelayBillingObserver {
  onStage(stage: AiOperationProgressStage): void | Promise<void>
  onProgress?(update: AiOperationProgressUpdate): void | Promise<void>
}
