import { describe, expect, it } from 'vitest'
import {
  isAllowedAppNavigationUrl,
  isAllowedExternalUrl,
  hasDisallowedPackagedDebugSwitch,
  isTrustedIpcSenderUrl,
  resolvePackagedApplicationFile,
  type ApplicationUrlPolicy,
} from './security'

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
    expect(isAllowedAppNavigationUrl('https://api.solov.cc/', windowsPolicy)).toBe(false)
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

describe('external URL allowlist', () => {
  const allowlist = [
    'https://api.solov.cc',
    'https://api.solov.cc/keys',
    'https://s4621e8xzb.feishu.cn/wiki/XLDLwdXDli3fj9kyMvsc5Qldnie?from=from_copylink',
    'https://nodejs.org/',
    'ms-windows-store://pdp/?ProductId=9PLM9XGG6VKS',
  ]

  it('matches normalized HTTPS URLs and the exact local Microsoft Store URI', () => {
    expect(isAllowedExternalUrl('https://api.solov.cc/', allowlist)).toBe(true)
    expect(isAllowedExternalUrl('https://api.solov.cc/keys', allowlist)).toBe(true)
    expect(isAllowedExternalUrl('https://nodejs.org/', allowlist)).toBe(true)
    expect(isAllowedExternalUrl(
      'https://s4621e8xzb.feishu.cn/wiki/XLDLwdXDli3fj9kyMvsc5Qldnie?from=from_copylink',
      allowlist,
    )).toBe(true)
    expect(isAllowedExternalUrl('ms-windows-store://pdp/?ProductId=9PLM9XGG6VKS', allowlist)).toBe(true)
  })

  it('rejects lookalike hosts, extra URL data, credentials, and other schemes', () => {
    expect(isAllowedExternalUrl('https://api.solov.cc.evil.example/keys', allowlist)).toBe(false)
    expect(isAllowedExternalUrl('https://api.solov.cc/keys?redirect=1', allowlist)).toBe(false)
    expect(isAllowedExternalUrl('https://api.solov.cc/keys#token', allowlist)).toBe(false)
    expect(isAllowedExternalUrl('https://user@api.solov.cc/keys', allowlist)).toBe(false)
    expect(isAllowedExternalUrl('http://api.solov.cc/keys', allowlist)).toBe(false)
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
})
