import type { WorkflowFile } from '../model'
import { serializeWorkflow } from './workflow-serializer'
import type { CanvasProjectStore } from './host-project-fields'

export type CanvasWorkflowSnapshot =
  | { content: string; errorMessage: null }
  | { content: null; errorMessage: string }

/** Rendering an editable document must not require that it is currently saveable. */
export function inspectCanvasWorkflowSnapshot(workflow: WorkflowFile, store?: CanvasProjectStore): CanvasWorkflowSnapshot {
  try {
    return { content: serializeWorkflow(workflow, store), errorMessage: null }
  } catch (error) {
    return { content: null, errorMessage: error instanceof Error ? error.message : '工作流暂时无法保存，请检查当前便签和节点内容' }
  }
}

export function canvasWorkflowSnapshotNeedsSave(snapshot: CanvasWorkflowSnapshot, confirmedContent: string | null): boolean {
  return snapshot.content === null || snapshot.content !== confirmedContent
}
