import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { applyEdits, getNodeValue, modify, parseTree, type Node, type ParseError } from 'jsonc-parser'
import { executeFilePlans, type NativeConfigWriteHooks } from './config-files'
import { assertNoReparseComponents, readSafeUtf8FileSync } from './safe-local-data'

/**
 * Claude Code 的 VS Code 插件（Cursor 装的是同一个）一打开先是一屏「登录 Anthropic 账号」，接星芒的客户
 * 没有那种账号。官方文档《在 VS Code 中使用 Claude Code》「使用第三方提供商」第一步就是勾「禁用登录提示」，
 * 也就是编辑器用户设置里的 claudeCode.disableLoginPrompt；连上哪个服务、用哪把 Key 照旧读 ~/.claude/settings.json，
 * 跟命令行同一份。插件也不用客户自己去装：在 VS Code、Cursor 的终端里跑一次 Claude Code，它就自己装上
 * （autoInstallIdeExtension 默认开，2.1.310 安装包里核过），所以星芒写 Claude Code 配置时顺手在编辑器里补上这一项。
 *
 * 只补这一项：键不在才补，客户写过的（哪怕是 false）一个字不动；设置文件带注释、末尾逗号，原样只插这一行，读回来
 * 必须恰好只多了这一个键，对不上就不写；编辑器从没打开过（用户设置那层目录都没有）就不建。
 * 切回官方账号不收回：这一项是不是星芒补的认不出来，客户自己写的不能删。官方账号在星芒里是命令行登录过的，
 * 插件跟命令行共用那份登录，这一项对它不起作用。
 * 这台电脑上出现过这一项（星芒补的，或者客户自己写的）的编辑器，之后不再看也不再补：现在没有就是客户删的
 * （0.2.22 第二轮回归第 3 条，记在 app-settings.ts 的 seededToolDefaults）。
 */

export const editorClaudeLoginPromptSetting = 'claudeCode.disableLoginPrompt'

export type EditorId = 'vscode' | 'cursor'

const editorIds: readonly EditorId[] = ['vscode', 'cursor']

// 编辑器自己的数据目录名，三个平台一样：Windows 在 %APPDATA% 下，Mac 在 ~/Library/Application Support 下，
// Linux 在 $XDG_CONFIG_HOME（缺省 ~/.config）下，用户设置是其中的 User/settings.json。
const editorDirectoryNames: Record<EditorId, string> = { vscode: 'Code', cursor: 'Cursor' }

const MAX_EDITOR_SETTINGS_BYTES = 2 * 1024 * 1024

export interface EditorSettingsLocationOptions {
  platform: NodeJS.Platform
  userHome: string
  /** 缺省时只有 userHome 是本机真实主目录才读 process.env：测试用的假主目录不能摸到操作者自己的编辑器设置。 */
  env?: NodeJS.ProcessEnv
}

export interface EditorSettingsLocation {
  editor: EditorId
  userDirectory: string
  settingsPath: string
}

function environmentFor(options: EditorSettingsLocationOptions): NodeJS.ProcessEnv {
  if (options.env) return options.env
  const sameHome = options.platform === 'win32'
    ? path.resolve(options.userHome).toLowerCase() === path.resolve(os.homedir()).toLowerCase()
    : path.resolve(options.userHome) === path.resolve(os.homedir())
  return sameHome ? process.env : {}
}

/** 环境变量给的目录不是绝对路径（或带控制字符）就当没给，用缺省位置。 */
function absoluteDirectoryOr(value: string | undefined, fallback: string): string {
  return value && path.isAbsolute(value) && !/[\u0000-\u001f]/.test(value) ? path.normalize(value) : fallback
}

export function resolveEditorSettingsLocations(options: EditorSettingsLocationOptions): EditorSettingsLocation[] {
  const env = environmentFor(options)
  const userHome = path.resolve(options.userHome)
  const base = options.platform === 'win32'
    ? absoluteDirectoryOr(env.APPDATA, path.join(userHome, 'AppData', 'Roaming'))
    : options.platform === 'darwin'
      ? path.join(userHome, 'Library', 'Application Support')
      : absoluteDirectoryOr(env.XDG_CONFIG_HOME, path.join(userHome, '.config'))
  return editorIds.map((editor) => {
    const userDirectory = path.join(base, editorDirectoryNames[editor], 'User')
    return { editor, userDirectory, settingsPath: path.join(userDirectory, 'settings.json') }
  })
}

export type EditorSettingsEdit =
  | { kind: 'add'; content: string }
  | { kind: 'present' }
  | { kind: 'unreadable' }

function propertyNames(node: Node): string[] {
  return (node.children ?? []).flatMap((property) => {
    const name: unknown = property.children?.[0]?.value
    return typeof name === 'string' ? [name] : []
  })
}

/** 平铺的 "claudeCode.disableLoginPrompt" 和嵌套的 "claudeCode": { "disableLoginPrompt": … } 都算客户写过。 */
function hasLoginPromptSetting(root: Node): boolean {
  if (propertyNames(root).includes(editorClaudeLoginPromptSetting)) return true
  return (root.children ?? []).some((property) => property.children?.[0]?.value === 'claudeCode'
    && property.children?.[1]?.type === 'object' && propertyNames(property.children[1]).includes('disableLoginPrompt'))
}

/** 照文件里第一行缩进的样子插；一行缩进都没有就用编辑器缺省的四个空格。 */
function indentationOf(text: string): { insertSpaces: boolean; tabSize: number } {
  const indent = /\n([ \t]+)\S/.exec(text)?.[1]
  if (!indent) return { insertSpaces: true, tabSize: 4 }
  return indent.startsWith('\t') ? { insertSpaces: false, tabSize: 4 } : { insertSpaces: true, tabSize: indent.length }
}

/**
 * 在编辑器用户设置里补上 claudeCode.disableLoginPrompt: true。null = 文件不在，写一份只有这一项的。
 * 编辑器本身照 JSONC 读（注释、末尾逗号都认），这里同样认；读不懂、最外层不是一组设置的给 unreadable，一字不动。
 */
export function buildEditorSettingsWithLoginPromptDisabled(existing: string | null): EditorSettingsEdit {
  const bom = existing?.startsWith('﻿') ? '﻿' : ''
  const text = existing === null ? '' : existing.slice(bom.length)
  if (!text.trim()) return { kind: 'add', content: `${bom}{\n    "${editorClaudeLoginPromptSetting}": true\n}\n` }
  const errors: ParseError[] = []
  const tree = parseTree(text, errors, { allowTrailingComma: true })
  if (!tree || errors.length || tree.type !== 'object') return { kind: 'unreadable' }
  if (hasLoginPromptSetting(tree)) return { kind: 'present' }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const content = applyEdits(text, modify(text, [editorClaudeLoginPromptSetting], true, {
    formattingOptions: { ...indentationOf(text), eol },
  }))
  const expected: Record<string, unknown> = getNodeValue(tree)
  expected[editorClaudeLoginPromptSetting] = true
  const rereadErrors: ParseError[] = []
  const reread = parseTree(content, rereadErrors, { allowTrailingComma: true })
  if (!reread || rereadErrors.length || !isDeepStrictEqual(getNodeValue(reread), expected)) return { kind: 'unreadable' }
  return { kind: 'add', content: `${bom}${content}` }
}

/** seeded = 这台电脑上出现过这一项，这次没看也没动。 */
export type EditorLoginPromptResult =
  | { editor: EditorId; outcome: 'added'; backups: string[] }
  | { editor: EditorId; outcome: 'present' | 'absent' | 'unreadable' | 'seeded' }
  | { editor: EditorId; outcome: 'failed'; error: unknown }

function userDirectoryExists(userDirectory: string): boolean {
  try {
    return fs.lstatSync(userDirectory).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function ensureOne(location: EditorSettingsLocation, hooks: NativeConfigWriteHooks): EditorLoginPromptResult {
  const { editor, userDirectory, settingsPath } = location
  if (!userDirectoryExists(userDirectory)) return { editor, outcome: 'absent' }
  assertNoReparseComponents(userDirectory, '编辑器设置目录')
  const existing = readSafeUtf8FileSync(settingsPath, '编辑器设置', MAX_EDITOR_SETTINGS_BYTES)
  const edit = buildEditorSettingsWithLoginPromptDisabled(existing)
  if (edit.kind !== 'add') return { editor, outcome: edit.kind }
  const saved = executeFilePlans([{ path: settingsPath, content: edit.content }], {
    beforeReplace(filePath, index) {
      hooks.beforeReplace?.(filePath, index)
      // 编辑器开着时客户可能刚在设置页里改过一项，那份不能被这次覆盖掉。
      if (readSafeUtf8FileSync(settingsPath, '编辑器设置', MAX_EDITOR_SETTINGS_BYTES) !== existing) {
        throw new Error('编辑器设置在保存前已变化，未执行修改')
      }
    },
  }, userDirectory)
  return { editor, outcome: 'added', backups: saved.backups }
}

/**
 * 给这台电脑上用过的 VS Code、Cursor 各补一次。一家出错（设置文件是链接、被占用……）不影响另一家，
 * 结果逐家交回，调用方记日志；这一项补不上不算 Claude Code 配置没写成。seeded 里的编辑器出现过这一项，
 * 不再看也不再补。
 */
export function ensureEditorClaudeLoginPromptDisabled(
  options: EditorSettingsLocationOptions,
  hooks: NativeConfigWriteHooks = {},
  seeded: readonly EditorId[] = [],
): EditorLoginPromptResult[] {
  return resolveEditorSettingsLocations(options).map((location) => {
    if (seeded.includes(location.editor)) return { editor: location.editor, outcome: 'seeded' }
    try {
      return ensureOne(location, hooks)
    } catch (error) {
      return { editor: location.editor, outcome: 'failed', error }
    }
  })
}
