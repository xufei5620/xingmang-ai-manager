import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupStaleDarwinCliDirectories,
  disposeStagedDarwinCliRecords,
  releaseStagedDarwinCli,
  stageVerifiedDarwinCli,
} from './darwin-cli-staging'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-darwin-stage-test-'))
  temporaryDirectories.push(directory)
  return directory
}

function sourceFixture() {
  const root = temporaryDirectory()
  const sourcePath = path.join(root, 'source-cli')
  fs.writeFileSync(sourcePath, '#!/bin/sh\n', { mode: 0o700 })
  const stats = fs.statSync(sourcePath, { bigint: true })
  return {
    root,
    sourcePath,
    sourceIdentity: {
      dev: stats.dev,
      ino: stats.ino,
      mode: stats.mode,
      size: stats.size,
      ctimeNs: stats.ctimeNs,
      mtimeNs: stats.mtimeNs,
    },
  }
}

afterEach(async () => {
  await disposeStagedDarwinCliRecords()
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.promises.rm(directory, { recursive: true, force: true })
  }
})

describe.runIf(process.platform === 'darwin')('private Darwin CLI staging lifecycle', () => {
  it('keeps one retained copy until both holders release the same file identity', async () => {
    const fixture = sourceFixture()
    let verifications = 0
    const stage = () => stageVerifiedDarwinCli({
      executableName: 'codex',
      sourcePath: fixture.sourcePath,
      sourceIdentity: fixture.sourceIdentity,
      retention: 'retained',
      baseDirectory: fixture.root,
      verify: async () => { verifications += 1 },
    })

    const first = await stage()
    const second = await stage()

    expect(second).toBe(first)
    expect(verifications).toBe(1)
    expect(fs.readdirSync(fixture.root).filter((name) => name.startsWith('xingmang-darwin-cli-'))).toHaveLength(1)

    await releaseStagedDarwinCli(second)

    expect(fs.existsSync(first)).toBe(true)
    await releaseStagedDarwinCli(first)
    expect(fs.existsSync(first)).toBe(false)
  })

  it('preserves the first holder when a second retained holder fails after acquisition', async () => {
    const fixture = sourceFixture()
    const stage = () => stageVerifiedDarwinCli({
      executableName: 'codex',
      sourcePath: fixture.sourcePath,
      sourceIdentity: fixture.sourceIdentity,
      retention: 'retained',
      baseDirectory: fixture.root,
      verify: async () => undefined,
    })
    const first = await stage()

    const failedAcquisition = async () => {
      let second: string | null = null
      try {
        second = await stage()
        throw new Error('post-stage validation failed')
      } catch (error) {
        if (second) await releaseStagedDarwinCli(second)
        throw error
      }
    }

    await expect(failedAcquisition()).rejects.toThrow('post-stage validation failed')
    expect(fs.existsSync(first)).toBe(true)

    await releaseStagedDarwinCli(first)
    expect(fs.existsSync(first)).toBe(false)
  })

  it('fails closed before a ninth active retained record creates a directory', async () => {
    const root = temporaryDirectory()
    const staged: string[] = []
    const stage = async (index: number) => {
      const sourcePath = path.join(root, `source-${index}`)
      fs.writeFileSync(sourcePath, `#!/bin/sh\n# ${index}\n`, { mode: 0o700 })
      const stats = fs.statSync(sourcePath, { bigint: true })
      return stageVerifiedDarwinCli({
        executableName: 'codex',
        sourcePath,
        sourceIdentity: {
          dev: stats.dev,
          ino: stats.ino,
          mode: stats.mode,
          size: stats.size,
          ctimeNs: stats.ctimeNs,
          mtimeNs: stats.mtimeNs,
        },
        retention: 'retained',
        baseDirectory: root,
        verify: async () => undefined,
      })
    }
    for (let index = 0; index < 8; index += 1) {
      staged.push(await stage(index))
    }
    const stagedDirectoryCount = () => fs.readdirSync(root)
      .filter((name) => name.startsWith('xingmang-darwin-cli-')).length
    let ninth: string | null = null
    let failure: unknown = null

    expect(stagedDirectoryCount()).toBe(8)
    try {
      ninth = await stage(8)
    } catch (error) {
      failure = error
    }

    expect.soft(failure).toBeInstanceOf(Error)
    expect.soft(failure instanceof Error ? failure.message : '').toContain('请重启应用后重试')
    expect.soft(stagedDirectoryCount()).toBe(8)

    await Promise.all([
      ...staged,
      ...(ninth ? [ninth] : []),
    ].map((executable) => releaseStagedDarwinCli(executable)))
    expect(stagedDirectoryCount()).toBe(0)
  })

  it('reserves the retained-record bound across concurrent unique acquisitions', async () => {
    const root = temporaryDirectory()
    const sources = Array.from({ length: 9 }, (_, index) => {
      const sourcePath = path.join(root, `concurrent-source-${index}`)
      fs.writeFileSync(sourcePath, `#!/bin/sh\n# ${index}\n`, { mode: 0o700 })
      const stats = fs.statSync(sourcePath, { bigint: true })
      return {
        sourcePath,
        sourceIdentity: {
          dev: stats.dev,
          ino: stats.ino,
          mode: stats.mode,
          size: stats.size,
          ctimeNs: stats.ctimeNs,
          mtimeNs: stats.mtimeNs,
        },
      }
    })
    const warmup = await stageVerifiedDarwinCli({
      executableName: 'warmup',
      ...sources[0],
      retention: 'ephemeral',
      baseDirectory: root,
      verify: async () => undefined,
    })
    await releaseStagedDarwinCli(warmup)

    const results = await Promise.allSettled(sources.map((source, index) => stageVerifiedDarwinCli({
      executableName: `codex-${index}`,
      ...source,
      retention: 'retained',
      baseDirectory: root,
      verify: async () => undefined,
    })))
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<string> => (
      result.status === 'fulfilled'
    ))
    const rejected = results.filter((result): result is PromiseRejectedResult => (
      result.status === 'rejected'
    ))

    expect(fulfilled).toHaveLength(8)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBeInstanceOf(Error)
    expect((rejected[0].reason as Error).message).toContain('请重启应用后重试')
    expect(fs.readdirSync(root).filter((name) => name.startsWith('xingmang-darwin-cli-'))).toHaveLength(8)

    await Promise.all(fulfilled.map(({ value }) => releaseStagedDarwinCli(value)))
  })

  it('removes an ephemeral selection when its waited consumer releases it', async () => {
    const fixture = sourceFixture()
    const executable = await stageVerifiedDarwinCli({
      executableName: 'grok',
      sourcePath: fixture.sourcePath,
      sourceIdentity: fixture.sourceIdentity,
      retention: 'ephemeral',
      baseDirectory: fixture.root,
      verify: async () => undefined,
    })
    const directory = path.dirname(executable)

    await releaseStagedDarwinCli(executable)

    expect(fs.existsSync(directory)).toBe(false)
  })

  it('disposes every staged record and clears retained reuse metadata', async () => {
    const fixture = sourceFixture()
    let verifications = 0
    const stageRetained = () => stageVerifiedDarwinCli({
      executableName: 'codex',
      sourcePath: fixture.sourcePath,
      sourceIdentity: fixture.sourceIdentity,
      retention: 'retained',
      baseDirectory: fixture.root,
      verify: async () => { verifications += 1 },
    })
    const retained = await stageRetained()
    const ephemeral = await stageVerifiedDarwinCli({
      executableName: 'grok',
      sourcePath: fixture.sourcePath,
      sourceIdentity: fixture.sourceIdentity,
      retention: 'ephemeral',
      baseDirectory: fixture.root,
      verify: async () => undefined,
    })
    try {
      await disposeStagedDarwinCliRecords()

      expect(fs.existsSync(path.dirname(retained))).toBe(false)
      expect(fs.existsSync(path.dirname(ephemeral))).toBe(false)

      const replacement = await stageRetained()
      expect(replacement).not.toBe(retained)
      expect(verifications).toBe(2)
      await releaseStagedDarwinCli(retained)
      expect(fs.existsSync(replacement)).toBe(true)
      await releaseStagedDarwinCli(replacement)
    } finally {
      await releaseStagedDarwinCli(retained)
      await releaseStagedDarwinCli(ephemeral)
    }
  })

  it('cleans a previous crashed process directory but preserves a live process directory', async () => {
    const root = temporaryDirectory()
    const stale = path.join(root, 'xingmang-darwin-cli-99999999-stale')
    const live = path.join(root, `xingmang-darwin-cli-${process.pid}-live`)
    fs.mkdirSync(stale, { mode: 0o700 })
    fs.mkdirSync(live, { mode: 0o700 })

    await cleanupStaleDarwinCliDirectories(root, (pid) => pid === process.pid)

    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.statSync(live).isDirectory()).toBe(true)
  })
  it('reclaims the slot and the directory when a retained copy fails revalidation', async () => {
    const fixture = sourceFixture()
    const stage = () => stageVerifiedDarwinCli({
      executableName: 'codex',
      sourcePath: fixture.sourcePath,
      sourceIdentity: fixture.sourceIdentity,
      retention: 'retained',
      baseDirectory: fixture.root,
      verify: async () => undefined,
    })

    const first = await stage()
    const firstDirectory = path.dirname(first)
    expect(fs.existsSync(firstDirectory)).toBe(true)

    // Remove the private copy so the cached record fails revalidation. The staged
    // file is 0500, so it is unlinked rather than rewritten; the source is untouched,
    // so the next call hits the same cache key and takes the invalidation path.
    fs.unlinkSync(first)

    const second = await stage()

    expect(second).not.toBe(first)
    expect(fs.existsSync(path.dirname(second))).toBe(true)
    // The invalidated record must not keep its directory alive. Releasing it
    // through the normal lease path would leave this true, because a retained
    // record's count never reaches zero.
    expect(fs.existsSync(firstDirectory)).toBe(false)
  })

  it('does not exhaust the retained slots when copies keep failing revalidation', async () => {
    const fixture = sourceFixture()
    const stage = () => stageVerifiedDarwinCli({
      executableName: 'codex',
      sourcePath: fixture.sourcePath,
      sourceIdentity: fixture.sourceIdentity,
      retention: 'retained',
      baseDirectory: fixture.root,
      verify: async () => undefined,
    })

    let staged = await stage()
    const directories = [path.dirname(staged)]
    // The cap is 8. Ten rounds would hit it if an invalidated record kept its slot.
    for (let round = 0; round < 10; round += 1) {
      fs.unlinkSync(staged)
      staged = await stage()
      directories.push(path.dirname(staged))
    }

    expect(fs.existsSync(staged)).toBe(true)
    // Only the newest directory survives; every superseded one was reclaimed.
    const surviving = directories.filter((directory) => fs.existsSync(directory))
    expect(surviving).toEqual([path.dirname(staged)])
  })
})
