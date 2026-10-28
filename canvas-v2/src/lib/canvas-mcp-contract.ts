export const canvasMcpLimits = { connections: 100, tools: 128, toolSchemaBytes: 32 * 1024, catalogBytes: 512 * 1024, argumentsBytes: 64 * 1024, resultBytes: 256 * 1024, referenceCharacters: 24_000, responseBytes: 1024 * 1024, headers: 16, headerBytes: 8192, connectionTimeoutMin: 1000, connectionTimeoutMax: 30_000, toolTimeoutMin: 1000, toolTimeoutMax: 120_000 } as const
export class CanvasMcpError extends Error { constructor(message: string, readonly status = 400) { super(message); this.name = 'CanvasMcpError' } }
export type CanvasMcpTransport = 'streamable-http' | 'sse'
export interface CanvasMcpTransportFields { transport?: CanvasMcpTransport; transportVersion?: 1 }
export type CanvasMcpAuth = { kind: 'none' } | { kind: 'bearer'; token: string } | { kind: 'headers'; headers: Record<string, string> }
export interface CanvasMcpConnectionDraft extends CanvasMcpTransportFields { name: string; url: string; connectionTimeoutMs: number; toolTimeoutMs: number; auth: CanvasMcpAuth; toolPolicyVersion?: 1; deniedToolNames?: string[] }
export interface CanvasMcpConnectionSummary extends CanvasMcpTransportFields {
  id: string; version: number; name: string; url: string; connectionTimeoutMs: number; toolTimeoutMs: number
  authKind: CanvasMcpAuth['kind']; headerNames: string[]; credentialsConfigured: boolean; enabled: boolean; archivedAt?: string; createdAt: string; updatedAt: string
  connectionStatus: 'untested' | 'ready' | 'failed'; checkedAt?: string; error?: string; toolCount: number
}
export interface CanvasMcpTool { name: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; toolSchemaDigest: string; schemaSupported: boolean; schemaError?: string }
export interface CanvasMcpConnection extends CanvasMcpConnectionSummary { tools: CanvasMcpTool[]; allowedToolNames: string[]; toolPolicyVersion?: 1; deniedToolNames?: string[] }
export interface CanvasMcpConnectionPatch extends Partial<CanvasMcpConnectionDraft> { enabled?: boolean; archived?: boolean; allowedToolNames?: string[] }
export interface CanvasMcpToolReference { connectionId: string; connectionVersion: number; toolName: string; toolSchemaDigest: string }
export interface CanvasMcpToolSnapshot extends CanvasMcpToolReference { connectionName: string; connectionUrl: string; tool: CanvasMcpTool }
export interface CanvasMcpTextContent { type: 'text'; text: string }
export interface CanvasMcpMetadataContent { type: 'metadata'; sourceType: string; metadata: Record<string, unknown>; omitted: string[]; notice: string }
export interface CanvasMcpCallResult { content: Array<CanvasMcpTextContent | CanvasMcpMetadataContent>; text: string; structuredContent?: Record<string, unknown>; isError: boolean }
export type CanvasMcpCallState = 'prepared' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'interrupted'
export interface CanvasMcpCall extends CanvasMcpToolReference {
  id: string; operationId: string; connectionName: string; connectionUrl: string; arguments: Record<string, unknown>; confirmationDigest: string; state: CanvasMcpCallState
  createdAt: string; updatedAt: string; startedAt?: string; completedAt?: string; error?: string; result?: CanvasMcpCallResult; resultDigest?: string
}
export type CanvasMcpCallSummary = Omit<CanvasMcpCall, 'arguments' | 'result'> & { resultAvailable: boolean }
export interface CanvasMcpResultReference { callId: string; resultDigest: string }
export interface CanvasMcpResultSnapshot extends CanvasMcpResultReference { connectionName: string; toolName: string; completedAt: string; result: CanvasMcpCallResult; characterCount: number }
export interface CanvasMcpOperation { id: string; state: 'running' | 'succeeded' | 'failed' | 'unknown'; connectionId?: string; connection?: CanvasMcpConnection; error?: string }
export interface CanvasMcpMethodMap {
  listConnections: { input: { query?: string; archived?: boolean; offset?: number; limit?: number }; result: { items: CanvasMcpConnectionSummary[]; total: number; query: string; archived: boolean; offset: number; limit: number } }
  readConnection: { input: { connectionId: string }; result: CanvasMcpConnection }
  createConnection: { input: { operationId: string; draft: CanvasMcpConnectionDraft }; result: CanvasMcpConnection }
  updateConnection: { input: { operationId: string; connectionId: string; expectedVersion: number; patch: CanvasMcpConnectionPatch }; result: CanvasMcpConnection }
  detectConnection: { input: { operationId: string; connectionId: string; expectedVersion: number; toolPolicyVersion?: 1; transportVersion?: 1 }; result: CanvasMcpConnection }
  inspectOperation: { input: { operationId: string }; result: { state: 'missing' } | { state: 'found'; operation: CanvasMcpOperation } }
  previewTool: { input: CanvasMcpToolReference; result: CanvasMcpToolSnapshot }
  prepareCall: { input: CanvasMcpToolReference & { operationId: string; arguments: Record<string, unknown> }; result: CanvasMcpCall }
  executeCall: { input: { callId: string; confirmationDigest: string }; result: CanvasMcpCall }
  listCalls: { input: { connectionId?: string; offset?: number; limit?: number }; result: { items: CanvasMcpCallSummary[]; total: number; offset: number; limit: number } }
  readCall: { input: { callId: string }; result: CanvasMcpCall }
  inspectCall: { input: { operationId: string }; result: { state: 'missing' } | { state: 'found'; call: CanvasMcpCall } }
  previewResult: { input: CanvasMcpResultReference; result: CanvasMcpResultSnapshot }
}
export type CanvasMcpMethod = keyof CanvasMcpMethodMap
export const canvasMcpMethods: readonly CanvasMcpMethod[] = ['listConnections', 'readConnection', 'createConnection', 'updateConnection', 'detectConnection', 'inspectOperation', 'previewTool', 'prepareCall', 'executeCall', 'listCalls', 'readCall', 'inspectCall', 'previewResult']
export interface CanvasMcpClient { active(): boolean; request<M extends CanvasMcpMethod>(method: M, input: CanvasMcpMethodMap[M]['input'], signal?: AbortSignal): Promise<CanvasMcpMethodMap[M]['result']> }
export function mcpRecord(value: unknown, label = 'MCP 请求'): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new CanvasMcpError(`${label}格式不正确`); return value as Record<string, unknown> }
export function mcpKeys(value: Record<string, unknown>, allowed: readonly string[]): void { if (Object.keys(value).some((key) => !allowed.includes(key))) throw new CanvasMcpError('MCP 请求包含不支持的字段') }
export function mcpText(value: unknown, label: string, maximum: number, empty = false): string { if (typeof value !== 'string' || value.length > maximum || !empty && !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new CanvasMcpError(`${label}格式不正确或超过上限`); return value.trim() }
export function mcpId(value: unknown): string { const id = mcpText(value, 'MCP 编号', 128); if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new CanvasMcpError('MCP 编号无效'); return id }
export function mcpOperationId(value: unknown): string { const id = mcpText(value, '操作编号', 36); if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) throw new CanvasMcpError('操作编号无效'); return id.toLowerCase() }
export function mcpInteger(value: unknown, min: number, max: number): number { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new CanvasMcpError(`MCP 数值必须为 ${min}–${max} 的整数`); return Number(value) }
export function mcpDigestValue(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new CanvasMcpError('MCP 内容摘要无效'); return value }
export function boundedMcpJson(value: unknown, maximum: number): unknown {
  let nodes = 0
  function visit(item: unknown, depth: number): unknown {
    if (++nodes > 20_000 || depth > 24) throw new CanvasMcpError('MCP JSON 嵌套或项目数量超过上限')
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item === 'string') { if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(item)) throw new CanvasMcpError('MCP JSON 包含无效文本'); return item }
    if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1))
    const object = mcpRecord(item, 'MCP JSON'), entries = Object.entries(Object.getOwnPropertyDescriptors(object))
    if (entries.some(([key, descriptor]) => !('value' in descriptor) || ['__proto__', 'prototype', 'constructor'].includes(key))) throw new CanvasMcpError('MCP JSON 包含不安全字段')
    return Object.fromEntries(entries.map(([key, descriptor]) => [key, visit(descriptor.value, depth + 1)]))
  }
  const safe = visit(value, 0)
  if (new TextEncoder().encode(JSON.stringify(safe)).length > maximum) throw new CanvasMcpError(`MCP JSON 超过 ${maximum} 字节上限，不能截断`, 413)
  return safe
}
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])); return value }
export async function canvasMcpDigest(value: unknown): Promise<string> { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(value)))); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('') }
export function parseCanvasMcpUrl(value: unknown): string {
  const raw = mcpText(value, 'MCP 地址', 2048)
  let url: URL; try { url = new URL(raw) } catch { throw new CanvasMcpError('MCP 地址无效') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || /[\\\s]/.test(raw)) throw new CanvasMcpError('MCP 仅支持无内嵌凭据的 HTTP(S) 地址')
  // Network policy (DNS, private ranges, local-only mode) is enforced again by
  // the transport. Query secrets must use the encrypted authentication fields.
  if (url.search) throw new CanvasMcpError('MCP 地址不能带查询参数，请把认证信息填写在加密认证字段')
  return url.href
}
const forbiddenHeaders = /^(?:authorization|cookie|set-cookie|host|connection|content-length|content-type|accept|accept-encoding|transfer-encoding|upgrade|te|trailer|origin|referer|user-agent|forwarded|x-forwarded-.*|cf-.*|x-canvas-.*|proxy-.*|sec-.*|mcp-.*|last-event-id)$/i
export function parseCanvasMcpAuth(value: unknown): CanvasMcpAuth {
  const raw = mcpRecord(value, 'MCP 认证')
  if (raw.kind === 'none') { mcpKeys(raw, ['kind']); return { kind: 'none' } }
  if (raw.kind === 'bearer') { mcpKeys(raw, ['kind', 'token']); if (typeof raw.token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(raw.token)) throw new CanvasMcpError('Bearer 凭据必须为 1–4096 个可打印字符'); return { kind: 'bearer', token: raw.token } }
  if (raw.kind !== 'headers') throw new CanvasMcpError('MCP 认证类型不支持')
  mcpKeys(raw, ['kind', 'headers']); const headers = mcpRecord(raw.headers, '自定义请求头'), entries = Object.entries(headers)
  if (!entries.length || entries.length > canvasMcpLimits.headers) throw new CanvasMcpError('自定义请求头数量必须为 1–16 个')
  const normalized: Record<string, string> = {}
  for (const [name, value] of entries) { const lower = name.toLowerCase(); if (!/^[a-zA-Z0-9!#$%&'*+.^_`|~-]{1,80}$/.test(name) || forbiddenHeaders.test(name) || lower in normalized || typeof value !== 'string' || !/^[\x20-\x7e]{1,4096}$/.test(value)) throw new CanvasMcpError('自定义请求头包含保留名称、重复项或无效值'); normalized[lower] = value }
  if (new TextEncoder().encode(JSON.stringify(normalized)).length > canvasMcpLimits.headerBytes) throw new CanvasMcpError('自定义请求头总量超过 8 KiB')
  return { kind: 'headers', headers: normalized }
}
export function parseCanvasMcpToolNames(value: unknown, label = '工具名单'): string[] {
  if (!Array.isArray(value) || value.length > canvasMcpLimits.tools) throw new CanvasMcpError(`${label}最多填写 128 个工具名称`)
  const names = value.map((item) => mcpText(item, label, 128))
  if (new Set(names).size !== names.length) throw new CanvasMcpError(`${label}包含重复的工具名称`)
  return names
}
export function parseCanvasMcpToolPolicy(value: Record<string, unknown>): Pick<CanvasMcpConnectionDraft, 'toolPolicyVersion' | 'deniedToolNames'> {
  if (value.toolPolicyVersion !== undefined && value.toolPolicyVersion !== 1 || value.deniedToolNames !== undefined && value.toolPolicyVersion !== 1) throw new CanvasMcpError('MCP 工具策略版本不支持，请刷新后重新核对拒绝名单', 409)
  return { ...(value.toolPolicyVersion === 1 ? { toolPolicyVersion: 1 } : {}), ...(value.deniedToolNames === undefined ? {} : { deniedToolNames: parseCanvasMcpToolNames(value.deniedToolNames, '工具拒绝名单') }) }
}
export function canvasMcpToolIsAllowed(connection: { allowedToolNames: readonly string[]; deniedToolNames?: readonly string[] }, toolName: string): boolean { return connection.allowedToolNames.includes(toolName) && !connection.deniedToolNames?.includes(toolName) }
export function parseCanvasMcpTransportFields(value: unknown, mode: 'draft' | 'patch' | 'stored' = 'draft'): CanvasMcpTransportFields {
  const raw = mcpRecord(value)
  if (!Object.hasOwn(raw, 'transport') && !Object.hasOwn(raw, 'transportVersion')) return {}
  if (raw.transportVersion !== 1) throw new CanvasMcpError('MCP 传输能力版本不受支持，请刷新后核对原连接', 409)
  if (raw.transport === undefined) {
    if (mode === 'patch') return { transportVersion: 1 }
    if (mode === 'stored') throw new CanvasMcpError('MCP 传输记录不完整，不能改为其他连接方式', 502)
    return { transport: 'streamable-http', transportVersion: 1 }
  }
  if (raw.transport !== 'streamable-http' && raw.transport !== 'sse') throw new CanvasMcpError('MCP 传输方式不受支持，请核对原连接', 409)
  return { transport: raw.transport, transportVersion: 1 }
}
export function parseCanvasMcpConnectionDraft(value: unknown): CanvasMcpConnectionDraft { const raw = mcpRecord(value); mcpKeys(raw, ['name', 'url', 'connectionTimeoutMs', 'toolTimeoutMs', 'auth', 'toolPolicyVersion', 'deniedToolNames', 'transport', 'transportVersion']); return { name: mcpText(raw.name, 'MCP 名称', 100), url: parseCanvasMcpUrl(raw.url), connectionTimeoutMs: mcpInteger(raw.connectionTimeoutMs, 1000, 30_000), toolTimeoutMs: mcpInteger(raw.toolTimeoutMs, 1000, 120_000), auth: parseCanvasMcpAuth(raw.auth), ...parseCanvasMcpToolPolicy(raw), ...parseCanvasMcpTransportFields(raw) } }
export function parseCanvasMcpToolReference(value: unknown): CanvasMcpToolReference { const raw = mcpRecord(value); mcpKeys(raw, ['connectionId', 'connectionVersion', 'toolName', 'toolSchemaDigest']); return { connectionId: mcpId(raw.connectionId), connectionVersion: mcpInteger(raw.connectionVersion, 1, Number.MAX_SAFE_INTEGER - 1), toolName: mcpText(raw.toolName, '工具名称', 128), toolSchemaDigest: mcpDigestValue(raw.toolSchemaDigest) } }
export function parseCanvasMcpResultReference(value: unknown): CanvasMcpResultReference { const raw = mcpRecord(value); mcpKeys(raw, ['callId', 'resultDigest']); return { callId: mcpId(raw.callId), resultDigest: mcpDigestValue(raw.resultDigest) } }

export async function canvasMcpToolSchemaDigest(value: unknown): Promise<string> {
  const raw = mcpRecord(value, 'MCP 工具')
  const name = mcpText(raw.name, '工具名称', 128), inputSchema = mcpRecord(boundedMcpJson(raw.inputSchema, canvasMcpLimits.toolSchemaBytes), '工具输入 schema')
  const outputSchema = raw.outputSchema === undefined ? undefined : mcpRecord(boundedMcpJson(raw.outputSchema, canvasMcpLimits.toolSchemaBytes), '工具输出 schema')
  return canvasMcpDigest({ name, inputSchema, ...(outputSchema ? { outputSchema } : {}) })
}
export function parseCanvasMcpTool(value: unknown): CanvasMcpTool {
  const raw = mcpRecord(value); mcpKeys(raw, ['name', 'description', 'inputSchema', 'outputSchema', 'toolSchemaDigest', 'schemaSupported', 'schemaError'])
  if (typeof raw.schemaSupported !== 'boolean' || raw.schemaSupported === false && typeof raw.schemaError !== 'string') throw new CanvasMcpError('工具 schema 能力回执不完整')
  return { name: mcpText(raw.name, '工具名称', 128), ...(raw.description === undefined ? {} : { description: mcpText(raw.description, '工具说明', 4000, true) }), inputSchema: mcpRecord(boundedMcpJson(raw.inputSchema, canvasMcpLimits.toolSchemaBytes)), ...(raw.outputSchema === undefined ? {} : { outputSchema: mcpRecord(boundedMcpJson(raw.outputSchema, canvasMcpLimits.toolSchemaBytes)) }), toolSchemaDigest: mcpDigestValue(raw.toolSchemaDigest), schemaSupported: raw.schemaSupported, ...(raw.schemaError === undefined ? {} : { schemaError: mcpText(raw.schemaError, 'schema 限制', 1000) }) }
}
function mcpBoolean(value: unknown): boolean { if (typeof value !== 'boolean') throw new CanvasMcpError('MCP 状态回执无效', 502); return value }
function mcpTime(value: unknown): string { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new CanvasMcpError('MCP 时间回执无效', 502); return value }
const connectionKeys = ['transport', 'transportVersion', 'id', 'version', 'name', 'url', 'connectionTimeoutMs', 'toolTimeoutMs', 'authKind', 'headerNames', 'credentialsConfigured', 'enabled', 'archivedAt', 'createdAt', 'updatedAt', 'connectionStatus', 'checkedAt', 'error', 'toolCount']
export function parseCanvasMcpConnectionSummary(value: unknown): CanvasMcpConnectionSummary {
  const raw = mcpRecord(value); mcpKeys(raw, connectionKeys)
  if (!['none', 'bearer', 'headers'].includes(String(raw.authKind)) || !['untested', 'ready', 'failed'].includes(String(raw.connectionStatus)) || !Array.isArray(raw.headerNames) || raw.headerNames.length > 16 || raw.headerNames.some((name) => typeof name !== 'string' || name.length > 80)) throw new CanvasMcpError('MCP 连接回执无效', 502)
  return { ...parseCanvasMcpTransportFields(raw, 'stored'), id: mcpId(raw.id), version: mcpInteger(raw.version, 1, Number.MAX_SAFE_INTEGER - 1), name: mcpText(raw.name, '连接名称', 100), url: parseCanvasMcpUrl(raw.url), connectionTimeoutMs: mcpInteger(raw.connectionTimeoutMs, 1000, 30_000), toolTimeoutMs: mcpInteger(raw.toolTimeoutMs, 1000, 120_000), authKind: raw.authKind as CanvasMcpAuth['kind'], headerNames: raw.headerNames as string[], credentialsConfigured: mcpBoolean(raw.credentialsConfigured), enabled: mcpBoolean(raw.enabled), connectionStatus: raw.connectionStatus as CanvasMcpConnectionSummary['connectionStatus'], toolCount: mcpInteger(raw.toolCount, 0, canvasMcpLimits.tools), createdAt: mcpTime(raw.createdAt), updatedAt: mcpTime(raw.updatedAt), ...(raw.archivedAt === undefined ? {} : { archivedAt: mcpTime(raw.archivedAt) }), ...(raw.checkedAt === undefined ? {} : { checkedAt: mcpTime(raw.checkedAt) }), ...(raw.error === undefined ? {} : { error: mcpText(raw.error, '连接错误', 1000) }) }
}
export function parseCanvasMcpConnection(value: unknown): CanvasMcpConnection {
  const raw = mcpRecord(value); mcpKeys(raw, [...connectionKeys, 'tools', 'allowedToolNames', 'toolPolicyVersion', 'deniedToolNames']); const { tools, allowedToolNames, toolPolicyVersion, deniedToolNames, ...summary } = raw
  if (toolPolicyVersion === 1 && deniedToolNames === undefined) throw new CanvasMcpError('MCP 工具拒绝策略回执不完整，请刷新后核对', 502)
  if (!Array.isArray(tools) || tools.length > canvasMcpLimits.tools || !Array.isArray(allowedToolNames) || allowedToolNames.some((name) => typeof name !== 'string')) throw new CanvasMcpError('MCP 工具列表回执无效', 502)
  const parsed = tools.map(parseCanvasMcpTool)
  if (new Set(parsed.map((tool) => tool.name)).size !== parsed.length || new Set(allowedToolNames).size !== allowedToolNames.length || allowedToolNames.some((name) => !parsed.some((tool) => tool.name === name)) || raw.toolCount !== parsed.length) throw new CanvasMcpError('MCP 工具列表身份不一致', 502)
  boundedMcpJson(parsed, canvasMcpLimits.catalogBytes)
  return { ...parseCanvasMcpConnectionSummary(summary), tools: parsed, allowedToolNames: allowedToolNames as string[], ...parseCanvasMcpToolPolicy({ toolPolicyVersion, deniedToolNames }) }
}
export function normalizeCanvasMcpCallResult(value: unknown): CanvasMcpCallResult {
  const raw = mcpRecord(boundedMcpJson(value, canvasMcpLimits.resultBytes), 'MCP 工具结果')
  if (!Array.isArray(raw.content) || raw.content.length > 128 || raw.isError !== undefined && typeof raw.isError !== 'boolean') throw new CanvasMcpError('MCP 工具结果格式不完整', 502)
  const content: CanvasMcpCallResult['content'] = [], texts: string[] = []
  for (const block of raw.content) {
    const item = mcpRecord(block, 'MCP 内容块'), type = mcpText(item.type, '内容类型', 64)
    if (type === 'text') { if (typeof item.text !== 'string') throw new CanvasMcpError('MCP 文本结果无效', 502); content.push({ type: 'text', text: item.text }); texts.push(item.text); const extras = Object.fromEntries(Object.entries(item).filter(([key]) => !['type', 'text'].includes(key))); if (Object.keys(extras).length) content.push({ type: 'metadata', sourceType: 'text-metadata', metadata: extras, omitted: [], notice: '文本附加元信息，仅供查看。' }) }
    else {
      const omitted: string[] = []
      function metadata(value: unknown, path: string): unknown { if (Array.isArray(value)) return value.map((child, index) => metadata(child, `${path}.${index}`)); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => { if ((key === 'data' || key === 'blob') && typeof child === 'string') { omitted.push(`${path}.${key}`); return [`${key}EncodedCharacters`, child.length] } return [key, metadata(child, `${path}.${key}`)] })); return value }
      const details = metadata(item, type) as Record<string, unknown>
      if (type === 'resource' && item.resource && typeof item.resource === 'object' && 'text' in item.resource && typeof item.resource.text === 'string') texts.push(item.resource.text)
      content.push({ type: 'metadata', sourceType: type, metadata: details, omitted, notice: omitted.length ? '已保留有界元信息，二进制内容未保存或下载；不会自动读取远程资源。' : '非文字内容仅保留元信息，不会自动读取或下载远程资源。' })
    }
  }
  const structuredContent = raw.structuredContent === undefined ? undefined : mcpRecord(raw.structuredContent, 'MCP 结构化结果')
  const extras = Object.fromEntries(Object.entries(raw).filter(([key]) => !['content', 'structuredContent', 'isError'].includes(key)))
  if (Object.keys(extras).length) content.push({ type: 'metadata', sourceType: 'result-metadata', metadata: extras, omitted: [], notice: '工具结果附加元信息，仅供查看。' })
  const result = { content, text: texts.join('\n\n'), ...(structuredContent ? { structuredContent } : {}), isError: raw.isError === true }
  boundedMcpJson(result, canvasMcpLimits.resultBytes)
  return result
}
export function parseCanvasMcpCallResult(value: unknown): CanvasMcpCallResult {
  const raw = mcpRecord(boundedMcpJson(value, canvasMcpLimits.resultBytes)); mcpKeys(raw, ['content', 'text', 'structuredContent', 'isError'])
  if (!Array.isArray(raw.content) || raw.content.length > 257 || typeof raw.text !== 'string' || typeof raw.isError !== 'boolean') throw new CanvasMcpError('MCP 保存结果无效', 502)
  const content = raw.content.map((block): CanvasMcpTextContent | CanvasMcpMetadataContent => { const item = mcpRecord(block); if (item.type === 'text') { mcpKeys(item, ['type', 'text']); if (typeof item.text !== 'string') throw new CanvasMcpError('文本回执无效'); return { type: 'text', text: item.text } } mcpKeys(item, ['type', 'sourceType', 'metadata', 'omitted', 'notice']); if (item.type !== 'metadata' || !Array.isArray(item.omitted) || item.omitted.some((entry) => typeof entry !== 'string')) throw new CanvasMcpError('非文字结果元信息无效'); return { type: 'metadata', sourceType: mcpText(item.sourceType, '内容类型', 80), metadata: mcpRecord(item.metadata), omitted: item.omitted as string[], notice: mcpText(item.notice, '内容说明', 500) } })
  return { content, text: raw.text, isError: raw.isError, ...(raw.structuredContent === undefined ? {} : { structuredContent: mcpRecord(raw.structuredContent) }) }
}
export function parseCanvasMcpCall(value: unknown): CanvasMcpCall {
  const raw = mcpRecord(value); mcpKeys(raw, ['id', 'operationId', 'connectionId', 'connectionVersion', 'connectionName', 'connectionUrl', 'toolName', 'toolSchemaDigest', 'arguments', 'confirmationDigest', 'state', 'createdAt', 'updatedAt', 'startedAt', 'completedAt', 'error', 'result', 'resultDigest'])
  if (!['prepared', 'running', 'succeeded', 'failed', 'unknown', 'interrupted'].includes(String(raw.state))) throw new CanvasMcpError('MCP 调用状态无效', 502)
  const reference = parseCanvasMcpToolReference({ connectionId: raw.connectionId, connectionVersion: raw.connectionVersion, toolName: raw.toolName, toolSchemaDigest: raw.toolSchemaDigest })
  const call: CanvasMcpCall = { ...reference, id: mcpId(raw.id), operationId: mcpOperationId(raw.operationId), connectionName: mcpText(raw.connectionName, '连接名称', 100), connectionUrl: parseCanvasMcpUrl(raw.connectionUrl), arguments: mcpRecord(boundedMcpJson(raw.arguments, canvasMcpLimits.argumentsBytes)), confirmationDigest: mcpDigestValue(raw.confirmationDigest), state: raw.state as CanvasMcpCallState, createdAt: mcpTime(raw.createdAt), updatedAt: mcpTime(raw.updatedAt), ...(raw.startedAt === undefined ? {} : { startedAt: mcpTime(raw.startedAt) }), ...(raw.completedAt === undefined ? {} : { completedAt: mcpTime(raw.completedAt) }), ...(raw.error === undefined ? {} : { error: mcpText(raw.error, '调用错误', 1000) }), ...(raw.result === undefined ? {} : { result: parseCanvasMcpCallResult(raw.result), resultDigest: mcpDigestValue(raw.resultDigest) }) }
  if (call.state === 'succeeded' && (!call.result || call.result.isError || !call.completedAt) || raw.result === undefined && raw.resultDigest !== undefined) throw new CanvasMcpError('MCP 调用成功回执不完整', 502)
  return call
}
export function parseCanvasMcpToolSnapshot(value: unknown): CanvasMcpToolSnapshot { const raw = mcpRecord(value); mcpKeys(raw, ['connectionId', 'connectionVersion', 'toolName', 'toolSchemaDigest', 'connectionName', 'connectionUrl', 'tool']); const { connectionName, connectionUrl, tool, ...reference } = raw; const parsed = parseCanvasMcpToolReference(reference), parsedTool = parseCanvasMcpTool(tool); if (parsedTool.name !== parsed.toolName || parsedTool.toolSchemaDigest !== parsed.toolSchemaDigest) throw new CanvasMcpError('MCP 工具快照不一致'); return { ...parsed, connectionName: mcpText(connectionName, '连接名称', 100), connectionUrl: parseCanvasMcpUrl(connectionUrl), tool: parsedTool } }
export function parseCanvasMcpResultSnapshot(value: unknown): CanvasMcpResultSnapshot { const raw = mcpRecord(value); mcpKeys(raw, ['callId', 'resultDigest', 'connectionName', 'toolName', 'completedAt', 'result', 'characterCount']); const result = parseCanvasMcpCallResult(raw.result), characterCount = JSON.stringify(result).length; if (raw.characterCount !== characterCount || characterCount > canvasMcpLimits.referenceCharacters || result.isError) throw new CanvasMcpError('MCP 结果引用超过容量或不可引用', 413); return { callId: mcpId(raw.callId), resultDigest: mcpDigestValue(raw.resultDigest), connectionName: mcpText(raw.connectionName, '连接名称', 100), toolName: mcpText(raw.toolName, '工具名称', 128), completedAt: mcpTime(raw.completedAt), result, characterCount } }
export function parseCanvasMcpOperation(value: unknown): CanvasMcpOperation { const raw = mcpRecord(value); mcpKeys(raw, ['id', 'state', 'connectionId', 'connection', 'error']); if (!['running', 'succeeded', 'failed', 'unknown'].includes(String(raw.state))) throw new CanvasMcpError('MCP 原操作状态无效'); return { id: mcpOperationId(raw.id), state: raw.state as CanvasMcpOperation['state'], ...(raw.connectionId === undefined ? {} : { connectionId: mcpId(raw.connectionId) }), ...(raw.connection === undefined ? {} : { connection: parseCanvasMcpConnection(raw.connection) }), ...(raw.error === undefined ? {} : { error: mcpText(raw.error, '操作错误', 1000) }) } }
export function parseCanvasMcpResponse<M extends CanvasMcpMethod>(method: M, value: unknown): CanvasMcpMethodMap[M]['result'] {
  let result: unknown
  if (method === 'previewTool') result = parseCanvasMcpToolSnapshot(value)
  else if (method === 'previewResult') result = parseCanvasMcpResultSnapshot(value)
  else if (method === 'inspectOperation' || method === 'inspectCall') { const raw = mcpRecord(value), key = method === 'inspectOperation' ? 'operation' : 'call'; mcpKeys(raw, raw.state === 'missing' ? ['state'] : ['state', key]); if (!['missing', 'found'].includes(String(raw.state))) throw new CanvasMcpError('MCP 原操作核对无效'); result = raw.state === 'missing' ? { state: 'missing' } : { state: 'found', [key]: key === 'operation' ? parseCanvasMcpOperation(raw[key]) : parseCanvasMcpCall(raw[key]) } }
  else if (method === 'listConnections' || method === 'listCalls') {
    const raw = mcpRecord(value); mcpKeys(raw, method === 'listConnections' ? ['items', 'total', 'offset', 'limit', 'query', 'archived'] : ['items', 'total', 'offset', 'limit']); const total = mcpInteger(raw.total, 0, 1_000_000), offset = mcpInteger(raw.offset, 0, 1_000_000), limit = mcpInteger(raw.limit, 1, 50)
    if (!Array.isArray(raw.items) || raw.items.length !== Math.min(limit, Math.max(0, total - offset))) throw new CanvasMcpError('MCP 分页回执不完整')
    const items = raw.items.map((entry) => method === 'listConnections' ? parseCanvasMcpConnectionSummary(entry) : parseCanvasMcpCallSummary(entry))
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new CanvasMcpError('MCP 分页重复')
    result = { items, total, offset, limit, ...(method === 'listConnections' ? { query: mcpText(raw.query, '搜索内容', 100, true), archived: mcpBoolean(raw.archived) } : {}) }
  } else if (['prepareCall', 'executeCall', 'readCall'].includes(method)) result = parseCanvasMcpCall(value)
  else result = parseCanvasMcpConnection(value)
  return result as CanvasMcpMethodMap[M]['result']
}

export function parseCanvasMcpCallSummary(value: unknown): CanvasMcpCallSummary {
  const raw = mcpRecord(value); mcpKeys(raw, ['id', 'operationId', 'connectionId', 'connectionVersion', 'connectionName', 'connectionUrl', 'toolName', 'toolSchemaDigest', 'confirmationDigest', 'state', 'createdAt', 'updatedAt', 'startedAt', 'completedAt', 'error', 'resultDigest', 'resultAvailable'])
  const resultAvailable = mcpBoolean(raw.resultAvailable), { resultAvailable: ignored, resultDigest, state, ...common } = raw
  const parsed = parseCanvasMcpCall({ ...common, state: state === 'succeeded' ? 'prepared' : state, arguments: {} })
  if (state === 'succeeded' && (!resultAvailable || !raw.completedAt) || resultAvailable !== (resultDigest !== undefined)) throw new CanvasMcpError('MCP 调用目录结果标记不完整')
  const { arguments: ignoredArgs, ...summary } = parsed
  return { ...summary, state: state as CanvasMcpCallState, resultAvailable, ...(resultDigest === undefined ? {} : { resultDigest: mcpDigestValue(resultDigest) }) }
}
