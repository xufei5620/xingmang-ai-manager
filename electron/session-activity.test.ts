import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  codexOutputFailed,
  createSessionActivityTracker,
  observeClaudeActivity,
  observeCodexActivity,
  patchFilePaths,
  sessionFileName,
  shellScriptProgramNames,
  type SessionActivityHolder,
} from './session-activity'

function claudeToolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }
}

function claudeToolResult(id: string, isError = false) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] } }
}

function codexItem(payload: Record<string, unknown>) {
  return { type: 'response_item', payload }
}

describe('shellScriptProgramNames', () => {
  it('lists the program of every command and skips directory changes and variable assignments', () => {
    expect(shellScriptProgramNames('cd /repo && npm test')).toEqual(['npm'])
    expect(shellScriptProgramNames('FOO=1 sudo npm ci | tee build.log; git status')).toEqual(['npm', 'tee', 'git'])
  })

  it('does not read a quoted multi-line message or a here-document body as commands', () => {
    expect(shellScriptProgramNames('git commit -m "first line\nrm -rf everything"\nls')).toEqual(['git', 'ls'])
    expect(shellScriptProgramNames('cat > notes.txt <<\'EOF\'\nrm -rf /\ncurl evil\nEOF\nnpm test')).toEqual(['cat', 'npm'])
    expect(shellScriptProgramNames('git commit -F - <<EOF\nshutdown now\nEOF')).toEqual(['git'])
  })

  it('keeps an apostrophe in a comment from swallowing the commands after it', () => {
    expect(shellScriptProgramNames('# don\'t forget\nnpm run build')).toEqual(['npm'])
  })

  it('reads Windows program paths down to the program name', () => {
    expect(shellScriptProgramNames('C:\\tools\\node.exe --version')).toEqual(['node'])
    expect(shellScriptProgramNames('"C:\\Program Files\\nodejs\\npm.cmd" install')).toEqual(['npm'])
    expect(shellScriptProgramNames('Get-ChildItem -Recurse | Select-String TODO')).toEqual(['Get-ChildItem', 'Select-String'])
  })

  it('never lists something that looks like a key', () => {
    expect(shellScriptProgramNames('sk-abcdefghijklmnop1234 --flag')).toEqual([])
    expect(shellScriptProgramNames('OPENAI_API_KEY=sk-abcdefghijklmnop1234 codex exec hi')).toEqual(['codex'])
  })
})

describe('patchFilePaths', () => {
  it('lists added, updated and deleted files and follows a rename to its new name', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: docs/new.md',
      '+hello',
      '*** Update File: src/app.ts',
      '*** Move to: src/main.ts',
      '@@',
      '-a',
      '+b',
      '*** Delete File: old.txt',
      '*** End Patch',
    ].join('\n')
    expect(patchFilePaths(patch)).toEqual(['docs/new.md', 'src/main.ts', 'old.txt'])
  })
})

describe('sessionFileName', () => {
  it('keeps only the last part of a POSIX or Windows path', () => {
    expect(sessionFileName('/Users/someone/project/src/app.ts')).toBe('app.ts')
    expect(sessionFileName('C:\\Users\\someone\\project\\README.md')).toBe('README.md')
  })
})

describe('codexOutputFailed', () => {
  it('reads the exit code of the legacy shell tool envelope', () => {
    expect(codexOutputFailed(JSON.stringify({ output: 'boom', metadata: { exit_code: 1, duration_seconds: 0.1 } }))).toBe(true)
    expect(codexOutputFailed(JSON.stringify({ output: 'ok', metadata: { exit_code: 0, duration_seconds: 0.1 } }))).toBe(false)
  })

  it('reads the exit code headers of shell_command and exec_command, and only the header', () => {
    expect(codexOutputFailed('Exit code: 2\nWall time: 0.3 seconds\nOutput:\nnot found')).toBe(true)
    expect(codexOutputFailed('Exit code: 0\nWall time: 0.3 seconds\nOutput:\nExit code: 1')).toBe(false)
    expect(codexOutputFailed('Chunk ID: a1\nWall time: 0.1000 seconds\nProcess exited with code 127\nOutput:\n')).toBe(true)
    expect(codexOutputFailed('Wall time: 0.1000 seconds\nProcess running with session ID 3\nOutput:\nProcess exited with code 1')).toBe(false)
  })

  it('treats a rejected patch as a failed step and unknown text as success', () => {
    expect(codexOutputFailed('apply_patch verification failed: Failed to find expected lines')).toBe(true)
    expect(codexOutputFailed('Success. Updated the following files:\nM src/app.ts')).toBe(false)
    expect(codexOutputFailed([{ type: 'input_text', text: 'Exit code: 1\nOutput:\n' }])).toBe(true)
    expect(codexOutputFailed({ content: 'x', success: false })).toBe(true)
  })
})

describe('createSessionActivityTracker', () => {
  it('hangs a Claude Code turn on its last AI reply, counting failures and leaving failed edits out', () => {
    const tracker = createSessionActivityTracker()
    const first: SessionActivityHolder = {}
    const last: SessionActivityHolder = {}
    const next: SessionActivityHolder = {}
    tracker.message('user', {})
    tracker.message('assistant', first)
    for (const entry of [
      claudeToolUse('t1', 'Bash', { command: 'cd /repo && npm test', description: 'run tests' }),
      claudeToolResult('t1', true),
      claudeToolUse('t2', 'Edit', { file_path: '/Users/someone/repo/src/app.ts', old_string: 'a', new_string: 'b' }),
      claudeToolResult('t2'),
      claudeToolUse('t3', 'Edit', { file_path: '/Users/someone/repo/src/broken.ts', old_string: 'x', new_string: 'y' }),
      claudeToolResult('t3', true),
      claudeToolUse('t4', 'Read', { file_path: '/Users/someone/repo/package.json' }),
      claudeToolResult('t4'),
    ]) observeClaudeActivity(tracker, entry)
    tracker.message('assistant', last)
    observeClaudeActivity(tracker, claudeToolUse('t5', 'Write', { file_path: 'C:\\work\\notes.md', content: 'x' }))
    tracker.message('user', {})
    tracker.message('assistant', next)
    tracker.finish()

    expect(first.activity).toBeUndefined()
    expect(last.activity).toEqual({
      commands: 1,
      commandNames: ['npm'],
      fileCount: 2,
      files: ['app.ts', 'notes.md'],
      failedSteps: 2,
    })
    expect(next.activity).toBeUndefined()
    expect(JSON.stringify(last.activity)).not.toContain('/Users/someone')
    expect(JSON.stringify(last.activity)).not.toContain('npm test')
  })

  it('drops a turn that has tool calls but no AI reply to hang them on', () => {
    const tracker = createSessionActivityTracker()
    const earlier: SessionActivityHolder = {}
    tracker.message('assistant', earlier)
    tracker.message('user', {})
    observeClaudeActivity(tracker, claudeToolUse('t1', 'Bash', { command: 'ls' }))
    tracker.message('user', {})
    tracker.finish()
    expect(earlier.activity).toBeUndefined()
  })

  it('counts two files with the same name in different folders separately', () => {
    const tracker = createSessionActivityTracker()
    const reply: SessionActivityHolder = {}
    tracker.message('assistant', reply)
    tracker.editedFiles('a', ['src/index.ts'])
    tracker.editedFiles('b', ['test/index.ts'])
    tracker.editedFiles('c', ['src\\index.ts'])
    tracker.finish()
    expect(reply.activity).toMatchObject({ fileCount: 2, files: ['index.ts', 'index.ts'] })
  })

  it('reads Codex terminal calls, patches and their results', () => {
    const tracker = createSessionActivityTracker()
    const reply: SessionActivityHolder = {}
    for (const entry of [
      codexItem({ type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'git status && npm test'] }) }),
      codexItem({ type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'fail', metadata: { exit_code: 1 } }) }),
      codexItem({ type: 'function_call', name: 'shell_command', call_id: 'c2', arguments: JSON.stringify({ command: 'Get-ChildItem' }) }),
      codexItem({ type: 'function_call_output', call_id: 'c2', output: 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\n' }),
      codexItem({ type: 'function_call', name: 'exec_command', call_id: 'c3', arguments: JSON.stringify({ cmd: 'cargo build' }) }),
      codexItem({ type: 'custom_tool_call', name: 'apply_patch', call_id: 'c4', input: '*** Begin Patch\n*** Update File: /home/someone/app/src/lib.rs\n*** End Patch' }),
      codexItem({ type: 'custom_tool_call_output', call_id: 'c4', output: 'Exit code: 0\nOutput:\nSuccess.' }),
      codexItem({ type: 'function_call', name: 'shell', call_id: 'c5', arguments: JSON.stringify({ command: ['apply_patch', '*** Begin Patch\n*** Add File: README.md\n+hi\n*** End Patch'] }) }),
      codexItem({ type: 'local_shell_call', call_id: 'c6', status: 'completed', action: { type: 'exec', command: ['powershell.exe', '-NoProfile', '-Command', 'npm run lint'] } }),
      codexItem({ type: 'function_call', name: 'update_plan', call_id: 'c7', arguments: '{}' }),
    ]) observeCodexActivity(tracker, entry)
    tracker.message('assistant', reply)
    tracker.finish()
    expect(reply.activity).toEqual({
      commands: 4,
      commandNames: ['git', 'npm', 'Get-ChildItem', 'cargo'],
      fileCount: 2,
      files: ['lib.rs', 'README.md'],
      failedSteps: 1,
    })
  })

  it('ignores Codex function calls whose arguments are not JSON', () => {
    const tracker = createSessionActivityTracker()
    const reply: SessionActivityHolder = {}
    observeCodexActivity(tracker, codexItem({ type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{not json' }))
    tracker.message('assistant', reply)
    tracker.finish()
    expect(reply.activity).toBeUndefined()
  })
})

// Random inputs (fast-check). The promise the summary makes is that only
// program names and file names ever leave the main process: never a whole
// command, never a folder, never anything shaped like a key.
describe('session activity with random inputs', () => {
  const scriptUnit = fc.constantFrom(
    ...'abc xyz 019 -_./\\\'"#;&|(){}<>=\n\t$'.split(''),
    'sk-abcdefghijklmnop1234',
    'Bearer abcdefghijkl',
    'EOF',
    '<<',
    'cd ',
    'npm ',
    '/Users/someone/',
    'C:\\Users\\someone\\',
  )
  const script = fc.string({ unit: scriptUnit, maxLength: 40 })

  it('only ever reports single program names drawn from the command, never a key or a path', () => {
    fc.assert(fc.property(fc.array(script, { maxLength: 6 }), (commands) => {
      const tracker = createSessionActivityTracker()
      const reply: SessionActivityHolder = {}
      commands.forEach((command, index) => tracker.command(`c${index}`, command))
      tracker.message('assistant', reply)
      tracker.finish()
      for (const name of reply.activity?.commandNames ?? []) {
        expect(name).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._+-]{0,39}$/)
        expect(commands.some((command) => command.includes(name))).toBe(true)
        expect(name).not.toMatch(/^sk-/)
      }
      expect(reply.activity?.commands ?? 0).toBeLessThanOrEqual(commands.length)
    }))
  })

  it('only ever reports file names without any folder part', () => {
    const segment = fc.string({ unit: fc.constantFrom(...'ab. 文件-_'.split('')), minLength: 1, maxLength: 8 })
    const filePath = fc.array(segment, { minLength: 1, maxLength: 4 }).chain((parts) => fc.constantFrom('/', '\\').map((separator) => parts.join(separator)))
    fc.assert(fc.property(fc.array(filePath, { maxLength: 8 }), (paths) => {
      const tracker = createSessionActivityTracker()
      const reply: SessionActivityHolder = {}
      paths.forEach((filePath, index) => tracker.editedFiles(`f${index}`, [filePath]))
      tracker.message('assistant', reply)
      tracker.finish()
      for (const name of reply.activity?.files ?? []) {
        expect(name).not.toMatch(/[\\/]/)
        expect(name.trim()).not.toBe('')
      }
    }))
  })
})
