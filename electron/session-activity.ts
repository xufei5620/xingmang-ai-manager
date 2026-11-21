import { redactSecretShapes } from './redaction-patterns'

// 记录详情里每一轮 AI 回复下面那行「这一轮：跑了 3 条命令，改了 2 个文件」（总单 Q4 C2）。
// 只从各工具自己写下的记录里读，跑过的命令只留程序名，改过的文件只留文件名：命令全文里
// 可能带着密钥，完整路径里有客户的用户名，这两样都不出主进程。

export interface SessionTurnActivity {
  /** 这一轮跑了几条命令（AI 调了几次终端），不管成没成功。 */
  commands: number
  /** 跑过的命令只留程序名（npm、git……），去重，按第一次出现排，最多 MAX_LISTED_COMMANDS 个。 */
  commandNames: string[]
  /** 这一轮改成了几个不同的文件。没成功的那几次不算。 */
  fileCount: number
  /** 改过的文件只留文件名，按第一次出现排，最多 MAX_LISTED_FILES 个；两个文件夹里的同名文件各占一个。 */
  files: string[]
  /** 跑命令、改文件里没成功的步数。 */
  failedSteps: number
}

/** 读记录时留下来的那条 AI 回复：这一轮结束时把摘要挂在它上面。 */
export interface SessionActivityHolder {
  activity?: SessionTurnActivity
}

export interface SessionActivityTracker {
  /** AI 调了一次终端。`command` 是整段脚本，或者 Codex 记下的那组参数。 */
  command(callId: string, command: string | readonly string[]): void
  /** AI 调了一次改文件的工具（一次可能改好几个）。 */
  editedFiles(callId: string, paths: readonly string[]): void
  /** 上面某一步的结果回来了。 */
  result(callId: string, failed: boolean): void
  /**
   * 读到一条显示出来的消息。你说的话开启新的一轮，前一轮的摘要挂在那一轮最后一条 AI 回复上；
   * 一轮里一句 AI 回复都没有（刚调完工具就被打断）时没有地方挂，这一轮就不显示。
   */
  message(role: string, holder: SessionActivityHolder | null): void
  /** 读完了：最后一轮也收尾。 */
  finish(): void
}

const MAX_LISTED_COMMANDS = 20
const MAX_LISTED_FILES = 50
// 一轮几千次工具调用已经不是正常对话了；再多的不记，免得一份坏记录把内存撑大。
const MAX_STEPS_PER_TURN = 5_000
const MAX_COMMAND_NAME_LENGTH = 40
const MAX_FILE_NAME_LENGTH = 120

// 包了一层的终端：真正跑的是 -c 后面那段脚本，名字要从脚本里取，不能只写一个 bash。
const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'powershell', 'pwsh', 'cmd'])
const SCRIPT_FLAGS = new Set(['-c', '-lc', '-ic', '-command', '/c', '/k'])
// 写在命令前面、本身不是要跑的那个程序的词。
const PREFIX_WORDS = new Set(['sudo', 'env', 'time', 'nohup', 'command', 'exec', 'nice', 'if', 'then', 'else', 'elif', 'while', 'until', 'do', '!'])
// 只是换目录、设变量、收尾的词，列出来只会让客户看不懂。
const IGNORED_WORDS = new Set([
  'cd', 'pushd', 'popd', 'export', 'set', 'unset', 'source', '.', 'true', 'false', 'exit', 'local',
  'fi', 'done', 'esac', 'for', 'case', 'in', 'function', 'return',
])
const PROGRAM_NAME = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/
const PATCH_FILE_LINE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/
const PATCH_MOVE_LINE = /^\*\*\* Move to: (.+)$/

interface ActivityStep {
  kind: 'command' | 'file'
  /** command：程序名；file：完整路径（只用来去重，出主进程前换成文件名）。 */
  names: string[]
  failed: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function looksSecret(value: string): boolean {
  return redactSecretShapes(value) !== value
}

/**
 * 路径最后一段。记录可能是另一种系统上写的，两种分隔符都认。最后一段只有空格时
 * 回空串：先整串去空格再切，会把 `src/ ` 认成 `src`，把文件夹名当文件名报出去。
 */
export function sessionFileName(filePath: string): string {
  const parts = filePath.split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1].trim() : ''
}

function presentableFileName(filePath: string): string | null {
  const name = sessionFileName(filePath).replace(/[\u0000-\u001f\u007f]/g, '')
  if (!name || looksSecret(name)) return null
  return name.length > MAX_FILE_NAME_LENGTH ? `${name.slice(0, MAX_FILE_NAME_LENGTH)}…` : name
}

function programName(token: string): string {
  return sessionFileName(token.replace(/^\(+/, '')).replace(/\.(?:exe|cmd|bat|com)$/i, '')
}

function presentableProgramName(token: string): string | null {
  const name = programName(token)
  if (!name || name.length > MAX_COMMAND_NAME_LENGTH || !PROGRAM_NAME.test(name)) return null
  if (IGNORED_WORDS.has(name.toLowerCase()) || looksSecret(name)) return null
  return name
}

/**
 * Splits a shell script into commands of words, honouring quotes, backslash
 * escapes and here-documents, so a multi-line commit message or a heredoc body
 * is never mistaken for a program. It is a reader for display, not a shell:
 * anything it cannot make sense of yields no name rather than a wrong one.
 */
export function splitShellCommands(script: string): string[][] {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | '\'' | null = null
  let heredocs: string[] = []

  function endWord(): void {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  function endCommand(): void {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }

  for (let index = 0; index < script.length; index += 1) {
    const char = script[index]
    if (quote) {
      if (char === quote) quote = null
      // Inside double quotes a backslash only escapes these four, as in sh;
      // before anything else it stays, which keeps "C:\Program Files\…" whole.
      else if (char === '\\' && quote === '"' && /["\\$`]/.test(script[index + 1] ?? '')) word += script[++index]
      else word += char
      continue
    }
    if (char === '\'' || char === '"') {
      quote = char
      inWord = true
      continue
    }
    if (char === '\\' && index + 1 < script.length) {
      const next = script[index + 1]
      // A backslash before a letter or digit is a Windows path separator
      // (PowerShell and cmd scripts are read here too), not an escape.
      if (/[A-Za-z0-9_.-]/.test(next)) {
        word += char
        inWord = true
        continue
      }
      index += 1
      if (next !== '\n') {
        word += next
        inWord = true
      }
      continue
    }
    if (char === '#' && !inWord) {
      // A comment runs to the end of the line; an apostrophe in it must not
      // open a quote that swallows the commands after it.
      const lineEnd = script.indexOf('\n', index)
      index = (lineEnd === -1 ? script.length : lineEnd) - 1
      continue
    }
    if (char === '<' && script[index + 1] === '<' && script[index + 2] !== '<') {
      const match = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(script.slice(index))
      if (match) {
        endWord()
        heredocs.push(match[2])
        index += match[0].length - 1
        continue
      }
    }
    if (char === '\n') {
      endCommand()
      // Here-document bodies start on the next line and run to a line that is
      // exactly the delimiter; none of it is a command.
      for (const delimiter of heredocs) {
        while (index + 1 < script.length) {
          const lineEnd = script.indexOf('\n', index + 1)
          const line = script.slice(index + 1, lineEnd === -1 ? script.length : lineEnd)
          index = lineEnd === -1 ? script.length : lineEnd
          if (line.trim() === delimiter) break
        }
      }
      heredocs = []
      continue
    }
    if (char === ';' || char === '&' || char === '|' || char === '(' || char === ')' || char === '{' || char === '}' || char === '\r') {
      endCommand()
      continue
    }
    if (/\s/.test(char)) {
      endWord()
      continue
    }
    word += char
    inWord = true
  }
  // A quote that never closes makes the shell refuse the line, so the
  // half-read command it swallowed ran nothing and names no program.
  if (quote) {
    words = []
    word = ''
    inWord = false
  }
  endCommand()
  return commands
}

/** 一段脚本里各条命令的程序名，按出现顺序，没去重。 */
export function shellScriptProgramNames(script: string): string[] {
  const names: string[] = []
  for (const words of splitShellCommands(script)) {
    let position = 0
    while (position < words.length) {
      const current = words[position]
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(current) || PREFIX_WORDS.has(current.toLowerCase())) {
        position += 1
        continue
      }
      break
    }
    if (position >= words.length) continue
    const name = presentableProgramName(words[position])
    // Quotes can glue a name together out of pieces (n'p'm); a name that is
    // not written out whole in the script is not shown rather than guessed.
    if (name && script.includes(name)) names.push(name)
  }
  return names
}

function unwrappedScript(argv: readonly string[]): string | null {
  if (argv.length < 3) return null
  if (!SHELL_WRAPPERS.has(programName(argv[0]).toLowerCase())) return null
  for (let index = 1; index < argv.length - 1; index += 1) {
    if (SCRIPT_FLAGS.has(argv[index].toLowerCase())) return argv.slice(index + 1).join(' ')
  }
  return null
}

/** Codex 的 apply_patch 补丁里写了哪些文件（改名的记新名字）。 */
export function patchFilePaths(patch: string): string[] {
  const paths: string[] = []
  for (const rawLine of patch.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const file = PATCH_FILE_LINE.exec(line)
    if (file) {
      paths.push(file[1].trim())
      continue
    }
    const moved = PATCH_MOVE_LINE.exec(line)
    if (moved && paths.length > 0) paths[paths.length - 1] = moved[1].trim()
  }
  return paths.filter(Boolean)
}

function isApplyPatchProgram(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === 'apply_patch' || lower === 'applypatch'
}

/**
 * 一次终端调用要怎么记：Codex 早先让模型用终端跑 apply_patch 改文件，那一次算改文件，
 * 不算跑命令。读不出程序名的照样算跑了一条命令，只是不列名字。
 */
function classifyCommand(command: string | readonly string[]): ActivityStep {
  if (typeof command !== 'string' && command.length > 0 && isApplyPatchProgram(programName(command[0]))) {
    return { kind: 'file', names: patchFilePaths(command.slice(1).join('\n')), failed: false }
  }
  const script = typeof command === 'string' ? command : unwrappedScript(command)
  if (script === null) {
    const argv = command as readonly string[]
    const name = argv.length > 0 ? presentableProgramName(argv[0]) : null
    return { kind: 'command', names: name ? [name] : [], failed: false }
  }
  const names = shellScriptProgramNames(script)
  if (names.length > 0 && isApplyPatchProgram(names[0]) && script.includes('*** Begin Patch')) {
    return { kind: 'file', names: patchFilePaths(script), failed: false }
  }
  return { kind: 'command', names, failed: false }
}

/** 一轮里记下的那些步，收成显示用的摘要；什么都没有就不挂。 */
function summarizeActivitySteps(steps: readonly ActivityStep[]): SessionTurnActivity | undefined {
  let commands = 0
  let failedSteps = 0
  const commandNames = new Set<string>()
  const files = new Map<string, string>()
  for (const step of steps) {
    if (step.failed) failedSteps += 1
    if (step.kind === 'command') {
      commands += 1
      for (const name of step.names) commandNames.add(name)
      continue
    }
    if (step.failed) continue
    for (const filePath of step.names) {
      const key = filePath.replace(/\\/g, '/')
      if (files.has(key)) continue
      const name = presentableFileName(filePath)
      if (name) files.set(key, name)
    }
  }
  if (commands === 0 && files.size === 0 && failedSteps === 0) return undefined
  return {
    commands,
    commandNames: [...commandNames].slice(0, MAX_LISTED_COMMANDS),
    fileCount: files.size,
    files: [...files.values()].slice(0, MAX_LISTED_FILES),
    failedSteps,
  }
}

export function createSessionActivityTracker(): SessionActivityTracker {
  let steps: ActivityStep[] = []
  let byCall = new Map<string, ActivityStep>()
  let lastAssistant: SessionActivityHolder | null = null

  function add(callId: string, step: ActivityStep): void {
    if (steps.length >= MAX_STEPS_PER_TURN) return
    steps.push(step)
    if (callId) byCall.set(callId, step)
  }
  function closeTurn(): void {
    const activity = summarizeActivitySteps(steps)
    if (activity && lastAssistant) lastAssistant.activity = activity
    steps = []
    byCall = new Map()
  }

  return {
    command(callId, command) {
      add(callId, classifyCommand(command))
    },
    editedFiles(callId, paths) {
      add(callId, { kind: 'file', names: paths.filter(Boolean), failed: false })
    },
    result(callId, failed) {
      const step = byCall.get(callId)
      if (step && failed) step.failed = true
    },
    message(role, holder) {
      if (role === 'user') {
        closeTurn()
        lastAssistant = null
      } else if (role === 'assistant') {
        lastAssistant = holder
      }
    },
    finish() {
      closeTurn()
    },
  }
}

/**
 * Claude Code 一行记一块：AI 调工具是 assistant 行里的 tool_use，结果是下一条 user 行里的
 * tool_result（is_error 标没成功）。终端是 Bash（Windows 上也可能是 PowerShell），
 * 改文件是 Edit / MultiEdit / Write / NotebookEdit。读文件、搜索这些不算。
 */
export function observeClaudeActivity(tracker: SessionActivityTracker, entry: Record<string, unknown>): void {
  const message = asRecord(entry.message)
  if (!message || !Array.isArray(message.content)) return
  for (const block of message.content) {
    const record = asRecord(block)
    if (!record) continue
    if (entry.type === 'assistant' && record.type === 'tool_use') {
      const callId = asString(record.id)
      const name = asString(record.name)
      const input = asRecord(record.input)
      if (name === 'Bash' || name === 'PowerShell') {
        const command = asString(input?.command)
        if (command.trim()) tracker.command(callId, command)
      } else if (name === 'Edit' || name === 'MultiEdit' || name === 'Write') {
        const file = asString(input?.file_path)
        if (file) tracker.editedFiles(callId, [file])
      } else if (name === 'NotebookEdit') {
        const file = asString(input?.notebook_path)
        if (file) tracker.editedFiles(callId, [file])
      }
    } else if (entry.type === 'user' && record.type === 'tool_result') {
      tracker.result(asString(record.tool_use_id), record.is_error === true)
    }
  }
}

function codexOutputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output.map((item) => asString(asRecord(item)?.text)).filter(Boolean).join('\n')
  }
  return asString(asRecord(output)?.content)
}

/**
 * Codex 不把「成没成功」写进记录（FunctionCallOutputPayload 只序列化正文），只能从交还给
 * 模型的那段文字里认。认得出的三种开头：老的 shell 工具回一段 JSON，带 metadata.exit_code；
 * shell_command 以「Exit code: N」开头；exec_command 在「Output:」之前写「Process exited with
 * code N」。apply_patch 没改成时回「apply_patch verification failed: …」一类的话。认不出的
 * 当成功，宁可少报一步没成功，也不把成功的说成失败。
 */
export function codexOutputFailed(output: unknown): boolean {
  const record = asRecord(output)
  if (record && typeof record.success === 'boolean') return !record.success
  const text = codexOutputText(output).trimStart()
  if (text.startsWith('{')) {
    try {
      const parsed = asRecord(JSON.parse(text))
      const exitCode = asRecord(parsed?.metadata)?.exit_code
      if (typeof exitCode === 'number') return exitCode !== 0
    } catch {
      // Not the legacy JSON envelope; fall through to the text headers.
    }
  }
  if (/^(?:apply_patch verification failed|failed to parse apply_patch)\b/i.test(text)) return true
  const header = text.split(/\r?\nOutput:/, 1)[0]
  const exit = /(?:^|\n)(?:Exit code:|Process exited with code) (-?\d+)/.exec(header)
  return exit !== null && Number(exit[1]) !== 0
}

function observeCodexFunctionCall(tracker: SessionActivityTracker, callId: string, name: string, rawArguments: string): void {
  let args: Record<string, unknown> | null = null
  try {
    args = asRecord(JSON.parse(rawArguments))
  } catch {
    return
  }
  if (!args) return
  if (name === 'shell' || name === 'container.exec') {
    const argv = stringArray(args.command)
    if (argv.length > 0) tracker.command(callId, argv)
  } else if (name === 'shell_command') {
    const command = asString(args.command)
    if (command.trim()) tracker.command(callId, command)
  } else if (name === 'exec_command') {
    const command = asString(args.cmd)
    if (command.trim()) tracker.command(callId, command)
  } else if (name === 'apply_patch') {
    tracker.editedFiles(callId, patchFilePaths(asString(args.input)))
  }
}

/**
 * Codex 的记录（rollout）里，调工具和结果都是 response_item：终端是 function_call（shell、
 * shell_command、exec_command）或 local_shell_call，改文件是 apply_patch（custom_tool_call，
 * 或早先的 function_call），结果是 function_call_output / custom_tool_call_output，靠 call_id 对上。
 */
export function observeCodexActivity(tracker: SessionActivityTracker, value: unknown): void {
  const entry = asRecord(value)
  if (!entry || entry.type !== 'response_item') return
  const payload = asRecord(entry.payload)
  if (!payload) return
  const callId = asString(payload.call_id) || asString(payload.id)
  if (payload.type === 'function_call') {
    observeCodexFunctionCall(tracker, callId, asString(payload.name), asString(payload.arguments))
  } else if (payload.type === 'custom_tool_call') {
    if (asString(payload.name) === 'apply_patch') tracker.editedFiles(callId, patchFilePaths(asString(payload.input)))
  } else if (payload.type === 'local_shell_call') {
    const argv = stringArray(asRecord(payload.action)?.command)
    if (argv.length > 0) tracker.command(callId, argv)
  } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    tracker.result(callId, codexOutputFailed(payload.output))
  }
}
