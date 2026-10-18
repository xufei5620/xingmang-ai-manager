import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isAllowedAppNavigationUrl,
  isAllowedExternalUrl,
  hasDisallowedPackagedDebugSwitch,
  isTrustedIpcSenderUrl,
  resolvePackagedApplicationFile,
  type ApplicationUrlPolicy,
} from './security'
import { supportServiceUrl } from './relay-sites'
import { accelerationWorkerArgument } from './acceleration-worker-entry'
import { loginLaunchArgument } from './login-launch'
import { uninstallCleanupArgument, uninstallClearLoginArgument } from './uninstall-cleanup-entry'

const windowsPolicy: ApplicationUrlPolicy = {
  rendererRoot: 'C:\\Program Files\\XingMang API\\resources\\app\\dist',
  devServerUrl: 'http://localhost:5173',
  packagedBaseUrl: 'xingmang://app/',
}

describe('application URL security', () => {
  it('accepts only the configured development server origin', () => {
    expect(isTrustedIpcSenderUrl('http://localhost:5173/', windowsPolicy)).toBe(true)
    expect(isTrustedIpcSenderUrl('http://localhost:5173/settings?tab=general#theme', windowsPolicy)).toBe(true)
    expect(isAllowedAppNavigationUrl('http://localhost:5173/onboarding', windowsPolicy)).toBe(true)

    expect(isTrustedIpcSenderUrl('https://localhost:5173/', windowsPolicy)).toBe(false)
    expect(isTrustedIpcSenderUrl('http://localhost:5174/', windowsPolicy)).toBe(false)
    expect(isTrustedIpcSenderUrl('http://localhost.example:5173/', windowsPolicy)).toBe(false)
    expect(isTrustedIpcSenderUrl('http://user@localhost:5173/', windowsPolicy)).toBe(false)
  })

  it('accepts packaged files only within the renderer root', () => {
    expect(isTrustedIpcSenderUrl(
      'file:///C:/Program%20Files/XingMang%20API/resources/app/dist/index.html',
      windowsPolicy,
    )).toBe(true)
    expect(isAllowedAppNavigationUrl(
      'file:///c:/program%20files/xingmang%20api/resources/app/dist/assets/index.js',
      windowsPolicy,
    )).toBe(true)

    expect(isTrustedIpcSenderUrl(
      'file:///C:/Program%20Files/XingMang%20API/resources/app/dist-copy/index.html',
      windowsPolicy,
    )).toBe(false)
    expect(isTrustedIpcSenderUrl(
      'file:///C:/Program%20Files/XingMang%20API/resources/app/secret.txt',
      windowsPolicy,
    )).toBe(false)
    expect(isTrustedIpcSenderUrl(
      'file:///C:/Program%20Files/XingMang%20API/resources/app/dist/%2e%2e/secret.txt',
      windowsPolicy,
    )).toBe(false)
    expect(isTrustedIpcSenderUrl(
      'file:///C:/Program%20Files/XingMang%20API/resources/app/dist/assets%2fsecret.txt',
      windowsPolicy,
    )).toBe(false)
    expect(isTrustedIpcSenderUrl(
      'file://server/share/XingMang/index.html',
      windowsPolicy,
    )).toBe(false)
  })

  it('maps only the packaged application protocol into the renderer root', () => {
    expect(isTrustedIpcSenderUrl('xingmang://app/index.html?theme=dark', windowsPolicy)).toBe(true)
    expect(resolvePackagedApplicationFile(
      'xingmang://app/assets/index.js',
      windowsPolicy,
    )).toBe('C:\\Program Files\\XingMang API\\resources\\app\\dist\\assets\\index.js')
    expect(resolvePackagedApplicationFile('xingmang://app/', windowsPolicy)).toBe(
      'C:\\Program Files\\XingMang API\\resources\\app\\dist\\index.html',
    )

    expect(isTrustedIpcSenderUrl('xingmang://other/index.html', windowsPolicy)).toBe(false)
    expect(isTrustedIpcSenderUrl('xingmang://user@app/index.html', windowsPolicy)).toBe(false)
    expect(isTrustedIpcSenderUrl('xingmang://app/assets%2fsecret.js', windowsPolicy)).toBe(false)
    expect(isTrustedIpcSenderUrl('xingmang://app/%5c%5cserver/share', windowsPolicy)).toBe(false)
  })

  it('rejects malformed URLs and non-application schemes', () => {
    expect(isAllowedAppNavigationUrl('', windowsPolicy)).toBe(false)
    expect(isAllowedAppNavigationUrl('not a URL', windowsPolicy)).toBe(false)
    expect(isAllowedAppNavigationUrl('javascript:alert(1)', windowsPolicy)).toBe(false)
    expect(isAllowedAppNavigationUrl('data:text/html,hello', windowsPolicy)).toBe(false)
    expect(isAllowedAppNavigationUrl('https://xm.solov.cc/', windowsPolicy)).toBe(false)
  })

  it('does not enable development origins from invalid policy URLs', () => {
    expect(isTrustedIpcSenderUrl('http://localhost:5173/', {
      rendererRoot: windowsPolicy.rendererRoot,
      devServerUrl: 'javascript:alert(1)',
    })).toBe(false)
    expect(isTrustedIpcSenderUrl('http://localhost:5173/', {
      rendererRoot: windowsPolicy.rendererRoot,
      devServerUrl: 'http://user@localhost:5173/',
    })).toBe(false)
  })

  it('does not trust a development origin when packaged policy omits it', () => {
    expect(isTrustedIpcSenderUrl('https://attacker.example/', {
      rendererRoot: windowsPolicy.rendererRoot,
      devServerUrl: undefined,
      packagedBaseUrl: windowsPolicy.packagedBaseUrl,
    })).toBe(false)
    expect(isTrustedIpcSenderUrl('xingmang://app/index.html', {
      rendererRoot: windowsPolicy.rendererRoot,
      devServerUrl: undefined,
      packagedBaseUrl: windowsPolicy.packagedBaseUrl,
    })).toBe(true)
  })
})

// The macOS renderer root is a POSIX path inside the .app bundle. Nothing
// covered that shape before, so a regression that only bites the mac build
// would have reached a release green.
describe('application URL security on a POSIX renderer root', () => {
  const macPolicy: ApplicationUrlPolicy = {
    rendererRoot: '/Applications/星芒AI管理工具.app/Contents/Resources/app/dist',
    devServerUrl: 'http://localhost:5173',
    packagedBaseUrl: 'xingmang://app/',
  }
  const bundle = '/Applications/%E6%98%9F%E8%8A%92AI%E7%AE%A1%E7%90%86%E5%B7%A5%E5%85%B7.app'
  const distUrl = `file://${bundle}/Contents/Resources/app/dist`

  it('maps only the packaged application protocol into the renderer root', () => {
    expect(isTrustedIpcSenderUrl('xingmang://app/index.html?theme=dark', macPolicy)).toBe(true)
    expect(resolvePackagedApplicationFile('xingmang://app/assets/index.js', macPolicy)).toBe(
      '/Applications/星芒AI管理工具.app/Contents/Resources/app/dist/assets/index.js',
    )
    expect(resolvePackagedApplicationFile('xingmang://app/', macPolicy)).toBe(
      '/Applications/星芒AI管理工具.app/Contents/Resources/app/dist/index.html',
    )

    expect(isTrustedIpcSenderUrl('xingmang://other/index.html', macPolicy)).toBe(false)
    expect(isTrustedIpcSenderUrl('xingmang://user@app/index.html', macPolicy)).toBe(false)
    expect(isTrustedIpcSenderUrl('xingmang://app/assets%2fsecret.js', macPolicy)).toBe(false)
    expect(isTrustedIpcSenderUrl('xingmang://app/%5c%5cserver/share', macPolicy)).toBe(false)
  })

  it('keeps every traversal spelling inside the renderer root', () => {
    // ../ and %2e%2e are both collapsed by the URL parser before the resolver
    // sees them, so these stay inside the root instead of being rejected.
    for (const traversal of [
      'xingmang://app/../secret.txt',
      'xingmang://app/%2e%2e/secret.txt',
      'xingmang://app/assets/%2e%2e/%2e%2e/secret.txt',
    ]) {
      expect(resolvePackagedApplicationFile(traversal, macPolicy)).toBe(
        '/Applications/星芒AI管理工具.app/Contents/Resources/app/dist/secret.txt',
      )
    }

    // An encoded separator is never decoded into a real one, so it cannot
    // rebuild the traversal the parser just collapsed.
    for (const encoded of [
      'xingmang://app/..%2fsecret.txt',
      'xingmang://app/%2e%2e%2fsecret.txt',
      'xingmang://app/assets%5c..%5c..%5csecret.txt',
    ]) {
      expect(resolvePackagedApplicationFile(encoded, macPolicy)).toBe(null)
      expect(isTrustedIpcSenderUrl(encoded, macPolicy)).toBe(false)
    }
  })

  // fileURLToPath demands a drive letter on Windows and throws for a POSIX
  // file URL, so only the hosts that can parse one run this.
  it.runIf(process.platform !== 'win32')('accepts packaged files only within the renderer root', () => {
    expect(isTrustedIpcSenderUrl(`${distUrl}/index.html`, macPolicy)).toBe(true)
    expect(isAllowedAppNavigationUrl(`${distUrl}/assets/index.js`, macPolicy)).toBe(true)

    expect(isTrustedIpcSenderUrl(`file://${bundle}/Contents/Resources/app/dist-copy/index.html`, macPolicy))
      .toBe(false)
    expect(isTrustedIpcSenderUrl(`file://${bundle}/Contents/Resources/app/secret.txt`, macPolicy))
      .toBe(false)
    expect(isTrustedIpcSenderUrl(`${distUrl}/%2e%2e/secret.txt`, macPolicy)).toBe(false)
    expect(isTrustedIpcSenderUrl(`${distUrl}/assets%2fsecret.txt`, macPolicy)).toBe(false)
    expect(isTrustedIpcSenderUrl('file://server/share/XingMang/index.html', macPolicy)).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('does not treat a case variant of the root as inside it', () => {
    // APFS is case-insensitive by default but case-preserving, and the
    // containment check is pure string math, so the variant must not pass.
    expect(isTrustedIpcSenderUrl(
      `file://${bundle}/contents/resources/app/dist/index.html`,
      macPolicy,
    )).toBe(false)
  })
})

describe('external URL allowlist', () => {
  const allowlist = [
    'https://xm.solov.cc',
    'https://xm.solov.cc/keys',
    'https://nodejs.org/',
    supportServiceUrl,
    'ms-windows-store://pdp/?ProductId=9PLM9XGG6VKS',
  ]

  it('matches normalized HTTPS URLs and the exact local Microsoft Store URI', () => {
    expect(isAllowedExternalUrl('https://xm.solov.cc/', allowlist)).toBe(true)
    expect(isAllowedExternalUrl('https://xm.solov.cc/keys', allowlist)).toBe(true)
    expect(isAllowedExternalUrl('https://nodejs.org/', allowlist)).toBe(true)
    expect(isAllowedExternalUrl(supportServiceUrl, allowlist)).toBe(true)
    expect(isAllowedExternalUrl('ms-windows-store://pdp/?ProductId=9PLM9XGG6VKS', allowlist)).toBe(true)
  })

  it('rejects lookalike hosts, extra URL data, credentials, and other schemes', () => {
    expect(isAllowedExternalUrl('https://xm.solov.cc.evil.example/keys', allowlist)).toBe(false)
    expect(isAllowedExternalUrl('https://xm.solov.cc/keys?redirect=1', allowlist)).toBe(false)
    expect(isAllowedExternalUrl('https://xm.solov.cc/keys#token', allowlist)).toBe(false)
    expect(isAllowedExternalUrl('https://user@xm.solov.cc/keys', allowlist)).toBe(false)
    expect(isAllowedExternalUrl('http://xm.solov.cc/keys', allowlist)).toBe(false)
    expect(isAllowedExternalUrl(supportServiceUrl + '?redirect=1', allowlist)).toBe(false)
    expect(isAllowedExternalUrl(supportServiceUrl + '/extra', allowlist)).toBe(false)
    // Derived from the constant so a support-account change cannot quietly
    // turn these into assertions about a URL nobody uses any more.
    expect(isAllowedExternalUrl(supportServiceUrl.replace('work.weixin.qq.com', 'work.weixin.qq.com.evil.example'), allowlist)).toBe(false)
    expect(isAllowedExternalUrl(supportServiceUrl.replace('https://', 'http://'), allowlist)).toBe(false)
    expect(isAllowedExternalUrl('ms-windows-store://pdp/?ProductId=OTHER', allowlist)).toBe(false)
    expect(isAllowedExternalUrl('ms-windows-store://search/?query=Codex', allowlist)).toBe(false)
    expect(isAllowedExternalUrl('javascript:alert(1)', allowlist)).toBe(false)
    expect(isAllowedExternalUrl('not a URL', allowlist)).toBe(false)
  })
})

describe('packaged debug switch security', () => {
  it('detects Electron and Chromium debugging switches', () => {
    expect(hasDisallowedPackagedDebugSwitch(['app.exe', '--inspect'])).toBe(true)
    expect(hasDisallowedPackagedDebugSwitch(['app.exe', '--inspect-brk=127.0.0.1:9229'])).toBe(true)
    expect(hasDisallowedPackagedDebugSwitch(['app.exe', '--remote-debugging-port=9222'])).toBe(true)
    expect(hasDisallowedPackagedDebugSwitch(['app.exe', '--REMOTE-DEBUGGING-PIPE'])).toBe(true)
  })

  it('allows normal application and Chromium switches', () => {
    expect(hasDisallowedPackagedDebugSwitch([
      'app.exe',
      '--user-data-dir=C:\\Users\\tester\\AppData\\Local\\XingMang',
      '--disable-gpu',
    ])).toBe(false)
    expect(hasDisallowedPackagedDebugSwitch(['app.exe', '--inspection-mode'])).toBe(false)
  })

  it('detects blocked switches written with a single dash on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(hasDisallowedPackagedDebugSwitch(['app', '-remote-debugging-port=9222'], platform)).toBe(true)
      expect(hasDisallowedPackagedDebugSwitch(['app', '-Remote-Debugging-Pipe'], platform)).toBe(true)
      expect(hasDisallowedPackagedDebugSwitch(['app', '-inspect'], platform)).toBe(true)
    }
  })

  it('detects blocked switches written with a slash on Windows', () => {
    expect(hasDisallowedPackagedDebugSwitch(['app.exe', '/remote-debugging-port=9222'], 'win32')).toBe(true)
    expect(hasDisallowedPackagedDebugSwitch(['app.exe', '/REMOTE-DEBUGGING-PIPE'], 'win32')).toBe(true)
    expect(hasDisallowedPackagedDebugSwitch(['app.exe', '/gpu-launcher=cmd.exe /c calc'], 'win32')).toBe(true)
  })

  it('treats a leading slash as a path outside Windows', () => {
    expect(hasDisallowedPackagedDebugSwitch(['app', '/remote-debugging-port'], 'darwin')).toBe(false)
    expect(hasDisallowedPackagedDebugSwitch(['app', '/remote-debugging-port'], 'linux')).toBe(false)
    expect(hasDisallowedPackagedDebugSwitch([
      '/Applications/星芒AI管理工具.app/Contents/MacOS/星芒AI管理工具',
    ], 'darwin')).toBe(false)
  })

  it('detects blocked switches surrounded by whitespace Chromium trims', () => {
    expect(hasDisallowedPackagedDebugSwitch(['app.exe', ' --remote-debugging-port=9222'], 'win32')).toBe(true)
    expect(hasDisallowedPackagedDebugSwitch(['app.exe', '\t/gpu-launcher=calc.exe '], 'win32')).toBe(true)
    expect(hasDisallowedPackagedDebugSwitch(['app.exe', '\u3000-remote-debugging-pipe'], 'win32')).toBe(true)
    expect(hasDisallowedPackagedDebugSwitch(['app.exe', '\u0085--inspect'], 'win32')).toBe(true)
    expect(hasDisallowedPackagedDebugSwitch(['app', '\n--renderer-cmd-prefix=sh -c id'], 'linux')).toBe(true)
  })

  it('detects switches that make Chromium launch a command', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(hasDisallowedPackagedDebugSwitch(['app', '--gpu-launcher=cmd.exe /c calc'], platform)).toBe(true)
      expect(hasDisallowedPackagedDebugSwitch(['app', '--renderer-cmd-prefix=calc.exe'], platform)).toBe(true)
      expect(hasDisallowedPackagedDebugSwitch(['app', '--utility-cmd-prefix=calc.exe'], platform)).toBe(true)
      expect(hasDisallowedPackagedDebugSwitch(['app', '--browser-subprocess-path=C:\\evil.exe'], platform)).toBe(true)
      expect(hasDisallowedPackagedDebugSwitch(['app', '--zygote-cmd-prefix=sh -c id'], platform)).toBe(true)
    }
  })

  it('detects the remaining Node inspector spellings', () => {
    expect(hasDisallowedPackagedDebugSwitch(['app', '--inspect-wait'], 'linux')).toBe(true)
    expect(hasDisallowedPackagedDebugSwitch(['app', '--inspect-brk-node=9229'], 'win32')).toBe(true)
  })

  it('still checks arguments after a bare double dash', () => {
    expect(hasDisallowedPackagedDebugSwitch(['app.exe', '--', '/remote-debugging-port=9222'], 'win32')).toBe(true)
  })

  it('allows the arguments the app itself launches with', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(hasDisallowedPackagedDebugSwitch([
        'app',
        loginLaunchArgument,
        accelerationWorkerArgument,
        '--user-data-dir=/tmp/xingmang-acceleration-profile-abc',
        uninstallCleanupArgument,
        uninstallClearLoginArgument,
        // electron-builder's StartApp after an update, and Electron's relaunch.
        '--updated',
        'xingmang://open',
        'xingmang://account/login?next=/wallet',
        '--',
        '-',
        '/',
      ], platform)).toBe(false)
    }
    // Windows starts a COM activator with -Embedding or /Embedding; older macOS
    // Finder adds a process serial number.
    expect(hasDisallowedPackagedDebugSwitch(['app.exe', '-Embedding', '/Embedding', '-ToastActivated'], 'win32')).toBe(false)
    expect(hasDisallowedPackagedDebugSwitch(['app', '-psn_0_12345'], 'darwin')).toBe(false)
    expect(hasDisallowedPackagedDebugSwitch([
      'C:\\Program Files\\星芒AI管理工具\\星芒AI管理工具.exe',
      '/c',
      'C:\\Users\\tester\\Documents\\remote-debugging-port',
    ], 'win32')).toBe(false)
  })
})

describe('packaged launch arguments from the Windows installer', () => {
  const repository = path.join(__dirname, '..')
  const windowsExecutable = 'C:\\Program Files\\星芒AI管理工具\\星芒AI管理工具.exe'

  it('lets every command line the uninstall hooks start this app with through', () => {
    const installer = fs.readFileSync(path.join(repository, 'build', 'installer.nsh'), 'utf8')
    const defines = new Map([...installer.matchAll(/^!define (\w+) "([^"]*)"$/gm)].map((match) => [match[1], match[2]]))
    const launches = installer.split('\n')
      .filter((line) => /\bExec\w*\b/.test(line) && line.includes('${APP_EXECUTABLE_FILENAME}'))
    expect(launches.length).toBeGreaterThan(0)
    for (const line of launches) {
      const tail = line.match(/\$\{APP_EXECUTABLE_FILENAME\}"([^']*)'/)
      expect(tail, line).not.toBeNull()
      const args = (tail?.[1] ?? '').trim().split(/\s+/).filter(Boolean)
        .map((token) => token.replace(/^\$\{(\w+)\}$/, (_whole, name: string) => defines.get(name) ?? token))
      expect(args.length, line).toBeGreaterThan(0)
      for (const argument of args) expect(argument, line).not.toContain('${')
      expect(hasDisallowedPackagedDebugSwitch([windowsExecutable, ...args], 'win32'), line).toBe(false)
    }
  })

  // The finish page's "run" box (assistedInstaller.nsh, oneClick is off) and the
  // silent update relaunch (common.nsh) each pick the arguments they hand to
  // ExecShellAsUser.
  it.each([
    ['assistedInstaller.nsh', /StrCpy \$1 "([^"]*)"/g],
    ['common.nsh', /StrCpy \$startAppArgs "([^"]*)"/g],
  ] as const)('lets the arguments electron-builder %s starts the app with through', (template, assignment) => {
    const source = fs.readFileSync(path.join(repository, 'node_modules', 'app-builder-lib', 'templates', 'nsis', template), 'utf8')
    expect(source).toContain('${StdUtils.ExecShellAsUser} $0 "$launchLink" "open"')
    const values = [...source.matchAll(assignment)].map((match) => match[1])
    expect(values).toContain('--updated')
    for (const value of values) {
      const args = value.split(/\s+/).filter(Boolean)
      expect(hasDisallowedPackagedDebugSwitch([windowsExecutable, ...args], 'win32'), value).toBe(false)
    }
  })
})
