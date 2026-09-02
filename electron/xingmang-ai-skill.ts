import fs from 'node:fs'
import path from 'node:path'
import { IMAGE_SKILL_GROUP_NAMES } from './ai-chat-protocol'
import type { RelayBackendClient } from './relay-backend'
import {
  ensureSafeDataDirectory,
  readSafeUtf8File,
  writeAtomicSafeUtf8File,
} from './safe-local-data'

export const XINGMANG_AI_SKILL_DIRECTORY = '星芒AI'
export const XINGMANG_AI_SKILL_KEY_NAME = 'xingmang-ai'
export const XINGMANG_AI_DEFAULT_BASE_URL = 'https://xm.solov.cc'
export const XINGMANG_AI_CONFIG_FILE = 'config.json'

// Codex/Gemini share ~/.agents/skills. Claude and Grok only see their own
// home roots, so the same managed skill is installed there too. Do not also
// write ~/.codex/skills or ~/.gemini/skills: those tabs already pick up
// ~/.agents and a second copy would show as a duplicate card.
export const XINGMANG_AI_USER_SKILL_ROOTS = [
  ['.agents', 'skills'],
  ['.claude', 'skills'],
  ['.grok', 'skills'],
] as const

export const XINGMANG_AI_BUNDLED_FILES = [
  'SKILL.md',
  'references.md',
  path.join('scripts', 'generate.mjs'),
] as const

export interface XingmangAiSkillConfig {
  baseUrl: string
  group: string
  keyId?: number
  keyName?: string
  apiKey?: string
}

export interface XingmangAiSkillSyncResult {
  ready: boolean
  group?: string
  installed: number
  reason?: string
}

type SkillAccountService = Pick<RelayBackendClient, 'getSessionState' | 'listUsableGroups' | 'provisionCliKey'>

export interface XingmangAiSkillSyncOptions {
  accountService: SkillAccountService
  bundledRoot: string
  userHome: string
  baseUrl?: string
}

export function resolveXingmangAiBundledSkillRoot(
  appPath: string,
  options: { packaged?: boolean; resourcesPath?: string } = {},
): string {
  const candidates: string[] = []
  if (options.packaged && options.resourcesPath) {
    candidates.push(path.join(path.resolve(options.resourcesPath), 'bundled-skills', 'xingmang-ai'))
  }
  candidates.push(path.join(path.resolve(appPath), 'bundled-skills', 'xingmang-ai'))
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join(candidate, 'SKILL.md'))) return candidate
    } catch {
      // Packaged asar or a missing extraResources copy should not abort lookup.
    }
  }
  return candidates[0]
}

export function resolveXingmangAiSkillDirectories(userHome: string): string[] {
  const home = path.resolve(userHome)
  return XINGMANG_AI_USER_SKILL_ROOTS.map((segments) => (
    path.join(home, ...segments, XINGMANG_AI_SKILL_DIRECTORY)
  ))
}

export function selectImageSkillGroup(groups: readonly { name: string }[]): string | null {
  const names = new Set(groups.map((entry) => entry.name.trim()).filter(Boolean))
  for (const candidate of IMAGE_SKILL_GROUP_NAMES) {
    if (names.has(candidate)) return candidate
  }
  return null
}

export function parseXingmangAiSkillConfig(raw: unknown): XingmangAiSkillConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('星芒AI Skill 配置格式错误')
  }
  const record = raw as Record<string, unknown>
  const baseUrl = typeof record.baseUrl === 'string' && record.baseUrl.trim()
    ? record.baseUrl.trim()
    : XINGMANG_AI_DEFAULT_BASE_URL
  assertSafeBaseUrl(baseUrl)
  const group = typeof record.group === 'string' ? record.group.trim() : ''
  if (!group || group.length > 128 || /[\x00-\x1F\x7F]/.test(group)) {
    throw new Error('星芒AI Skill 分组格式错误')
  }
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : ''
  if (apiKey && !apiKey.startsWith('sk-')) {
    throw new Error('星芒AI Skill 配置缺少有效 API Key')
  }
  const keyId = typeof record.keyId === 'number' && Number.isInteger(record.keyId) && record.keyId > 0
    ? record.keyId
    : undefined
  const keyName = typeof record.keyName === 'string' && record.keyName.trim()
    ? record.keyName.trim().slice(0, 50)
    : undefined
  return {
    baseUrl,
    group,
    ...(keyId ? { keyId } : {}),
    ...(keyName ? { keyName } : {}),
    ...(apiKey ? { apiKey } : {}),
  }
}

export function buildXingmangAiSkillConfig(input: XingmangAiSkillConfig): string {
  const parsed = parseXingmangAiSkillConfig(input)
  return `${JSON.stringify(parsed, null, 2)}\n`
}

export function publicXingmangAiSkillConfig(config: XingmangAiSkillConfig): Omit<XingmangAiSkillConfig, 'apiKey'> {
  const { apiKey: _apiKey, ...safe } = config
  return safe
}

function assertSafeBaseUrl(rawUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('星芒AI Skill 接口地址无效')
  }
  if (parsed.protocol !== 'https:') throw new Error('星芒AI Skill 接口地址必须是 https')
  if (parsed.username || parsed.password) throw new Error('星芒AI Skill 接口地址不能内嵌凭据')
}

function authenticatedUserId(accountService: SkillAccountService): number {
  const session = accountService.getSessionState()
  const userId = session.account?.userId
  if (!session.authenticated || !userId) throw new Error('请先登录星芒账号')
  return userId
}

function readBundledUtf8(filePath: string): string {
  const stats = fs.lstatSync(filePath)
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('内置星芒AI Skill 文件损坏')
  }
  const content = fs.readFileSync(filePath, 'utf8')
  if (/\bsk-[A-Za-z0-9]{20,}\b/.test(content)) {
    throw new Error('内置星芒AI Skill 含有密钥，已拒绝安装')
  }
  return content
}

export function assertBundledXingmangAiSkill(bundledRoot: string): void {
  const root = path.resolve(bundledRoot)
  for (const relative of XINGMANG_AI_BUNDLED_FILES) {
    readBundledUtf8(path.join(root, relative))
  }
}

export function isXingmangAiSkillInstalled(targetDirectory: string): boolean {
  return XINGMANG_AI_BUNDLED_FILES.every((relative) => (
    bundledSkillFileExists(path.join(targetDirectory, relative))
  ))
}

function bundledSkillFileExists(filePath: string): boolean {
  try {
    const stats = fs.lstatSync(filePath)
    return stats.isFile() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}

export async function installXingmangAiSkillFiles(
  bundledRoot: string,
  userHome: string,
): Promise<number> {
  const root = path.resolve(bundledRoot)
  assertBundledXingmangAiSkill(root)
  let installed = 0
  for (const directory of resolveXingmangAiSkillDirectories(userHome)) {
    if (await installBundledSkill(root, directory)) installed += 1
  }
  return installed
}

async function installBundledSkill(bundledRoot: string, targetDirectory: string): Promise<boolean> {
  if (isXingmangAiSkillInstalled(targetDirectory)) return false
  ensureSafeDataDirectory(targetDirectory, '星芒AI Skill 目录')
  ensureSafeDataDirectory(path.join(targetDirectory, 'scripts'), '星芒AI Skill 脚本目录')
  let wrote = false
  for (const relative of XINGMANG_AI_BUNDLED_FILES) {
    const destination = path.join(targetDirectory, relative)
    if (bundledSkillFileExists(destination)) continue
    const content = readBundledUtf8(path.join(bundledRoot, relative))
    await writeAtomicSafeUtf8File(destination, content, '星芒AI Skill 文件')
    wrote = true
  }
  return wrote
}

async function writeSkillConfig(targetDirectory: string, config: XingmangAiSkillConfig): Promise<void> {
  ensureSafeDataDirectory(targetDirectory, '星芒AI Skill 目录')
  await writeAtomicSafeUtf8File(
    path.join(targetDirectory, XINGMANG_AI_CONFIG_FILE),
    buildXingmangAiSkillConfig(config),
    '星芒AI Skill 配置',
  )
}

export async function syncXingmangAiSkill(
  options: XingmangAiSkillSyncOptions,
): Promise<XingmangAiSkillSyncResult> {
  authenticatedUserId(options.accountService)
  const bundledRoot = path.resolve(options.bundledRoot)
  const installed = await installXingmangAiSkillFiles(bundledRoot, options.userHome)

  const groups = await options.accountService.listUsableGroups()
  const group = selectImageSkillGroup(groups)
  if (!group) {
    return { ready: false, installed, reason: '当前账号没有可用的图片模型分组' }
  }

  const provisioned = await options.accountService.provisionCliKey({
    name: XINGMANG_AI_SKILL_KEY_NAME,
    group,
  })
  const config: XingmangAiSkillConfig = {
    baseUrl: options.baseUrl ?? XINGMANG_AI_DEFAULT_BASE_URL,
    group,
    keyId: provisioned.id,
    keyName: provisioned.name,
    apiKey: provisioned.key,
  }

  const directories = resolveXingmangAiSkillDirectories(options.userHome)
  for (const directory of directories) {
    await writeSkillConfig(directory, config)
  }
  return { ready: true, group, installed }
}

export async function clearXingmangAiSkillSecrets(userHome: string): Promise<number> {
  let cleared = 0
  for (const directory of resolveXingmangAiSkillDirectories(userHome)) {
    const filePath = path.join(directory, XINGMANG_AI_CONFIG_FILE)
    const raw = await readSafeUtf8File(filePath, '星芒AI Skill 配置', 16 * 1024)
    if (!raw) continue
    let existing: XingmangAiSkillConfig
    try {
      existing = parseXingmangAiSkillConfig(JSON.parse(raw))
    } catch {
      existing = {
        baseUrl: XINGMANG_AI_DEFAULT_BASE_URL,
        group: IMAGE_SKILL_GROUP_NAMES[0],
      }
    }
    await writeSkillConfig(directory, {
      baseUrl: existing.baseUrl,
      group: existing.group,
    })
    cleared += 1
  }
  return cleared
}
