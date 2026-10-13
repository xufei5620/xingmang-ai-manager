import { describe, expect, it } from 'vitest'
import {
  carryRequestDiagnostics,
  noteRequestDiagnostics,
  requestDiagnosticsOf,
  responseDiagnostics,
} from './request-diagnostics'

describe('request-diagnostics', () => {
  it('reads the status and both request identifiers off a response, on top of the line noted earlier', () => {
    const response = new Response('{}', {
      status: 401,
      headers: { 'X-Oneapi-Request-Id': '20261013163012345678abcdEFGH', 'cf-ray': '8f1a2b3c4d5e6f70-LAX' },
    })
    noteRequestDiagnostics(response, { line: 'direct' })
    expect(responseDiagnostics(response)).toEqual({
      line: 'direct', status: 401, requestId: '20261013163012345678abcdEFGH', cfRay: '8f1a2b3c4d5e6f70-LAX',
    })
    expect(responseDiagnostics(new Response(null, { status: 204 }))).toEqual({ status: 204 })
  })

  // 回应头是外部可控的：认不出的编号不进日志，免得一个回应头往日志里塞一段任意内容。
  it('drops identifiers that do not look like one', () => {
    for (const value of ['x'.repeat(129), 'id with spaces', 'id\tnext', '<script>', 'sk-fixture/../secret']) {
      const response = new Response(null, { status: 200, headers: { 'X-Oneapi-Request-Id': value, 'cf-ray': value } })
      expect(responseDiagnostics(response)).toEqual({ status: 200 })
    }
  })

  it('leaves out the zero status of a refused redirect', () => {
    const redirect = new Response(null, { status: 200 })
    Object.defineProperties(redirect, { type: { value: 'opaqueredirect' }, status: { value: 0 } })
    expect(responseDiagnostics(redirect)).toEqual({})
  })

  it('merges later notes over earlier ones and ignores what cannot carry a note', () => {
    const error = new Error('登录失败')
    noteRequestDiagnostics(error, { line: 'direct' })
    noteRequestDiagnostics(error, { status: 200, requestId: 'req-1' })
    noteRequestDiagnostics(error, { line: 'primary' })
    noteRequestDiagnostics(error, null)
    expect(requestDiagnosticsOf(error)).toEqual({ line: 'primary', status: 200, requestId: 'req-1' })
    noteRequestDiagnostics('plain text', { line: 'direct' })
    expect(requestDiagnosticsOf('plain text')).toBeNull()
    expect(requestDiagnosticsOf(new Error('nothing noted'))).toBeNull()
    expect(requestDiagnosticsOf(null)).toBeNull()
  })

  it('finds a note on a wrapped failure through its cause and carries it onto a replacement', () => {
    const original = new TypeError('fetch failed')
    noteRequestDiagnostics(original, { line: 'direct' })
    const wrapped = new Error('星芒账号服务暂时联系不上', { cause: original })
    expect(requestDiagnosticsOf(wrapped)).toEqual({ line: 'direct' })
    const replacement = carryRequestDiagnostics(wrapped, { provider: 'codex', message: '请求超时' })
    expect(requestDiagnosticsOf(replacement)).toEqual({ line: 'direct' })
    expect(Object.keys(replacement)).toEqual(['provider', 'message'])
  })

  // 诊断挂在旁边，不改错误本身：错误照旧原样交给渲染层、照旧按字段比对。
  it('never adds a property to the error or result it describes', () => {
    const error = new Error('账号或密码错误')
    noteRequestDiagnostics(error, { line: 'direct', status: 401, requestId: 'req-2' })
    expect(Object.keys(error)).toEqual([])
    expect(JSON.stringify(error)).toBe('{}')
  })
})
