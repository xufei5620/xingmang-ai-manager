import type { CanvasHostBridge, CanvasPromptPreset, CanvasWorkshopItem, CommunityWorkshopOwned } from '../host'
import { createEmptyWorkflow } from '../model'
import { parseCanvasPromptPreset } from '../library/prompt-preset-contract'
import { builtinPromptPresets } from '../library/prompt-presets'

/** Build editable text only; graph insertion remains the App's single command. */
export function promptPresetWorkflowItem(value: CanvasPromptPreset): CanvasWorkshopItem {
  const preset = parseCanvasPromptPreset(value)
  return { id: preset.id, kind: 'node', name: preset.name, description: preset.description ?? '', category: 'general', tags: [...preset.tags], version: preset.version ?? 1,
    nodeCount: 1, edgeCount: 0, nodeKinds: ['prompt'], createdAt: preset.createdAt, updatedAt: preset.updatedAt,
    workflow: { ...createEmptyWorkflow(preset.name), nodes: [{ id: 'prompt-preset', kind: 'prompt', definitionVersion: 1, position: { x: 80, y: 80 }, data: { prompt: preset.prompt, model: '', status: 'idle', settings: { title: preset.name } } }] } }
}

export function builtinPromptWorkflowItem(id: string): CanvasWorkshopItem {
  const preset = builtinPromptPresets.find((item) => item.id === id)
  if (!preset) throw new Error('官方提示词不存在，请重新选择')
  return { id: preset.id, kind: 'node', name: preset.title, description: preset.description, category: 'general', tags: [...preset.tags], version: 1,
    nodeCount: 1, edgeCount: 0, nodeKinds: ['prompt'], createdAt: '', updatedAt: '',
    workflow: { ...createEmptyWorkflow(preset.title), nodes: [{ id: 'builtin-prompt', kind: 'prompt', definitionVersion: 1, position: { x: 80, y: 80 }, data: { prompt: preset.prompt, model: '', status: 'idle', settings: { title: preset.title } } }] } }
}

export type OwnedWorkshopContent = { kind: 'prompt'; preset: CanvasPromptPreset } | { kind: 'workflow'; item: CanvasWorkshopItem }

export async function readOwnedWorkshopContent(bridge: CanvasHostBridge, owned: CommunityWorkshopOwned): Promise<OwnedWorkshopContent> {
  if (owned.state === 'trash') throw new Error('已获取的副本在我的工坊回收站中，请先恢复后再使用；不会重复创建。')
  if (owned.state === 'missing') throw new Error('已获取的私有副本已删除，原获取记录仍保留，不会重新创建。')
  if (owned.kind === 'prompt') {
    const preset = (await bridge.listPromptPresets()).find((entry) => entry.id === owned.id)
    if (!preset) throw new Error('已获取的提示词已删除，请刷新我的提示词；不会使用旧公开正文覆盖。')
    return { kind: 'prompt', preset: parseCanvasPromptPreset(preset) }
  }
  if (!bridge.readWorkshopItem) throw new Error('当前环境暂不支持读取我的工坊')
  const item = await bridge.readWorkshopItem(owned.id)
  if (item.id !== owned.id || item.kind !== owned.kind || item.deletedAt) throw new Error('已获取副本的当前状态无法确认，请刷新我的工坊后重试。')
  return { kind: 'workflow', item }
}
