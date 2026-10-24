import { describe, expect, it } from 'vitest'
import { CommandRunnerError } from './command-runner'
import { commandOutputTail, withCommandOutput } from './extension-command-output'

function commandFailure(stderr: string, stdout = ''): CommandRunnerError {
  return new CommandRunnerError('命令执行失败（退出码 1）：claude', {
    code: 'EXIT_NON_ZERO',
    executable: 'claude',
    argv: ['plugin', 'marketplace', 'add', 'anthropics/claude-plugins-official'],
    exitCode: 1,
    signal: null,
    stdout,
    stderr,
    outputBytes: stderr.length + stdout.length,
    maxOutputBytes: 1024 * 1024,
    durationMs: 10,
  })
}

describe('commandOutputTail', () => {
  it('keeps the last three lines when nothing in them is recognised', () => {
    expect(commandOutputTail(commandFailure('Usage: claude\n\n  one\n  two\nthree\n'))).toBe('one / two / three')
  })

  it('falls back to stdout when stderr is empty', () => {
    expect(commandOutputTail(commandFailure('', 'only stdout\n'))).toBe('only stdout')
  })

  it('picks the recognised lines out of a long git transcript, shortest first', () => {
    const stderr = [
      'Cloning via HTTPS: https://github.com/anthropics/claude-plugins-official.git',
      "fatal: unable to access 'https://github.com/anthropics/claude-plugins-official.git/': Failed to connect to github.com port 443 after 21045 ms: Couldn't connect to server",
      'Cloning via SSH: git@github.com:anthropics/claude-plugins-official.git',
      'ssh: connect to host github.com port 22: Connection timed out',
      'fatal: Could not read from remote repository.',
      '',
      'Please make sure you have the correct access rights',
      'and the repository exists.',
    ].join('\n')

    expect(commandOutputTail(commandFailure(stderr))).toBe(
      'ssh: connect to host github.com port 22: Connection timed out / '
      + "fatal: unable to access 'https://github.com/anthropics/claude-plugins-official.git/': Failed to connect to github.com port 443 after 21045 ms: Couldn't connect to server",
    )
  })

  it('caps what goes on screen at 240 characters', () => {
    expect(commandOutputTail(commandFailure(`${'x'.repeat(500)}\n`))).toHaveLength(240)
  })

  it('has nothing to add for errors that are not command failures', () => {
    expect(commandOutputTail(new Error('boom'))).toBe('')
    expect(commandOutputTail(commandFailure('  \n'))).toBe('')
  })
})

describe('withCommandOutput', () => {
  it('appends the output and keeps the original failure as the cause', () => {
    const failure = commandFailure('Error: Executable not found in $PATH: "git"\n')
    const wrapped = withCommandOutput(failure)

    expect(wrapped).toBeInstanceOf(Error)
    expect((wrapped as Error).message).toBe('命令执行失败（退出码 1）：claude（命令输出：Error: Executable not found in $PATH: "git"）')
    expect((wrapped as Error).cause).toBe(failure)
  })

  it('returns anything without command output unchanged', () => {
    const plain = new Error('boom')
    expect(withCommandOutput(plain)).toBe(plain)
    const silent = commandFailure('')
    expect(withCommandOutput(silent)).toBe(silent)
    expect(withCommandOutput('text')).toBe('text')
  })
})
