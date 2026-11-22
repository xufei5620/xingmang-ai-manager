/**
 * Why an AI answer stopped before it was finished (0.2.25 总单第 24 项，11-18 复核 D10).
 *
 * The relay speaks the chat-completions format, where every answer ends with a
 * finish_reason. Only a plain stop means the model said everything it meant to;
 * an output cap or a content filter also ends the stream cleanly, so without
 * this the half answer looked exactly like a whole one. new-api maps Claude's
 * max_tokens to length and Gemini's safety blocks to content_filter, but passes
 * reasons it does not know through unchanged, so the raw upstream names are
 * accepted too.
 */
export type AiAnswerCutOff = 'length' | 'filtered'

const lengthReasons = new Set(['length', 'max_tokens', 'max_output_tokens'])
const filteredReasons = new Set(['content_filter', 'safety', 'refusal'])

/** The cut-off a finish_reason names, or null for a normal finish (stop, tool_calls, …) or no reason at all. */
export function resolveAnswerCutOff(finishReason: unknown): AiAnswerCutOff | null {
  if (typeof finishReason !== 'string') return null
  const reason = finishReason.trim().toLowerCase()
  if (lengthReasons.has(reason)) return 'length'
  if (filteredReasons.has(reason)) return 'filtered'
  return null
}

export const aiAnswerCutOffMessages: Record<AiAnswerCutOff, string> = {
  length: '回答已达到单次输出长度上限，结果不完整。请精简要求或分段生成后重新运行。',
  filtered: '回答因触发内容安全审核而中止，结果不完整。请调整内容后重试。',
}

/**
 * Thrown by the one-shot completion (canvas text node, 剧本解析, 写分镜) instead
 * of handing the half answer back: those callers treat whatever they get as the
 * whole result, and a retry would just pay for the same cut again. Callers that
 * can say it better for their own page check `cutOff` and replace the message.
 */
export class AiAnswerCutOffError extends Error {
  readonly cutOff: AiAnswerCutOff

  constructor(cutOff: AiAnswerCutOff) {
    super(aiAnswerCutOffMessages[cutOff])
    this.name = 'AiAnswerCutOffError'
    this.cutOff = cutOff
  }
}
