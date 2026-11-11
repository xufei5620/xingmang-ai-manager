import { describe, expect, it } from 'vitest'
import { mcpCopyConfig } from './mcp-copy'

describe('mcpCopyConfig', () => {
  it('carries a Claude Code stdio connection with its environment and an http one with its headers', () => {
    expect(mcpCopyConfig('claude', { type: 'stdio', command: 'npx', args: ['-y', '@acme/mcp'], env: { ACME_TOKEN: 'secret' } }))
      .toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@acme/mcp'], env: { ACME_TOKEN: 'secret' } })
    expect(mcpCopyConfig('claude', { command: 'uvx', args: ['acme'] })).toEqual({ type: 'stdio', command: 'uvx', args: ['acme'], env: {} })
    expect(mcpCopyConfig('claude', { type: 'http', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer secret' } }))
      .toEqual({ type: 'http', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer secret' } })
  })

  it('reads Codex config.toml entries the same way, ignoring only the enabled flag', () => {
    expect(mcpCopyConfig('codex', { command: 'npx', args: ['-y', '@acme/mcp'], env: { ACME_TOKEN: 'secret' }, enabled: false }))
      .toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@acme/mcp'], env: { ACME_TOKEN: 'secret' } })
    expect(mcpCopyConfig('codex', { url: 'https://mcp.example.com', http_headers: { 'X-Api-Key': 'secret' } }))
      .toEqual({ type: 'http', url: 'https://mcp.example.com', headers: { 'X-Api-Key': 'secret' } })
    expect(mcpCopyConfig('codex', { url: 'https://mcp.example.com' })).toEqual({ type: 'http', url: 'https://mcp.example.com' })
  })

  // 别的工具没有同样写法的设置，搬过去会悄悄少一截：碰到就不搬，把是哪几项说出来。
  it('refuses settings the other tools cannot express instead of dropping them', () => {
    expect(() => mcpCopyConfig('codex', { url: 'https://mcp.example.com', bearer_token_env_var: 'ACME_TOKEN' }))
      .toThrow('这条连接用了星芒搬不过去的设置（bearer_token_env_var），请在要装的工具里手动添加。')
    expect(() => mcpCopyConfig('codex', { command: 'acme', cwd: '/srv', startup_timeout_sec: 30 })).toThrow('（cwd、startup_timeout_sec）')
    expect(() => mcpCopyConfig('claude', { type: 'sse', url: 'https://mcp.example.com/sse' })).toThrow('（type = sse）')
    expect(() => mcpCopyConfig('claude', { type: 'http', url: 'https://mcp.example.com', oauth: { clientId: 'x' } })).toThrow('（oauth）')
  })

  it('refuses values that only Claude Code would expand', () => {
    expect(() => mcpCopyConfig('claude', { command: 'acme', env: { TOKEN: '${ACME_TOKEN}' } })).toThrow('${…}')
    expect(() => mcpCopyConfig('claude', { type: 'http', url: 'https://${HOST}/mcp' })).toThrow('${…}')
    // Codex 不展开，照字面就是它自己在用的值。
    expect(mcpCopyConfig('codex', { command: 'acme', args: ['${literal}'] })).toEqual({ type: 'stdio', command: 'acme', args: ['${literal}'], env: {} })
  })

  it('says a connection is gone or malformed rather than carrying something half-read', () => {
    expect(() => mcpCopyConfig('claude', undefined)).toThrow('没有找到这个连接，请刷新列表后再试。')
    for (const entry of ['npx', { command: '' }, { command: 'acme', args: 'x' }, { command: 'acme', env: { 'BAD NAME': 'x' } }, { type: 'http', url: 'https://a', headers: { 'Bad Header': 'x' } }, { type: 'http', command: 'acme', url: 'https://a' }]) {
      expect(() => mcpCopyConfig('claude', entry), JSON.stringify(entry)).toThrow('这条连接的设置格式不对，星芒搬不过去，请在要装的工具里手动添加。')
    }
  })
})
