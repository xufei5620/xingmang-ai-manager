import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GENERATED_PROJECT_INSTRUCTION_FILENAME,
  PROJECT_INSTRUCTION_FILENAMES,
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
