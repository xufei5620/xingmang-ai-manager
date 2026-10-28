import { isCanvasPublicAccountId } from '../lib/canvas-account-contract'
import type { CanvasHostKind } from '../host-kind'
import { collectAssetReferenceIds } from '../lib/asset-reference-values'
import { canvasClipboardMime, maximumClipboardBytes, parseCanvasClipboard, serializeCanvasClipboard, type CanvasClipboardPayload } from './clipboard'

const transferFormat = 'xingmang-canvas-selection'
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }

export function canvasClipboardHasPrivateSources(payload: CanvasClipboardPayload): boolean {
  return collectAssetReferenceIds(payload.nodes).length > 0 || payload.nodes.some((node) => typeof node.data.group === 'string' && node.data.group.length > 0)
}

export function buildCanvasClipboardTransfer(payload: CanvasClipboardPayload, identity: { ownerId: string | null; projectId: string | null }): string {
  const canonical = parseCanvasClipboard(serializeCanvasClipboard(payload))!
  if (!isCanvasPublicAccountId(identity.ownerId)) throw new Error('当前画布账号尚未核对，请重新进入工作区后复制；创建副本仍可使用')
  if (identity.projectId !== null && !isCanvasPublicAccountId(identity.projectId)) throw new Error('当前画布工程编号尚未核对，尚未复制')
  const text = JSON.stringify({ format: transferFormat, version: 2, ownerId: identity.ownerId, sourceProjectId: identity.projectId, payload: canonical })
  if (new TextEncoder().encode(text).byteLength > maximumClipboardBytes) throw new Error('选区超过 5 MB，请拆分后复制')
  return text
}

export function parseCanvasClipboardTransfer(content: string, ownerId: string | null): CanvasClipboardPayload {
  if (typeof content !== 'string' || !content || content.length > maximumClipboardBytes || new TextEncoder().encode(content).byteLength > maximumClipboardBytes) throw new Error('剪贴板选区为空或超过 5 MB，请重新复制较小的选区')
  let raw: unknown
  try { raw = JSON.parse(content) } catch { throw new Error('剪贴板中没有星芒画布选区，请先在画布中复制节点') }
  const envelope = object(raw) && raw.format === transferFormat
  if (envelope && (!object(raw) || raw.version !== 2 || Object.keys(raw).some((key) => !['format', 'version', 'ownerId', 'sourceProjectId', 'payload'].includes(key)) || !isCanvasPublicAccountId(raw.ownerId) || raw.sourceProjectId !== null && !isCanvasPublicAccountId(raw.sourceProjectId))) throw new Error('剪贴板选区版本或身份不受支持，请返回原画布重新复制')
  const payload = parseCanvasClipboard(envelope && object(raw) ? JSON.stringify(raw.payload) : content)
  if (!payload) throw new Error('剪贴板选区含不支持或损坏的节点、连线或引用，尚未粘贴；请返回原画布检查并重新复制')
  if (canvasClipboardHasPrivateSources(payload)) {
    if (!envelope) throw new Error('旧版选区没有账号身份，不能核对私有素材或模型来源；请在原账号重新复制')
    if (!isCanvasPublicAccountId(ownerId) || !object(raw) || raw.ownerId !== ownerId) throw new Error('选区的私有素材或模型来源属于其他账号，尚未粘贴；请切回原账号，或使用工坊分享的便携配置')
  }
  return payload
}

/**
 * The desktop hands the kernel no account UUID (its accounts are numeric), so a
 * copy there is owned by the workspace mount instead. The workspace remounts on
 * every account change, which retires the id together with the account.
 */
export function canvasClipboardOwnerId(accountId: string | null, host: CanvasHostKind, workspaceId: string): string | null {
  return accountId ?? (host === 'desktop' ? workspaceId : null)
}

/**
 * A host that cannot inspect private sources may still take back the exact
 * selection this workspace copied: every asset and model source in it was
 * already on this account's canvas. Anything else, even under a matching
 * owner id, still needs the host's inspection.
 */
export function canvasClipboardCopiedHere(text: string, copied: string | null): boolean {
  return copied !== null && text === copied
}

/** Browser custom MIME support varies; text/plain is the durable fallback. */
export function writeCanvasClipboardEvent(data: Pick<DataTransfer, 'setData'> | null, text: string): boolean {
  if (!data) return false
  try { data.setData('text/plain', text) } catch { return false }
  try { data.setData(canvasClipboardMime, text) } catch { /* The plain-text envelope still carries the exact selection. */ }
  return true
}

export function canvasClipboardEventAllowed(event: { defaultPrevented?: boolean; target?: unknown }, modalOpen: boolean): boolean {
  if (event.defaultPrevented || modalOpen) return false
  const target = event.target
  if (!object(target)) return true
  const tag = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : ''
  if (['input', 'textarea', 'select'].includes(tag) || target.isContentEditable === true) return false
  return typeof target.closest !== 'function' || !Reflect.apply(target.closest, target, ['input, textarea, select, [contenteditable="true"], [role="dialog"], [role="alertdialog"], [role="menu"]'])
}

/** The caller supplies a generation guard, including account/project ABA. */
export async function runCanvasClipboardPaste(options: {
  ownerId: string | null
  current(): boolean
  read(): Promise<string>
  inspect(payload: CanvasClipboardPayload, text: string): Promise<void>
  apply(payload: CanvasClipboardPayload): void
}): Promise<boolean> {
  if (!options.current()) return false
  const text = await options.read()
  if (!options.current()) return false
  const payload = parseCanvasClipboardTransfer(text, options.ownerId)
  if (canvasClipboardHasPrivateSources(payload)) {
    await options.inspect(payload, text)
    if (!options.current()) return false
  }
  if (!options.current()) return false
  options.apply(payload)
  return true
}
