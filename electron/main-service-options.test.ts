import { describe, expect, it } from 'vitest'
import { rootedMainServiceOptions } from './main-service-options'

describe('rootedMainServiceOptions', () => {
  it('projects one context into every Codex-aware service without changing user roots', () => {
    const context = {
      userHome: '/Users/alex',
      codexHome: '/Volumes/private/codex',
      codexEnv: {
        HOME: '/Users/alex',
        USERPROFILE: 'C:\\Users\\alex',
        CODEX_HOME: '/Volumes/private/codex',
      },
    }
    const providerRoots = { userHome: context.userHome, codexHome: context.codexHome }
    expect(rootedMainServiceOptions(context)).toEqual({
      system: { providerRoots, codexEnv: context.codexEnv },
      sessions: { codexHome: context.codexHome },
      backups: { providerRoots },
      codexExtensions: {
        userHome: context.userHome,
        codexHome: context.codexHome,
        env: context.codexEnv,
      },
      providerExtensions: {
        homeDirectory: context.userHome,
        codexHome: context.codexHome,
        codexEnv: context.codexEnv,
      },
      diagnostics: { providerRoots, env: context.codexEnv },
      diagnosticExport: { userHome: context.userHome, codexHome: context.codexHome },
    })
  })

  it('hands an ignored CODEX_HOME to diagnostics only', () => {
    const ignoredCodexHome = { value: '.codex', reason: 'relative' as const }
    const options = rootedMainServiceOptions({
      userHome: '/Users/alex',
      codexHome: '/Users/alex/.codex',
      codexEnv: { CODEX_HOME: '/Users/alex/.codex' },
      ignoredCodexHome,
    })

    expect(options.diagnostics.ignoredCodexHome).toBe(ignoredCodexHome)
    expect(options.diagnostics.env.CODEX_HOME).toBe('/Users/alex/.codex')
  })
})
