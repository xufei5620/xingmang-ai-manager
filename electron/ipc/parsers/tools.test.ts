import { describe, expect, it } from 'vitest'
import {
  parseCliInstallVersion,
  parseCodexResumeRecordId,
  parseConfigSavePayload,
  parseRunningToolsProviders,
  parseWorkspace,
} from './tools'

const sessionUuid = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('parseConfigSavePayload', () => {
  it('forwards the key exactly as typed for an active tool', () => {
    expect(parseConfigSavePayload({ provider: 'codex', apiKey: ' sk-test ', model: 'gpt-6-astra', mode: 'merge' }))
      .toEqual({ provider: 'codex', apiKey: ' sk-test ', model: 'gpt-6-astra', mode: 'merge' })
  })

  it('rejects a retired or unknown tool before any config file is touched', () => {
    for (const provider of ['gemini', 'cursor', undefined]) {
      expect(() => parseConfigSavePayload({ provider, apiKey: 'sk-test', model: 'm', mode: 'merge' })).toThrow('未知的 CLI 类型')
    }
  })

  it('rejects a key that is not a string or is oversized', () => {
    for (const apiKey of [undefined, 42, { value: 'sk' }, 'k'.repeat(4_097)]) {
      expect(() => parseConfigSavePayload({ provider: 'claude', apiKey, model: 'm', mode: 'merge' })).toThrow('API Key 格式错误')
    }
  })

  it('rejects an unknown save mode', () => {
    expect(() => parseConfigSavePayload({ provider: 'claude', apiKey: 'sk', model: 'm', mode: 'overwrite' })).toThrow('配置保存方式错误')
  })
})

describe('parseCodexResumeRecordId', () => {
  it('accepts only a Codex record id when resuming Codex', () => {
    expect(parseCodexResumeRecordId('codex', 'resumeLast', `codex:${sessionUuid}`)).toBe(`codex:${sessionUuid}`)
    expect(parseCodexResumeRecordId('codex', 'resumeLast', undefined)).toBeNull()
  })

  it('rejects a record id for another tool or for a new conversation', () => {
    expect(() => parseCodexResumeRecordId('claude', 'resumeLast', `codex:${sessionUuid}`)).toThrow('CLI 启动方式错误')
    expect(() => parseCodexResumeRecordId('codex', 'new', `codex:${sessionUuid}`)).toThrow('CLI 启动方式错误')
  })

  it('rejects ids that are not a bare session uuid, so nothing else reaches argv', () => {
    for (const recordId of [sessionUuid, `claude:${sessionUuid}`, 'codex:../../etc/passwd', `codex:${sessionUuid} --dangerously-bypass`, 42]) {
      expect(() => parseCodexResumeRecordId('codex', 'resumeLast', recordId)).toThrow('会话 ID 格式错误')
    }
  })
})

describe('parseCliInstallVersion', () => {
  it('accepts an exact version and treats a missing one as the recommended version', () => {
    expect(parseCliInstallVersion('2.1.302')).toBe('2.1.302')
    expect(parseCliInstallVersion(undefined)).toBeUndefined()
    expect(parseCliInstallVersion(null)).toBeUndefined()
  })

  it('rejects tags, ranges and anything shaped like an npm argument', () => {
    for (const version of ['latest', '^2.1.0', '2.1.x', ' 2.1.302', '--registry=https://evil.invalid', '2.1.302 --force', 2]) {
      expect(() => parseCliInstallVersion(version)).toThrow('CLI 版本号格式错误')
    }
  })
})

describe('parseWorkspace', () => {
  it('trims the folder and falls back when it is blank or missing', () => {
    expect(parseWorkspace('  /home/user/project  ', '/fallback')).toBe('/home/user/project')
    expect(parseWorkspace('   ', '/fallback')).toBe('/fallback')
    expect(parseWorkspace(undefined, '/fallback')).toBe('/fallback')
  })

  it('rejects a path longer than Windows allows', () => {
    expect(() => parseWorkspace('a'.repeat(32_768), '/fallback')).toThrow('工作目录格式错误')
  })
})

describe('parseRunningToolsProviders', () => {
  it('keeps known tools once each and rejects retired ones', () => {
    expect(parseRunningToolsProviders(['codex', 'codex', 'claude'])).toEqual(['codex', 'claude'])
    expect(() => parseRunningToolsProviders(['gemini'])).toThrow('未知的 CLI 类型')
    expect(() => parseRunningToolsProviders('codex')).toThrow('工具列表格式错误')
  })
})
