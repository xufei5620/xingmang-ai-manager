import { describe, expect, it } from 'vitest'
import { codexRuntimeSetupMessage, nodeRuntimeSupported } from '../src/onboarding-runtime'
import type { ToolStatus } from '../src/types'

function tool(installed: boolean): ToolStatus {
  return {
    installed,
    version: installed ? 'test-version' : null,
    path: installed ? 'C:\\test\\tool.exe' : null,
    installDirectory: installed ? 'C:\\test' : null,
  }
}

describe('codexRuntimeSetupMessage', () => {
  it('returns no error when Node.js and npm are available', () => {
    expect(codexRuntimeSetupMessage({ node: tool(true), npm: tool(true) })).toBeNull()
  })

  it('explains both missing prerequisites and PATH setup', () => {
    expect(codexRuntimeSetupMessage({ node: tool(false), npm: tool(false) }))
      .toContain('npm package manager 和 Add to PATH')
  })

  it('distinguishes a missing npm installation from a missing Node.js installation', () => {
    expect(codexRuntimeSetupMessage({ node: tool(true), npm: tool(false) }))
      .toContain('已检测到 Node.js，但未检测到 npm')
    expect(codexRuntimeSetupMessage({ node: tool(false), npm: tool(true) }))
      .toContain('未检测到 Node.js')
  })

  it('blocks an installed but unsupported Node.js version', () => {
    expect(codexRuntimeSetupMessage({
      node: { ...tool(true), version: 'v16.20.2', tooOld: true, versionStatus: 'too-old' },
      npm: tool(true),
    })).toContain('版本过低')
  })

  it('keeps malformed Node.js output actionable', () => {
    expect(codexRuntimeSetupMessage({
      node: { ...tool(true), version: 'node?', versionStatus: 'unknown' },
      npm: tool(true),
    })).toContain('版本无法识别')
  })

  it('does not mark an old or unknown runtime as ready', () => {
    expect(nodeRuntimeSupported({
      node: { ...tool(true), tooOld: true, versionStatus: 'too-old' },
      npm: tool(true),
    })).toBe(false)
    expect(nodeRuntimeSupported({
      node: { ...tool(true), versionStatus: 'unknown' },
      npm: tool(true),
    })).toBe(false)
    expect(nodeRuntimeSupported({ node: tool(true), npm: tool(true) })).toBe(true)
  })
})
