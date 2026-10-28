import type { CanvasAgentClient } from '../lib/canvas-agent-contract'
import { canvasAgentSkillLimits, parseCanvasAgentSkillReferences, type CanvasAgentSkillReference, type CanvasAgentSkillSnapshot } from '../lib/canvas-agent-skill-contract'

export function agentSkillReferenceKey(reference: CanvasAgentSkillReference): string { return JSON.stringify([reference.skillId, reference.version, reference.contentDigest, reference.resourcePaths]) }
export function parseAgentDraftSkills(value: unknown): CanvasAgentSkillReference[] { return parseCanvasAgentSkillReferences(value) ?? [] }
export function addAgentSkillReference(current: readonly CanvasAgentSkillReference[], reference: CanvasAgentSkillReference): CanvasAgentSkillReference[] { return parseAgentDraftSkills([...current.filter((item) => item.skillId !== reference.skillId), reference]) }
export function skillSnapshotReference(snapshot: CanvasAgentSkillSnapshot): CanvasAgentSkillReference { return { skillId: snapshot.skillId, version: snapshot.version, contentDigest: snapshot.contentDigest, resourcePaths: [...snapshot.resourcePaths] } }
export function assertAgentSkillSnapshot(snapshot: CanvasAgentSkillSnapshot, reference: CanvasAgentSkillReference): void {
  if (agentSkillReferenceKey(snapshot) !== agentSkillReferenceKey(reference) || snapshot.characterCount !== snapshot.skillMarkdown.length + snapshot.resources.reduce((sum, file) => sum + file.content.length, 0)
    || JSON.stringify(snapshot.resources.map((file) => file.path)) !== JSON.stringify(reference.resourcePaths)) throw new Error('技能内容或所选资源已经变化，请移除后重新选择')
}
export function assertAgentSkillBudget(snapshots: readonly CanvasAgentSkillSnapshot[]): number {
  const count = snapshots.reduce((sum, item) => sum + item.characterCount, 0)
  if (count > canvasAgentSkillLimits.selectedCharacters) throw new Error(`已选技能共 ${count.toLocaleString('zh-CN')} 字符，超过 ${canvasAgentSkillLimits.selectedCharacters.toLocaleString('zh-CN')} 字符；请减少资源或技能，正文不会截断`)
  return count
}
export async function verifyAgentSkills(client: CanvasAgentClient, references: readonly CanvasAgentSkillReference[], signal?: AbortSignal): Promise<CanvasAgentSkillSnapshot[]> {
  const snapshots: CanvasAgentSkillSnapshot[] = []
  for (const reference of parseAgentDraftSkills(references)) {
    signal?.throwIfAborted()
    if (!client.active()) throw new Error('账号已切换，请重新打开技能库')
    const snapshot = await client.request('previewSkillReference', reference, signal)
    signal?.throwIfAborted()
    if (!client.active()) throw new Error('账号已切换，请重新打开技能库')
    assertAgentSkillSnapshot(snapshot, reference); snapshots.push(snapshot)
  }
  assertAgentSkillBudget(snapshots)
  return snapshots
}
export interface AgentSkillEntry { reference: CanvasAgentSkillReference; snapshot?: CanvasAgentSkillSnapshot; loading: boolean; error?: string }
