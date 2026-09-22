import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GENERATED_PROJECT_INSTRUCTION_FILENAME,
  PROJECT_INSTRUCTION_FILENAMES,
  ProjectInstructionsStateStore,
  ensureProjectInstructions,
  hasExistingProjectInstructions,
  readProjectInstructionsTemplate,
  resolveProjectInstructionsTemplatePath,
} from './project-instructions'

const temporaryDirectories: string[] = []

function temporaryWorkspace(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-project-instructions-'))
  temporaryDirectories.push(directory)
  return directory
}

const BUNDLED_TEMPLATE = readProjectInstructionsTemplate(
  path.join(__dirname, '..', 'bundled-catalog', 'project-instructions', 'AGENTS.zh-CN.md'),
)

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('hasExistingProjectInstructions', () => {
  it('detects any of the three instruction files case-insensitively', () => {
    expect(hasExistingProjectInstructions(['README.md', 'src'])).toBe(false)
    expect(hasExistingProjectInstructions(['CLAUDE.md'])).toBe(true)
    expect(hasExistingProjectInstructions(['agents.md'])).toBe(true)
    expect(hasExistingProjectInstructions(['Gemini.MD'])).toBe(true)
  })
})

describe('ensureProjectInstructions', () => {
  it('writes AGENTS.md verbatim from the template when the directory has no instruction file', async () => {
    const workspace = temporaryWorkspace()
    const result = await ensureProjectInstructions({ workspace, template: BUNDLED_TEMPLATE })
    expect(result).toEqual({ created: true })
    const written = fs.readFileSync(path.join(workspace, GENERATED_PROJECT_INSTRUCTION_FILENAME), 'utf8')
    expect(written).toBe(BUNDLED_TEMPLATE)
  })

  for (const existing of PROJECT_INSTRUCTION_FILENAMES) {
    it(`never writes when ${existing} already exists`, async () => {
      const workspace = temporaryWorkspace()
      fs.writeFileSync(path.join(workspace, existing), '客户自己的项目说明', 'utf8')
      const result = await ensureProjectInstructions({ workspace, template: BUNDLED_TEMPLATE })
      expect(result).toEqual({ created: false, reason: 'exists' })
      // The existing file is left untouched and no AGENTS.md is added beside it.
      expect(fs.readFileSync(path.join(workspace, existing), 'utf8')).toBe('客户自己的项目说明')
      if (existing !== GENERATED_PROJECT_INSTRUCTION_FILENAME) {
        expect(fs.existsSync(path.join(workspace, GENERATED_PROJECT_INSTRUCTION_FILENAME))).toBe(false)
      }
    })
  }

  it('never brings back an AGENTS.md the user deleted', async () => {
    const workspace = temporaryWorkspace()
    const state = new ProjectInstructionsStateStore(path.join(temporaryWorkspace(), 'state'))
    const target = path.join(workspace, GENERATED_PROJECT_INSTRUCTION_FILENAME)

    const first = await ensureProjectInstructions({ workspace, template: BUNDLED_TEMPLATE, state })
    expect(first).toEqual({ created: true })
    expect(fs.existsSync(target)).toBe(true)

    // 客户看了一眼决定不要，删掉它。
    fs.rmSync(target)
    const second = await ensureProjectInstructions({ workspace, template: BUNDLED_TEMPLATE, state })
    expect(second).toEqual({ created: false, reason: 'already-generated' })
    expect(fs.existsSync(target)).toBe(false)
  })

  it('does not generate a second time while the generated file is still there', async () => {
    const workspace = temporaryWorkspace()
    const state = new ProjectInstructionsStateStore(path.join(temporaryWorkspace(), 'state'))
    await ensureProjectInstructions({ workspace, template: BUNDLED_TEMPLATE, state })
    const second = await ensureProjectInstructions({ workspace, template: BUNDLED_TEMPLATE, state })
    expect(second).toEqual({ created: false, reason: 'already-generated' })
  })

  it('keeps each workspace independent', async () => {
    const stateRoot = path.join(temporaryWorkspace(), 'state')
    const state = new ProjectInstructionsStateStore(stateRoot)
    const first = temporaryWorkspace()
    const second = temporaryWorkspace()
    await ensureProjectInstructions({ workspace: first, template: BUNDLED_TEMPLATE, state })
    // 记住第一个目录不能让第二个目录也被当成生成过。
    expect(await ensureProjectInstructions({ workspace: second, template: BUNDLED_TEMPLATE, state }))
      .toEqual({ created: true })
  })

  it('treats a damaged generation record as already generated', async () => {
    const workspace = temporaryWorkspace()
    const stateRoot = path.join(temporaryWorkspace(), 'state')
    const state = new ProjectInstructionsStateStore(stateRoot)
    await state.remember(workspace)
    // 记录坏掉时宁可不生成，也不能把客户删掉的文件又变回来。
    const [recordName] = fs.readdirSync(stateRoot)
    fs.writeFileSync(path.join(stateRoot, recordName), '{ not json', 'utf8')
    expect(state.generated(workspace)).toBe(true)
    expect(await ensureProjectInstructions({ workspace, template: BUNDLED_TEMPLATE, state }))
      .toEqual({ created: false, reason: 'already-generated' })
    expect(fs.existsSync(path.join(workspace, GENERATED_PROJECT_INSTRUCTION_FILENAME))).toBe(false)
  })

  it('still generates without a state store, and records nothing', async () => {
    const workspace = temporaryWorkspace()
    expect(await ensureProjectInstructions({ workspace, template: BUNDLED_TEMPLATE }))
      .toEqual({ created: true })
  })

  it('does nothing when the template is empty', async () => {
    const workspace = temporaryWorkspace()
    const result = await ensureProjectInstructions({ workspace, template: '   ' })
    expect(result).toEqual({ created: false, reason: 'no-template' })
    expect(fs.existsSync(path.join(workspace, GENERATED_PROJECT_INSTRUCTION_FILENAME))).toBe(false)
  })
})

describe('resolveProjectInstructionsTemplatePath', () => {
  it('prefers the unpacked resources copy when packaged', () => {
    // 两边都过 path.resolve：解析器自己就是这么归一化的，而 Windows 会给一个
    // 裸的 POSIX 绝对路径补上当前盘符（/opt/... → D:\opt\...）。
    const resourcesPath = path.resolve('/opt/app/resources')
    const resolved = resolveProjectInstructionsTemplatePath(path.join(resourcesPath, 'app.asar'), {
      packaged: true,
      resourcesPath,
    })
    // A non-existent candidate falls through to the first entry, which is the
    // resources copy when packaged.
    expect(resolved).toBe(
      path.join(resourcesPath, 'bundled-catalog', 'project-instructions', 'AGENTS.zh-CN.md'),
    )
  })

  it('resolves the bundled template from the repository root in development', () => {
    const resolved = resolveProjectInstructionsTemplatePath(path.join(__dirname, '..'))
    expect(fs.existsSync(resolved)).toBe(true)
    expect(readProjectInstructionsTemplate(resolved)).toBe(BUNDLED_TEMPLATE)
  })
})
