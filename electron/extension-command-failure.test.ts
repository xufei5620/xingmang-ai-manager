import { describe, expect, it } from 'vitest'
import {
  commandOutputMarker,
  extensionCommandFailure,
  extensionCommandFailureInMessage,
} from './extension-command-failure'

describe('extensionCommandFailure', () => {
  it('recognises a missing Git the way each platform says it', () => {
    for (const line of [
      'Error: Executable not found in $PATH: "git"',
      'Executable not found in $PATH: "git.exe"',
      'Error: spawn git ENOENT',
      "'git' is not recognized as an internal or external command,",
      'bash: git: command not found',
      'sh: git: not found',
    ]) {
      expect(extensionCommandFailure(line), line).toBe('gitMissing')
    }
  })

  it('reads a network error as GitHub being unreachable only when it names github.com', () => {
    for (const line of [
      "fatal: unable to access 'https://github.com/anthropics/claude-code.git/': Failed to connect to github.com port 443 after 21045 ms: Couldn't connect to server",
      "fatal: unable to access 'https://github.com/acme/market.git/': Could not resolve host: github.com",
      "fatal: unable to access 'https://github.com/acme/market.git/': Recv failure: Connection was reset",
      "fatal: unable to access 'https://github.com/acme/market.git/': GnuTLS recv error (-110): The TLS connection was non-properly terminated.",
      'ssh: connect to host github.com port 22: Connection timed out',
    ]) {
      expect(extensionCommandFailure(line), line).toBe('githubUnreachable')
    }
    expect(extensionCommandFailure("fatal: unable to access 'https://gitlab.com/acme/market.git/': Could not resolve host: gitlab.com")).toBeNull()
    expect(extensionCommandFailure('Cloning into github.com/acme/market')).toBeNull()
  })

  it('recognises a name that is already taken', () => {
    expect(extensionCommandFailure('MCP server demo already exists in local config')).toBe('nameTaken')
    expect(extensionCommandFailure('Error: Marketplace "acme" already exists')).toBe('nameTaken')
  })

  it('puts a missing Git ahead of the other two', () => {
    expect(extensionCommandFailure('github.com: spawn git ENOENT, target already exists')).toBe('gitMissing')
  })

  it('leaves everything else alone', () => {
    expect(extensionCommandFailure('Permission denied (publickey).')).toBeNull()
    expect(extensionCommandFailure('fatal: Could not read from remote repository.')).toBeNull()
    expect(extensionCommandFailure('')).toBeNull()
  })
})

describe('extensionCommandFailureInMessage', () => {
  it('only reads messages that carry command output from the main process', () => {
    expect(extensionCommandFailureInMessage(`命令执行失败（退出码 1）：claude${commandOutputMarker}MCP server demo already exists in local config）`))
      .toBe('nameTaken')
    // 别处的话碰巧带着同样的英文，不认成扩展失败。
    expect(extensionCommandFailureInMessage('Skill 已存在：demo already exists')).toBeNull()
    expect(extensionCommandFailureInMessage('spawn git ENOENT')).toBeNull()
  })
})
