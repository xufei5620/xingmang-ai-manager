// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

/**
 * 一段视频交给服务端以后没拿到任务号时，客户看到的那句话。
 *
 * 提交的回包丢了、服务端回 5xx、读不出任务号，或者提交到一半点了停止：服务端可能已经收下、
 * 已经扣了钱，这边却没有任务号，查不了也接不回来。主进程照这句报错（ai-video-service.ts），
 * 视频剪辑页按它认出这一类，把镜头记成「结果不明」存下来，重开以后照样提醒，再生成时在确认框里
 * 另外说清可能多扣一次（#1406 P1-1、#1489 N2）。所以这个模块两边都用，不许引 Node。
 */
export const aiVideoUnconfirmedSubmissionMessage = '视频提交结果不明确，服务端可能已创建任务，请勿立即重复提交'

/** 服务端已经回了任务号、本机的恢复记录却没写进去时那句话的开头：钱扣了，片段同样接不回来。 */
export const aiVideoTaskRecordLostPrefix = '视频任务已创建但本地恢复记录保存失败'

/** 这句报错说的是「可能已经扣了钱、片段接不回来」，再提交一次可能多扣一次。 */
export function isAiVideoUnconfirmedSubmission(message: string): boolean {
  return message === aiVideoUnconfirmedSubmissionMessage || message.startsWith(aiVideoTaskRecordLostPrefix)
}
