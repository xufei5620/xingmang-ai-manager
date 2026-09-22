import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_STATUS_LINE_SCRIPT_NAME,
  applyClaudeStatusLine,
  buildClaudeStatusLineCommand,
  isManagedClaudeStatusLine,
  resolveClaudeStatusLineScriptPath,
} from './claude-status-line'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-status-line-'))
  temporaryDirectories.push(directory)
  return directory
}

function plantScript(root: string): string {
  const directory = path.join(root, 'bundled-catalog', 'cli-status-line')
  fs.mkdirSync(directory, { recursive: true })
  const scriptPath = path.join(directory, CLAUDE_STATUS_LINE_SCRIPT_NAME)
  fs.writeFileSync(scriptPath, '', 'utf8')
  return scriptPath
}

afterEach(() => {
  while (temporaryDirectories.length) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true })
  }
})

describe('resolveClaudeStatusLineScriptPath', () => {
  it('prefers the packaged resources copy that an external node can read', () => {
    const resourcesPath = temporaryDirectory()
    const appPath = temporaryDirectory()
    const packagedScript = plantScript(resourcesPath)
    plantScript(appPath)

    expect(resolveClaudeStatusLineScriptPath(appPath, { packaged: true, resourcesPath }))
      .toBe(packagedScript)
  })

  it('falls back to the checkout copy during development', () => {
    const appPath = temporaryDirectory()
    const script = plantScript(appPath)

    expect(resolveClaudeStatusLineScriptPath(appPath)).toBe(script)
  })

  it('returns null when the script was not shipped', () => {
    expect(resolveClaudeStatusLineScriptPath(temporaryDirectory())).toBeNull()
  })
})

describe('buildClaudeStatusLineCommand', () => {
  const node = path.resolve('/managed/node/node')
  const script = path.resolve('/app/resources/bundled-catalog/cli-status-line/', CLAUDE_STATUS_LINE_SCRIPT_NAME)

  it('quotes both paths so a directory with spaces still runs', () => {
    const scriptWithSpace = path.resolve('/app dir/resources', CLAUDE_STATUS_LINE_SCRIPT_NAME)
    expect(buildClaudeStatusLineCommand(node, scriptWithSpace))
      .toBe(`"${node}" "${scriptWithSpace}"`)
  })

  it('builds the command from two absolute paths', () => {
    expect(buildClaudeStatusLineCommand(node, script)).toBe(`"${node}" "${script}"`)
  })

  it.each([
    ['a double quote', path.resolve('/app/"quoted"', CLAUDE_STATUS_LINE_SCRIPT_NAME)],
    ['a dollar sign', path.resolve('/app/$HOME', CLAUDE_STATUS_LINE_SCRIPT_NAME)],
    ['a backtick', path.resolve('/app/`whoami`', CLAUDE_STATUS_LINE_SCRIPT_NAME)],
    ['a percent sign', path.resolve('/app/%USERNAME%', CLAUDE_STATUS_LINE_SCRIPT_NAME)],
  ])('refuses a script path containing %s', (_label, unsafeScript) => {
    expect(buildClaudeStatusLineCommand(node, unsafeScript)).toBeNull()
  })

  it('refuses a node executable the shell could expand', () => {
    expect(buildClaudeStatusLineCommand(path.resolve('/opt/$TOOLS/node'), script)).toBeNull()
  })

  it('refuses relative or empty paths', () => {
    expect(buildClaudeStatusLineCommand('node', script)).toBeNull()
    expect(buildClaudeStatusLineCommand(node, '   ')).toBeNull()
  })
})

describe('applyClaudeStatusLine', () => {
  const command = `"/managed/node" "/app/${CLAUDE_STATUS_LINE_SCRIPT_NAME}"`

  it('writes the status line when the user has none', () => {
    const parsed: Record<string, unknown> = {}
    applyClaudeStatusLine(parsed, command)
    expect(parsed.statusLine).toEqual({ type: 'command', command })
  })

  it('leaves a status line the user configured untouched', () => {
    const own = { type: 'command', command: '~/my-statusline.sh', padding: 0 }
    const parsed: Record<string, unknown> = { statusLine: { ...own } }
    applyClaudeStatusLine(parsed, command)
    expect(parsed.statusLine).toEqual(own)
  })

  it('refreshes our own status line after the app moved, keeping the rest of the entry', () => {
    const parsed: Record<string, unknown> = {
      statusLine: { type: 'command', command: `"/old/node" "/old/${CLAUDE_STATUS_LINE_SCRIPT_NAME}"`, padding: 0 },
    }
    applyClaudeStatusLine(parsed, command)
    expect(parsed.statusLine).toEqual({ type: 'command', command, padding: 0 })
  })

  it('does not touch a non-object status line', () => {
    const parsed: Record<string, unknown> = { statusLine: 'my-statusline.sh' }
    applyClaudeStatusLine(parsed, command)
    expect(parsed.statusLine).toBe('my-statusline.sh')
  })

  it('recognises only our own command as managed', () => {
    expect(isManagedClaudeStatusLine({ type: 'command', command })).toBe(true)
    expect(isManagedClaudeStatusLine({ type: 'command', command: 'ccstatusline' })).toBe(false)
    expect(isManagedClaudeStatusLine({ command })).toBe(false)
    expect(isManagedClaudeStatusLine(null)).toBe(false)
    expect(isManagedClaudeStatusLine([{ type: 'command', command }])).toBe(false)
  })
})

// The shipped script is plain CommonJS run by an external node, so it is
// exercised the same way Claude Code runs it: spawn it and write the payload
// to stdin. The fixture is the real 2.1.278 payload captured from the CLI.
describe('the shipped status line script', () => {
  const scriptPath = path.join(__dirname, '..', 'bundled-catalog', 'cli-status-line', CLAUDE_STATUS_LINE_SCRIPT_NAME)

  function run(input: unknown): string {
    return execFileSync(process.execPath, [scriptPath], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      encoding: 'utf8',
    })
  }

  const payload = {
    session_id: 'f2a0',
    cwd: path.join(os.homedir(), 'demo'),
    model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
    workspace: { current_dir: path.join(os.homedir(), 'demo'), project_dir: path.join(os.homedir(), 'demo') },
    version: '2.1.278',
    context_window: {
      total_input_tokens: 24000,
      total_output_tokens: 400,
      context_window_size: 200000,
      current_usage: null,
      used_percentage: 12,
      remaining_percentage: 88,
    },
    exceeds_200k_tokens: false,
  }

  it('shows the model, the directory and the context share on one line', () => {
    expect(run(payload)).toBe('Opus 4.6 · ~/demo · 上下文 12%')
  })

  it('warns once the context is nearly full', () => {
    const output = run({ ...payload, context_window: { ...payload.context_window, used_percentage: 86 } })
    expect(output).toBe('Opus 4.6 · ~/demo · 上下文 86%（接近上限，会自动压缩）')
  })

  it('computes the share itself when the CLI reports no percentage yet', () => {
    const output = run({
      ...payload,
      context_window: { ...payload.context_window, used_percentage: null, total_input_tokens: 40000 },
    })
    expect(output).toBe('Opus 4.6 · ~/demo · 上下文 20%')
  })

  it('falls back to the model id and drops the context segment when fields are missing', () => {
    expect(run({ model: { id: 'claude-sonnet-5' }, cwd: path.join(os.homedir(), 'demo') }))
      .toBe('claude-sonnet-5 · ~/demo')
  })

  it('prints nothing instead of failing on input it cannot read', () => {
    expect(run('not json at all')).toBe('')
    expect(run([1, 2, 3])).toBe('')
    expect(run({})).toBe('')
  })

  it('shortens a deep directory from the left', () => {
    const deep = path.join(os.homedir(), 'a'.repeat(20), 'b'.repeat(20), 'project')
    const output = run({ ...payload, workspace: { current_dir: deep } })
    expect(output).toContain('…')
    expect(output).toContain('project')
    expect(output.split(' · ')[1].length).toBeLessThanOrEqual(33)
  })
})
