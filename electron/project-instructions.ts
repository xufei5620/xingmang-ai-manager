import fs from 'node:fs'
import path from 'node:path'
import { writeAtomicSafeUtf8File } from './safe-local-data'

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
  if (content.length > MAX_TEMPLATE_BYTES) throw new Error('项目说明模板超出安全上限')
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
  reason?: 'exists' | 'no-template'
}

/**
 * 目录里三种说明文件都不存在时，写入一份 AGENTS.md。写入走原子安全写（I8）：
 * 目标目录不能经过符号链接，目标文件以独占创建写临时文件再改名。已有说明的目录
 * 一律原样返回，绝不覆盖也绝不追加。
 */
export async function ensureProjectInstructions(options: {
  workspace: string
  template: string
}): Promise<ProjectInstructionsResult> {
  const template = options.template
  if (!template.trim()) return { created: false, reason: 'no-template' }
  const workspace = path.resolve(options.workspace)
  const entries = fs.readdirSync(workspace)
  if (hasExistingProjectInstructions(entries)) return { created: false, reason: 'exists' }
  const target = path.join(workspace, GENERATED_PROJECT_INSTRUCTION_FILENAME)
  await writeAtomicSafeUtf8File(target, template, '项目说明 AGENTS.md')
  return { created: true }
}
