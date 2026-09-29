import { describe, expect, it } from 'vitest'
import { diagnosticFolderTarget } from './diagnostic-folder'

describe('diagnosticFolderTarget', () => {
  it('offers the button only for the two folders the main process knows', () => {
    expect(diagnosticFolderTarget({ details: { openFolder: 'projects' } })).toBe('projects')
    expect(diagnosticFolderTarget({ details: { openFolder: 'ai-output' } })).toBe('ai-output')
    expect(diagnosticFolderTarget({ details: { openFolder: 'C:\\Windows' } })).toBeNull()
    expect(diagnosticFolderTarget({ details: {} })).toBeNull()
    expect(diagnosticFolderTarget({})).toBeNull()
  })
})
