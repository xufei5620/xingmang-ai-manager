import { describe, expect, it } from 'vitest'
import { AiAnswerCutOffError, aiAnswerCutOffMessages, resolveAnswerCutOff } from './ai-answer-cut-off'

describe('AI answer cut-off', () => {
  it('names the output cap and the content filter, whatever the upstream calls them', () => {
    expect(resolveAnswerCutOff('length')).toBe('length')
    expect(resolveAnswerCutOff('max_tokens')).toBe('length')
    expect(resolveAnswerCutOff(' MAX_OUTPUT_TOKENS ')).toBe('length')
    expect(resolveAnswerCutOff('content_filter')).toBe('filtered')
    expect(resolveAnswerCutOff('SAFETY')).toBe('filtered')
    expect(resolveAnswerCutOff('refusal')).toBe('filtered')
  })

  it('treats a normal finish, a tool call and a missing reason as complete', () => {
    for (const reason of ['stop', 'end_turn', 'tool_calls', 'function_call', '', '  ', null, undefined, 7, {}]) {
      expect(resolveAnswerCutOff(reason)).toBeNull()
    }
  })

  it('carries which cut-off happened and the wording for it', () => {
    const error = new AiAnswerCutOffError('filtered')
    expect(error).toBeInstanceOf(Error)
    expect(error.cutOff).toBe('filtered')
    expect(error.message).toBe(aiAnswerCutOffMessages.filtered)
    expect(new AiAnswerCutOffError('length').message).toBe(aiAnswerCutOffMessages.length)
  })
})
