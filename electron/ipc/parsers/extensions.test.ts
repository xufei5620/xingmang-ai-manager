import { describe, expect, it } from 'vitest'
import { parseMarketplaceInput, parseMcpInput, parseProviderExtensionMutation, parseSkillInput } from './extensions'

describe('parseSkillInput', () => {
  it('trims the folder and keeps the scope', () => {
    expect(parseSkillInput({ sourcePath: '  /home/user/skills/demo  ', scope: 'user' }))
      .toEqual({ sourcePath: '/home/user/skills/demo', scope: 'user' })
  })

  it('rejects a path with a NUL byte or longer than Windows allows', () => {
    for (const sourcePath of ['/home/user/skills\0/etc', 'a'.repeat(32_768), '', 42]) {
      expect(() => parseSkillInput({ sourcePath })).toThrow('Skill 路径格式错误')
    }
  })

  it('rejects an unknown scope', () => {
    expect(() => parseSkillInput({ sourcePath: '/home/user/skills/demo', scope: 'system' })).toThrow('Skill 范围格式错误')
  })
})

describe('parseMcpInput', () => {
  it('keeps a stdio command and its arguments as separate strings', () => {
    expect(parseMcpInput({ type: 'stdio', name: 'demo', command: 'npx', args: ['-y', 'a&calc.exe'], env: { TOKEN: 'x' } }))
      .toEqual({ type: 'stdio', name: 'demo', command: 'npx', args: ['-y', 'a&calc.exe'], env: { TOKEN: 'x' } })
  })

  it('rejects a NUL byte in the command, arguments or address', () => {
    expect(() => parseMcpInput({ type: 'stdio', name: 'demo', command: 'npx\0calc' })).toThrow('MCP 命令格式错误')
    expect(() => parseMcpInput({ type: 'stdio', name: 'demo', command: 'npx', args: ['ok', 'bad\0'] })).toThrow('MCP 参数格式错误')
    expect(() => parseMcpInput({ type: 'http', name: 'demo', url: 'https://example.invalid/\0' })).toThrow('MCP 地址格式错误')
  })

  it('rejects environment values that are not strings and too many variables', () => {
    expect(() => parseMcpInput({ type: 'stdio', name: 'demo', command: 'npx', env: { TOKEN: 1 } })).toThrow('MCP 环境变量格式错误')
    const env = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`K${index}`, 'v']))
    expect(() => parseMcpInput({ type: 'stdio', name: 'demo', command: 'npx', env })).toThrow('MCP 环境变量数量过多')
  })
})

// 表单 F10-a：附加参数照提供方说明原样交给工具，"" 占位和首尾空格都是参数的一部分。
describe('MCP arguments', () => {
  function addArgs(args: unknown): unknown {
    const parsed = parseMcpInput({ type: 'stdio', name: 'demo', command: 'npx', args })
    return parsed.type === 'stdio' ? parsed.args : undefined
  }
  function installArgs(args: unknown): unknown {
    const parsed = parseProviderExtensionMutation({
      provider: 'claude', kind: 'mcp', action: 'install', id: 'demo', mcp: { type: 'stdio', command: 'npx', args },
    })
    return parsed.mcp?.type === 'stdio' ? parsed.mcp.args : undefined
  }

  it('keeps empty and space-padded arguments exactly as given', () => {
    for (const parse of [addArgs, installArgs]) {
      expect(parse(['-y', 'pkg', ''])).toEqual(['-y', 'pkg', ''])
      expect(parse([' x ', '  ', '\tvalue\n'])).toEqual([' x ', '  ', '\tvalue\n'])
      expect(parse(undefined)).toEqual([])
    }
  })

  it('still rejects non-strings, NUL bytes, overlong arguments and too many arguments', () => {
    for (const parse of [addArgs, installArgs]) {
      expect(parse(['a'.repeat(4_096)])).toEqual(['a'.repeat(4_096)])
      expect(parse(Array.from({ length: 128 }, () => ''))).toHaveLength(128)
      for (const bad of [['ok', 42], ['ok', null], ['bad\0'], ['a'.repeat(4_097)], Array.from({ length: 129 }, () => 'x'), 'x', null, {}]) {
        expect(() => parse(bad)).toThrow('MCP 参数格式错误')
      }
    }
  })

  it('leaves marketplace sparse paths trimmed and non-empty', () => {
    expect(parseMarketplaceInput({ source: 'owner/repo', sparse: [' plugins/a '] }).sparse).toEqual(['plugins/a'])
    expect(() => parseMarketplaceInput({ source: 'owner/repo', sparse: [''] })).toThrow('Sparse 路径格式错误')
  })
})

describe('MCP request headers', () => {
  it('keeps valid headers trimmed and leaves the field out when there are none', () => {
    expect(parseMcpInput({ type: 'http', name: 'demo', url: 'https://example.test/mcp', headers: { Authorization: ' Bearer x ' } }))
      .toMatchObject({ headers: { Authorization: 'Bearer x' } })
    expect(parseMcpInput({ type: 'http', name: 'demo', url: 'https://example.test/mcp', headers: {} })).not.toHaveProperty('headers')
    expect(parseProviderExtensionMutation({
      provider: 'grok', kind: 'mcp', action: 'install', id: 'demo',
      mcp: { type: 'http', url: 'https://example.test/mcp', headers: { 'X-Api-Key': 'k' } },
    }).mcp).toEqual({ type: 'http', url: 'https://example.test/mcp', headers: { 'X-Api-Key': 'k' } })
    expect(parseProviderExtensionMutation({
      provider: 'grok', kind: 'mcp', action: 'install', id: 'demo', mcp: { type: 'http', url: 'https://example.test/mcp' },
    }).mcp).toEqual({ type: 'http', url: 'https://example.test/mcp' })
  })

  it('rejects headers that are not plain one-line text under a token name', () => {
    for (const headers of [['Authorization: x'], { Authorization: 1 }, { Authorization: 'a\nb' }, { '-H': 'x' }, { 'A B': 'x' }, 'x']) {
      expect(() => parseMcpInput({ type: 'http', name: 'demo', url: 'https://example.test/mcp', headers })).toThrow('MCP 请求头格式错误')
      expect(() => parseProviderExtensionMutation({
        provider: 'claude', kind: 'mcp', action: 'install', id: 'demo', mcp: { type: 'http', url: 'https://example.test/mcp', headers },
      })).toThrow('MCP 请求头格式错误')
    }
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`X-${index}`, 'v']))
    expect(() => parseMcpInput({ type: 'http', name: 'demo', url: 'https://example.test/mcp', headers: many })).toThrow('MCP 请求头数量过多')
  })
})

describe('parseProviderExtensionMutation', () => {
  it('passes trust only for a literal true', () => {
    expect(parseProviderExtensionMutation({ provider: 'claude', kind: 'plugin', action: 'install', id: 'demo', trust: true }))
      .toMatchObject({ trust: true })
    expect(parseProviderExtensionMutation({ provider: 'claude', kind: 'plugin', action: 'install', id: 'demo', trust: false }))
      .not.toHaveProperty('trust')
    for (const trust of ['true', 1]) {
      expect(() => parseProviderExtensionMutation({ provider: 'claude', kind: 'plugin', action: 'install', trust })).toThrow('扩展操作格式错误')
    }
  })

  it('rejects a retired tool', () => {
    expect(() => parseProviderExtensionMutation({ provider: 'gemini', kind: 'mcp', action: 'install' })).toThrow('扩展操作格式错误')
  })
})
