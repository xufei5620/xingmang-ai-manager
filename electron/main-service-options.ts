import type { CodexHomeContext, ProviderConfigRoots } from './codex-home'

export interface RootedMainServiceOptions {
  system: { providerRoots: ProviderConfigRoots; codexEnv: NodeJS.ProcessEnv }
  sessions: { codexHome: string }
  backups: { providerRoots: ProviderConfigRoots }
  codexExtensions: { userHome: string; codexHome: string; env: NodeJS.ProcessEnv }
  providerExtensions: { homeDirectory: string; codexHome: string; codexEnv: NodeJS.ProcessEnv }
  diagnostics: { providerRoots: ProviderConfigRoots; env: NodeJS.ProcessEnv }
  diagnosticExport: { userHome: string; codexHome: string }
}

export function rootedMainServiceOptions(context: CodexHomeContext): RootedMainServiceOptions {
  const providerRoots = { userHome: context.userHome, codexHome: context.codexHome }
  return {
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
  }
}
