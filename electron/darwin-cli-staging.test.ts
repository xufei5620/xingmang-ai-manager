import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildOpenDarwinFilesProbeArgv,
  cleanupStaleDarwinCliDirectories,
  disposeDarwinCliStagingAtExit,
  disposeStagedDarwinCliRecords,
  listOpenDarwinFiles,
  parseOpenDarwinFilesProbeOutput,
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

function staleDirectoryFixture(root: string, name: string, executableName: string | null) {
  const directory = path.join(root, name)
  fs.mkdirSync(directory, { mode: 0o700 })
  const executable = executableName ? path.join(directory, executableName) : null
  if (executable) fs.writeFileSync(executable, '#!/bin/sh\n', { mode: 0o500 })
  return { directory, executable }
}

afterEach(async () => {
  await disposeStagedDarwinCliRecords()
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.promises.rm(directory, { recursive: true, force: true })
  }
})

describe('stale Darwin CLI staging cleanup', () => {
  const onlyThisProcessIsAlive = (pid: number) => pid === process.pid

  it('keeps a dead creator directory whose copy a terminal still runs and removes the unused one', async () => {
    const root = temporaryDirectory()
    const running = staleDirectoryFixture(root, 'xingmang-darwin-cli-99999991-run', 'grok')
    const finished = staleDirectoryFixture(root, 'xingmang-darwin-cli-99999992-old', 'codex')
    const probed: string[][] = []

    await cleanupStaleDarwinCliDirectories(root, onlyThisProcessIsAlive, async (files) => {
      probed.push([...files])
      // lsof may answer with the /private spelling of a /var/folders path.
      return [`/private${running.executable}`]
    })

    expect(probed).toHaveLength(1)
    expect([...probed[0]].sort()).toEqual([running.executable, finished.executable].sort())
    expect(fs.existsSync(running.executable!)).toBe(true)
    expect(fs.existsSync(finished.directory)).toBe(false)
  })

  it('keeps every directory holding a file when the open-file probe cannot tell', async () => {
    const root = temporaryDirectory()
    const staged = staleDirectoryFixture(root, 'xingmang-darwin-cli-99999993-unknown', 'grok')
    const empty = staleDirectoryFixture(root, 'xingmang-darwin-cli-99999994-empty', null)

    await cleanupStaleDarwinCliDirectories(root, onlyThisProcessIsAlive, async () => null)

    expect(fs.existsSync(staged.executable!)).toBe(true)
    expect(fs.existsSync(empty.directory)).toBe(false)
  })

  it('does not run the open-file probe when no dead creator left a file behind', async () => {
    const root = temporaryDirectory()
    const live = staleDirectoryFixture(root, `xingmang-darwin-cli-${process.pid}-live`, 'grok')
    const empty = staleDirectoryFixture(root, 'xingmang-darwin-cli-99999995-empty', null)
    let probes = 0

    await cleanupStaleDarwinCliDirectories(root, onlyThisProcessIsAlive, async () => {
      probes += 1
      return []
    })

    expect(probes).toBe(0)
    expect(fs.existsSync(live.executable!)).toBe(true)
    expect(fs.existsSync(empty.directory)).toBe(false)
  })

  it('does not match a directory whose name only shares a prefix with an open path', async () => {
    const root = temporaryDirectory()
    const staged = staleDirectoryFixture(root, 'xingmang-darwin-cli-99999996-ab', 'grok')

    await cleanupStaleDarwinCliDirectories(root, onlyThisProcessIsAlive, async () => [
      path.join(root, 'xingmang-darwin-cli-99999996-abc', 'grok'),
    ])

    expect(fs.existsSync(staged.directory)).toBe(false)
  })

  it('asks lsof for the named files only and reads back just the name fields', () => {
    expect(buildOpenDarwinFilesProbeArgv(['/tmp/a/grok', '-b'])).toEqual(['-w', '-F', 'n', '--', '/tmp/a/grok', '-b'])
    expect(parseOpenDarwinFilesProbeOutput('p123\nftxt\nn/private/var/x/grok\np456\nn/var/y/codex\nn\n')).toEqual([
      '/private/var/x/grok',
      '/var/y/codex',
    ])
    expect(parseOpenDarwinFilesProbeOutput('')).toEqual([])
  })
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

  it('leaves the copy handed to a terminal on disk at exit and removes a one-shot copy', async () => {
    const fixture = sourceFixture()
    const retained = await stageVerifiedDarwinCli({
      executableName: 'grok',
      sourcePath: fixture.sourcePath,
      sourceIdentity: fixture.sourceIdentity,
      retention: 'retained',
      baseDirectory: fixture.root,
      verify: async () => undefined,
    })
    const ephemeral = await stageVerifiedDarwinCli({
      executableName: 'codex',
      sourcePath: fixture.sourcePath,
      sourceIdentity: fixture.sourceIdentity,
      retention: 'ephemeral',
      baseDirectory: fixture.root,
      verify: async () => undefined,
    })

    disposeDarwinCliStagingAtExit()

    expect(fs.existsSync(retained)).toBe(true)
    expect(fs.existsSync(path.dirname(ephemeral))).toBe(false)
  })

  it('keeps a staged directory a running process executes from until that process exits', async () => {
    const root = temporaryDirectory()
    const staged = staleDirectoryFixture(root, 'xingmang-darwin-cli-99999997-live', null)
    const executable = path.join(staged.directory, 'sleep')
    fs.copyFileSync('/bin/sleep', executable)
    fs.chmodSync(executable, 0o500)
    const child = spawn(executable, ['60'], { stdio: 'ignore' })
    const exited = new Promise((resolve) => child.once('exit', resolve))
    try {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })

      const open = await listOpenDarwinFiles([executable])
      expect(open?.some((name) => name.split(path.sep).includes(path.basename(staged.directory)))).toBe(true)
      await cleanupStaleDarwinCliDirectories(root, (pid) => pid === process.pid)
      expect(fs.existsSync(executable)).toBe(true)
    } finally {
      child.kill('SIGKILL')
      await exited
    }

    expect(await listOpenDarwinFiles([executable])).toEqual([])
    await cleanupStaleDarwinCliDirectories(root, (pid) => pid === process.pid)
    expect(fs.existsSync(staged.directory)).toBe(false)
  })
})
