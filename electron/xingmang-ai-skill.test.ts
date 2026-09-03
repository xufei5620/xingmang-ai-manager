import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as TOML from '@iarna/toml'
import { IMAGE_SKILL_GROUP_NAMES } from './ai-chat-protocol'
import { managedCliKeyProfiles } from './catalog'
import type { RelayBackendClient } from './relay-backend'
import {
  XINGMANG_AI_CONFIG_FILE,
  XINGMANG_AI_MANAGED_MANIFEST_FILE,
  XINGMANG_AI_DEFAULT_BASE_URL,
  XINGMANG_AI_SKILL_DIRECTORY,
  XINGMANG_AI_SKILL_KEY_NAME,
  applyXingmangAiSkillEnabledFlag,
  assertBundledXingmangAiSkill,
  buildXingmangAiSkillConfig,
  clearXingmangAiSkillSecrets,
  parseXingmangAiSkillConfig,
  publicXingmangAiSkillConfig,
  installXingmangAiSkillFiles,
  resolveXingmangAiBundledSkillRoot,
  resolveXingmangAiCodexSkillPath,
  resolveXingmangAiSkillDirectories,
  selectImageSkillGroup,
  syncXingmangAiSkill,
  syncXingmangAiSkillCodexAvailability,
} from './xingmang-ai-skill'

const bundledRoot = resolveXingmangAiBundledSkillRoot(path.resolve(__dirname, '..'))
const temporaryRoots: string[] = []

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xingmang-ai-skill-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function loggedInAccount(options: {
  groups?: Array<{ name: string }>
  provision?: ReturnType<typeof vi.fn>
} = {}) {
  const provisionCliKey = options.provision ?? vi.fn(async (input: { name?: string; group?: string } = {}) => {
    const image = input.name === XINGMANG_AI_SKILL_KEY_NAME
      || input.group === IMAGE_SKILL_GROUP_NAMES[0]
      || input.group === '生图分组'
    return {
      id: image ? 42 : 7,
      name: input.name ?? 'generated',
      key: image ? 'sk-test-image-group-secret-12345678' : 'sk-test-codex-group-secret-12345678',
    }
  })
  return {
    accountService: {
      getSessionState: vi.fn(() => ({ authenticated: true, account: { userId: 9 } })),
      listUsableGroups: vi.fn(async () => options.groups ?? [
        { name: 'GPT-中转/订阅' },
        { name: IMAGE_SKILL_GROUP_NAMES[0] },
      ]),
      provisionCliKey,
    } as unknown as Pick<RelayBackendClient, 'getSessionState' | 'listUsableGroups' | 'provisionCliKey'>,
    provisionCliKey,
  }
}

async function readInstalledConfig(userHome: string, rootIndex = 0): Promise<string> {
  const directory = resolveXingmangAiSkillDirectories(userHome)[rootIndex]
  return readFile(path.join(directory, XINGMANG_AI_CONFIG_FILE), 'utf8')
}

async function seedOptionalToolHomes(userHome: string): Promise<void> {
  await mkdir(path.join(userHome, '.claude'), { recursive: true })
  await mkdir(path.join(userHome, '.grok'), { recursive: true })
}

describe('xingmang-ai-skill', () => {
  it('prefers the current image group name over the legacy alias', () => {
    expect(selectImageSkillGroup([
      { name: '生图分组' },
      { name: '图片模型-中转/订阅' },
    ])).toBe('图片模型-中转/订阅')
  })

  it('falls back to the legacy image group when that is the only usable one', () => {
    expect(selectImageSkillGroup([{ name: '生图分组' }])).toBe('生图分组')
  })

  it('returns null when the account cannot use any image group', () => {
    expect(selectImageSkillGroup([{ name: 'GPT-中转/订阅' }])).toBeNull()
  })

  it('accepts the openai alias used by older image groups', () => {
    expect(selectImageSkillGroup([{ name: 'openai' }])).toBe('openai')
  })

  it('matches a renamed 图片中转 group without treating video groups as image groups', () => {
    expect(selectImageSkillGroup([
      { name: '视频模型-中转/订阅' },
      { name: '图片模型中转' },
    ])).toBe('图片模型中转')
  })

  it('omits both API keys from the renderer-safe config view', () => {
    const config = parseXingmangAiSkillConfig({
      baseUrl: XINGMANG_AI_DEFAULT_BASE_URL,
      group: IMAGE_SKILL_GROUP_NAMES[0],
      keyId: 3,
      keyName: XINGMANG_AI_SKILL_KEY_NAME,
      apiKey: 'sk-test-image-group-secret-12345678',
      codexGroup: managedCliKeyProfiles.codex.group,
      codexApiKey: 'sk-test-codex-group-secret-12345678',
    })
    expect(publicXingmangAiSkillConfig(config)).toEqual({
      baseUrl: XINGMANG_AI_DEFAULT_BASE_URL,
      group: IMAGE_SKILL_GROUP_NAMES[0],
      keyId: 3,
      keyName: XINGMANG_AI_SKILL_KEY_NAME,
      codexGroup: managedCliKeyProfiles.codex.group,
    })
    expect(JSON.stringify(publicXingmangAiSkillConfig(config))).not.toContain('sk-')
  })

  it('rejects a config that embeds credentials in the base URL', () => {
    expect(() => parseXingmangAiSkillConfig({
      baseUrl: 'https://user:pass@xm.solov.cc',
      group: IMAGE_SKILL_GROUP_NAMES[0],
    })).toThrow('不能内嵌凭据')
  })

  it('ships a bundled template without secrets or environment-variable setup', () => {
    assertBundledXingmangAiSkill(bundledRoot)
    expect(buildXingmangAiSkillConfig({
      baseUrl: XINGMANG_AI_DEFAULT_BASE_URL,
      group: IMAGE_SKILL_GROUP_NAMES[0],
    })).not.toContain('sk-')
  })

  it('installs skill files on first launch without a login or config.json', async () => {
    const userHome = await temporaryHome()
    await expect(installXingmangAiSkillFiles(bundledRoot, userHome)).resolves.toEqual({
      installed: 1,
      warnings: [],
    })
    expect(resolveXingmangAiSkillDirectories(userHome)).toEqual([
      path.join(userHome, '.agents', 'skills', XINGMANG_AI_SKILL_DIRECTORY),
    ])
    await expect(readFile(
      path.join(userHome, '.agents', 'skills', XINGMANG_AI_SKILL_DIRECTORY, 'SKILL.md'),
      'utf8',
    )).resolves.toContain('name: 星芒AI')
    await expect(readFile(
      path.join(userHome, '.agents', 'skills', XINGMANG_AI_SKILL_DIRECTORY, XINGMANG_AI_CONFIG_FILE),
      'utf8',
    )).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(userHome, '.claude'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(userHome, '.grok'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('also copies the skill into Claude and Grok homes that already exist', async () => {
    const userHome = await temporaryHome()
    await seedOptionalToolHomes(userHome)
    await expect(installXingmangAiSkillFiles(bundledRoot, userHome)).resolves.toEqual({
      installed: 3,
      warnings: [],
    })
    for (const directory of resolveXingmangAiSkillDirectories(userHome)) {
      expect(await readFile(path.join(directory, 'SKILL.md'), 'utf8')).toContain('name: 星芒AI')
    }
  })

  it('skips directories whose bundled files already match the template', async () => {
    const userHome = await temporaryHome()
    await installXingmangAiSkillFiles(bundledRoot, userHome)
    await expect(installXingmangAiSkillFiles(bundledRoot, userHome)).resolves.toEqual({
      installed: 0,
      warnings: [],
    })
  })

  it('keeps a user-edited skill file and still writes missing official files', async () => {
    const userHome = await temporaryHome()
    await installXingmangAiSkillFiles(bundledRoot, userHome)
    const directory = resolveXingmangAiSkillDirectories(userHome)[0]
    const customized = `${await readFile(path.join(directory, 'SKILL.md'), 'utf8')}\n用户自定义说明\n`
    await writeFile(path.join(directory, 'SKILL.md'), customized, 'utf8')
    await expect(installXingmangAiSkillFiles(bundledRoot, userHome)).resolves.toEqual({
      installed: 0,
      warnings: [],
    })
    expect(await readFile(path.join(directory, 'SKILL.md'), 'utf8')).toBe(customized)
  })

  it('refreshes an official skill file that still matches the last managed copy', async () => {
    const userHome = await temporaryHome()
    await installXingmangAiSkillFiles(bundledRoot, userHome)
    const directory = resolveXingmangAiSkillDirectories(userHome)[0]
    const stale = '// previous-official\n'
    await writeFile(path.join(directory, 'scripts', 'generate.mjs'), stale, 'utf8')
    const manifest = JSON.parse(await readFile(path.join(directory, XINGMANG_AI_MANAGED_MANIFEST_FILE), 'utf8')) as {
      version: 1
      files: Record<string, string>
    }
    manifest.files['scripts/generate.mjs'] = createHash('sha256').update(stale, 'utf8').digest('hex')
    await writeFile(path.join(directory, XINGMANG_AI_MANAGED_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await expect(installXingmangAiSkillFiles(bundledRoot, userHome)).resolves.toEqual({
      installed: 1,
      warnings: [],
    })
    expect(await readFile(path.join(directory, 'scripts', 'generate.mjs'), 'utf8')).toContain('codexApiKey')
  })

  it('only fills missing files when a previous install is incomplete', async () => {
    const userHome = await temporaryHome()
    const directory = resolveXingmangAiSkillDirectories(userHome)[0]
    await mkdir(path.join(directory, 'scripts'), { recursive: true })
    await writeFile(path.join(directory, 'SKILL.md'), '---\nname: partial\n---\n', 'utf8')
    await expect(installXingmangAiSkillFiles(bundledRoot, userHome)).resolves.toEqual({
      installed: 1,
      warnings: [],
    })
    expect(await readFile(path.join(directory, 'SKILL.md'), 'utf8')).toContain('name: partial')
    expect(await readFile(path.join(directory, 'references.md'), 'utf8')).toContain('星芒中转')
  })

  it('prefers packaged extraResources and falls back to the app path', async () => {
    const root = await temporaryHome()
    const resourcesSkill = path.join(root, 'resources', 'bundled-skills', 'xingmang-ai')
    const asarSkill = path.join(root, 'asar', 'bundled-skills', 'xingmang-ai')
    await mkdir(resourcesSkill, { recursive: true })
    await writeFile(path.join(resourcesSkill, 'SKILL.md'), 'resources', 'utf8')
    expect(resolveXingmangAiBundledSkillRoot(path.join(root, 'asar'), {
      packaged: true,
      resourcesPath: path.join(root, 'resources'),
    })).toBe(resourcesSkill)

    await mkdir(asarSkill, { recursive: true })
    await writeFile(path.join(asarSkill, 'SKILL.md'), 'asar', 'utf8')
    expect(resolveXingmangAiBundledSkillRoot(path.join(root, 'asar'), {
      packaged: true,
      resourcesPath: path.join(root, 'missing-resources'),
    })).toBe(asarSkill)
  })

  it('provisions a missing image-group key and writes it into every user skill config', async () => {
    const userHome = await temporaryHome()
    await seedOptionalToolHomes(userHome)
    const { accountService, provisionCliKey } = loggedInAccount()

    const result = await syncXingmangAiSkill({
      accountService,
      bundledRoot,
      userHome,
    })

    expect(result).toEqual({
      ready: true,
      group: '图片模型-中转/订阅',
      installed: 3,
      configured: 3,
    })
    expect(provisionCliKey).toHaveBeenCalledWith({
      name: managedCliKeyProfiles.codex.keyName,
      group: managedCliKeyProfiles.codex.group,
    })
    expect(provisionCliKey).toHaveBeenCalledWith({
      name: XINGMANG_AI_SKILL_KEY_NAME,
      group: '图片模型-中转/订阅',
    })

    for (const directory of resolveXingmangAiSkillDirectories(userHome)) {
      const parsed = parseXingmangAiSkillConfig(JSON.parse(await readFile(
        path.join(directory, XINGMANG_AI_CONFIG_FILE),
        'utf8',
      )))
      expect(parsed.apiKey).toBe('sk-test-image-group-secret-12345678')
      expect(parsed.codexApiKey).toBe('sk-test-codex-group-secret-12345678')
      expect(parsed.group).toBe('图片模型-中转/订阅')
      expect(parsed.codexGroup).toBe(managedCliKeyProfiles.codex.group)
      expect(await readFile(path.join(directory, 'SKILL.md'), 'utf8')).toContain('name: 星芒AI')
      expect(path.basename(directory)).toBe(XINGMANG_AI_SKILL_DIRECTORY)
    }
  })

  it('still writes the Codex key when the account has no image group', async () => {
    const userHome = await temporaryHome()
    const { accountService, provisionCliKey } = loggedInAccount({
      groups: [{ name: managedCliKeyProfiles.codex.group }],
    })

    await expect(syncXingmangAiSkill({
      accountService,
      bundledRoot,
      userHome,
    })).resolves.toEqual({
      ready: true,
      group: managedCliKeyProfiles.codex.group,
      installed: 1,
      configured: 1,
    })
    expect(provisionCliKey).toHaveBeenCalledWith({
      name: managedCliKeyProfiles.codex.keyName,
      group: managedCliKeyProfiles.codex.group,
    })
    expect(provisionCliKey).not.toHaveBeenCalledWith({
      name: XINGMANG_AI_SKILL_KEY_NAME,
      group: expect.anything(),
    })
    const parsed = parseXingmangAiSkillConfig(JSON.parse(await readInstalledConfig(userHome)))
    expect(parsed.codexApiKey).toBe('sk-test-codex-group-secret-12345678')
    expect(parsed.apiKey).toBeUndefined()
  })

  it('reuses provisionCliKey so an existing usable group key is not created twice', async () => {
    const userHome = await temporaryHome()
    const { accountService, provisionCliKey } = loggedInAccount({
      groups: [{ name: '生图分组' }],
    })

    await syncXingmangAiSkill({ accountService, bundledRoot, userHome })
    expect(provisionCliKey).toHaveBeenCalledWith({
      name: XINGMANG_AI_SKILL_KEY_NAME,
      group: '生图分组',
    })
  })

  it('skips Claude and Grok skill homes that were never created', async () => {
    const userHome = await temporaryHome()
    const { accountService, provisionCliKey } = loggedInAccount()

    const result = await syncXingmangAiSkill({
      accountService,
      bundledRoot,
      userHome,
    })

    expect(result).toEqual({
      ready: true,
      group: '图片模型-中转/订阅',
      installed: 1,
      configured: 1,
    })
    expect(provisionCliKey).toHaveBeenCalled()
    expect(parseXingmangAiSkillConfig(JSON.parse(await readInstalledConfig(userHome))).apiKey)
      .toBe('sk-test-image-group-secret-12345678')
    await expect(readFile(path.join(userHome, '.claude'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(userHome, '.grok'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('still writes the agents config when a leftover Claude path is not a directory', async () => {
    const userHome = await temporaryHome()
    await writeFile(path.join(userHome, '.claude'), 'not-a-directory', 'utf8')
    const { accountService, provisionCliKey } = loggedInAccount()

    const result = await syncXingmangAiSkill({
      accountService,
      bundledRoot,
      userHome,
    })

    expect(result.ready).toBe(true)
    expect(result.configured).toBe(1)
    expect(result.directoryWarnings ?? []).toEqual([])
    expect(provisionCliKey).toHaveBeenCalledWith({
      name: XINGMANG_AI_SKILL_KEY_NAME,
      group: '图片模型-中转/订阅',
    })
    const agentsConfig = parseXingmangAiSkillConfig(JSON.parse(await readFile(
      path.join(userHome, '.agents', 'skills', XINGMANG_AI_SKILL_DIRECTORY, XINGMANG_AI_CONFIG_FILE),
      'utf8',
    )))
    expect(agentsConfig.apiKey).toBe('sk-test-image-group-secret-12345678')
  })

  it('strips the written key on logout without removing the skill files', async () => {
    const userHome = await temporaryHome()
    const { accountService } = loggedInAccount()
    await syncXingmangAiSkill({ accountService, bundledRoot, userHome })

    expect(await clearXingmangAiSkillSecrets(userHome)).toBe(1)
    const parsed = parseXingmangAiSkillConfig(JSON.parse(await readInstalledConfig(userHome)))
    expect(parsed.apiKey).toBeUndefined()
    expect(parsed.codexApiKey).toBeUndefined()
    expect(parsed.group).toBe('图片模型-中转/订阅')
    expect(parsed.codexGroup).toBe(managedCliKeyProfiles.codex.group)
    expect(JSON.stringify(parsed)).not.toContain('sk-test-image-group-secret-12345678')
    expect(JSON.stringify(parsed)).not.toContain('sk-test-codex-group-secret-12345678')
    expect(await readFile(
      path.join(resolveXingmangAiSkillDirectories(userHome)[0], 'SKILL.md'),
      'utf8',
    )).toContain('星芒AI')
  })

  it('refreshes a previously cleared config on the next login sync', async () => {
    const userHome = await temporaryHome()
    const first = loggedInAccount()
    await syncXingmangAiSkill({ accountService: first.accountService, bundledRoot, userHome })
    await clearXingmangAiSkillSecrets(userHome)

    const second = loggedInAccount({
      provision: vi.fn(async () => ({
        id: 99,
        name: 'xingmang-ai-replaced',
        key: 'sk-replacement-image-key-abcdefghi',
      })),
    })
    await syncXingmangAiSkill({ accountService: second.accountService, bundledRoot, userHome })
    expect(JSON.parse(await readInstalledConfig(userHome))).toMatchObject({
      keyId: 99,
      apiKey: 'sk-replacement-image-key-abcdefghi',
    })
  })

  it('does not keep a leftover secret when rewriting a damaged config during logout', async () => {
    const userHome = await temporaryHome()
    const directory = resolveXingmangAiSkillDirectories(userHome)[0]
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, XINGMANG_AI_CONFIG_FILE), '{not-json', 'utf8')
    await clearXingmangAiSkillSecrets(userHome)
    expect(JSON.parse(await readFile(path.join(directory, XINGMANG_AI_CONFIG_FILE), 'utf8'))).toEqual({
      baseUrl: XINGMANG_AI_DEFAULT_BASE_URL,
      group: IMAGE_SKILL_GROUP_NAMES[0],
    })
  })

  it('disables the Codex skill for a ChatGPT account and turns it back on for Xingmang', async () => {
    const userHome = await temporaryHome()
    const skillPath = resolveXingmangAiCodexSkillPath(userHome)
    const configPath = path.join(userHome, '.codex', 'config.toml')
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(configPath, 'model = "gpt-5.4"\n[features]\ngoals = true\n', 'utf8')

    await expect(syncXingmangAiSkillCodexAvailability({
      userHome,
      officialCodex: true,
      configPath,
    })).resolves.toEqual({ changed: true, enabled: false })
    expect(TOML.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      model: 'gpt-5.4',
      features: { goals: true },
      skills: { config: [{ path: skillPath, enabled: false }] },
    })

    await expect(syncXingmangAiSkillCodexAvailability({
      userHome,
      officialCodex: false,
      configPath,
    })).resolves.toEqual({ changed: true, enabled: true })
    expect(TOML.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      skills: { config: [{ path: skillPath, enabled: true }] },
    })

    await expect(syncXingmangAiSkillCodexAvailability({
      userHome,
      officialCodex: false,
      configPath,
    })).resolves.toEqual({ changed: false, enabled: true })
  })

  it('does not invent a Codex config.toml just to keep the skill enabled', async () => {
    const userHome = await temporaryHome()
    await expect(syncXingmangAiSkillCodexAvailability({
      userHome,
      officialCodex: false,
    })).resolves.toEqual({ changed: false, enabled: true })
    await expect(readFile(path.join(userHome, '.codex', 'config.toml'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('creates a Codex skills.config entry when ChatGPT is already selected at install', async () => {
    const userHome = await temporaryHome()
    const configPath = path.join(userHome, '.codex', 'config.toml')
    await expect(installXingmangAiSkillFiles(bundledRoot, userHome, {
      officialCodex: true,
      codexHome: path.dirname(configPath),
    })).resolves.toEqual({
      installed: 1,
      warnings: [],
    })
    expect(TOML.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      skills: { config: [{ path: resolveXingmangAiCodexSkillPath(userHome), enabled: false }] },
    })
  })

  it('does not rewrite an unrelated skills.config entry', () => {
    const skillPath = path.resolve('agents', '星芒AI', 'SKILL.md')
    const otherPath = path.resolve('agents', 'other', 'SKILL.md')
    const config = {
      skills: {
        config: [{ path: otherPath, enabled: true }],
      },
    }
    expect(applyXingmangAiSkillEnabledFlag(config, skillPath, false)).toBe(true)
    expect(config.skills.config).toEqual([
      { path: otherPath, enabled: true },
      { path: skillPath, enabled: false },
    ])
  })
})
