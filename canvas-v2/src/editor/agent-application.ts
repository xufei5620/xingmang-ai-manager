import type { CanvasAgentTurn, CanvasAgentMethodMap } from '../lib/canvas-agent-contract'
import { buildCanvasAgentProposalWorkflow, canvasAgentGraphDigest, canvasAgentGraphSnapshot } from '../lib/canvas-agent-patch'
import { canvasAgentImageBindingDigest } from '../lib/canvas-agent-image-bindings'
import type { WorkflowFile } from '../model'

export interface CanvasAgentApplication {
  projectId: string
  pendingSaves: Promise<unknown>
  current(): boolean
  capture(): WorkflowFile
  beforeCommit?(): void
  completeSavedReceipt?: boolean
  commit(workflow: WorkflowFile): void
  save(workflow: WorkflowFile): Promise<number>
  mark(input: CanvasAgentMethodMap['markApplied']['input']): Promise<CanvasAgentTurn>
  validate?(input: CanvasAgentMethodMap['validateApplication']['input']): Promise<CanvasAgentMethodMap['validateApplication']['result']>
}

/** A retry reconciles the exact resulting graph; it never inserts nodes twice. */
export async function applyCanvasAgentTurn(turn: CanvasAgentTurn, options: CanvasAgentApplication): Promise<CanvasAgentTurn> {
  const proposal = turn.proposal
  if (!proposal || turn.projectId !== options.projectId || !['ready', 'applied'].includes(turn.state) || proposal.id !== turn.id || proposal.baseGraphDigest !== turn.baseGraphDigest || proposal.baseProjectVersion !== turn.baseProjectVersion) throw new Error('提案归属或状态已变化，请重新读取当前会话')
  function assertCurrent() { if (!options.current()) throw new Error('工程或账号已切换，原提案操作已停止，请返回原工程核对') }
  function assertGraph(expected: string) {
    assertCurrent()
    if (canvasAgentGraphSnapshot(options.capture()) !== expected) throw new Error('画布已发生变化，请重新规划；当前编辑仍保留')
  }
  await options.pendingSaves
  assertCurrent()
  const base = options.capture(), before = canvasAgentGraphSnapshot(base)
  const currentDigest = await canvasAgentGraphDigest(base)
  assertGraph(before)
  if (turn.approval || turn.planningVersion === 3 || turn.mediaModels) {
    if (!options.validate) throw new Error('当前页面不能核对附图提案，请刷新后重新读取原计划')
    const imageBindingDigest = await canvasAgentImageBindingDigest(proposal)
    assertGraph(before)
    const receipt = await options.validate({ projectId: options.projectId, sessionId: turn.sessionId, turnId: turn.id, proposalDigest: proposal.digest })
    assertGraph(before)
    if (receipt.turnId !== turn.id || receipt.proposalDigest !== proposal.digest || receipt.baseGraphDigest !== proposal.baseGraphDigest || receipt.expectedResultGraphDigest !== proposal.expectedResultGraphDigest || receipt.imageBindingDigest !== imageBindingDigest) throw new Error('图片提案核对回执不一致，画布尚未修改，请重新读取原计划')
  }
  let result = base
  if (currentDigest !== proposal.expectedResultGraphDigest) {
    if (turn.state === 'applied' || currentDigest !== proposal.baseGraphDigest) throw new Error('画布已发生变化或提案已应用，请重新规划；当前编辑仍保留')
    result = buildCanvasAgentProposalWorkflow(base, proposal, { planningVersion: turn.planningVersion, imageReferences: turn.imageReferences, mediaModels: turn.mediaModels })
    if (await canvasAgentGraphDigest(result) !== proposal.expectedResultGraphDigest) throw new Error('提案结果无法核对，未修改画布，请重新读取会话')
    assertGraph(before)
    options.beforeCommit?.()
    options.commit(result)
  }
  const after = canvasAgentGraphSnapshot(result)
  assertGraph(after)
  // Save the editor's projection, including its implicit dimensions. Persisting
  // the raw model proposal here would schedule a second, needless autosave.
  const appliedProjectVersion = await options.save(options.capture())
  // An approved mutation may be stopped after its exact save has succeeded.
  // Finish that original server-validated receipt without restoring over a
  // newer local edit. This does not authorize another mutation or request.
  if (options.completeSavedReceipt) assertCurrent()
  else assertGraph(after)
  const receipt = await options.mark({ projectId: options.projectId, sessionId: turn.sessionId, turnId: turn.id, proposalDigest: proposal.digest, afterGraphDigest: proposal.expectedResultGraphDigest, appliedProjectVersion })
  assertCurrent()
  if (receipt.id !== turn.id || receipt.sessionId !== turn.sessionId || receipt.projectId !== turn.projectId || receipt.state !== 'applied' || receipt.proposal?.digest !== proposal.digest) throw new Error('应用回执无法核对，画布已保留，请读取原会话确认')
  return receipt
}
