import { boundedMcpJson, CanvasMcpError, canvasMcpLimits, mcpRecord } from './canvas-mcp-contract'
const keywords = new Set(['$schema', '$id', '$ref', '$defs', 'definitions', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties', 'items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas'])
const types = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
function safePattern(pattern: unknown): RegExp {
  if (typeof pattern !== 'string' || pattern.length > 128 || /[()|]|\\[1-9]/.test(pattern) || (pattern.match(/[*+{]/g) ?? []).length > 1) throw new CanvasMcpError('此工具使用暂不支持的复杂正则约束')
  try { return new RegExp(pattern, 'u') } catch { throw new CanvasMcpError('工具正则约束无效') }
}
function resolveRef(root: Record<string, unknown>, ref: unknown): unknown {
  if (typeof ref !== 'string' || !/^#\/(?:\$defs|definitions)\//.test(ref)) throw new CanvasMcpError('仅支持工具 schema 内部定义引用，不会联网加载')
  let current: unknown = root
  for (const part of ref.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) { if (['__proto__', 'constructor', 'prototype'].includes(part)) throw new CanvasMcpError('工具 schema 引用无效'); current = mcpRecord(current, '工具 schema 引用')[part] }
  if (current === undefined) throw new CanvasMcpError('工具 schema 引用不存在')
  return current
}
function inspectSchema(schema: unknown, root: Record<string, unknown>, refs: Set<string>, depth = 0): void {
  if (depth > 24) throw new CanvasMcpError('工具 schema 深度超过上限')
  if (typeof schema === 'boolean') return
  const value = mcpRecord(schema, '工具参数 schema')
  for (const key of Object.keys(value)) if (!keywords.has(key)) throw new CanvasMcpError(`工具 schema 约束 ${key} 暂不支持，不能忽略后调用`)
  if (value.$ref !== undefined) { const ref = String(value.$ref); if (refs.has(ref)) throw new CanvasMcpError('暂不支持递归参数 schema'); inspectSchema(resolveRef(root, value.$ref), root, new Set([...refs, ref]), depth + 1) }
  if (value.type !== undefined && !(typeof value.type === 'string' ? types.includes(value.type) : Array.isArray(value.type) && value.type.length > 0 && value.type.every((item) => typeof item === 'string' && types.includes(item)))) throw new CanvasMcpError('工具 schema type 无效')
  for (const key of ['minProperties', 'maxProperties', 'minItems', 'maxItems', 'minLength', 'maxLength']) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0)) throw new CanvasMcpError('工具 schema 长度约束无效')
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || key === 'multipleOf' && Number(value[key]) <= 0)) throw new CanvasMcpError('工具 schema 数值约束无效')
  if (value.uniqueItems !== undefined && typeof value.uniqueItems !== 'boolean') throw new CanvasMcpError('工具 schema uniqueItems 无效')
  if (value.required !== undefined && (!Array.isArray(value.required) || !value.required.every((key) => typeof key === 'string') || new Set(value.required).size !== value.required.length)) throw new CanvasMcpError('工具 schema required 无效')
  if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length)) throw new CanvasMcpError('工具 schema enum 无效')
  if (value.pattern !== undefined) safePattern(value.pattern)
  if (value.format !== undefined && !['date-time', 'date', 'email', 'uri', 'uuid'].includes(String(value.format))) throw new CanvasMcpError(`工具 schema format ${String(value.format)} 暂不支持`)
  for (const key of ['properties', '$defs', 'definitions', 'dependentSchemas']) if (value[key] !== undefined) for (const child of Object.values(mcpRecord(value[key], '工具 schema 子项'))) inspectSchema(child, root, refs, depth + 1)
  for (const key of ['additionalProperties', 'items', 'not', 'if', 'then', 'else']) if (value[key] !== undefined) inspectSchema(value[key], root, refs, depth + 1)
  for (const key of ['prefixItems', 'allOf', 'anyOf', 'oneOf']) if (value[key] !== undefined) { if (!Array.isArray(value[key]) || (value[key] as unknown[]).length > 32 || key !== 'prefixItems' && !(value[key] as unknown[]).length) throw new CanvasMcpError('工具组合 schema 无效'); for (const child of value[key] as unknown[]) inspectSchema(child, root, refs, depth + 1) }
  if (value.dependentRequired !== undefined) for (const keys of Object.values(mcpRecord(value.dependentRequired))) if (!Array.isArray(keys) || !keys.every((key) => typeof key === 'string')) throw new CanvasMcpError('工具依赖字段约束无效')
}
export function inspectCanvasMcpSchema(schema: unknown): { supported: boolean; error?: string } {
  try { const root = mcpRecord(boundedMcpJson(schema, canvasMcpLimits.toolSchemaBytes), '工具 schema'); if (root.type !== 'object') throw new CanvasMcpError('工具输入 schema 必须明确 type:object'); inspectSchema(root, root, new Set()); return { supported: true } }
  catch (error) { return { supported: false, error: error instanceof CanvasMcpError ? error.message : '工具 schema 无法安全验证' } }
}
function equal(a: unknown, b: unknown, budget: { steps: number }): boolean { if (++budget.steps > 50_000) throw new CanvasMcpError('工具参数验证超过复杂度上限'); if (a === b) return true; if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => equal(item, b[i], budget)); if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) { const x = a as Record<string, unknown>, y = b as Record<string, unknown>; return Object.keys(x).length === Object.keys(y).length && Object.keys(x).every((key) => Object.hasOwn(y, key) && equal(x[key], y[key], budget)) } return false }
function validCalendarDate(value: string): boolean { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const milliseconds = Date.parse(value); return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value }
function matches(schema: unknown, data: unknown, root: Record<string, unknown>, budget: { steps: number }, depth = 0): boolean {
  if (++budget.steps > 50_000 || depth > 32) throw new CanvasMcpError('工具参数验证超过复杂度上限')
  if (typeof schema === 'boolean') return schema
  const s = schema as Record<string, unknown>
  if (s.$ref !== undefined && !matches(resolveRef(root, s.$ref), data, root, budget, depth + 1)) return false
  if (s.type !== undefined) { const accepts = (type: string) => type === 'null' ? data === null : type === 'object' ? !!data && typeof data === 'object' && !Array.isArray(data) : type === 'array' ? Array.isArray(data) : type === 'integer' ? Number.isInteger(data) : typeof data === type; if (!(Array.isArray(s.type) ? s.type : [s.type]).some((type) => accepts(String(type)))) return false }
  if (Object.hasOwn(s, 'const') && !equal(s.const, data, budget) || Array.isArray(s.enum) && !s.enum.some((value) => equal(value, data, budget))) return false
  for (const key of ['allOf', 'anyOf', 'oneOf']) if (Array.isArray(s[key])) { const count = (s[key] as unknown[]).reduce<number>((sum, child) => sum + Number(matches(child, data, root, budget, depth + 1)), 0); if (key === 'allOf' && count !== (s[key] as unknown[]).length || key === 'anyOf' && count === 0 || key === 'oneOf' && count !== 1) return false }
  if (s.not !== undefined && matches(s.not, data, root, budget, depth + 1)) return false
  if (s.if !== undefined) { const branch = matches(s.if, data, root, budget, depth + 1) ? s.then : s.else; if (branch !== undefined && !matches(branch, data, root, budget, depth + 1)) return false }
  if (typeof data === 'string') {
    const length = Array.from(data).length
    if (s.pattern !== undefined && length > 4096) throw new CanvasMcpError('正则参数文本超过 4096 字符验证上限，不能忽略约束后调用')
    if (s.minLength !== undefined && length < Number(s.minLength) || s.maxLength !== undefined && length > Number(s.maxLength) || s.pattern !== undefined && !safePattern(s.pattern).test(data)) return false
    if (s.format === 'uuid' && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(data) || s.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data) || s.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(data) || !Number.isFinite(Date.parse(data)) || !validCalendarDate(data.slice(0, 10))) || s.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !Number.isFinite(Date.parse(data)) || new Date(data).toISOString().slice(0, 10) !== data)) return false
    if (s.format === 'uri') { if (/[\u0000-\u0020\u007f]/u.test(data) || /%(?![0-9a-f]{2})/i.test(data)) return false; try { new URL(data) } catch { return false } }
  }
  if (typeof data === 'number') { if (s.minimum !== undefined && data < Number(s.minimum) || s.maximum !== undefined && data > Number(s.maximum) || s.exclusiveMinimum !== undefined && data <= Number(s.exclusiveMinimum) || s.exclusiveMaximum !== undefined && data >= Number(s.exclusiveMaximum)) return false; if (s.multipleOf !== undefined) { const q = data / Number(s.multipleOf); if (Math.abs(q - Math.round(q)) > Math.max(1, Math.abs(q)) * Number.EPSILON * 8) return false } }
  if (Array.isArray(data)) {
    if (s.minItems !== undefined && data.length < Number(s.minItems) || s.maxItems !== undefined && data.length > Number(s.maxItems)) return false
    if (s.uniqueItems === true && data.some((item, i) => data.slice(0, i).some((previous) => equal(item, previous, budget)))) return false
    const prefix = Array.isArray(s.prefixItems) ? s.prefixItems : []
    if (data.some((item, i) => { const child = i < prefix.length ? prefix[i] : s.items; return child !== undefined && !matches(child, item, root, budget, depth + 1) })) return false
  } else if (data && typeof data === 'object') {
    const object = data as Record<string, unknown>, keys = Object.keys(object), props = (s.properties ?? {}) as Record<string, unknown>
    if (s.minProperties !== undefined && keys.length < Number(s.minProperties) || s.maxProperties !== undefined && keys.length > Number(s.maxProperties) || Array.isArray(s.required) && s.required.some((key) => !Object.hasOwn(object, String(key)))) return false
    for (const key of keys) { const child = Object.hasOwn(props, key) ? props[key] : s.additionalProperties; if (child !== undefined && !matches(child, object[key], root, budget, depth + 1)) return false }
    for (const [key, required] of Object.entries((s.dependentRequired ?? {}) as Record<string, string[]>)) if (Object.hasOwn(object, key) && required.some((name) => !Object.hasOwn(object, name))) return false
    for (const [key, child] of Object.entries((s.dependentSchemas ?? {}) as Record<string, unknown>)) if (Object.hasOwn(object, key) && !matches(child, data, root, budget, depth + 1)) return false
  }
  return true
}
export function validateCanvasMcpArguments(schema: Record<string, unknown>, value: unknown): Record<string, unknown> {
  const inspected = inspectCanvasMcpSchema(schema)
  if (!inspected.supported) throw new CanvasMcpError(inspected.error!, 422)
  const args = mcpRecord(boundedMcpJson(value, canvasMcpLimits.argumentsBytes), '工具参数')
  if (!matches(schema, args, schema, { steps: 0 })) throw new CanvasMcpError('工具参数不满足已确认 schema，请检查类型、必填项和约束', 422)
  return args
}
