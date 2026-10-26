import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as configFiles from './config-files'
import * as geminiRetired from './gemini-retired'
import { typeImportCount, valueReferences } from './type-only-imports.test-support'

describe('gemini-retired', () => {
  it('is what config-files.ts still exports under the old names', () => {
    const names = [
      'ensureGeminiContextFilenamesInSettingsText',
      'ensureGeminiProjectContextFiles',
      'forgetStaleGeminiUsageStatisticsRecord',
      'GEMINI_PROJECT_CONTEXT_FILENAMES',
      'geminiCliCompatibleModel',
      'geminiTrustedFoldersTrustFolder',
      'geminiUsageStatisticsRecordName',
      'inspectRetiredGeminiIntegrations',
      'removeRetiredGeminiIntegrations',
      'trustGeminiWorkspace',
      'trustGeminiWorkspaceInTrustedFoldersText',
    ] as const
    for (const name of names) expect(configFiles[name]).toBe(geminiRetired[name])
  })

  it('only takes types from config-files.ts so the two never require each other', () => {
    const file = path.join(__dirname, 'gemini-retired.ts')
    const configFilesModule = path.join(__dirname, 'config-files.ts')
    expect(typeImportCount(file, configFilesModule)).toBeGreaterThan(0)
    expect(valueReferences(file, configFilesModule)).toEqual([])
  })

  it('keeps comments and the user layout when it edits a commented settings file', () => {
    const original = '// mine\n{\n  "ui": { "theme": "Dracula" } // keep\n}\n'
    const next = { ui: { theme: 'Dracula' }, general: { enableAutoUpdate: false } }
    const written = geminiRetired.geminiJsonContent(original, next)
    expect(written.startsWith('// mine\n')).toBe(true)
    expect(written).toContain('// keep')
    expect(written).toContain('"enableAutoUpdate": false')
  })

  it('leaves a session retention the user already wrote alone', () => {
    const parsed: Record<string, unknown> = { general: { sessionRetention: { enabled: false } } }
    geminiRetired.extendGeminiSessionRetention(parsed)
    expect(parsed).toEqual({ general: { sessionRetention: { enabled: false } } })
    const empty: Record<string, unknown> = {}
    geminiRetired.extendGeminiSessionRetention(empty)
    expect(empty).toEqual({ general: { sessionRetention: { maxAge: geminiRetired.MANAGED_GEMINI_SESSION_MAX_AGE } } })
  })
})
