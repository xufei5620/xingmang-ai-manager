import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as TOML from '@iarna/toml'
import { afterEach, describe, expect, it } from 'vitest'
import { providerBaseUrls } from './catalog'
import { codexConfigSnapshotPaths, saveProviderConfig } from './config-files'

const homes: string[] = []

function fixture(content: string) {
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-provider-isolation-'))
  homes.push(userHome)
  const roots = { userHome, codexHome: path.join(userHome, '.codex') }
  fs.mkdirSync(roots.codexHome)
  const config = path.join(roots.codexHome, 'config.toml')
  fs.writeFileSync(config, content)
  return { roots, config }
}

function readConfig(file: string) {
  return TOML.parse(fs.readFileSync(file, 'utf8'))
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    if (path.dirname(home) !== os.tmpdir() || !path.basename(home).startsWith('xingmang-provider-isolation-')) throw new Error('Unsafe fixture cleanup')
    fs.rmSync(home, { recursive: true, force: true })
  }
})

describe('Codex relay provider isolation', () => {
  it.each(['openai', 'ollama', 'lmstudio'])('does not redefine the built-in %s provider', (provider) => {
    const original = `model_provider = "${provider}"\nmodel = "original"\n[projects."C:/project"]\ntrust_level = "untrusted"\n`
    const { roots, config } = fixture(original)
    saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'merge', roots, {}, providerBaseUrls)
    const parsed = readConfig(config)
    expect(parsed.model_provider).toBe('XingmangAI')
    expect(parsed.model_providers).toEqual({ XingmangAI: expect.objectContaining({ base_url: providerBaseUrls.codex, wire_api: 'responses' }) })
    expect(parsed.projects).toEqual({ 'C:/project': { trust_level: 'untrusted' } })
    expect(fs.readFileSync(codexConfigSnapshotPaths(roots).chatgpt, 'utf8')).toBe(original)
  })

  it('allocates a free relay identifier without overwriting unselected user tables', () => {
    const original = '[model_providers.OpenAI]\nbase_url = "https://user.example/v1"\n[model_providers.XingmangAI]\nbase_url = "https://other.example/v1"\n[model_providers.XingmangAI-2]\nbase_url = "https://third.example/v1"\n'
    const { roots, config } = fixture(original)
    saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'merge', roots, {}, providerBaseUrls)
    const parsed = readConfig(config)
    expect(parsed.model_provider).toBe('XingmangAI-3')
    expect(parsed.model_providers).toEqual({
      ...readConfig(codexConfigSnapshotPaths(roots).chatgpt).model_providers as object,
      'XingmangAI-3': expect.objectContaining({ base_url: providerBaseUrls.codex }),
    })
    saveProviderConfig('codex', 'fixture-key-2', 'next-model', 'merge', roots, {}, providerBaseUrls)
    expect(readConfig(config).model_provider).toBe('XingmangAI-3')
    expect(Object.keys(readConfig(config).model_providers as object)).toHaveLength(4)
  })

  it('migrates a reserved relay table without dropping its provider options', () => {
    const { roots, config } = fixture('model_provider = "openai"\n[model_providers.openai]\nbase_url = "https://xm.solov.cc/v1"\nrequest_max_retries = 2\n')
    saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'merge', roots, {}, providerBaseUrls)
    expect(readConfig(config).model_providers).toEqual({
      XingmangAI: expect.objectContaining({ base_url: providerBaseUrls.codex, request_max_retries: 2 }),
    })
  })

  it.each(['openai', 'custom'])('rejects foreign reserved tables without modifying the %s profile', (active) => {
    const original = `model_provider = "${active}"\n[model_providers.openai]\nbase_url = "https://private.example/v1"\nenv_key = "PRIVATE_KEY"\n`
    const { roots, config } = fixture(original)
    expect(() => saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'merge', roots, {}, providerBaseUrls))
      .toThrow('占用了内置名称 openai')
    expect(fs.readFileSync(config, 'utf8')).toBe(original)
    expect(fs.existsSync(codexConfigSnapshotPaths(roots).chatgpt)).toBe(false)
    const reset = saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'reset', roots, {}, providerBaseUrls)
    expect(reset.backups.some((backup) => fs.readFileSync(backup, 'utf8') === original)).toBe(true)
    expect((readConfig(config).model_providers as Record<string, unknown>).openai).toBeUndefined()
  })

  it('backs up a reserved profile before an explicit reset', () => {
    const original = 'model_provider = "openai"\ncustom_setting = "preserve-in-backup"\n'
    const { roots, config } = fixture(original)
    const result = saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'reset', roots, {}, providerBaseUrls)
    expect(readConfig(config).model_provider).toBe('XingmangAI')
    expect(result.backups.some((backup) => fs.readFileSync(backup, 'utf8') === original)).toBe(true)
  })

  it('rolls back active and snapshot files when provider migration fails', () => {
    const original = 'model_provider = "openai"\n'
    const { roots, config } = fixture(original)
    expect(() => saveProviderConfig('codex', 'fixture-key', 'fixture-model', 'merge', roots, {
      beforeReplace: (_target, index) => { if (index === 1) throw new Error('fixture failure') },
    }, providerBaseUrls)).toThrow('fixture failure')
    expect(fs.readFileSync(config, 'utf8')).toBe(original)
    expect(fs.existsSync(codexConfigSnapshotPaths(roots).chatgpt)).toBe(false)
  })
})
