import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  ensureSafeDataDirectory,
  readSafeUtf8FileSync,
  writeAtomicSafeUtf8File,
} from './safe-local-data'

// Claude Code 2.1.277 起在没有 CLAUDE.md 时读 AGENTS.md，Codex 一直读 AGENTS.md，
// Gemini CLI 通过 settings.json 的 context.fileName 也能读它。所以一份 AGENTS.md
// 就能被三个工具共用。这里只在目录里三种说明文件一个都没有时才生成，绝不覆盖、
// 绝不追加到已有文件。
export const PROJECT_INSTRUCTION_FILENAMES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'] as const
export const GENERATED_PROJECT_INSTRUCTION_FILENAME = 'AGENTS.md'

const PROJECT_INSTRUCTIONS_TEMPLATE_RELATIVE = [
  'bundled-catalog',
  'project-instructions',
  'AGENTS.zh-CN.md',
] as const

// The bundled template is our own asset, but a corrupt or oversized copy must
// not be written verbatim into a user's project tree.
const MAX_TEMPLATE_BYTES = 64 * 1024

export function resolveProjectInstructionsTemplatePath(
  appPath: string,
  options: { packaged?: boolean; resourcesPath?: string } = {},
): string {
  const candidates: string[] = []
  if (options.packaged && options.resourcesPath) {
    candidates.push(path.join(path.resolve(options.resourcesPath), ...PROJECT_INSTRUCTIONS_TEMPLATE_RELATIVE))
  }
  candidates.push(path.join(path.resolve(appPath), ...PROJECT_INSTRUCTIONS_TEMPLATE_RELATIVE))
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // A packaged asar or a missing extraResources copy must not abort lookup.
    }
  }
  return candidates[0]
}

export function readProjectInstructionsTemplate(templatePath: string): string {
  const content = fs.readFileSync(templatePath, 'utf8')
  // 模板是中文的，一个字三个字节，所以按字节量而不是字符数卡上限。
  if (Buffer.byteLength(content, 'utf8') > MAX_TEMPLATE_BYTES) {
    throw new Error('项目说明模板超出安全上限')
  }
  return content
}

/**
 * 目录里是否已经有任意一种项目说明文件。大小写不敏感：Windows 文件系统本就
 * 不区分大小写，Linux 上一个小写的 agents.md 也应当被当成"已有说明"，宁可不生成
 * 也不要写出第二份。
 */
export function hasExistingProjectInstructions(entryNames: readonly string[]): boolean {
  const wanted = new Set(PROJECT_INSTRUCTION_FILENAMES.map((name) => name.toLowerCase()))
  return entryNames.some((name) => wanted.has(name.toLowerCase()))
}

export interface ProjectInstructionsResult {
  created: boolean
  reason?: 'exists' | 'no-template' | 'already-generated'
}

const STATE_FILE_LABEL = '项目说明生成记录'
const MAX_STATE_BYTES = 4096

function normalizedWorkspaceKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * 「这个目录已经生成过一次」的记录。每个目录一个小文件，文件名是路径的摘要——
 * 和 ToolConfigOwnershipStore 一个写法，省掉一份会无限长的清单，也没有并发合并。
 * 标记只存在本应用自己的数据目录里，绝不往客户的项目目录写标记文件。
 */
export interface ProjectInstructionsState {
  generated(workspace: string): boolean
  remember(workspace: string): Promise<void>
}

export class ProjectInstructionsStateStore implements ProjectInstructionsState {
  constructor(private readonly directory: string) {}

  private file(workspace: string): string {
    const digest = createHash('sha256').update(normalizedWorkspaceKey(workspace)).digest('hex')
    return path.join(this.directory, `${digest}.json`)
  }

  generated(workspace: string): boolean {
    try {
      const raw = readSafeUtf8FileSync(this.file(workspace), STATE_FILE_LABEL, MAX_STATE_BYTES)
      // 文件不存在是正常路径：这个目录还没生成过。
      if (raw === null) return false
      const value: unknown = JSON.parse(raw)
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && (value as Record<string, unknown>).version === 1
    } catch {
      // 记录读不懂（损坏、被换成符号链接）时当成「已经生成过」。客户很可能已经把
      // 那份 AGENTS.md 删了，宁可这次不生成，也不能让一份坏掉的记录把他删掉的
      // 文件又变回来 —— 这个方向的代价只是少一份模板，反过来是改动客户的目录。
      return true
    }
  }

  async remember(workspace: string): Promise<void> {
    ensureSafeDataDirectory(this.directory, STATE_FILE_LABEL)
    const content = `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString() })}\n`
    await writeAtomicSafeUtf8File(this.file(workspace), content, STATE_FILE_LABEL)
  }
}

/**
 * 目录里三种说明文件都不存在、且本应用没给这个目录生成过，才写入一份 AGENTS.md。
 * 写入走原子安全写（I8）：目标目录不能经过符号链接，目标文件以独占创建写临时文件
 * 再改名。已有说明的目录一律原样返回，绝不覆盖也绝不追加。
 *
 * 「只生成一次」是刻意的：客户把生成出来的 AGENTS.md 删掉，就是他不想要，
 * 下次打开不该再长回来。记录存在本应用的数据目录，不往客户目录放标记文件。
 */
export async function ensureProjectInstructions(options: {
  workspace: string
  template: string
  state?: ProjectInstructionsState
}): Promise<ProjectInstructionsResult> {
  const template = options.template
  if (!template.trim()) return { created: false, reason: 'no-template' }
  const workspace = path.resolve(options.workspace)
  if (options.state?.generated(workspace)) return { created: false, reason: 'already-generated' }
  const entries = fs.readdirSync(workspace)
  if (hasExistingProjectInstructions(entries)) return { created: false, reason: 'exists' }
  const target = path.join(workspace, GENERATED_PROJECT_INSTRUCTION_FILENAME)
  await writeAtomicSafeUtf8File(target, template, '项目说明 AGENTS.md')
  // 写成功之后才记。记完失败的话下一次打开会被「三种文件都存在」那一关挡住，
  // 除非客户当真把它删了 —— 那时再生成一次也还说得过去。
  await options.state?.remember(workspace)
  return { created: true }
}
