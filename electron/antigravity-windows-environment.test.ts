import { describe, expect, it } from 'vitest'
import { antigravityGatewayVariableNames, buildAntigravityGatewayEnvironment } from './antigravity-gateway'
import {
  antigravityEnvironmentValueVariable,
  buildReadWindowsAntigravityEnvironmentScript,
  buildWriteWindowsAntigravityEnvironmentScript,
  parseReadAntigravityEnvironmentOutput,
  parseWriteAntigravityEnvironmentOutput,
  readWindowsAntigravityEnvironment,
  writeWindowsAntigravityEnvironment,
} from './antigravity-windows-environment'
import { splitConstrainedLanguageBranch } from './powershell-constrained-language.test-support'

const key = 'sk-0123456789abcdefABCDEF'
const environment = buildAntigravityGatewayEnvironment({
  baseUrl: 'https://xm.solov.cc',
  apiKey: key,
  models: ['gemini-3.8-flash', 'gemini-4-argon-high'],
})

describe('the Windows Antigravity environment scripts', () => {
  const write = buildWriteWindowsAntigravityEnvironmentScript()
  const read = buildReadWindowsAntigravityEnvironmentScript()

  it('take every value from the child environment and carry none in the script text', () => {
    for (const name of antigravityGatewayVariableNames) {
      expect(write).toContain(`$env:${antigravityEnvironmentValueVariable(name)}`)
    }
    for (const value of Object.values(environment)) {
      expect(write).not.toContain(value)
      expect(read).not.toContain(value)
    }
  })

  it('name only the four gateway variables, both ways', () => {
    for (const script of [write, read]) {
      const names = [...new Set(script.match(/'AGY_[A-Z_]+'/g) ?? [])]
      expect(names.sort()).toEqual(antigravityGatewayVariableNames.map((name) => `'${name}'`).sort())
    }
  })

  it('write only the current user and store plain strings', () => {
    expect(write).not.toMatch(/HKLM|LocalMachine|"Machine"/)
    expect(write).toContain('[Microsoft.Win32.RegistryValueKind]::String')
    expect(splitConstrainedLanguageBranch(write).branch).toContain('-PropertyType String -Force')
  })

  it('tell the system only after a change, in both language modes', () => {
    const parts = splitConstrainedLanguageBranch(write)
    for (const part of [parts.branch, parts.fullLanguage]) {
      const unchanged = part.indexOf('if (-not $changed) { "unchanged"; return }')
      expect(unchanged).toBeGreaterThan(0)
      const broadcast = Math.max(part.indexOf('XINGMANG_SETX_EXE'), part.indexOf('XINGMANG_ENVIRONMENT_REFRESH'))
      expect(broadcast).toBeGreaterThan(unchanged)
      expect(part.trimEnd().endsWith('"written"')).toBe(true)
    }
  })

  it('refuse to run with a missing value instead of writing an empty one', () => {
    const parts = splitConstrainedLanguageBranch(write)
    for (const part of [parts.branch, parts.fullLanguage]) {
      expect(part).toContain("foreach ($value in $values) { if (-not $value) { throw 'Missing value' } }")
    }
  })
})

describe('parseWriteAntigravityEnvironmentOutput', () => {
  it('reads the last word the script printed', () => {
    expect(parseWriteAntigravityEnvironmentOutput('noise\r\nwritten\r\n')).toBe('written')
    expect(parseWriteAntigravityEnvironmentOutput('unchanged')).toBe('unchanged')
  })

  it('refuses anything else', () => {
    expect(() => parseWriteAntigravityEnvironmentOutput('')).toThrow('无法确认 Antigravity 的连接设置是否已写入，请重试')
    expect(() => parseWriteAntigravityEnvironmentOutput('written\nsomething else')).toThrow()
  })
})

describe('parseReadAntigravityEnvironmentOutput', () => {
  it('keeps the four names whatever their case and only string values', () => {
    expect(parseReadAntigravityEnvironmentOutput('{"agy_llm_gateway_url":"https://xm.solov.cc","AGY_LLM_GATEWAY_MODELS":"a,b","AGY_LLM_GATEWAY_API_KEY":1,"PATH":"C:\\\\x"}'))
      .toEqual({ AGY_LLM_GATEWAY_URL: 'https://xm.solov.cc', AGY_LLM_GATEWAY_MODELS: 'a,b' })
  })

  it('reads an empty answer as nothing set', () => {
    expect(parseReadAntigravityEnvironmentOutput('{}\r\n')).toEqual({})
  })

  it.each(['', 'not json', '[]', 'null'])('refuses %j', (stdout) => {
    expect(() => parseReadAntigravityEnvironmentOutput(stdout)).toThrow('无法读取 Antigravity 的设置')
  })
})

describe('writeWindowsAntigravityEnvironment', () => {
  it('hands the values and setx to the script through its environment', async () => {
    let seen: NodeJS.ProcessEnv = {}
    let script = ''
    const outcome = await writeWindowsAntigravityEnvironment(environment, {
      platform: 'win32',
      run: async (text, env) => {
        script = text
        seen = env
        return 'written\r\n'
      },
    })
    expect(outcome).toBe('written')
    expect(script).toBe(buildWriteWindowsAntigravityEnvironmentScript())
    for (const name of antigravityGatewayVariableNames) {
      expect(seen[antigravityEnvironmentValueVariable(name)]).toBe(environment[name])
    }
    expect(seen.XINGMANG_SETX_EXE).toMatch(/setx\.exe$/i)
  })

  it('writes nothing when a value is missing or spans lines', async () => {
    let ran = false
    const run = async () => {
      ran = true
      return 'written'
    }
    await expect(writeWindowsAntigravityEnvironment({ ...environment, AGY_LLM_GATEWAY_MODELS: '' }, { platform: 'win32', run }))
      .rejects.toThrow('Antigravity 的连接设置不完整，未作任何修改')
    await expect(writeWindowsAntigravityEnvironment({ ...environment, AGY_LLM_GATEWAY_URL: 'https://xm.solov.cc\r\nX=1' }, { platform: 'win32', run }))
      .rejects.toThrow('Antigravity 的连接设置不完整')
    expect(ran).toBe(false)
  })

  it('runs only on Windows', async () => {
    await expect(writeWindowsAntigravityEnvironment(environment, { platform: 'darwin', run: async () => 'written' }))
      .rejects.toThrow('当前系统不支持此项设置')
  })
})

describe('readWindowsAntigravityEnvironment', () => {
  it('runs the read script and parses its answer', async () => {
    let script = ''
    const values = await readWindowsAntigravityEnvironment({
      platform: 'win32',
      run: async (text) => {
        script = text
        return '{"AGY_LLM_GATEWAY_WIRE_PROTOCOL":"genai"}'
      },
    })
    expect(script).toBe(buildReadWindowsAntigravityEnvironmentScript())
    expect(values).toEqual({ AGY_LLM_GATEWAY_WIRE_PROTOCOL: 'genai' })
  })
})
