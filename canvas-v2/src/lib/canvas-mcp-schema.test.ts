import { describe, expect, it } from 'vitest'
import { inspectCanvasMcpSchema, validateCanvasMcpArguments } from './canvas-mcp-schema'
import { boundedMcpJson, canvasMcpLimits, normalizeCanvasMcpCallResult, parseCanvasMcpAuth, parseCanvasMcpConnectionDraft } from './canvas-mcp-contract'

describe('bounded MCP JSON Schema validation', () => {
  const schema = { type: 'object', properties: { title: { type: 'string', minLength: 2, maxLength: 8 }, count: { type: 'integer', minimum: 1, maximum: 5 }, optional: { type: ['null', 'boolean'] } }, required: ['title', 'count'], additionalProperties: false }
  it('enforces object required fields, unicode lengths, strict types and unknown fields', () => {
    expect(inspectCanvasMcpSchema(schema)).toEqual({ supported: true })
    expect(validateCanvasMcpArguments(schema, { title: '☕😀', count: 2, optional: null })).toEqual({ title: '☕😀', count: 2, optional: null })
    for (const args of [{ title: 'a', count: 2 }, { title: '合法', count: '2' }, { title: '合法', count: 0 }, { title: '合法', count: 1, extra: true }, { title: '合法' }]) expect(() => validateCanvasMcpArguments(schema, args)).toThrow('不满足')
  })
  it('supports local definitions, tuples, arrays, uniqueness and exact enum or const', () => {
    const input = { type: 'object', $defs: { item: { type: 'string', enum: ['a', 'b'] } }, properties: { values: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { $ref: '#/$defs/item' } }, tuple: { type: 'array', prefixItems: [{ const: 'start' }, { type: 'number', multipleOf: 0.5 }], items: false } }, required: ['values'] }
    expect(validateCanvasMcpArguments(input, { values: ['a', 'b'], tuple: ['start', 1.5] })).toBeTruthy()
    for (const args of [{ values: ['c'] }, { values: ['a', 'a'] }, { values: ['a'], tuple: ['start', 1.1] }, { values: ['a'], tuple: ['start', 1, 'extra'] }]) expect(() => validateCanvasMcpArguments(input, args)).toThrow()
  })
  it('honors combinators, dependent fields and conditional branches', () => {
    const input = { type: 'object', properties: { mode: { enum: ['a', 'b'] }, value: { anyOf: [{ type: 'integer', minimum: 1 }, { const: null }] }, marker: { type: 'string', pattern: '^[a-z]+$' } }, dependentRequired: { marker: ['mode'] }, if: { properties: { mode: { const: 'a' } }, required: ['mode'] }, then: { required: ['value'] }, else: { not: { required: ['value'] } } }
    expect(validateCanvasMcpArguments(input, { mode: 'a', value: null })).toBeTruthy()
    expect(validateCanvasMcpArguments(input, { mode: 'b', marker: 'abc' })).toBeTruthy()
    for (const args of [{ mode: 'a' }, { mode: 'b', value: 1 }, { marker: 'abc' }, { mode: 'b', marker: '123' }]) expect(() => validateCanvasMcpArguments(input, args)).toThrow()
    expect(() => validateCanvasMcpArguments({ type: 'object', oneOf: [{ required: ['a'] }, { required: ['b'] }] }, { a: 1, b: 1 })).toThrow()
  })
  it.each([{ patternProperties: { '.*': { type: 'string' } } }, { unevaluatedProperties: false }, { $ref: 'https://example.invalid/schema.json' }, { properties: { value: { pattern: '(a+)+' } } }, { properties: { value: { format: 'unrecognized' } } }])('refuses unsupported constraints instead of ignoring them: %s', (additional) => {
    const schema = { type: 'object', ...additional }
    expect(inspectCanvasMcpSchema(schema).supported).toBe(false)
    expect(() => validateCanvasMcpArguments(schema, {})).toThrow()
  })
  it('validates actual calendar dates and rejects invalid URI whitespace or percent sequences', () => {
    const schema = { type: 'object', properties: { timestamp: { type: 'string', format: 'date-time' }, url: { type: 'string', format: 'uri' } } }
    expect(validateCanvasMcpArguments(schema, { timestamp: '2024-02-29T01:02:03+02:00', url: 'https://example.invalid/a%20b' })).toBeTruthy()
    for (const args of [{ timestamp: '2025-02-29T01:02:03Z' }, { url: 'https://example.invalid/a b' }, { url: 'https://example.invalid/a%zz' }]) expect(() => validateCanvasMcpArguments(schema, args)).toThrow('不满足')
  })
  it('bounds quadratic uniqueness work and patterned strings without truncating input', () => {
    const schema = { type: 'object', properties: { items: { type: 'array', uniqueItems: true }, text: { type: 'string', pattern: '^a+$' } } }
    expect(() => validateCanvasMcpArguments(schema, { items: Array.from({ length: 400 }, (_, i) => i) })).toThrow('复杂度')
    expect(() => validateCanvasMcpArguments(schema, { text: 'a'.repeat(4097) })).toThrow('4096')
    expect(validateCanvasMcpArguments({ type: 'object' }, { text: 'a'.repeat(4097) })).toBeTruthy()
  })
  it('rejects recursive references, excessive depth, prototype accessors and oversized argument JSON', () => {
    expect(inspectCanvasMcpSchema({ type: 'object', $defs: { a: { $ref: '#/$defs/a' } }, $ref: '#/$defs/a' }).supported).toBe(false)
    const object = Object.create(null); Object.defineProperty(object, 'secret', { enumerable: true, get() { throw new Error('Must not invoke') } })
    expect(() => boundedMcpJson(object, 1000)).toThrow('不安全字段')
    expect(() => validateCanvasMcpArguments({ type: 'object' }, { value: 'x'.repeat(canvasMcpLimits.argumentsBytes) })).toThrow('不能截断')
    expect(() => boundedMcpJson(JSON.parse('{"__proto__":{"polluted":true}}'), 1000)).toThrow('不安全字段')
  })
})
describe('MCP credentials and result contract', () => {
  it.each(['Cookie', 'Host', 'Proxy-Authorization', 'MCP-Session-Id', 'Content-Type', 'Authorization', 'CF-Connecting-IP', 'X-Canvas-Expected-Account'])('rejects reserved custom header %s', (name) => {
    expect(() => parseCanvasMcpAuth({ kind: 'headers', headers: { [name]: 'secret' } })).toThrow('保留名称')
  })
  it('allows bounded custom credential headers and explicit no-auth without embedding credentials in URLs', () => {
    expect(parseCanvasMcpAuth({ kind: 'headers', headers: { 'X-Client-Key': 'opaque', 'X-Workspace': 'space' } })).toEqual({ kind: 'headers', headers: { 'x-client-key': 'opaque', 'x-workspace': 'space' } })
    expect(parseCanvasMcpAuth({ kind: 'none' })).toEqual({ kind: 'none' })
    const draft = { name: 'MCP', url: 'https://example.invalid/mcp/', connectionTimeoutMs: 1000, toolTimeoutMs: 1000, auth: { kind: 'none' } }
    expect(parseCanvasMcpConnectionDraft(draft).url).toBe(draft.url)
    for (const url of ['https://user:secret@example.invalid/mcp', 'https://example.invalid/mcp?key=secret', 'file:///etc/passwd']) expect(() => parseCanvasMcpConnectionDraft({ ...draft, url })).toThrow()
  })
  it('retains text, structured values and annotated nontext metadata without silently discarding blocks', () => {
    const result = normalizeCanvasMcpCallResult({ content: [{ type: 'text', text: '  原文\n', annotations: { audience: ['user'] } }, { type: 'audio', mimeType: 'audio/wav', data: 'AAAA' }, { type: 'resource', resource: { uri: 'https://example.invalid/text', mimeType: 'text/plain', text: '嵌入正文' } }], structuredContent: { count: 1 }, _meta: { trace: 'safe' } })
    expect(result.text).toBe('  原文\n\n\n嵌入正文'); expect(result.structuredContent).toEqual({ count: 1 })
    expect(result.content).toHaveLength(5); expect(result.content[2]).toMatchObject({ sourceType: 'audio', omitted: ['audio.data'], metadata: { dataEncodedCharacters: 4 } }); expect(result.content[4]).toMatchObject({ sourceType: 'result-metadata', metadata: { _meta: { trace: 'safe' } } })
  })
})
