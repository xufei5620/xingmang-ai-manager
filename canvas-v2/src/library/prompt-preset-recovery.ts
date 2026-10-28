import type { CanvasPromptPreset } from './prompt-preset-contract'

export type PromptPresetSaveFailureKind = 'conflict' | 'rejected' | 'uncertain'

export function promptPresetSaveFailure(error: unknown, editing: boolean): { kind: PromptPresetSaveFailureKind; message: string } {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined
  const message = error instanceof Error ? error.message : '保存未完成。'
  if (status === 409 && editing) return { kind: 'conflict', message: `${message} 本次修改未保存，输入已保留。请读取最新版本后选择如何继续。` }
  if (typeof status === 'number' && [400, 404, 409, 413, 422, 429].includes(status)) return { kind: 'rejected', message: `${message} 本次修改未保存，输入已保留。` }
  return { kind: 'uncertain', message: `${message} 保存结果待核对，请先重新读取；输入继续保留。` }
}

/** Only the explicit keep-draft action advances the captured version. Reads
 * never change the user's draft or silently turn it into a last-writer win. */
export function resumePromptPresetDraft<T extends { id?: string; expectedVersion?: number }>(draft: T, latest: CanvasPromptPreset): T {
  if (!draft.id || draft.id !== latest.id) throw new Error('提示词编号不一致，请重新读取。')
  const version = latest.version ?? 1
  if (version < (draft.expectedVersion ?? 1)) throw new Error('读取到较旧版本，请重新读取。')
  return { ...draft, expectedVersion: version }
}
