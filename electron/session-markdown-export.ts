import { randomUUID } from 'node:crypto'
import { promises as fsPromises, type WriteStream } from 'node:fs'
import path from 'node:path'
import { finished } from 'node:stream/promises'

/**
 * 把一条对话记录导出成 Markdown，只留这一份写法。Codex 的导出（codex-sessions.ts）和
 * 其它工具的导出（provider-sessions.ts）原先各抄一遍，改一边容易忘另一边（#1073 第 4 条）。
 * 两边各自负责找到这条记录、把消息逐条读出来；文件放哪、叫什么、开头几行怎么写、
 * 不完整怎么标注、怎么落盘都在这里，两边导出的文件因此一字不差地同一个格式。
 */

export interface SessionMarkdownMessage {
  role: string
  text: string
}

export interface SessionMarkdownContent {
  messages: number
  /** 源记录超过读取上限或有读不出来的行，导出文件因此不完整。 */
  truncated: boolean
}

export interface SessionMarkdownExportRequest {
  destinationPath: string
  /** 目的地是已有的文件夹，或者没有扩展名时，在它下面用的文件名（`sessionMarkdownFileName`）。 */
  fileName: string
  title: string
  /**
   * 标题下面先列的几项，如工具名和会话 ID。值原样放进反引号、不转义，
   * 跟改成共用之前导出的文件保持一致。
   */
  identity: ReadonlyArray<readonly [label: string, value: string]>
  cwd?: string
  model?: string
  /** 助手消息的小标题：Codex 写「Codex」，其它工具写「AI」。 */
  assistantLabel: string
  writeMessages(write: (message: SessionMarkdownMessage) => Promise<void>): Promise<SessionMarkdownContent>
}

export interface SessionMarkdownExportResult extends SessionMarkdownContent {
  outputPath: string
}

export function sessionMarkdownFileName(title: string, fallbackStem: string, sessionId: string): string {
  const safe = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 80)
  return `${safe || fallbackStem}-${sessionId.slice(0, 8)}.md`
}

function markdownHeadingText(value: string, maximum = 160): string {
  // Titles and roles come from untrusted session content; a newline or '## '
  // fragment inside one would break the exported document structure, so
  // headings are collapsed to one bounded line.
  const cleaned = value.replace(/\s+/g, ' ').trim()
  return cleaned.length > maximum ? `${cleaned.slice(0, maximum)}…` : cleaned
}

function roleLabel(role: string, assistantLabel: string): string {
  if (role === 'user') return '用户'
  if (role === 'assistant') return assistantLabel
  if (role === 'developer') return '开发者指令'
  if (role === 'system') return '系统'
  return role || '其他'
}

async function writeChunk(output: WriteStream, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    output.write(text, 'utf8', (error) => error ? reject(error) : resolve())
  })
}

export async function exportSessionMarkdown(request: SessionMarkdownExportRequest): Promise<SessionMarkdownExportResult> {
  let outputPath = path.resolve(request.destinationPath)
  try {
    if ((await fsPromises.stat(outputPath)).isDirectory()) outputPath = path.join(outputPath, request.fileName)
  } catch {
    if (!path.extname(outputPath)) outputPath = path.join(outputPath, request.fileName)
  }
  if (path.extname(outputPath).toLowerCase() !== '.md') throw new Error('会话导出文件必须使用 .md 扩展名')
  await fsPromises.mkdir(path.dirname(outputPath), { recursive: true })
  // 先写同目录临时文件，成功后 rename 原子覆盖，避免失败时破坏用户已有文件。
  const tempPath = `${outputPath}.${randomUUID()}.tmp`
  const handle = await fsPromises.open(tempPath, 'wx', 0o600)
  const output = handle.createWriteStream({ encoding: 'utf8' })
  // 写不进去时（盘满、U 盘被拔），Node 除了把错误交给这一笔的回调，还会在流上发一次
  // error 事件；流上没人听，这个事件就成了主进程未捕获的异常，整个星芒直接闪退（11-18 复核
  // D14）。错误本身由写入回调和收尾的 finished 交回来，这里只负责让它有人听。
  output.on('error', () => undefined)
  try {
    await writeChunk(output, `# ${markdownHeadingText(request.title)}\n\n`)
    for (const [label, value] of request.identity) await writeChunk(output, `- ${label}：\`${value}\`\n`)
    if (request.cwd) await writeChunk(output, `- 项目文件夹：\`${request.cwd.replaceAll('`', '\\`')}\`\n`)
    if (request.model) await writeChunk(output, `- 模型：\`${request.model.replaceAll('`', '\\`')}\`\n`)
    await writeChunk(output, '\n---\n\n')
    const content = await request.writeMessages(async (message) => {
      await writeChunk(output, `## ${markdownHeadingText(roleLabel(message.role, request.assistantLabel))}\n\n${message.text}\n\n`)
    })
    // 用户拿导出文件当备份，缺了内容必须写在文件里，光在界面上提示不够。
    if (content.truncated) {
      await writeChunk(output, '> 注意：源会话超过安全读取上限或含有损坏记录，本导出文件已明确标记为不完整。\n')
    }
    // 等到文件真关上再改名：U 盘被拔时，写进去的最后几笔可能到关文件这一步才报错，
    // 只等写完就改名会把一份残缺的文件当成导出成功。
    output.end()
    await finished(output)
    await fsPromises.rename(tempPath, outputPath)
    return { outputPath, messages: content.messages, truncated: content.truncated }
  } catch (error) {
    output.destroy()
    // 先等句柄关上再删：Windows 上删一个还开着的文件，要等句柄关了它才真正消失。删不掉
    // （U 盘已经拔了）也照样报原来的错，界面才认得出「磁盘满了」这类原因。
    await finished(output).catch(() => undefined)
    await fsPromises.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}
