import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildDocumentsFallbackPrompt,
  buildWorkspaceNotWritablePrompt,
  createStarterWorkspaceWithFallback,
  inspectDocumentsWritability,
  inspectWorkspaceWritable,
  isWritePermissionError,
  probeDirectoryWritable,
  probeDirectoryWritableSync,
  shouldCheckWorkspaceWritable,
} from './documents-fallback'
import { createStarterWorkspace, type StarterWorkspaceLocationContext } from './starter-workspace'

function systemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code })
}

describe('isWritePermissionError', () => {
  it('recognises permission errors, also when wrapped in a Chinese message', () => {
    expect(isWritePermissionError(systemError('EPERM'))).toBe(true)
    expect(isWritePermissionError(systemError('EACCES'))).toBe(true)
    expect(isWritePermissionError(new Error('可能是没有写入权限，或者磁盘已满', { cause: systemError('EPERM') }))).toBe(true)
  })

  it('does not treat a full or read-only disk as a permission problem', () => {
    expect(isWritePermissionError(systemError('ENOSPC'))).toBe(false)
    expect(isWritePermissionError(systemError('EROFS'))).toBe(false)
    expect(isWritePermissionError(new Error('项目文件夹必须是普通目录'))).toBe(false)
    expect(isWritePermissionError('EPERM')).toBe(false)
  })
})

describe('probeDirectoryWritableSync', () => {
  let directory: string

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-documents-probe-'))
  })

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it('writes a file and leaves nothing behind', () => {
    probeDirectoryWritableSync(directory)

    expect(fs.readdirSync(directory)).toEqual([])
  })

  it.runIf(process.platform !== 'win32')('never follows a planted link at the probe name', () => {
    const target = path.join(directory, 'target')
    fs.writeFileSync(target, 'keep')
    const bytes = Buffer.alloc(16, 1)
    fs.symlinkSync(target, path.join(directory, `.write-check-${bytes.toString('hex')}.tmp`))

    expect(() => probeDirectoryWritableSync(directory, () => bytes)).toThrow(/EEXIST/)
    expect(fs.readFileSync(target, 'utf8')).toBe('keep')
  })
})

describe('probeDirectoryWritable', () => {
  let directory: string

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-workspace-probe-'))
  })

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it('writes a file and leaves nothing behind', async () => {
    await probeDirectoryWritable(directory)

    expect(fs.readdirSync(directory)).toEqual([])
  })

  it.runIf(process.platform !== 'win32')('never follows a planted link at the probe name', async () => {
    const target = path.join(directory, 'target')
    fs.writeFileSync(target, 'keep')
    const bytes = Buffer.alloc(16, 2)
    fs.symlinkSync(target, path.join(directory, `.write-check-${bytes.toString('hex')}.tmp`))

    await expect(probeDirectoryWritable(directory, () => bytes)).rejects.toThrow(/EEXIST/)
    expect(fs.readFileSync(target, 'utf8')).toBe('keep')
  })
})

describe('shouldCheckWorkspaceWritable', () => {
  it('only checks on Windows', () => {
    expect(shouldCheckWorkspaceWritable(null, 'win32')).toBe(true)
    expect(shouldCheckWorkspaceWritable(null, 'darwin')).toBe(false)
    expect(shouldCheckWorkspaceWritable(null, 'linux')).toBe(false)
  })

  it('checks the folders controlled folder access guards but not ones the user was already warned about', () => {
    expect(shouldCheckWorkspaceWritable('documents', 'win32')).toBe(true)
    expect(shouldCheckWorkspaceWritable('desktop', 'win32')).toBe(true)
    expect(shouldCheckWorkspaceWritable('downloads', 'win32')).toBe(true)
    expect(shouldCheckWorkspaceWritable('drive-root', 'win32')).toBe(false)
    expect(shouldCheckWorkspaceWritable('home', 'win32')).toBe(false)
    expect(shouldCheckWorkspaceWritable('system', 'win32')).toBe(false)
    expect(shouldCheckWorkspaceWritable('provider-config', 'win32')).toBe(false)
  })
})

describe('inspectWorkspaceWritable', () => {
  it('reports a folder that takes the probe as writable', async () => {
    await expect(inspectWorkspaceWritable('C:\\work', { probe: async () => undefined })).resolves.toBe('writable')
  })

  it('reports permission errors as denied', async () => {
    await expect(inspectWorkspaceWritable('C:\\work', { probe: async () => { throw systemError('EPERM') } })).resolves.toBe('denied')
    await expect(inspectWorkspaceWritable('C:\\work', { probe: async () => { throw systemError('EACCES') } })).resolves.toBe('denied')
  })

  it('does not blame permissions for a missing folder or a full disk', async () => {
    await expect(inspectWorkspaceWritable('C:\\work', { probe: async () => { throw systemError('ENOENT') } })).resolves.toBe('unknown')
    await expect(inspectWorkspaceWritable('C:\\work', { probe: async () => { throw systemError('ENOSPC') } })).resolves.toBe('unknown')
  })

  it('gives up on a probe that hangs instead of holding the launch', async () => {
    await expect(inspectWorkspaceWritable('\\\\server\\share', {
      probe: () => new Promise<void>(() => undefined),
      timeoutMs: 10,
    })).resolves.toBe('unknown')
  })
})

describe('buildWorkspaceNotWritablePrompt', () => {
  it('offers a writable place by default and keeps a way to open anyway', () => {
    const prompt = buildWorkspaceNotWritablePrompt({ allowCreate: true })

    expect(prompt.buttons).toEqual(['换到能写的位置', '照常打开', '先不打开'])
    expect(prompt.createIndex).toBe(0)
    expect(prompt.defaultIndex).toBe(0)
    expect(prompt.buttons[prompt.continueIndex]).toBe('照常打开')
    expect(prompt.buttons[prompt.cancelIndex]).toBe('先不打开')
    expect(prompt.detail).toContain('受控文件夹访问')
    expect(prompt.detail).toContain('原来的文件还在原来的位置')
  })

  it('does not offer another folder when resuming a conversation', () => {
    const prompt = buildWorkspaceNotWritablePrompt({ allowCreate: false })

    expect(prompt.buttons).toEqual(['先不打开', '照常打开'])
    expect(prompt.createIndex).toBeNull()
    expect(prompt.buttons[prompt.defaultIndex]).toBe('照常打开')
  })
})

describe('createStarterWorkspaceWithFallback', () => {
  let home: string
  let documents: string
  let context: StarterWorkspaceLocationContext

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-documents-home-')))
    documents = path.join(home, 'Documents')
    fs.mkdirSync(documents)
    context = { platform: process.platform === 'win32' ? 'win32' : 'linux', home, env: {} }
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('keeps new projects in the documents folder when it can be written', () => {
    const placement = createStarterWorkspaceWithFallback(documents, context)

    expect(placement).toEqual({ directory: path.join(documents, 'XingmangProjects', 'my-project'), movedFromDocuments: false })
  })

  it('moves to the home folder when documents refuses the folder itself', () => {
    const create = vi.fn((parent: string, guard: Parameters<typeof createStarterWorkspace>[1]) => {
      if (parent === documents) throw new Error('可能是没有写入权限，或者磁盘已满', { cause: systemError('EPERM') })
      return createStarterWorkspace(parent, guard)
    })

    const placement = createStarterWorkspaceWithFallback(documents, context, { create })

    expect(placement).toEqual({ directory: path.join(home, 'XingmangProjects', 'my-project'), movedFromDocuments: true })
    expect(fs.statSync(placement.directory).isDirectory()).toBe(true)
  })

  it('moves when the folder is created but no file may be written in it, removing the empty folder', () => {
    const probe = vi.fn((directory: string) => {
      if (directory.startsWith(documents)) throw systemError('EACCES')
    })

    const placement = createStarterWorkspaceWithFallback(documents, context, { probe })

    expect(placement).toEqual({ directory: path.join(home, 'XingmangProjects', 'my-project'), movedFromDocuments: true })
    expect(fs.existsSync(path.join(documents, 'XingmangProjects', 'my-project'))).toBe(false)
  })

  it('keeps the original message for a full disk and does not move', () => {
    const create = vi.fn((parent: string) => {
      throw new Error('可能是没有写入权限，或者磁盘已满', { cause: systemError('ENOSPC') })
    })

    expect(() => createStarterWorkspaceWithFallback(documents, context, { create })).toThrow('磁盘已满')
    expect(create).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(path.join(home, 'XingmangProjects'))).toBe(false)
  })

  it('hands over the created folder when the extra write check fails for another reason', () => {
    const placement = createStarterWorkspaceWithFallback(documents, context, { probe: () => { throw systemError('ENOSPC') } })

    expect(placement).toEqual({ directory: path.join(documents, 'XingmangProjects', 'my-project'), movedFromDocuments: false })
  })

  it('has nowhere else to go when projects already live in the home folder', () => {
    const create = vi.fn(() => { throw new Error('可能是没有写入权限，或者磁盘已满', { cause: systemError('EPERM') }) })
    const probe = vi.fn()

    expect(() => createStarterWorkspaceWithFallback(documents, { ...context, platform: 'darwin' }, { create, probe })).toThrow('写入权限')
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(home, expect.anything())
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('buildDocumentsFallbackPrompt', () => {
  it('says where the project went, why, and offers to open it', () => {
    const prompt = buildDocumentsFallbackPrompt('C:\\Users\\peaker\\XingmangProjects\\my-project', 'win32')

    expect(prompt.message).toBe('「文档」文件夹不让写，项目放在了 C:\\Users\\peaker\\XingmangProjects\\my-project')
    expect(prompt.detail).toContain('受控文件夹访问')
    expect(prompt.buttons[prompt.openFolderIndex]).toBe('打开文件夹')
    expect(`${prompt.title}${prompt.message}${prompt.detail}`).not.toMatch(/EPERM|EACCES|权限位|%USERPROFILE%/)
  })

  it('does not mention the Windows setting on other systems', () => {
    expect(buildDocumentsFallbackPrompt('/Users/alex/XingmangProjects/my-project', 'darwin').detail).not.toContain('Windows')
  })
})

describe('inspectDocumentsWritability', () => {
  const windows: StarterWorkspaceLocationContext = { platform: 'win32', home: 'C:\\Users\\peaker', env: {}, directoryExists: () => true }

  it('writes a test file into documents', () => {
    const probe = vi.fn()

    expect(inspectDocumentsWritability('C:\\Users\\peaker\\Documents', windows, { probe })).toEqual({ state: 'writable' })
    expect(probe).toHaveBeenCalledWith('C:\\Users\\peaker\\Documents')
  })

  it('separates a refusal from other failures', () => {
    expect(inspectDocumentsWritability('C:\\Users\\peaker\\Documents', windows, { probe: () => { throw systemError('EPERM') } }))
      .toMatchObject({ state: 'denied' })
    expect(inspectDocumentsWritability('C:\\Users\\peaker\\Documents', windows, { probe: () => { throw systemError('ENOSPC') } }))
      .toMatchObject({ state: 'failed' })
  })

  it('does not probe a documents folder that is not used anyway', () => {
    const probe = vi.fn()

    expect(inspectDocumentsWritability('C:\\Users\\peaker\\OneDrive\\Documents', windows, { probe })).toEqual({ state: 'not-used', why: 'cloud' })
    expect(inspectDocumentsWritability(null, windows, { probe })).toEqual({ state: 'not-used', why: 'missing' })
    expect(probe).not.toHaveBeenCalled()
  })
})
