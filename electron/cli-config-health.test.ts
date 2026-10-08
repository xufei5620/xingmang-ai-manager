import { describe, expect, it } from 'vitest'
import { isClaudeSettingsBroken, isCodexAuthBroken, isGeminiSettingsBroken } from './cli-config-health'

const gbkWord = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])

function bytes(text: string): Buffer {
  return Buffer.from(text, 'utf8')
}

function withGbkValue(prefix: string, suffix: string): Buffer {
  return Buffer.concat([bytes(prefix), gbkWord, bytes(suffix)])
}

const claudeSettings = JSON.stringify({
  env: { ANTHROPIC_AUTH_TOKEN: 'sk-relay', ANTHROPIC_BASE_URL: 'https://xm.solov.cc', DISABLE_AUTOUPDATER: '1' },
  permissions: { defaultMode: 'bypassPermissions', deny: ['WebSearch'] },
  model: 'claude-opus-4-6',
}, null, 2)

const geminiSettings = JSON.stringify({
  general: { enableAutoUpdate: false },
  security: { auth: { selectedType: 'gemini-api-key' } },
}, null, 2)

const chatgptLogin = JSON.stringify({
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: { id_token: 'a.b.c', access_token: 'access', refresh_token: 'refresh', account_id: 'acct' },
  last_refresh: '2026-10-06T11:45:02.618826Z',
}, null, 2)

describe('isClaudeSettingsBroken', () => {
  // Claude Code 2.1.277 reads every one of these and applies the env block.
  it('accepts what Claude Code itself reads', () => {
    for (const content of [
      bytes(claudeSettings),
      bytes(`﻿${claudeSettings}`),
      bytes(claudeSettings.replace(/\n/g, '\r\n')),
      bytes('{"model": "a", "model": "claude-opus-4-6"}'),
      withGbkValue('{"note": "', '", "model": "claude-opus-4-6"}'),
      bytes(''),
      bytes(' \n\t'),
      bytes('{"env": {"X": 1, "Y": null, "Z": {"a": true}}}'),
      bytes('{"somethingNew": [1, 2]}'),
      bytes('{"env": {"A": "\\ud800"}}'),
    ]) expect(isClaudeSettingsBroken(content)).toBe(false)
  })

  // Each of these makes Claude Code 2.1.277 show "Settings Error" and skip the whole file.
  it('reports what Claude Code skips as a whole', () => {
    for (const text of [
      claudeSettings.replace(/\n}$/, ',\n}'),
      `// note\n${claudeSettings}`,
      `/* note */\n${claudeSettings}`,
      claudeSettings.slice(0, -20),
      '\u0000'.repeat(200),
      '{"env": {"A": "a\u0001b"}}',
      '[]',
      'null',
      '"x"',
      '1',
      '{"env": "oops"}',
      '{"env": null}',
      '{"env": []}',
      '{"permissions": "all"}',
      '{"permissions": null}',
      '{"permissions": []}',
      '{"permissions": {"deny": "Bash"}}',
      '{"model": null}',
      '{"model": 4}',
    ]) expect(isClaudeSettingsBroken(bytes(text)), text).toBe(true)
  })
})

describe('isGeminiSettingsBroken', () => {
  // Gemini CLI 0.60.0 strips comments before parsing and keeps the last duplicate.
  it('accepts what Gemini CLI itself reads', () => {
    for (const content of [
      bytes(geminiSettings),
      bytes(`// 我的设置\n${geminiSettings}`),
      bytes('{\n  /* auth */ "security": {"auth": {"selectedType": "gemini-api-key"}}\n}'),
      bytes('{"a": 1, "a": 2}'),
      withGbkValue('{"note": "', '"}'),
      bytes(geminiSettings.replace(/\n/g, '\r\n')),
      bytes('{"general": "not an object"}'),
    ]) expect(isGeminiSettingsBroken(content)).toBe(false)
  })

  // Each of these makes Gemini CLI 0.60.0 print "Error in …settings.json" and exit with 52.
  it('reports what Gemini CLI refuses to start with', () => {
    for (const text of [
      `﻿${geminiSettings}`,
      geminiSettings.replace(/\n}$/, ',\n}'),
      geminiSettings.slice(0, -10),
      '',
      '   \n',
      '\u0000'.repeat(64),
      '[]',
      'null',
    ]) expect(isGeminiSettingsBroken(bytes(text)), JSON.stringify(text)).toBe(true)
  })
})

describe('isCodexAuthBroken', () => {
  // Codex 0.159.0-alpha.12.1 reads each of these as a login.
  it('accepts what Codex itself reads', () => {
    for (const content of [
      bytes(JSON.stringify({ OPENAI_API_KEY: 'sk-relay' }, null, 2)),
      bytes(chatgptLogin),
      bytes(chatgptLogin.replace(/\n/g, '\r\n')),
      bytes('{"OPENAI_API_KEY": "sk-relay", "tokens": null, "auth_mode": null}'),
      bytes('{"OPENAI_API_KEY": "sk-relay", "note": 1, "note": 2}'),
      bytes('{"OPENAI_API_KEY": "  sk-relay  ", "nested": {"a": [1, 2]}}'),
    ]) expect(isCodexAuthBroken(content)).toBe(false)
  })

  // Codex 0.159.0-alpha.12.1 cannot read these and silently treats the user as logged out.
  it('reports what Codex silently treats as logged out', () => {
    for (const content of [
      bytes('{"OPENAI_API_KEY": "sk-test-re'),
      Buffer.alloc(200),
      bytes(''),
      bytes('   \n\t '),
      bytes(`﻿${JSON.stringify({ OPENAI_API_KEY: 'sk-relay' })}`),
      bytes('{"OPENAI_API_KEY": "sk-relay",}'),
      withGbkValue('{"OPENAI_API_KEY": "sk-relay", "note": "', '"}'),
      bytes('[]'),
      bytes('null'),
      bytes('"sk-relay"'),
      bytes('{"OPENAI_API_KEY": "sk-a", "OPENAI_API_KEY": "sk-relay"}'),
      bytes(`// note\n${JSON.stringify({ OPENAI_API_KEY: 'sk-relay' })}`),
      bytes('{"OPENAI_API_KEY": 1}'),
      bytes('{"OPENAI_API_KEY": true}'),
      bytes('{"OPENAI_API_KEY": {"k": "v"}}'),
      bytes('{"OPENAI_API_KEY": "sk-relay", "auth_mode": 1}'),
      bytes('{"OPENAI_API_KEY": "sk-relay", "last_refresh": "yesterday"}'),
      bytes('{"OPENAI_API_KEY": "sk-relay", "last_refresh": 5}'),
      bytes('{"OPENAI_API_KEY": "sk-relay", "tokens": "x"}'),
      bytes(`${JSON.stringify({ OPENAI_API_KEY: 'sk-relay' })}\n\u0000`),
    ]) expect(isCodexAuthBroken(content), content.toString('utf8')).toBe(true)
  })
})
