import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildClaudeDesktopGatewayConfig, createClaudeDesktopConfigService,
  type ClaudeDesktopGatewayInput, type ClaudeDesktopConfigOptions,
} from './claude-desktop-config'

const temporaryDirectories: string[] = []
const input: ClaudeDesktopGatewayInput = {
  baseUrl: 'https://xm.solov.cc', apiKey: 'sk-main-process-only', authScheme: 'x-api-key', models: ['claude-opus-5'],
}
const otherId = '00000000-0000-4000-8000-000000000001'

function write(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
function read(filePath: string): Record<string, unknown> { return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown> }
function fixture(overrides: Partial<ClaudeDesktopConfigOptions> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-claude-desktop-'))
  temporaryDirectories.push(directory)
  const dataDirectory = path.join(directory, 'toolbox')
  const profileDirectory = path.join(directory, 'local', 'Claude-3p')
  const developerDirectory = path.join(directory, 'roaming', 'Claude')
  const options = { dataDirectory, profileDirectory, developerDirectories: [developerDirectory], ...overrides }
  return {
    directory, dataDirectory, profileDirectory, developerDirectory, options,
    metadataPath: path.join(profileDirectory, 'configLibrary', '_meta.json'),
    configPath: path.join(profileDirectory, 'claude_desktop_config.json'),
    service: createClaudeDesktopConfigService(options),
  }
}
function markerPath(f: ReturnType<typeof fixture>): string {
  const directory = path.join(f.dataDirectory, 'external-clients', 'claude-desktop')
  return path.join(directory, fs.readdirSync(directory).find((file) => file.endsWith('.json'))!)
}
function snapshot(files: readonly string[]): Map<string, string> {
  return new Map(files.map((file) => [file, fs.readFileSync(file, 'utf8')]))
}
function expectSnapshot(previous: ReadonlyMap<string, string>): void {
  for (const [file, content] of previous) expect(fs.readFileSync(file, 'utf8'), file).toBe(content)
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('Claude Desktop in-app third-party configuration', () => {
  it('saves the native library, deployment mode and developer settings without exposing credentials', async () => {
    const f = fixture()
    expect(await f.service.inspectConnection(input.baseUrl)).toMatchObject({ configured: false, configurationReady: false, configurationSource: 'missing' })
    const result = await f.service.saveGateway(input)
    expect(result).toMatchObject({ mode: 'local', restartRequired: true, connectionVerified: false, backups: [] })
    expect(result.path).toContain(path.join('Claude-3p', 'configLibrary'))
    expect(read(result.path)).toEqual(buildClaudeDesktopGatewayConfig(input))
    const id = path.basename(result.path, '.json')
    expect(read(f.metadataPath)).toEqual({ appliedId: id, entries: [{ id, name: '星芒 AI' }] })
    expect(read(f.configPath)).toEqual({ deploymentMode: '3p' })
    for (const directory of [f.profileDirectory, f.developerDirectory]) expect(read(path.join(directory, 'developer_settings.json'))).toEqual({ allowDevTools: true })
    expect(read(markerPath(f))).toMatchObject({ version: 1, id })
    const status = await f.service.inspectConnection(input.baseUrl)
    expect(status).toEqual({ configured: true, configurationReady: true, model: 'claude-opus-5', configurationSource: 'xingmang', configurationError: null })
    expect(JSON.stringify({ result, status })).not.toContain(input.apiKey)
  })

  it('preserves user profiles, metadata and settings while applying a separate toolbox profile', async () => {
    const f = fixture()
    const otherPath = path.join(f.profileDirectory, 'configLibrary', `${otherId}.json`)
    write(otherPath, { privateSetting: 'keep', inferenceGatewayApiKey: 'user-private-key' })
    write(f.metadataPath, { entries: [{ id: otherId, name: 'Existing Gateway', custom: 17 }], appliedId: otherId, hybridPointer: { id: otherId }, custom: 'keep' })
    write(f.configPath, { deploymentMode: '1p', mcpServers: { example: { command: 'example' } }, preferences: { theme: 'dark' } })
    write(path.join(f.developerDirectory, 'developer_settings.json'), { allowDevTools: false, other: true })
    const previous = snapshot([f.metadataPath, f.configPath, path.join(f.developerDirectory, 'developer_settings.json')])
    const otherBefore = fs.readFileSync(otherPath, 'utf8')
    const result = await f.service.saveGateway(input)
    expect(result.path).not.toBe(otherPath)
    expect(fs.readFileSync(otherPath, 'utf8')).toBe(otherBefore)
    expect(read(f.metadataPath)).toMatchObject({ custom: 'keep', entries: [{ id: otherId, name: 'Existing Gateway', custom: 17 }, { name: '星芒 AI' }] })
    expect(read(f.metadataPath)).not.toHaveProperty('hybridPointer')
    expect(read(f.configPath)).toMatchObject({ deploymentMode: '3p', mcpServers: { example: { command: 'example' } }, preferences: { theme: 'dark' } })
    expect(read(path.join(f.developerDirectory, 'developer_settings.json'))).toEqual({ allowDevTools: true, other: true })
    expect(result.backups).toHaveLength(3)
    for (const [file, content] of previous) expect(fs.readFileSync(result.backups.find((backup) => backup.startsWith(`${file}.bak.`))!, 'utf8')).toBe(content)
  })

  it('reuses the toolbox profile and keeps its custom settings on subsequent saves', async () => {
    const f = fixture()
    const first = await f.service.saveGateway(input)
    write(first.path, { ...read(first.path), custom: { preserved: true }, inferenceGatewayAuthScheme: 'bearer' })
    const old = fs.readFileSync(first.path, 'utf8')
    const next = await f.service.saveGateway({ ...input, apiKey: 'sk-replacement', models: ['custom/opus'] })
    expect(next.path).toBe(first.path)
    expect(read(next.path)).toMatchObject({ inferenceGatewayApiKey: 'sk-replacement', inferenceGatewayAuthScheme: 'x-api-key', inferenceModels: ['custom/opus'], custom: { preserved: true } })
    expect(read(f.metadataPath).entries).toHaveLength(1)
    expect(next.backups).toHaveLength(1)
    expect(fs.readFileSync(next.backups[0], 'utf8')).toBe(old)
    expect(JSON.stringify(next)).not.toContain('sk-replacement')
    const identical = await f.service.saveGateway({ ...input, apiKey: 'sk-replacement', models: ['custom/opus'] })
    expect(identical.backups).toEqual([])
  })

  it('matches site and active account and reads object model entries', async () => {
    const f = fixture()
    const result = await f.service.saveGateway(input)
    write(result.path, { ...read(result.path), inferenceModels: [{ name: 'routed/opus', displayName: 'Opus' }] })
    expect(await f.service.inspectConnection(`${input.baseUrl}/`, (key) => key === input.apiKey)).toMatchObject({ configured: true, configurationReady: true, model: 'routed/opus' })
    expect(await f.service.inspectConnection('https://another.example')).toMatchObject({ configured: false, configurationReady: true, configurationSource: 'other' })
    expect(await f.service.inspectConnection(input.baseUrl, () => false)).toMatchObject({ configured: false, configurationReady: true, configurationSource: 'other' })
  })

  it('does not claim manually applied profiles belong to the toolbox without account evidence', async () => {
    const f = fixture()
    write(f.configPath, { deploymentMode: '3p' })
    write(f.metadataPath, { appliedId: otherId, entries: [{ id: otherId, name: 'Manual' }] })
    write(path.join(f.profileDirectory, 'configLibrary', `${otherId}.json`), buildClaudeDesktopGatewayConfig(input))
    expect(await f.service.inspectConnection(input.baseUrl)).toMatchObject({ configured: false, configurationReady: true, configurationSource: 'other' })
    expect(await f.service.inspectConnection(input.baseUrl, (key) => key === input.apiKey)).toMatchObject({ configured: true, configurationReady: true, configurationSource: 'xingmang' })
  })

  it('recognizes a manual Default profile with native model discovery and default authentication without changing it', async () => {
    const f = fixture()
    write(f.metadataPath, { appliedId: otherId, entries: [{ id: otherId, name: 'Default' }] })
    const gatewayPath = path.join(f.profileDirectory, 'configLibrary', `${otherId}.json`)
    write(gatewayPath, { inferenceProvider: 'gateway', inferenceGatewayBaseUrl: input.baseUrl, inferenceGatewayApiKey: input.apiKey })
    const previous = snapshot([f.metadataPath, gatewayPath])
    const status = await f.service.inspectConnection(input.baseUrl)
    expect(status).toEqual({ configured: false, configurationReady: true, model: null, configurationSource: 'other', configurationError: null })
    expect(await f.service.inspectConnection(input.baseUrl, (key) => key === input.apiKey)).toMatchObject({ configured: true, configurationReady: true, model: null, configurationSource: 'xingmang' })
    expect(await f.service.inspectConnection(input.baseUrl, () => false)).toMatchObject({ configured: false, configurationReady: true, configurationSource: 'other' })
    expect(JSON.stringify(status)).not.toContain(input.apiKey)
    expectSnapshot(previous)
    expect(fs.existsSync(f.dataDirectory)).toBe(false)
    expect(fs.existsSync(f.configPath)).toBe(false)
  })

  it.each(['1p', 'invalid-mode'])('does not report a gateway as ready when deployment mode is %s', async (deploymentMode) => {
    const f = fixture()
    await f.service.saveGateway(input)
    write(f.configPath, { deploymentMode })
    expect(await f.service.inspectConnection(input.baseUrl)).toMatchObject({ configured: false, configurationReady: false, configurationSource: 'other' })
  })

  it('recognizes the official defaults for deployment mode and static key credentials', async () => {
    const f = fixture()
    const result = await f.service.saveGateway(input)
    write(f.configPath, {})
    const config = read(result.path)
    delete config.inferenceCredentialKind
    write(result.path, config)
    expect(await f.service.inspectConnection(input.baseUrl)).toMatchObject({ configured: true, configurationReady: true, configurationSource: 'xingmang' })
  })

  it('reports a native empty default profile as missing configuration', async () => {
    const f = fixture()
    write(f.metadataPath, { appliedId: otherId, entries: [{ id: otherId, name: 'Default' }] })
    write(path.join(f.profileDirectory, 'configLibrary', `${otherId}.json`), {})
    expect(await f.service.inspectConnection(input.baseUrl)).toMatchObject({ configured: false, configurationReady: false, configurationSource: 'missing' })
    write(f.metadataPath, { ...read(f.metadataPath), hybridPointer: { orgUuid: otherId } })
    expect(await f.service.inspectConnection(input.baseUrl)).toMatchObject({ configured: false, configurationReady: false, configurationSource: 'other' })
  })

  it.each([{ bootstrapUrl: 'https://bootstrap.example' }, { selfHostedUrl: 'https://self-hosted.example' }, { selfHosted: true }])('does not report bootstrap or self-hosted profiles as static configuration', async (dynamic) => {
    const f = fixture()
    const result = await f.service.saveGateway(input)
    write(result.path, { ...read(result.path), ...dynamic })
    expect(await f.service.inspectConnection(input.baseUrl)).toMatchObject({ configured: false, configurationReady: false, configurationSource: 'other' })
  })

  it('ignores disabled bootstrap and removes stale dynamic settings only from the owned profile on save', async () => {
    const f = fixture()
    const result = await f.service.saveGateway(input)
    write(result.path, { ...read(result.path), bootstrapUrl: 'https://bootstrap.example', bootstrapEnabled: false, inferenceApiKeyHelper: '/private/helper', inferenceGatewayOidcClientId: 'old', selfHosted: false, custom: true })
    expect(await f.service.inspectConnection(input.baseUrl)).toMatchObject({ configured: true, configurationReady: true })
    await f.service.saveGateway(input)
    expect(read(result.path)).toEqual({ ...buildClaudeDesktopGatewayConfig(input), custom: true })
  })

  it.each(['helper', 'oidc', 'bootstrap'])('does not report dynamic %s credentials as static configuration', async (inferenceCredentialKind) => {
    const f = fixture()
    const result = await f.service.saveGateway(input)
    write(result.path, { ...read(result.path), inferenceCredentialKind })
    expect(await f.service.inspectConnection(input.baseUrl)).toMatchObject({ configured: false, configurationReady: false, configurationSource: 'other' })
  })

  it('does not report a hybrid configuration as the applied static profile', async () => {
    const f = fixture()
    await f.service.saveGateway(input)
    write(f.metadataPath, { ...read(f.metadataPath), hybridPointer: { provider: 'bootstrap' } })
    expect(await f.service.inspectConnection(input.baseUrl)).toMatchObject({ configured: false, configurationReady: false, configurationSource: 'other' })
  })

  it.each([
    { inferenceGatewayBaseUrl: undefined },
    { inferenceGatewayBaseUrl: '' },
    { inferenceGatewayBaseUrl: 'not-a-url' },
    { inferenceGatewayBaseUrl: 'http://gateway.example' },
    { inferenceGatewayBaseUrl: 'https://user:password@gateway.example' },
    { inferenceGatewayBaseUrl: 'https://gateway.example?key=secret' },
    { inferenceGatewayBaseUrl: 'https://gateway.example/#secret' },
    { inferenceGatewayBaseUrl: 'https://gateway.example\n/path' },
    { inferenceGatewayBaseUrl: 'file:///tmp/gateway' },
    { inferenceGatewayApiKey: undefined },
    { inferenceGatewayApiKey: '' },
    { inferenceGatewayApiKey: '  ' },
    { inferenceGatewayApiKey: 'sk-secret\nheader' },
    { inferenceGatewayAuthScheme: 'invalid' },
    { inferenceProvider: 'bedrock' },
    { inferenceModels: [{ id: 'invalid-model-field' }] },
  ])('does not report incomplete or invalid gateway settings as ready', async (patch) => {
    const f = fixture()
    write(f.metadataPath, { appliedId: otherId, entries: [{ id: otherId, name: 'Default' }] })
    const gatewayPath = path.join(f.profileDirectory, 'configLibrary', `${otherId}.json`)
    write(gatewayPath, { ...buildClaudeDesktopGatewayConfig(input), ...patch })
    const previous = snapshot([f.metadataPath, gatewayPath])
    expect(await f.service.inspectConnection(input.baseUrl, () => true)).toMatchObject({ configured: false, configurationReady: false, configurationSource: 'other' })
    expectSnapshot(previous)
  })

  it('keeps the documented flat gateway keys and exact model IDs', () => {
    expect(buildClaudeDesktopGatewayConfig({ ...input, models: ['alias/sonnet', 'alias/sonnet'] })).toEqual({
      inferenceProvider: 'gateway', inferenceGatewayBaseUrl: input.baseUrl, inferenceGatewayApiKey: input.apiKey,
      inferenceGatewayAuthScheme: 'x-api-key', inferenceCredentialKind: 'static', inferenceModels: ['alias/sonnet'],
    })
    expect(buildClaudeDesktopGatewayConfig({ ...input, baseUrl: 'https://gateway.example/v1', models: undefined, authScheme: undefined })).toMatchObject({ inferenceGatewayBaseUrl: 'https://gateway.example/v1', inferenceGatewayAuthScheme: 'bearer' })
    expect(buildClaudeDesktopGatewayConfig({ ...input, baseUrl: 'http://127.0.0.1:4000' }).inferenceGatewayBaseUrl).toBe('http://127.0.0.1:4000')
    expect(() => buildClaudeDesktopGatewayConfig({ ...input, apiKey: 'secret\nheader' })).toThrow('API Key')
    expect(() => buildClaudeDesktopGatewayConfig({ ...input, models: ['alias\nmodel'] })).toThrow('模型 ID')
  })

  it.each(['http://example.com', 'https://user:password@example.com', 'https://example.com?key=secret', 'file:///tmp/gateway', 'https://example.com/#secret'])('rejects unsafe gateway address %s before side effects', async (baseUrl) => {
    const assertUnmanaged = vi.fn(async () => undefined)
    const f = fixture({ assertUnmanaged })
    await expect(f.service.saveGateway({ ...input, baseUrl })).rejects.toThrow('配置')
    expect(assertUnmanaged).not.toHaveBeenCalled()
    expect(fs.readdirSync(f.directory)).toEqual([])
  })

  it.each([
    '{"entries":[],"entries":[]}',
    '{"entries":[],"appliedId":"../outside"}',
    '{"entries":[{"id":"../outside","name":"unsafe"}]}',
    JSON.stringify({ entries: [{ id: otherId, name: 'one' }, { id: otherId, name: 'two' }] }),
    JSON.stringify({ entries: [], appliedId: otherId }),
    '{"entries":[],}',
    '{"entries":[] /* comment */}',
    '[]',
  ])('rejects malformed or ambiguous library metadata without overwriting it', async (content) => {
    const f = fixture()
    fs.mkdirSync(path.dirname(f.metadataPath), { recursive: true })
    fs.writeFileSync(f.metadataPath, content, 'utf8')
    await expect(f.service.saveGateway(input)).rejects.toThrow('配置')
    expect(fs.readFileSync(f.metadataPath, 'utf8')).toBe(content)
    expect(fs.existsSync(f.configPath)).toBe(false)
    expect(await f.service.inspectConnection(input.baseUrl)).toMatchObject({ configured: false, configurationReady: false, configurationSource: 'unknown' })
  })

  it('rejects malformed settings before creating the gateway and redacts parser failures', async () => {
    const f = fixture()
    fs.mkdirSync(f.profileDirectory, { recursive: true })
    fs.writeFileSync(f.configPath, '{"inferenceGatewayApiKey":"sk-do-not-echo",oops}', 'utf8')
    let message = ''
    try { await f.service.saveGateway(input) } catch (error) { message = (error as Error).message }
    expect(message).toContain('有效 JSON')
    expect(message).not.toContain('sk-do-not-echo')
    expect(fs.existsSync(path.dirname(f.metadataPath))).toBe(false)
  })

  it('rejects oversized JSON and invalid ownership records', async () => {
    const f = fixture()
    await f.service.saveGateway(input)
    const marker = markerPath(f)
    write(marker, { ...read(marker), id: '../outside' })
    await expect(f.service.saveGateway(input)).rejects.toThrow('归属记录无效')
    fs.writeFileSync(f.metadataPath, ' '.repeat(512 * 1024 + 1), 'utf8')
    await expect(f.service.saveGateway(input)).rejects.toThrow('安全上限')
  })

  it('stops when a policy appears after reads and leaves all files unchanged', async () => {
    const guard = vi.fn(async () => undefined)
    const f = fixture({ assertUnmanaged: guard })
    const result = await f.service.saveGateway(input)
    const previous = snapshot(result.files)
    guard.mockReset().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('存在管理策略'))
    await expect(f.service.saveGateway({ ...input, apiKey: 'sk-new' })).rejects.toThrow('管理策略')
    expectSnapshot(previous)
    guard.mockRejectedValue(new Error('policy sk-do-not-echo'))
    const status = await f.service.inspectConnection(input.baseUrl)
    expect(status).toMatchObject({ configured: false, configurationReady: false, configurationSource: 'unknown' })
    expect(JSON.stringify(status)).not.toContain('sk-do-not-echo')
  })

  it.each([1, 2])('checks account changes after asynchronous guard %s', async (guardIndex) => {
    let active = true
    let calls = 0
    const f = fixture({
      assertBeforeWrite: () => { if (!active) throw new Error('sk-do-not-echo') },
      assertUnmanaged: async () => { if (++calls === guardIndex) active = false },
    })
    await expect(f.service.saveGateway(input)).rejects.toThrow('账号或站点已切换')
    expect(fs.readdirSync(f.directory)).toEqual([])
  })

  it('rejects a configuration edited during the final policy check', async () => {
    const guard = vi.fn(async () => undefined)
    const f = fixture({ assertUnmanaged: guard })
    const result = await f.service.saveGateway(input)
    const gatewayBefore = fs.readFileSync(result.path, 'utf8')
    guard.mockReset().mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { write(f.configPath, { deploymentMode: '1p', concurrent: true }) })
    await expect(f.service.saveGateway({ ...input, apiKey: 'sk-new' })).rejects.toThrow('未完成')
    expect(read(f.configPath)).toEqual({ deploymentMode: '1p', concurrent: true })
    expect(fs.readFileSync(result.path, 'utf8')).toBe(gatewayBefore)
  })

  it('rolls back all committed files when a later rename fails, retaining backups', async () => {
    const f = fixture()
    const result = await f.service.saveGateway(input)
    write(f.configPath, { ...read(f.configPath), deploymentMode: '1p' })
    const previous = snapshot(result.files)
    const rename = fs.renameSync.bind(fs)
    let writes = 0
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (++writes === 2) throw new Error('rename failure sk-do-not-echo')
      rename(source, target)
    })
    await expect(f.service.saveGateway({ ...input, apiKey: 'sk-new' })).rejects.toThrow('原配置已保留或恢复')
    expectSnapshot(previous)
    expect(fs.readdirSync(path.dirname(result.path)).some((file) => file.includes('.bak.'))).toBe(true)
    expect(fs.readdirSync(path.dirname(result.path)).some((file) => file.endsWith('.tmp'))).toBe(false)
  })

  it('rolls back newly created profiles and settings if metadata cannot be committed', async () => {
    const f = fixture()
    const rename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (target === f.metadataPath) throw new Error('blocked')
      rename(source, target)
    })
    await expect(f.service.saveGateway(input)).rejects.toThrow('原配置已保留或恢复')
    expect(fs.readdirSync(path.dirname(f.metadataPath))).toEqual([])
    expect(fs.existsSync(f.configPath)).toBe(false)
    expect(fs.existsSync(path.join(f.developerDirectory, 'developer_settings.json'))).toBe(false)
  })

  it('preserves concurrent replacements instead of overwriting them during rollback', async () => {
    const f = fixture()
    const result = await f.service.saveGateway(input)
    write(f.configPath, { deploymentMode: '1p' })
    const rename = fs.renameSync.bind(fs)
    let writes = 0
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      rename(source, target)
      if (++writes === 1) write(result.path, { concurrent: 'replacement' })
    })
    await expect(f.service.saveGateway({ ...input, apiKey: 'sk-new' })).rejects.toThrow('未覆盖外部改动')
    expect(read(result.path)).toEqual({ concurrent: 'replacement' })
    expect(read(f.configPath)).toEqual({ deploymentMode: '1p' })
  })

  it('cleans partially written staged files without changing any target', async () => {
    const f = fixture()
    const writeFile = fs.writeFileSync.bind(fs)
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      writeFile(file, data, options)
      throw new Error('disk failure sk-do-not-echo')
    })
    await expect(f.service.saveGateway(input)).rejects.toThrow('原配置已保留或恢复')
    expect(fs.readdirSync(path.dirname(f.metadataPath))).toEqual([])
  })

  it('refuses hard-linked settings files', async () => {
    const f = fixture()
    const target = path.join(f.directory, 'outside.json')
    write(target, { keep: true })
    fs.mkdirSync(f.profileDirectory, { recursive: true })
    fs.linkSync(target, f.configPath)
    await expect(f.service.saveGateway(input)).rejects.toThrow('单链接普通文件')
    expect(read(target)).toEqual({ keep: true })
  })

  it('rejects a junction before writing credentials', async () => {
    const f = fixture()
    const destination = path.join(f.directory, 'outside')
    fs.mkdirSync(destination)
    fs.mkdirSync(path.dirname(f.profileDirectory), { recursive: true })
    fs.symlinkSync(destination, f.profileDirectory, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(f.service.saveGateway(input)).rejects.toThrow('符号链接或目录联接')
    expect(fs.readdirSync(destination)).toEqual([])
  })

  it('rejects relative directories and deduplicates repeated developer profiles', async () => {
    const f = fixture()
    expect(() => createClaudeDesktopConfigService({ ...f.options, profileDirectory: 'relative' })).toThrow('绝对路径')
    const service = createClaudeDesktopConfigService({ ...f.options, developerDirectories: [f.profileDirectory, f.profileDirectory, f.developerDirectory] })
    const result = await service.saveGateway(input)
    expect(new Set(result.files).size).toBe(result.files.length)
  })
})
