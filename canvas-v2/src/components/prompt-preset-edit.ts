export interface PromptPresetDraft {
  id: string
  name: string
  prompt: string
  group?: string
  description?: string
  expectedVersion?: number
}

export type PromptPresetSaveResult = { ok: true } | { ok: false; message: string }

export async function savePromptPresetDraft(
  draft: PromptPresetDraft,
  update: (id: string, patch: { name: string; prompt: string; group?: string; description?: string; expectedVersion?: number }) => void | Promise<void>,
): Promise<PromptPresetSaveResult> {
  const name = draft.name.trim()
  const prompt = draft.prompt
  if (!name || !prompt.trim()) return { ok: false, message: '请填写预设名称和内容' }
  try {
    await update(draft.id, { name, prompt, ...(draft.group !== undefined ? { group: draft.group.trim() } : {}), ...(draft.description !== undefined ? { description: draft.description.trim() } : {}), ...(draft.expectedVersion !== undefined ? { expectedVersion: draft.expectedVersion } : {}) })
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '保存失败，请重试' }
  }
}
