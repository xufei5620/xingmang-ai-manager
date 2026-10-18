import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { stripIpcErrorPrefix } from './ipc-error-prefix'

function patternLiteral(source: string, name: string) {
  const match = new RegExp(`^const ${name} = (/.*/[a-z]*)$`, 'm').exec(source)
  if (!match) throw new Error(`${name} not found`)
  return match[1]
}

describe('stripIpcErrorPrefix', () => {
  it('drops the channel and the class name right after it, layer by layer', () => {
    expect(stripIpcErrorPrefix("Error invoking remote method 'account:login': Error: 账号服务正在升级")).toBe('账号服务正在升级')
    expect(stripIpcErrorPrefix("Error invoking remote method 'account:get-balance': NewApiNetworkError: 连接账号服务超时")).toBe('连接账号服务超时')
    expect(stripIpcErrorPrefix("Error invoking remote method 'a:one': Error: Error invoking remote method 'b:two': StreamFailure: 真正的原因")).toBe('真正的原因')
  })

  it('leaves everything that is not the Electron wrapper alone', () => {
    expect(stripIpcErrorPrefix('Error: 这句是业务文案')).toBe('Error: 这句是业务文案')
    expect(stripIpcErrorPrefix("Error invoking remote method 'cli:install': Error: EPERM: operation not permitted")).toBe('EPERM: operation not permitted')
    expect(stripIpcErrorPrefix("Error invoking remote method 'config:save': C:\\Users\\张三\\config.toml 写不进去")).toBe('C:\\Users\\张三\\config.toml 写不进去')
    expect(stripIpcErrorPrefix("Error invoking remote method 'account:login': 原因  ")).toBe('原因  ')
  })

  it('stays identical to the copy the sandboxed canvas preload has to keep', () => {
    // canvas-preload.ts 是 sandbox 脚本，不能 import 这里（I7），只能抄一份；抄走样了画布节点上就会多出或少剥一截。
    const shared = readFileSync(new URL('./ipc-error-prefix.ts', import.meta.url), 'utf8')
    const canvas = readFileSync(new URL('../../electron/canvas-preload.ts', import.meta.url), 'utf8')
    expect(patternLiteral(canvas, 'ipcErrorPrefix')).toBe(patternLiteral(shared, 'ipcPrefixPattern'))
  })
})
