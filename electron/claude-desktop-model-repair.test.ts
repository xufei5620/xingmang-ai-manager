import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClaudeDesktopConfigService } from './claude-desktop-config'
import { runClaudeDesktopModelRepair } from './claude-desktop-model-repair'

const commitFailure = vi.hoisted(() => ({ remaining: 0 }))
const recordFailure = vi.hoisted(() => ({ enabled: false }))
vi.mock('./safe-local-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./safe-local-data')>()
  return {
    ...actual,
    writeAtomicSafeUtf8File: async (...args: Parameters<typeof actual.writeAtomicSafeUtf8File>) => {
      if (recordFailure.enabled) throw new Error('Claude Desktop 型号清单修复记录写入失败')
      return actual.writeAtomicSafeUtf8File(...args)
    },
  }
})
vi.mock('./claude-desktop-local-transaction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./claude-desktop-local-transaction')>()
  return {
    ...actual,
    commitClaudeDesktopFiles: (...args: Parameters<typeof actual.commitClaudeDesktopFiles>) => {
      if (commitFailure.remaining > 0) {
        commitFailure.remaining--
        throw new Error('Claude Desktop 第三方推理配置未完成，原配置已保留或恢复')
      }
      return actual.commitClaudeDesktopFiles(...args)
    },
  }
})

const temporaryDirectories: string[] = []
const relayBaseUrls = ['https://xm.solov.cc', 'https://api.solov.cc']
const legacyModels = ['claude-sonnet-5', 'claude-fable-5', 'claude-opus-5-5']

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-claude-desktop-repair-'))
  temporaryDirectories.push(directory)
  const dataDirectory = path.join(directory, 'toolbox')
  const userHome = path.join(directory, 'home')
  const profileDirectory = path.join(directory, 'claude-data')
  const options = { platform: process.platform, userHome, env: { CLAUDE_USER_DATA_DIR: profileDirectory }, relayBaseUrls }
  const markerPath = path.join(dataDirectory, 'migrations', 'claude-desktop-single-model-v1.json')
  const desktop = createClaudeDesktopConfigService({ dataDirectory, profileDirectory })
  return { dataDirectory, profileDirectory, options, markerPath, desktop }
}
function models(filePath: string): unknown {
  return (JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>).inferenceModels
}

afterEach(() => {
  commitFailure.remaining = 0
  recordFailure.enabled = false
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('runClaudeDesktopModelRepair', () => {
  it('repairs the 0.2.12 model list once and only reads its own record afterwards', async () => {
    const f = fixture()
    const saved = await f.desktop.saveGateway({ baseUrl: 'https://xm.solov.cc', apiKey: 'sk-fixture', models: legacyModels })
    const report = await runClaudeDesktopModelRepair(f.dataDirectory, f.options)
    expect(report).toEqual({ skipped: false, repaired: 1, backups: 1, unrecognized: [], failures: [] })
    expect(models(saved.path)).toEqual(['claude-sonnet-5'])
    expect(fs.readFileSync(f.markerPath, 'utf8')).toBe('{"version":1,"completed":true}\n')

    // Even if a later downgrade writes the list again, the one-time repair stays done.
    await f.desktop.saveGateway({ baseUrl: 'https://xm.solov.cc', apiKey: 'sk-fixture', models: legacyModels })
    const again = await runClaudeDesktopModelRepair(f.dataDirectory, f.options)
    expect(again).toMatchObject({ skipped: true, repaired: 0 })
    expect(models(saved.path)).toEqual(legacyModels)
  })

  it('finishes the check without writing anything into Claude when the toolbox never configured it', async () => {
    const f = fixture()
    const report = await runClaudeDesktopModelRepair(f.dataDirectory, f.options)
    expect(report).toEqual({ skipped: false, repaired: 0, backups: 0, unrecognized: [], failures: [] })
    expect(fs.existsSync(f.profileDirectory)).toBe(false)
    expect(fs.readFileSync(f.markerPath, 'utf8')).toBe('{"version":1,"completed":true}\n')
  })

  it('reports lists it cannot vouch for without touching them and does not look again', async () => {
    const f = fixture()
    const saved = await f.desktop.saveGateway({ baseUrl: 'https://xm.solov.cc', apiKey: 'sk-fixture', models: ['claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5'] })
    const before = fs.readFileSync(saved.path, 'utf8')
    expect(await runClaudeDesktopModelRepair(f.dataDirectory, f.options)).toMatchObject({ repaired: 0, unrecognized: ['model-list'], failures: [] })
    expect(fs.readFileSync(saved.path, 'utf8')).toBe(before)
    expect(fs.readFileSync(f.markerPath, 'utf8')).toBe('{"version":1,"completed":true}\n')
  })

  it('retries a failed write on the next two launches and then stops trying', async () => {
    const f = fixture()
    const saved = await f.desktop.saveGateway({ baseUrl: 'https://xm.solov.cc', apiKey: 'sk-fixture', models: legacyModels })
    commitFailure.remaining = 3
    const first = await runClaudeDesktopModelRepair(f.dataDirectory, f.options)
    expect(first).toMatchObject({ skipped: false, repaired: 0, failures: [expect.stringContaining('未完成')] })
    expect(fs.readFileSync(f.markerPath, 'utf8')).toBe('{"version":1,"attempts":1}\n')
    expect(await runClaudeDesktopModelRepair(f.dataDirectory, f.options)).toMatchObject({ skipped: false, repaired: 0 })
    expect(fs.readFileSync(f.markerPath, 'utf8')).toBe('{"version":1,"attempts":2}\n')
    expect(await runClaudeDesktopModelRepair(f.dataDirectory, f.options)).toMatchObject({ skipped: false, repaired: 0 })
    expect(fs.readFileSync(f.markerPath, 'utf8')).toBe('{"version":1,"completed":true}\n')
    expect(await runClaudeDesktopModelRepair(f.dataDirectory, f.options)).toMatchObject({ skipped: true })
    expect(models(saved.path)).toEqual(legacyModels)
  })

  it('repairs on a later launch when an earlier attempt could not write', async () => {
    const f = fixture()
    const saved = await f.desktop.saveGateway({ baseUrl: 'https://xm.solov.cc', apiKey: 'sk-fixture', models: legacyModels })
    commitFailure.remaining = 1
    expect(await runClaudeDesktopModelRepair(f.dataDirectory, f.options)).toMatchObject({ repaired: 0, failures: [expect.any(String)] })
    expect(await runClaudeDesktopModelRepair(f.dataDirectory, f.options)).toMatchObject({ repaired: 1, failures: [] })
    expect(models(saved.path)).toEqual(['claude-sonnet-5'])
    expect(fs.readFileSync(f.markerPath, 'utf8')).toBe('{"version":1,"completed":true}\n')
  })

  it('still reports a finished repair when its record cannot be written, and settles on the next launch', async () => {
    const f = fixture()
    const saved = await f.desktop.saveGateway({ baseUrl: 'https://xm.solov.cc', apiKey: 'sk-fixture', models: legacyModels })
    recordFailure.enabled = true
    const report = await runClaudeDesktopModelRepair(f.dataDirectory, f.options)
    expect(report).toMatchObject({ skipped: false, repaired: 1, failures: [expect.stringContaining('修复记录')] })
    expect(models(saved.path)).toEqual(['claude-sonnet-5'])
    expect(fs.existsSync(f.markerPath)).toBe(false)
    recordFailure.enabled = false
    expect(await runClaudeDesktopModelRepair(f.dataDirectory, f.options)).toEqual({ skipped: false, repaired: 0, backups: 0, unrecognized: [], failures: [] })
    expect(fs.readFileSync(f.markerPath, 'utf8')).toBe('{"version":1,"completed":true}\n')
  })

  // Windows needs a privilege to create the link; the refusal itself is the same safe-local-data check there.
  it.runIf(process.platform !== 'win32')('retries instead of giving up when the profile cannot be read safely this time', async () => {
    const f = fixture()
    const saved = await f.desktop.saveGateway({ baseUrl: 'https://xm.solov.cc', apiKey: 'sk-fixture', models: legacyModels })
    const real = `${saved.path}.real`
    fs.renameSync(saved.path, real)
    fs.symlinkSync(real, saved.path)
    expect(await runClaudeDesktopModelRepair(f.dataDirectory, f.options)).toMatchObject({ repaired: 0, unrecognized: [], failures: [expect.any(String)] })
    expect(fs.readFileSync(f.markerPath, 'utf8')).toBe('{"version":1,"attempts":1}\n')
    expect(models(real)).toEqual(legacyModels)
    fs.rmSync(saved.path)
    fs.renameSync(real, saved.path)
    expect(await runClaudeDesktopModelRepair(f.dataDirectory, f.options)).toMatchObject({ repaired: 1, failures: [] })
    expect(models(saved.path)).toEqual(['claude-sonnet-5'])
  })

  it('changes nothing when its own record is damaged', async () => {
    const f = fixture()
    const saved = await f.desktop.saveGateway({ baseUrl: 'https://xm.solov.cc', apiKey: 'sk-fixture', models: legacyModels })
    fs.mkdirSync(path.dirname(f.markerPath), { recursive: true })
    fs.writeFileSync(f.markerPath, '{"version":1,"attempts":7}\n', 'utf8')
    await expect(runClaudeDesktopModelRepair(f.dataDirectory, f.options)).rejects.toThrow('损坏')
    expect(models(saved.path)).toEqual(legacyModels)
  })
})
