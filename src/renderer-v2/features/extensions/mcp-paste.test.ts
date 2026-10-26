import { describe, expect, it } from 'vitest'
import {
  mcpHeaderLines,
  mcpNameFrom,
  mcpPasteChoiceLabel,
  mcpPasteNotice,
  mcpPastePlaceholders,
  parseMcpPaste,
  splitCommandLine,
  type McpPasteResult,
} from './mcp-paste'

function servers(result: McpPasteResult) {
  if (result.status !== 'ok') throw new Error(`expected servers, got ${JSON.stringify(result)}`)
  return result.servers
}

describe('parseMcpPaste', () => {
  it('reads the mcpServers block most providers hand out, keeping each server name', () => {
    const result = parseMcpPaste(`{
      "mcpServers": {
        "amap-maps": {
          "command": "npx",
          "args": ["-y", "@amap/amap-maps-mcp-server"],
          "env": { "AMAP_MAPS_API_KEY": "abc123" }
        },
        "github": {
          "type": "http",
          "url": "https://api.githubcopilot.com/mcp/",
          "headers": { "Authorization": "Bearer ghp_real" }
        }
      }
    }`)
    expect(servers(result)).toEqual([
      {
        name: 'amap-maps',
        config: { type: 'stdio', command: 'npx', args: ['-y', '@amap/amap-maps-mcp-server'], env: { AMAP_MAPS_API_KEY: 'abc123' } },
        problem: null,
      },
      {
        name: 'github',
        config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ghp_real' } },
        problem: null,
      },
    ])
  })

  it('accepts comments, trailing commas, curly quotes and a fragment without the outer braces', () => {
    const commented = parseMcpPaste('{\n  // 复制自说明\n  "servers": { "docs": { "url": "https://docs.example.com/mcp", }, },\n}')
    expect(servers(commented)[0]?.config).toEqual({ type: 'http', url: 'https://docs.example.com/mcp', headers: {} })
    const curly = parseMcpPaste('{ \u201Cfetch\u201D: { \u201Ccommand\u201D: \u201Cuvx\u201D, \u201Cargs\u201D: [\u201Cmcp-server-fetch\u201D] } }')
    expect(servers(curly)).toEqual([
      { name: 'fetch', config: { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'], env: {} }, problem: null },
    ])
    const fragment = parseMcpPaste('"memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] }')
    expect(servers(fragment)[0]?.name).toBe('memory')
  })

  it('reads a single server on its own, the VS Code, OpenCode and Zed layouts', () => {
    expect(servers(parseMcpPaste('{ "command": "npx", "args": ["-y", "@upstash/context7-mcp@1.0.0"] }'))).toEqual([
      { name: 'context7-mcp', config: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp@1.0.0'], env: {} }, problem: null },
    ])
    expect(servers(parseMcpPaste('{ "mcp": { "servers": { "time": { "type": "stdio", "command": "uvx", "args": ["mcp-server-time"] } } } }'))[0]?.name)
      .toBe('time')
    expect(servers(parseMcpPaste(JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        local: { type: 'local', command: ['npx', '-y', 'demo-server'], environment: { TOKEN: 't' }, enabled: true },
        remote: { type: 'remote', url: 'https://mcp.example.com/mcp', headers: { 'X-Key': 'k' } },
      },
    })))).toEqual([
      { name: 'local', config: { type: 'stdio', command: 'npx', args: ['-y', 'demo-server'], env: { TOKEN: 't' } }, problem: null },
      { name: 'remote', config: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { 'X-Key': 'k' } }, problem: null },
    ])
    expect(servers(parseMcpPaste('{ "context_servers": { "zed": { "command": { "path": "node", "args": ["server.js"], "env": {} } } } }'))[0]?.config)
      .toEqual({ type: 'stdio', command: 'node', args: ['server.js'], env: {} })
  })

  it('reads the Codex and Grok TOML tables, headers included', () => {
    const result = parseMcpPaste([
      '# Codex',
      '[mcp_servers.context7]',
      'command = "npx"',
      'args = [',
      '  "-y", # 包名',
      '  "@upstash/context7-mcp",',
      ']',
      'env = { "CONTEXT7_API_KEY" = "ctx-1" }',
      '',
      '[mcp_servers.figma]',
      'url = \'https://mcp.figma.com/mcp\'',
      'bearer_token_env_var = "FIGMA_TOKEN"',
      '',
      '[mcp_servers.figma.http_headers]',
      '"X-Figma-Region" = "us-east-1"',
      '',
      '[mcp_servers.grok_remote]',
      'url = "https://grok.example.com/mcp"',
      'enabled = true',
      '[mcp_servers.grok_remote.headers]',
      'Authorization = "Bearer \\u0041BC"',
    ].join('\n'))
    expect(servers(result)).toEqual([
      { name: 'context7', config: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: { CONTEXT7_API_KEY: 'ctx-1' } }, problem: null },
      { name: 'figma', config: { type: 'http', url: 'https://mcp.figma.com/mcp', headers: { 'X-Figma-Region': 'us-east-1' }, bearerTokenEnvVar: 'FIGMA_TOKEN' }, problem: null },
      { name: 'grok_remote', config: { type: 'http', url: 'https://grok.example.com/mcp', headers: { Authorization: 'Bearer ABC' } }, problem: null },
    ])
  })

  it('gives up on TOML it does not fully understand instead of guessing', () => {
    for (const text of [
      '[mcp_servers.a]\ncommand = """npx"""',
      '[[mcp_servers.a]]\ncommand = "npx"',
      '[mcp_servers.a]\ncommand = "npx" args = []',
      '[mcp_servers.a]\nstarted = 1979-05-27',
      '[mcp_servers.a]\ncommand = "npx"\ncommand = "uvx"',
    ]) {
      expect(parseMcpPaste(text)).toMatchObject({ status: 'failed', problem: expect.stringContaining('原样复制过来') })
    }
  })

  it('reads the claude / codex / grok `mcp add` lines from their docs', () => {
    expect(servers(parseMcpPaste('claude mcp add --transport http notion https://mcp.notion.com/mcp'))).toEqual([
      { name: 'notion', config: { type: 'http', url: 'https://mcp.notion.com/mcp', headers: {} }, problem: null },
    ])
    expect(servers(parseMcpPaste(
      'claude mcp add --transport http corridor https://app.corridor.dev/api/mcp --header "Authorization: Bearer abc" "X-Team: one"',
    ))[0]?.config).toEqual({ type: 'http', url: 'https://app.corridor.dev/api/mcp', headers: { Authorization: 'Bearer abc', 'X-Team': 'one' } })
    expect(servers(parseMcpPaste('claude mcp add my-server -e API_KEY=xxx-1 --scope user -- npx -y my-mcp-server'))[0]).toEqual({
      name: 'my-server', config: { type: 'stdio', command: 'npx', args: ['-y', 'my-mcp-server'], env: { API_KEY: 'xxx-1' } }, problem: null,
    })
    expect(servers(parseMcpPaste('codex mcp add context7 --env TOKEN=t -- npx -y @upstash/context7-mcp'))[0]?.config)
      .toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: { TOKEN: 't' } })
    expect(servers(parseMcpPaste('codex mcp add figma --url https://mcp.figma.com/mcp --bearer-token-env-var FIGMA_TOKEN'))[0]?.config)
      .toEqual({ type: 'http', url: 'https://mcp.figma.com/mcp', headers: {}, bearerTokenEnvVar: 'FIGMA_TOKEN' })
    expect(servers(parseMcpPaste('grok mcp add -H "X-Api-Key: k" docs https://docs.example.com/mcp'))[0]?.config)
      .toEqual({ type: 'http', url: 'https://docs.example.com/mcp', headers: { 'X-Api-Key': 'k' } })
    // 文档里拆成几行、带提示符的写法。
    expect(servers(parseMcpPaste('$ claude mcp add airtable \\\n  --env AIRTABLE_API_KEY=key \\\n  -- npx -y airtable-mcp-server'))[0]?.config)
      .toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'airtable-mcp-server'], env: { AIRTABLE_API_KEY: 'key' } })
    expect(servers(parseMcpPaste('claude mcp add-json weather \'{"type":"stdio","command":"/path/to/weather-cli","args":["--api-key","abc"]}\''))[0])
      .toEqual({ name: 'weather', config: { type: 'stdio', command: '/path/to/weather-cli', args: ['--api-key', 'abc'], env: {} }, problem: null })
  })

  it('reads a bare start command or address and suggests a name for it', () => {
    expect(servers(parseMcpPaste('npx -y @modelcontextprotocol/server-filesystem@2026.8.31 "D:\\My Projects"'))).toEqual([
      {
        name: 'server-filesystem',
        config: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@2026.8.31', 'D:\\My Projects'], env: {} },
        problem: null,
      },
    ])
    expect(servers(parseMcpPaste('GITHUB_TOKEN=t docker run -i --rm -e GITHUB_TOKEN ghcr.io/github/github-mcp-server:latest'))[0]).toMatchObject({
      name: 'github-mcp-server',
      config: { command: 'docker', env: { GITHUB_TOKEN: 't' } },
    })
    expect(servers(parseMcpPaste('https://mcp.amap.com/mcp?key=abc'))).toEqual([
      { name: 'amap', config: { type: 'http', url: 'https://mcp.amap.com/mcp?key=abc', headers: {} }, problem: null },
    ])
    expect(servers(parseMcpPaste('C:\\tools\\my-server.exe --stdio'))[0]?.name).toBe('my-server')
  })

  it('splits a whole command line written into "command" when there are no arguments', () => {
    expect(servers(parseMcpPaste('{ "x": { "command": "npx -y @acme/tool" } }'))[0]?.config)
      .toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@acme/tool'], env: {} })
    // 带路径的是一个程序，空格是路径的一部分。
    expect(servers(parseMcpPaste('{ "x": { "command": "C:\\\\Program Files\\\\tool\\\\server.exe" } }'))[0]?.config)
      .toEqual({ type: 'stdio', command: 'C:\\Program Files\\tool\\server.exe', args: [], env: {} })
  })

  it('cleans up names the tools would refuse and falls back to a suggestion', () => {
    const result = parseMcpPaste('{ "mcpServers": { "my.server v2": { "url": "https://a.example.com/mcp" }, "高德地图": { "url": "https://mcp.amap.com/mcp" } } }')
    expect(servers(result).map((server) => server.name)).toEqual(['my-server-v2', 'amap'])
    expect(mcpNameFrom('--a__b--')).toBe('a__b')
    expect(mcpNameFrom('x'.repeat(50))).toHaveLength(40)
  })

  it('says why a server cannot be added: SSE, other transports, missing parts, bad formats', () => {
    const result = parseMcpPaste(JSON.stringify({
      mcpServers: {
        old: { type: 'sse', url: 'https://mcp.example.com/sse' },
        guessed: { url: 'https://mcp.example.com/sse' },
        socket: { type: 'websocket', url: 'wss://mcp.example.com' },
        empty: { type: 'stdio' },
        args: { command: 'npx', args: [{ bad: true }] },
        env: { command: 'npx', env: { 'BAD-NAME': 'x' } },
        headers: { url: 'https://mcp.example.com/mcp', headers: { 'Bad Name': 'x' } },
        scheme: { url: 'ftp://mcp.example.com' },
      },
    }))
    expect(servers(result).map((server) => [server.name, server.config, server.problem])).toEqual([
      ['old', null, expect.stringContaining('SSE')],
      ['guessed', null, expect.stringContaining('SSE')],
      ['socket', null, '它用的连接方式这里加不了，换提供方给的其他写法试试。'],
      ['empty', null, '这一段里没找到启动命令或服务地址。'],
      ['args', null, expect.stringContaining('附加参数格式不对')],
      ['env', null, expect.stringContaining('附加设置格式不对')],
      ['headers', null, expect.stringContaining('请求头格式不对')],
      ['scheme', null, '服务地址要以 http:// 或 https:// 开头'],
    ])
    expect(servers(parseMcpPaste('claude mcp add --transport sse asana https://mcp.asana.com/sse'))[0]?.problem).toContain('SSE')
    expect(servers(parseMcpPaste('https://mcp.example.com/sse'))[0]?.problem).toContain('SSE')
  })

  it('fails in plain words when nothing usable is in the paste', () => {
    expect(parseMcpPaste('   ')).toEqual({ status: 'empty' })
    for (const text of ['随便写的一句话', 'hello world', '{ "mcpServers": ', 'npx "unterminated', 'line one\nline two']) {
      expect(parseMcpPaste(text)).toMatchObject({ status: 'failed', problem: expect.stringContaining('原样复制过来') })
    }
    expect(parseMcpPaste('{ "theme": "dark" }')).toEqual({
      status: 'failed',
      problem: '这段里没找到启动命令或服务地址，可能少复制了一部分，对照提供方说明再看看。',
    })
  })
})

describe('splitCommandLine', () => {
  it('keeps quoted spaces and Windows backslashes, and rejects an unclosed quote', () => {
    expect(splitCommandLine('node "C:\\My Tools\\a.js" \'x y\' "say \\"hi\\""')).toEqual(['node', 'C:\\My Tools\\a.js', 'x y', 'say "hi"'])
    expect(splitCommandLine('a "" b')).toEqual(['a', '', 'b'])
    expect(splitCommandLine('npx "oops')).toBeNull()
  })
})

describe('mcpPastePlaceholders', () => {
  it('names the settings and headers still holding example text', () => {
    expect(mcpPastePlaceholders({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg', '/path/to/allowed/files'],
      env: { AMAP_MAPS_API_KEY: '您在高德官网上申请的key', EMPTY: '', REAL: 'f3a9c1', TOKEN: '<YOUR_TOKEN>' },
    })).toEqual(['AMAP_MAPS_API_KEY', 'EMPTY', 'TOKEN', '附加参数'])
    expect(mcpPastePlaceholders({
      type: 'http',
      url: 'https://mcp.amap.com/mcp?key=YOUR_API_KEY',
      headers: { Authorization: 'Bearer ${input:github_token}', 'X-Key': 'sk-xxxx', 'X-Real': 'sk-9fa1' },
    })).toEqual(['服务地址', 'Authorization', 'X-Key'])
    expect(mcpPastePlaceholders({ type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ghp_real' } })).toEqual([])
  })
})

describe('mcpPasteNotice', () => {
  it('says what was found, what still needs the customer, and how to add the rest of a multi-server paste', () => {
    expect(mcpPasteNotice({ status: 'empty' }, 0)).toBeNull()
    expect(mcpPasteNotice(parseMcpPaste('hello world'), 0)).toMatchObject({ tone: 'warn', title: '没认出这段配置' })
    expect(mcpPasteNotice(parseMcpPaste('{ "command": "npx", "args": ["-y", "@acme/tool"] }'), 0)).toEqual({
      tone: 'ok',
      title: '认出来了：本地程序「tool」',
      body: '下面几项已经替你填好，看一眼再点「添加」。',
    })
    const pair = parseMcpPaste('{ "mcpServers": { "a": { "url": "https://a.example.com/mcp", "headers": { "Authorization": "Bearer <token>" } }, "b": { "type": "sse", "url": "https://b.example.com/sse" } } }')
    expect(mcpPasteNotice(pair, 0)).toEqual({
      tone: 'warn',
      title: '认出来了：网络服务「a」',
      body: '下面几项已经替你填好。Authorization 看起来还是说明里的示例文字，换成你自己的再点「添加」。一次加一个，加好以后再粘贴同一段，选下一个。',
    })
    expect(mcpPasteNotice(pair, 1)).toMatchObject({ tone: 'warn', title: '「b」加不了' })
  })

  it('labels unnamed servers by position and writes headers one per line', () => {
    expect(mcpPasteChoiceLabel({ name: '', config: null, problem: 'x' }, 2)).toBe('第 3 个')
    expect(mcpHeaderLines({ Authorization: 'Bearer a', 'X-Region': 'cn' })).toBe('Authorization: Bearer a\nX-Region: cn')
  })
})
