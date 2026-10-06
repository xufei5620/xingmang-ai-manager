import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildClearProviderOverridesScript,
  clearUserProviderOverrides,
  isDiagnosticFixKind,
  parseClearProviderOverridesOutput,
  setAsideCodexDotenv,
  setAsideHomeProjectInstructions,
} from './diagnostic-fixes'
import { clearableEnvironmentOverrides } from './diagnostics'
import { readProjectInstructionsTemplate } from './project-instructions'

const temporary: string[] = []
function codexHome() {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xingmang-dotenv-'))
  temporary.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('diagnostic fix kinds', () => {
  it('accepts only the known fixes from the renderer', () => {
    expect(isDiagnosticFixKind('set-aside-codex-dotenv')).toBe(true)
    expect(isDiagnosticFixKind('clear-user-overrides')).toBe(true)
    expect(isDiagnosticFixKind('set-aside-home-agents-md')).toBe(true)
    for (const value of ['clear-user-proxy', '../.env', '../AGENTS.md', '', null, 1]) expect(isDiagnosticFixKind(value)).toBe(false)
  })
})

describe('setAsideCodexDotenv', () => {
  it('renames the Codex .env next to itself instead of deleting it', () => {
    const home = codexHome()
    fs.writeFileSync(path.join(home, '.env'), 'OPENAI_API_KEY=sk-other\n')
    const result = setAsideCodexDotenv(home, new Date(2026, 8, 30, 18, 5, 9))
    expect(result).toEqual({ kind: 'set-aside-codex-dotenv', fixed: 1, machineRemaining: false })
    expect(fs.existsSync(path.join(home, '.env'))).toBe(false)
    expect(fs.readFileSync(path.join(home, '.env.xingmang-20260930-180509.bak'), 'utf8')).toBe('OPENAI_API_KEY=sk-other\n')
  })

  it('never overwrites an earlier set-aside copy', () => {
    const home = codexHome()
    const now = new Date(2026, 8, 30, 18, 5, 9)
    fs.writeFileSync(path.join(home, '.env.xingmang-20260930-180509.bak'), 'first\n')
    fs.writeFileSync(path.join(home, '.env'), 'second\n')
    setAsideCodexDotenv(home, now)
    expect(fs.readFileSync(path.join(home, '.env.xingmang-20260930-180509.bak'), 'utf8')).toBe('first\n')
    expect(fs.readFileSync(path.join(home, '.env.xingmang-20260930-180509.bak.2'), 'utf8')).toBe('second\n')
  })

  it('reports nothing to do when the file is already gone', () => {
    expect(setAsideCodexDotenv(codexHome())).toEqual({ kind: 'set-aside-codex-dotenv', fixed: 0, machineRemaining: false })
  })

  it.runIf(process.platform !== 'win32')('refuses to move a hard-linked .env, which could redirect the rename', () => {
    const home = codexHome()
    const outside = path.join(codexHome(), 'secret')
    fs.writeFileSync(outside, 'x')
    fs.linkSync(outside, path.join(home, '.env'))
    expect(() => setAsideCodexDotenv(home)).toThrow()
    expect(fs.existsSync(path.join(home, '.env'))).toBe(true)
  })
})

describe('setAsideHomeProjectInstructions', () => {
  const template = readProjectInstructionsTemplate(
    path.join(__dirname, '..', 'bundled-catalog', 'project-instructions', 'AGENTS.zh-CN.md'),
  )

  it('renames the AGENTS.md this app left in the home folder instead of deleting it', () => {
    const home = codexHome()
    fs.writeFileSync(path.join(home, 'AGENTS.md'), template, 'utf8')
    const result = setAsideHomeProjectInstructions(home, new Date(2026, 9, 6, 19, 30, 5))
    expect(result).toEqual({ kind: 'set-aside-home-agents-md', fixed: 1, machineRemaining: false })
    expect(fs.existsSync(path.join(home, 'AGENTS.md'))).toBe(false)
    expect(fs.readFileSync(path.join(home, 'AGENTS.md.xingmang-20261006-193005.bak'), 'utf8')).toBe(template)
  })

  it('never overwrites an earlier set-aside copy', () => {
    const home = codexHome()
    const now = new Date(2026, 9, 6, 19, 30, 5)
    fs.writeFileSync(path.join(home, 'AGENTS.md.xingmang-20261006-193005.bak'), 'first\n')
    fs.writeFileSync(path.join(home, 'AGENTS.md'), template, 'utf8')
    setAsideHomeProjectInstructions(home, now)
    expect(fs.readFileSync(path.join(home, 'AGENTS.md.xingmang-20261006-193005.bak'), 'utf8')).toBe('first\n')
    expect(fs.readFileSync(path.join(home, 'AGENTS.md.xingmang-20261006-193005.bak.2'), 'utf8')).toBe(template)
  })

  it('leaves a copy the customer edited since the check where it is, and says there is nothing to move', () => {
    const home = codexHome()
    fs.writeFileSync(path.join(home, 'AGENTS.md'), `${template}- 我自己的规矩\n`, 'utf8')
    expect(setAsideHomeProjectInstructions(home)).toEqual({ kind: 'set-aside-home-agents-md', fixed: 0, machineRemaining: false })
    expect(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8')).toBe(`${template}- 我自己的规矩\n`)
    expect(fs.readdirSync(home)).toEqual(['AGENTS.md'])
  })

  it('reports nothing to do when the file is already gone', () => {
    expect(setAsideHomeProjectInstructions(codexHome())).toEqual({ kind: 'set-aside-home-agents-md', fixed: 0, machineRemaining: false })
  })

  it.runIf(process.platform !== 'win32')('does not move a hard-linked copy, which could redirect the rename', () => {
    const home = codexHome()
    const outside = path.join(codexHome(), 'template.md')
    fs.writeFileSync(outside, template, 'utf8')
    fs.linkSync(outside, path.join(home, 'AGENTS.md'))
    expect(setAsideHomeProjectInstructions(home).fixed).toBe(0)
    expect(fs.existsSync(path.join(home, 'AGENTS.md'))).toBe(true)
  })
})

describe('clearable environment overrides', () => {
  const urls = { claude: 'https://relay.example', codex: 'https://relay.example/v1', gemini: 'https://relay.example', grok: 'https://relay.example/v1' }
  it('offers keys and foreign addresses but never the folders that hold the user\'s own config', () => {
    const env = {
      ANTHROPIC_API_KEY: 'sk-x',
      OPENAI_BASE_URL: 'https://other.example/v1',
      GOOGLE_GEMINI_BASE_URL: 'https://relay.example',
      CLAUDE_CONFIG_DIR: '/elsewhere/claude',
    }
    expect(clearableEnvironmentOverrides(env, urls, '/home/user')).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_BASE_URL'])
  })
})

describe('clearUserProviderOverrides', () => {
  it('passes the names through the environment, not the script, and drops only user-only values from this process', async () => {
    const seen: Array<{ script: string; names: string | undefined }> = []
    const processEnv: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'sk-x', OPENAI_BASE_URL: 'https://machine.example' }
    const result = await clearUserProviderOverrides({
      names: ['ANTHROPIC_API_KEY', 'OPENAI_BASE_URL', 'PATH'],
      platform: 'win32',
      processEnv,
      run: async (script, env) => {
        seen.push({ script, names: env.XINGMANG_CLEAR_OVERRIDES })
        return 'cleared:ANTHROPIC_API_KEY;OPENAI_BASE_URL\nmachine:OPENAI_BASE_URL\n'
      },
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].names).toBe('ANTHROPIC_API_KEY;OPENAI_BASE_URL')
    expect(seen[0].script).not.toContain('sk-')
    expect(result).toEqual({ kind: 'clear-user-overrides', fixed: 2, machineRemaining: true })
    expect(processEnv).toEqual({ OPENAI_BASE_URL: 'https://machine.example' })
  })

  it('does not start PowerShell when nothing on the allow-list is left to clear', async () => {
    let ran = false
    const result = await clearUserProviderOverrides({ names: ['PATH'], platform: 'win32', run: async () => { ran = true; return '' } })
    expect(ran).toBe(false)
    expect(result.fixed).toBe(0)
  })

  it('refuses outside Windows', async () => {
    await expect(clearUserProviderOverrides({ names: ['ANTHROPIC_API_KEY'], platform: 'darwin' })).rejects.toThrow('只有 Windows')
  })

  it('checks every name against the fixed allow-list inside the script as well', () => {
    const script = buildClearProviderOverridesScript()
    expect(script).toContain('$allowed = @(')
    expect(script).toContain('"ANTHROPIC_API_KEY"')
    expect(script).toContain('SetEnvironmentVariable($name, $null, "User")')
    expect(script).not.toContain('"Machine")\n    [Environment]::SetEnvironmentVariable')
  })

  it('rejects output it cannot read and ignores names outside the allow-list', () => {
    expect(() => parseClearProviderOverridesOutput('')).toThrow('没能确认')
    expect(parseClearProviderOverridesOutput('cleared:PATH;gemini_api_key\nmachine:\n')).toEqual({ cleared: ['GEMINI_API_KEY'], machine: [] })
  })
})
