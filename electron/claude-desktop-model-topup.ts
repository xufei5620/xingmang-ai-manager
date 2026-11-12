import { createHash } from 'node:crypto'
import path from 'node:path'
import { claudeDesktopTopUpCandidates, claudeDesktopTopUpMaximumModels, probeClaudeDesktopModels } from './claude-desktop-models'
import { isCliModelName } from './cli-model-defaults'
import { ensureSafeDataDirectory, readSafeUtf8File, writeAtomicSafeUtf8File } from './safe-local-data'

// Claude Desktop 的型号菜单只在客户点「保存配置」那一刻写（claude-desktop-models.ts），之后账号上了新型号它也看不到，
// 要客户回星芒再保存一次。yoyo 2026-11-12 回「1 2 3 做」第 1 条：开机时替他补进去，只加不减，默认那个不动，
// Claude Desktop 开着就这次不补。0.2.12 把列着的全写进去出过事（#685），所以补的和保存时一样，每个先照 Claude Desktop
// 的开机检查发一个字，通了才放。
//
// 哪些算新上的：每次补完把这把密钥当时列着的型号记一笔（这个文件），下次只看记录里没有的。这样客户自己从菜单里拿掉的、
// 菜单满了没放进去的不会每次开机又补回来、又试一遍。试过没通的不记，下次开机再试：刚上的型号渠道常常还不稳。

const recordLabel = 'Claude Desktop 型号菜单补充记录'
const recordMaximumBytes = 64 * 1024
// 一个分组列几百个 Claude 型号已经不正常了，记录也就不认。
const recordMaximumModels = 500
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 开机那一阵本机还在检测工具、恢复登录、查更新，Windows 上要起好几段 PowerShell。补型号要读 Claude Desktop 的配置
 * （商店版也要起 PowerShell）、联网试型号，等这一阵过去再做；等太久客户可能已经把 Claude Desktop 打开了，那就这次不补。
 */
export const claudeDesktopModelTopUpStartupDelayMs = 30_000

/** 星芒写进 Claude Desktop、现在正用着的那一份。主进程内部专用：apiKey 永不跨 IPC（I3），也不落盘（记录里只存摘要）。 */
export interface ClaudeDesktopModelMenu {
  /** 那份配置在 configLibrary 里的编号，记录按它分开记。 */
  id: string
  /** 菜单里现在的型号，第一项是默认。 */
  models: readonly string[]
  apiKey: string
}

export interface ClaudeDesktopModelTopUpOptions {
  /** 星芒自己的数据目录，记录放在它下面。 */
  dataDirectory: string
  menu: ClaudeDesktopModelMenu
  /** 这把密钥现在能用的型号。 */
  offered: readonly string[]
  /** 照 Claude Desktop 的开机检查发一个字，回 true 才算通。 */
  probe: (model: string) => Promise<boolean>
  /**
   * 把试通了的写进菜单：写之前重读一遍、再看一眼 Claude Desktop 还关着，只加不减。交回真放进去的那几个；写不成就抛错，
   * 这次的记录也不记，下次开机重来。
   */
  add: (models: readonly string[]) => Promise<string[]>
}

export interface ClaudeDesktopModelTopUpReport {
  /** 这次放进菜单的。 */
  added: string[]
  /** 试过没通的，只进运行日志，下次开机再试。 */
  rejected: string[]
  /** 试通了、但菜单已经满了没放进去的。 */
  overflow: string[]
}

function recordPath(dataDirectory: string, configId: string): string {
  if (!uuidPattern.test(configId)) throw new Error(`${recordLabel}的配置编号无效`)
  return path.join(dataDirectory, 'external-clients', 'claude-desktop-models', `${configId.toLowerCase()}.json`)
}

// 记录跟着这把密钥走：换了 Key（换账号、换组、重签），能用的型号可能整个变了，上一把的记录不算。只存摘要。
function keyDigest(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex')
}

function claudeModels(models: readonly string[]): string[] {
  return [...new Set(models)].filter((model) => /^claude-/i.test(model) && isCliModelName(model))
}

function buildRecord(apiKey: string, models: readonly string[]): string {
  return `${JSON.stringify({ version: 1, key: keyDigest(apiKey), models })}\n`
}

/** 记录里的型号；没有记录、是别的密钥的、或者读出来对不上格式，都当没有（null），这次照保存的挑法补一遍。 */
export function parseClaudeDesktopModelTopUpRecord(content: string | null, apiKey: string): string[] | null {
  if (content === null) return null
  let value: unknown
  try { value = JSON.parse(content) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.version !== 1 || record.key !== keyDigest(apiKey) || !Array.isArray(record.models) || record.models.length > recordMaximumModels) return null
  const models = record.models
  return models.every((model): model is string => typeof model === 'string' && model.length <= 512 && isCliModelName(model)) ? models : null
}

/**
 * 开机补一次型号。读记录、挑出新上的、逐个试、试通了的交给 add 放进菜单（放到满 claudeDesktopTopUpMaximumModels 个为止），
 * 最后把这次这把密钥列着的型号记下来（没试通的除外）。读记录、写菜单出错往外抛，由调用方记日志；记录写不进去也往外抛，
 * 菜单那时已经写好了，下次开机按没有记录再看一遍，菜单里已经有的不会重复放。
 */
export async function runClaudeDesktopModelTopUp(options: ClaudeDesktopModelTopUpOptions): Promise<ClaudeDesktopModelTopUpReport> {
  const filePath = recordPath(options.dataDirectory, options.menu.id)
  const previous = await readSafeUtf8File(filePath, recordLabel, recordMaximumBytes)
  const known = parseClaudeDesktopModelTopUpRecord(previous, options.menu.apiKey)
  const candidates = claudeDesktopTopUpCandidates(options.menu.models, options.offered, known)
  const tried = await probeClaudeDesktopModels(candidates, options.probe)
  const room = Math.max(0, claudeDesktopTopUpMaximumModels - options.menu.models.length)
  const wanted = tried.passed.slice(0, room)
  const added = wanted.length ? await options.add(wanted) : []
  const next = buildRecord(options.menu.apiKey, claudeModels(options.offered).filter((model) => !tried.rejected.includes(model)))
  if (next !== previous) {
    const directory = path.dirname(filePath)
    ensureSafeDataDirectory(directory, recordLabel)
    await writeAtomicSafeUtf8File(filePath, next, recordLabel)
  }
  return { added, rejected: tried.rejected, overflow: tried.passed.slice(room) }
}
