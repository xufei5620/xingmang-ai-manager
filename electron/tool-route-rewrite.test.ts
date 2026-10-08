import { describe, expect, it } from 'vitest'
import { readEnvLineValue, readJsonString, readTomlString, rewriteEnvValue, rewriteJsonStrings, rewriteTomlStrings } from './tool-route-rewrite'

const fromUrl = 'https://xm.solov.cc/v1'
const toUrl = 'https://xm-direct.solov.cc/v1'

describe('tool-route-rewrite', () => {
  it('changes only the addressed TOML string and keeps comments, order and blank lines', () => {
    const content = [
      '# 我自己加的注释 https://xm.solov.cc/v1',
      'model_provider = "XingmangAI"',
      'model = "gpt-5.5"',
      '',
      '[model_providers.XingmangAI]',
      'name = "XingmangAI"',
      `base_url = "${fromUrl}"   # 星芒`,
      'wire_api = "responses"',
      '',
    ].join('\n')
    const next = rewriteTomlStrings(content, [{ path: ['model_providers', 'XingmangAI', 'base_url'], value: toUrl }])
    expect(next).toBe(content.replace(`base_url = "${fromUrl}"`, `base_url = "${toUrl}"`))
  })

  it('finds a value under a quoted or dotted table name', () => {
    const content = `model_provider = "my relay"\nmodel_providers."my relay".base_url = '${fromUrl}'\n`
    const next = rewriteTomlStrings(content, [{ path: ['model_providers', 'my relay', 'base_url'], value: toUrl }])
    expect(next).toBe(`model_provider = "my relay"\nmodel_providers."my relay".base_url = '${toUrl}'\n`)
  })

  it('tells two keys holding the same address apart', () => {
    const content = [
      '[models]', 'default = "mine"', '',
      '[model.mine]', `base_url = "${fromUrl}"`, '',
      '[endpoints]', `xai_api_base_url = "${fromUrl}"`, '',
    ].join('\n')
    const only = rewriteTomlStrings(content, [{ path: ['model', 'mine', 'base_url'], value: toUrl }])
    expect(readTomlString(only ?? '', ['model', 'mine', 'base_url'])).toBe(toUrl)
    expect(readTomlString(only ?? '', ['endpoints', 'xai_api_base_url'])).toBe(fromUrl)
    const both = rewriteTomlStrings(content, [
      { path: ['model', 'mine', 'base_url'], value: toUrl },
      { path: ['endpoints', 'xai_api_base_url'], value: toUrl },
    ])
    expect(both).toBe(content.split(fromUrl).join(toUrl))
  })

  it('refuses when the value cannot be located or the file does not parse', () => {
    expect(rewriteTomlStrings('a = 1\n', [{ path: ['model_providers', 'x', 'base_url'], value: toUrl }])).toBeNull()
    expect(rewriteTomlStrings('base_url = """\nhttps://xm.solov.cc/v1"""\n', [{ path: ['base_url'], value: toUrl }])).toBeNull()
    expect(rewriteTomlStrings('[broken\n', [{ path: ['a'], value: toUrl }])).toBeNull()
    expect(rewriteTomlStrings('a = 1\n', [{ path: ['a'], value: toUrl }])).toBeNull()
  })

  it('keeps a byte order mark and leaves an already-current value untouched', () => {
    const content = `﻿[t]\nbase_url = "${fromUrl}"\r\n`
    expect(rewriteTomlStrings(content, [{ path: ['t', 'base_url'], value: toUrl }])).toBe(`﻿[t]\nbase_url = "${toUrl}"\r\n`)
    expect(rewriteTomlStrings(content, [{ path: ['t', 'base_url'], value: fromUrl }])).toBe(content)
  })

  it('rewrites a JSON value without reformatting the file', () => {
    const content = '{\n    "env": {"ANTHROPIC_BASE_URL": "https://xm.solov.cc", "OTHER": "https://xm.solov.cc"},\n  "model": "x"\n}\n'
    const next = rewriteJsonStrings(content, [{ path: ['env', 'ANTHROPIC_BASE_URL'], value: 'https://xm-direct.solov.cc' }])
    expect(next).toBe('{\n    "env": {"ANTHROPIC_BASE_URL": "https://xm-direct.solov.cc", "OTHER": "https://xm.solov.cc"},\n  "model": "x"\n}\n')
    expect(readJsonString(next ?? '', ['env', 'OTHER'])).toBe('https://xm.solov.cc')
    expect(rewriteJsonStrings('{ // comment\n}', [{ path: ['env', 'ANTHROPIC_BASE_URL'], value: toUrl }])).toBeNull()
  })

  it('rewrites the first matching .env line and keeps its quoting and line endings', () => {
    const content = '# keep\r\n  GOOGLE_GEMINI_BASE_URL = "https://xm.solov.cc"  \r\nGEMINI_API_KEY=sk-test\r\nGOOGLE_GEMINI_BASE_URL=https://other.example\r\n'
    // `名字 =` 带空格的那行 readEnvValue 也不认，认的是后面那行。
    expect(readEnvLineValue(rewriteEnvValue(content, 'GOOGLE_GEMINI_BASE_URL', 'https://xm-direct.solov.cc') ?? '', 'GOOGLE_GEMINI_BASE_URL')).toBe('https://xm-direct.solov.cc')
    expect(readEnvLineValue(content, 'GOOGLE_GEMINI_BASE_URL')).toBe('https://other.example')
    const spaced = '# keep\r\n  GOOGLE_GEMINI_BASE_URL="https://xm.solov.cc"  \r\nGEMINI_API_KEY=sk-test\r\nGOOGLE_GEMINI_BASE_URL=https://other.example\r\n'
    const next = rewriteEnvValue(spaced, 'GOOGLE_GEMINI_BASE_URL', 'https://xm-direct.solov.cc')
    expect(next).toBe('# keep\r\n  GOOGLE_GEMINI_BASE_URL="https://xm-direct.solov.cc"  \r\nGEMINI_API_KEY=sk-test\r\nGOOGLE_GEMINI_BASE_URL=https://other.example\r\n')
    expect(readEnvLineValue(next ?? '', 'GOOGLE_GEMINI_BASE_URL')).toBe('https://xm-direct.solov.cc')
    expect(rewriteEnvValue("A='x'\n", 'A', 'y')).toBe("A='y'\n")
    expect(rewriteEnvValue('B=x\n', 'A', 'y')).toBeNull()
    expect(rewriteEnvValue('A=x\n', 'A', 'y"z')).toBeNull()
  })
})
