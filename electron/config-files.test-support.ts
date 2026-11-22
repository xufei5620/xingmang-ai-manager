import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { providerConfigPaths, saveProviderConfig } from './config-files'
import { providerBaseUrls, type ProviderId } from './catalog'
import type { CliHookInvocation } from './cli-hooks'

// config-files*.test.ts 六个文件共用的夹具。这些用例都在临时目录里真的写配置文件，原来挤在一个 359 条的文件里，
// Windows 跑道上一个文件就占 190 秒上下、慢机器上 355 秒，分片没法把它拆开发，跑道慢一阵就把那一片推过 15 分钟
// （11-22 #2117 的 vitest-1），所以按 describe 拆开：
// - config-files.test.ts：读配置、坏文件的重置与修复、认地址、检测与清除
// - config-files.merge.test.ts：保存时写进去和留着的东西（通知、状态栏、自动更新、Codex 默认值、回滚、备份）
// - config-files.official-codex.test.ts：Codex 切回官方账号（快照、登录、别名表）
// - config-files.official-switch.test.ts：Claude Code、Gemini CLI、Grok CLI 切回官方与账号模式
// - config-files.trust-hooks.test.ts：信任文件夹、官方凭据挪开、搬家后的通知与状态栏、退役的 Gemini CLI
// - config-files.template.test.ts：老配置补到当前模板、回复语言、Codex 模型目录、Claude 的两个开关
// 前两个和中间两个各自沿用原来的同名 describe，用例的完整名字一条没变。

const temporaryHomes: string[] = []
export const statusLineCommand = '"/managed/node/bin/node" "/opt/app/resources/bundled-catalog/cli-status-line/xingmang-statusline.cjs"'
export const cliHook: CliHookInvocation = {
  nodeExecutable: '/managed/node/bin/node',
  scriptPath: '/opt/app/resources/bundled-catalog/cli-hooks/xingmang-hook.cjs',
  eventsDirectory: '/home/me/.config/xingmang-ai-manager/cli-events',
  platform: 'linux',
}
export interface GrokConfigShape {
  compat?: unknown
  hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
  model: Record<string, { api_key?: string }>
}
export const testModels: Record<ProviderId, string> = {
  claude: 'claude-opus-4-6',
  codex: 'gpt-5.5',
  gemini: 'gemini-3.5-flash',
  grok: 'grok-4.5',
}
// Codex must not send response.interrupt over the relay's WebSocket (see keepCodexRelayResponsesUninterrupted).
export const uninterruptedFeatures = { instant_interrupt: false, defer_mailbox_preemption: true }

export function temporaryHome(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-config-test-'))
  temporaryHomes.push(directory)
  return directory
}

export function removeTemporaryHomes(): void {
  for (const directory of temporaryHomes.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

export function providerRoots(userHome: string) {
  return { userHome, codexHome: path.join(userHome, '.codex') }
}

export function directoryFileSnapshot(directory: string): Record<string, string> {
  return Object.fromEntries(
    fs.readdirSync(directory).sort().map((name) => [
      name,
      fs.readFileSync(path.join(directory, name)).toString('base64'),
    ]),
  )
}

// TOML.parse returns AnyJson (string | number | boolean | Date | JsonMap | JsonArray),
// which cannot support chained property access. Tests that read back a written
// config.toml know the fixture shape, so narrow one level at a time the same way
// codex-sessions.ts / provider-sessions.ts already do for their own JSON payloads.
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

// 下面两个原来是「switching a provider back to the official subscription account」里的局部函数，
// 那个 describe 拆到 official-codex 和 official-switch 两个文件后两边都要用。
export function chatGptTokens() {
  return {
    id_token: 'header.payload.signature',
    access_token: 'access-token-value',
    refresh_token: 'refresh-token-value',
    account_id: 'account-uuid',
  }
}

export function seedCodexRelayConfigWithChatGptLogin(home: string) {
  saveProviderConfig('codex', 'sk-relay', testModels.codex, 'reset', providerRoots(home), {}, providerBaseUrls)
  const [, authPath] = providerConfigPaths('codex', providerRoots(home))
  // Codex 的订阅登录与 API Key 共存于同一份 auth.json。
  fs.writeFileSync(authPath, JSON.stringify({
    OPENAI_API_KEY: 'sk-relay',
    tokens: chatGptTokens(),
    last_refresh: '2026-08-12T00:00:00Z',
  }, null, 2))
}
