import { hostBridge, type CanvasAppearance, type CanvasStoredProjectSummary } from '../canvas-v2/src/host'

const params = new URLSearchParams(location.search)
const closeRequests = new Set<(event: { requestId: string }) => void>()
const closeCancellations = new Set<(event: { requestId: string }) => void>()
const appearances = new Set<(event: CanvasAppearance) => void>()
let activeRequest: string | null = null
let resolveRuns: (() => void) | undefined
const runPending = params.get('running') === '1' ? new Promise<void>((resolve) => { resolveRuns = resolve }) : Promise.resolve()
const pendingSaves: Array<{ resolve(): void; reject(error: Error): void }> = []
const project: CanvasStoredProjectSummary = {
  id: 'close-project', name: '关闭保护验收', createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z',
  lastOpenedAt: '2026-09-07T00:00:00Z', nodeCount: 1, assetCount: 0, workspaceConfigured: true, workspaceStatus: 'ready',
}
const content = JSON.stringify({
  schemaVersion: 2, name: project.name, viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [{ id: 'prompt-1', kind: 'prompt', definitionVersion: 1, position: { x: 160, y: 120 }, data: { prompt: '保留项目内容', model: '' } }], edges: [],
})
const harness = {
  holdSaves: false, saves: [] as string[], pendingCount: 0, cancelCalls: 0,
  acknowledgements: [] as Array<{ requestId: string; allowed: boolean }>,
  close(requestId: string) { activeRequest = requestId; for (const listener of closeRequests) listener({ requestId }) },
  expire(requestId: string) { if (activeRequest === requestId) activeRequest = null; for (const listener of closeCancellations) listener({ requestId }) },
  settleSave(index: number, failure?: string) { if (failure) pendingSaves[index].reject(new Error(failure)); else pendingSaves[index].resolve() },
  finishRuns() { resolveRuns?.() },
  appearance(appearance: CanvasAppearance) { for (const listener of appearances) listener(appearance) },
}
declare global { interface Window { canvasCloseHarness: typeof harness } }
window.canvasCloseHarness = harness
window.xingmangCanvasHost = {
  ...hostBridge(),
  listGroups: async () => [{ name: '生图分组', description: '', ratio: 1 }, { name: 'grok', description: '', ratio: 1 }],
  prepareGroup: async (group) => ({ group, models: group === 'grok' ? ['grok-imagine-video', 'minimax-h3-mini'] : ['gpt-image-2'], keyCreated: false }),
  listProjects: async () => [project], openProject: async () => ({ project, content }),
  listRuns: async () => { await runPending; return [] },
  saveProject: async (_id, content) => {
    harness.saves.push(content)
    if (harness.holdSaves) await new Promise<void>((resolve, reject) => { pendingSaves.push({ resolve, reject }); harness.pendingCount = pendingSaves.length })
    return project
  },
  onCloseRequested(listener) { closeRequests.add(listener); return () => closeRequests.delete(listener) },
  onCloseCancelled(listener) { closeCancellations.add(listener); return () => closeCancellations.delete(listener) },
  onAppearanceChange(listener) { appearances.add(listener); return () => appearances.delete(listener) },
  finishClose: async (requestId, allowed) => {
    harness.acknowledgements.push({ requestId, allowed })
    if (activeRequest !== requestId) return false
    if (!allowed) harness.expire(requestId)
    return true
  },
  cancelCloseTasks: async (requestId) => { if (activeRequest !== requestId) return false; harness.cancelCalls++; return true },
}
await import('../canvas-v2/src/main')
