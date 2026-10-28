import { createEmptyWorkflow, type WorkflowFile } from '../model'
import { defaultInteriorTask, type InteriorTask } from '../interior/interior-task'

export function interiorTaskWorkflowFixture(task: Partial<InteriorTask> = {}): WorkflowFile {
  const assetId = 'a'.repeat(43)
  return { ...createEmptyWorkflow('室内创作'), nodes: [
    { id: 'room-source', kind: 'image-input', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle', result: { kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}`, width: 512, height: 512 } } },
    { id: 'room-render', kind: 'image-generate', definitionVersion: 1, position: { x: 360, y: 0 }, data: { prompt: '保留地板纹理', model: 'gpt-image-1', size: '1024x1024', quality: 'low', imageResolution: '1K', imageCandidateCount: 1, status: 'idle', settings: { title: '室内渲染', interiorTask: { ...defaultInteriorTask(), ...task }, imageReferenceOrder: { version: 1, slots: [{ role: 'source', edgeId: 'room-input', outputIndex: 0 }] } } } },
    { id: 'room-gallery', kind: 'gallery', definitionVersion: 1, position: { x: 720, y: 0 }, data: { prompt: '', model: '', status: 'idle' } },
  ], edges: [
    { id: 'room-input', source: 'room-source', target: 'room-render', sourceHandle: 'out:image', targetHandle: 'in:images' },
    { id: 'room-output', source: 'room-render', target: 'room-gallery', sourceHandle: 'out:image', targetHandle: 'in:images' },
  ] }
}
