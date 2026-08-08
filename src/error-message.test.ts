import { describe, expect, it } from 'vitest'
import { errorMessage } from './error-message'

describe('errorMessage', () => {
  it('strips the Electron IPC prefix that would otherwise expose channel names', () => {
    expect(errorMessage(new Error("Error invoking remote method 'config:save': 保存失败")))
      .toBe('保存失败')
  })

  it('strips every layer when the prefix is nested', () => {
    // A handler that re-invokes another channel produces a stacked prefix, and
    // showing even one of them leaks an internal channel name to the user.
    const nested = new Error(
      "Error invoking remote method 'a:one': "
      + "Error invoking remote method 'b:two': "
      + "Error invoking remote method 'c:three': 真正的原因",
    )

    expect(errorMessage(nested)).toBe('真正的原因')
  })

  it('reads a message off a plain object that is not an Error', () => {
    // Structured clone across IPC can deliver an error-shaped plain object.
    expect(errorMessage({ message: '来自结构化克隆的错误' })).toBe('来自结构化克隆的错误')
    expect(errorMessage({ message: "Error invoking remote method 'x:y': 内部原因" }))
      .toBe('内部原因')
  })

  it('gives a readable fallback instead of "null" or "undefined"', () => {
    expect(errorMessage(null)).toBe('未知错误')
    expect(errorMessage(undefined)).toBe('未知错误')
  })

  it('stringifies values that carry no message', () => {
    expect(errorMessage('直接抛出的字符串')).toBe('直接抛出的字符串')
    expect(errorMessage(404)).toBe('404')
    expect(errorMessage({ code: 'ENOENT' })).toBe('[object Object]')
  })

  it('leaves an ordinary message untouched', () => {
    expect(errorMessage(new Error('工作目录不存在，请重新选择')))
      .toBe('工作目录不存在，请重新选择')
    // A quoted method name mid-sentence must not be mistaken for the prefix,
    // which is anchored to the start.
    expect(errorMessage(new Error("调用 'config:save' 时出错")))
      .toBe("调用 'config:save' 时出错")
  })

  it('is not affected by regex lastIndex state across calls', () => {
    // The prefix pattern deliberately has no /g flag. If that ever changes,
    // .test() would advance lastIndex and every other call would miss.
    const prefixed = "Error invoking remote method 'config:save': 保存失败"
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(errorMessage(new Error(prefixed))).toBe('保存失败')
    }
  })

  it('returns an empty string rather than throwing on an empty message', () => {
    expect(errorMessage(new Error(''))).toBe('')
    expect(errorMessage({ message: '' })).toBe('')
  })
})
