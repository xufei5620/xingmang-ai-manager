import { CanvasAgentError, canvasAgentDigestValue, canvasAgentKeys, canvasAgentRecord } from './canvas-agent-contract'
import { parseCanvasAgentSkillDraft, parseCanvasAgentSkillResourcePath, type CanvasAgentSkillDraft } from './canvas-agent-skill-contract'

export const canvasAgentSkillImportLifetimeSeconds = 7 * 24 * 60 * 60
export type CanvasAgentSkillRemoteSource = { kind: 'url'; url: string } | { kind: 'github'; url: string; ref?: string; directory?: string }
export interface CanvasAgentSkillSourceFile { path: string; bytes: number; sha256: string }
/** Public, non-executing provenance. File hashes describe canonical UTF-8 text. */
export interface CanvasAgentSkillSource {
  version: 1
  kind: 'url' | 'github'
  url: string
  repository?: string
  commit?: string
  directory?: string
  retrievedAt: string
  originalDraftDigest: string
  files: CanvasAgentSkillSourceFile[]
  bundleSha256?: string
  verification: 'server-read' | 'imported-claim'
  modified: boolean
}
export interface CanvasAgentSkillRemotePreview { version: 1; draft: CanvasAgentSkillDraft; source: CanvasAgentSkillSource; proof: string; expiresAt: string }
export function skillImportTime(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new CanvasAgentError('技能来源时间无效')
  return value
}
export function skillImportUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) throw new CanvasAgentError('请填写公开 HTTPS 技能地址')
  let url: URL
  try { url = new URL(value) } catch { throw new CanvasAgentError('技能地址格式不正确') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443' || !url.hostname.includes('.') || /[\[\]:]/.test(url.hostname) || /^[0-9.]+$/.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|onion)$/.test(url.hostname) || [...url.searchParams.keys()].some((key) => /(?:token|secret|key|auth|password|credential|signature|sig|code)/i.test(key))) throw new CanvasAgentError('技能地址须为不含账户、凭据或锚点的公开 HTTPS 地址')
  return url.href
}
export function skillImportDirectory(value: unknown): string {
  if (value === '') return ''
  if (typeof value !== 'string' || value.length > 200 || value !== value.normalize('NFC') || /[\\:\x00-\x20\x7f?#%]/.test(value) || value.split('/').length > 5 || value.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.'))) throw new CanvasAgentError('GitHub 技能目录须为不含上级目录的规范相对路径')
  return value
}
export function parseCanvasAgentSkillRemoteSource(value: unknown): CanvasAgentSkillRemoteSource {
  const input = canvasAgentRecord(value, '技能来源')
  canvasAgentKeys(input, input.kind === 'url' ? ['kind', 'url'] : ['kind', 'url', 'ref', 'directory'])
  const url = skillImportUrl(input.url)
  if (input.kind === 'url') return { kind: 'url', url }
  if (input.kind !== 'github' || new URL(url).hostname !== 'github.com' || new URL(url).search) throw new CanvasAgentError('GitHub 导入只接受 github.com 仓库或技能目录地址')
  if (input.ref !== undefined && (typeof input.ref !== 'string' || !input.ref || input.ref.length > 200 || /[\x00-\x20\x7f\\?#%]/.test(input.ref) || input.ref.includes('..') || input.ref.startsWith('/') || input.ref.endsWith('/'))) throw new CanvasAgentError('GitHub 分支或提交格式不正确')
  return { kind: 'github', url, ...(input.ref === undefined ? {} : { ref: String(input.ref) }), ...(input.directory === undefined ? {} : { directory: skillImportDirectory(input.directory) }) }
}
export function parseCanvasAgentSkillSource(value: unknown): CanvasAgentSkillSource {
  const input = canvasAgentRecord(value, '技能来源记录')
  canvasAgentKeys(input, ['version', 'kind', 'url', 'repository', 'commit', 'directory', 'retrievedAt', 'originalDraftDigest', 'files', 'bundleSha256', 'verification', 'modified'])
  if (input.version !== 1 || !['url', 'github'].includes(String(input.kind)) || !['server-read', 'imported-claim'].includes(String(input.verification)) || typeof input.modified !== 'boolean' || !Array.isArray(input.files) || !input.files.length || input.files.length > 32) throw new CanvasAgentError('技能来源格式或版本不受支持')
  const files = input.files.map((entry) => {
    const file = canvasAgentRecord(entry); canvasAgentKeys(file, ['path', 'bytes', 'sha256'])
    const path = file.path === 'SKILL.md' ? 'SKILL.md' : parseCanvasAgentSkillResourcePath(file.path)
    if (!Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0 || Number(file.bytes) > 64 * 1024) throw new CanvasAgentError('技能来源文件大小无效')
    return { path, bytes: Number(file.bytes), sha256: canvasAgentDigestValue(file.sha256) }
  })
  if (files[0].path !== 'SKILL.md' || new Set(files.map((file) => file.path.toLowerCase())).size !== files.length || files.reduce((sum, file) => sum + file.bytes, 0) > 256 * 1024) throw new CanvasAgentError('技能来源文件清单不完整或重复')
  const url = skillImportUrl(input.url)
  if (input.kind === 'github') {
    if (typeof input.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) || input.repository.length > 200 || typeof input.commit !== 'string' || !/^[0-9a-f]{40}$/.test(input.commit) || input.directory === undefined || new URL(url).hostname !== 'github.com') throw new CanvasAgentError('GitHub 来源缺少固定提交或技能目录')
  } else if (input.repository !== undefined || input.commit !== undefined || input.directory !== undefined) throw new CanvasAgentError('普通地址不能声明 GitHub 提交来源')
  return { version: 1, kind: input.kind as 'url' | 'github', url, ...(input.kind === 'github' ? { repository: String(input.repository), commit: String(input.commit), directory: skillImportDirectory(input.directory) } : {}), retrievedAt: skillImportTime(input.retrievedAt), originalDraftDigest: canvasAgentDigestValue(input.originalDraftDigest), files, ...(input.bundleSha256 === undefined ? {} : { bundleSha256: canvasAgentDigestValue(input.bundleSha256) }), verification: input.verification as 'server-read' | 'imported-claim', modified: input.modified }
}
export function parseCanvasAgentSkillImportProof(value: unknown): string {
  if (typeof value !== 'string' || value.length > 24 * 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw new CanvasAgentError('技能来源预览无效，请重新读取并预览')
  return value
}
export function parseCanvasAgentSkillRemotePreview(value: unknown): CanvasAgentSkillRemotePreview {
  const input = canvasAgentRecord(value); canvasAgentKeys(input, ['version', 'draft', 'source', 'proof', 'expiresAt'])
  if (input.version !== 1) throw new CanvasAgentError('技能预览版本不受支持')
  const source = parseCanvasAgentSkillSource(input.source), expiresAt = skillImportTime(input.expiresAt)
  if (source.verification !== 'server-read' || source.modified || Date.parse(expiresAt) - Date.parse(source.retrievedAt) !== canvasAgentSkillImportLifetimeSeconds * 1000) throw new CanvasAgentError('技能预览来源与有效期不一致')
  return { version: 1, draft: parseCanvasAgentSkillDraft(input.draft), source, proof: parseCanvasAgentSkillImportProof(input.proof), expiresAt }
}
