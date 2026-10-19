import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as configFiles from './config-files'
import {
  executeFilePlans,
  fillableRecord,
  providerConfigPaths,
  readText,
  requireConfigText,
  requireRawConfigText,
  trustedFolderKey,
} from './config-files-context'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-config-context-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('config-files-context', () => {
  it('is what config-files.ts still exports under the old names', () => {
    expect(configFiles.executeFilePlans).toBe(executeFilePlans)
    expect(configFiles.providerConfigPaths).toBe(providerConfigPaths)
  })

  it('only takes types from config-files.ts so the two never require each other', () => {
    const source = fs.readFileSync(path.join(__dirname, 'config-files-context.ts'), 'utf8')
    const imports = source.split('\n').filter((line) => /from '\.\/config-files'/.test(line))
    expect(imports.length).toBeGreaterThan(0)
    for (const line of imports) expect(line).toMatch(/^import type /)
  })

  it('reads text without the byte order mark unless asked to keep it', () => {
    const file = path.join(temporaryDirectory(), 'settings.json')
    fs.writeFileSync(file, '\uFEFF{"a":1}')
    expect(readText(file)).toBe('{"a":1}')
    expect(requireConfigText(file, '配置')).toBe('{"a":1}')
    expect(requireRawConfigText(file, '配置')).toBe('\uFEFF{"a":1}')
  })

  it('treats a hard-linked file as unreadable and refuses it on the write path', () => {
    const directory = temporaryDirectory()
    const original = path.join(directory, 'original.json')
    const linked = path.join(directory, 'settings.json')
    fs.writeFileSync(original, '{}')
    fs.linkSync(original, linked)
    expect(readText(linked)).toBeNull()
    expect(() => requireConfigText(linked, '现有配置')).toThrow()
    expect(requireConfigText(path.join(directory, 'missing.json'), '现有配置')).toBeNull()
  })

  it('compares a verbatim Windows path the same as the plain one', () => {
    expect(trustedFolderKey('\\\\?\\C:\\Users\\Me')).toBe(trustedFolderKey('C:\\Users\\Me'))
    expect(trustedFolderKey('\\\\?\\UNC\\server\\share')).toBe(trustedFolderKey('\\\\server\\share'))
  })

  it('creates a missing table but leaves a value that is not a table alone', () => {
    const parsed: Record<string, unknown> = { kept: 'text' }
    expect(fillableRecord(parsed, 'added')).toEqual({})
    expect(parsed.added).toEqual({})
    expect(fillableRecord(parsed, 'kept')).toBeNull()
    expect(parsed.kept).toBe('text')
  })
})
