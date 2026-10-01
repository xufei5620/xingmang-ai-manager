import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LaunchInstallNotice, launchInstallCountdownText, launchInstallSecondsLeft } from './LaunchInstallNotice'
import { StartupNotices } from './StartupNotices'

const notice = {
  version: '0.2.13',
  title: '星芒AI马上更新',
  body: '上次下好的新版 0.2.13 几秒后开始安装，软件会先关掉，装好自动打开。Windows 弹出授权窗口时请点「是」。',
  installAt: 10_000,
}

describe('LaunchInstallNotice', () => {
  it('counts whole seconds down to the install moment and never below zero', () => {
    expect(launchInstallSecondsLeft(10_000, 5_000)).toBe(5)
    expect(launchInstallSecondsLeft(10_000, 5_001)).toBe(5)
    expect(launchInstallSecondsLeft(10_000, 9_999)).toBe(1)
    expect(launchInstallSecondsLeft(10_000, 10_000)).toBe(0)
    expect(launchInstallSecondsLeft(10_000, 20_000)).toBe(0)
  })

  it('says the install is starting once the countdown runs out', () => {
    expect(launchInstallCountdownText(3)).toBe('还有 3 秒开始安装。')
    expect(launchInstallCountdownText(0)).toBe('正在开始安装，软件马上关掉。')
  })

  it('renders the same wording as the system notification in the startup corner, without a dismiss button', () => {
    const markup = renderToStaticMarkup(<StartupNotices notices={[]} onDismiss={() => undefined} onOpen={() => undefined}
      leading={<LaunchInstallNotice notice={notice} now={() => 5_000} />} />)
    expect(markup).toContain('data-testid="startup-notices"')
    expect(markup).toContain('data-testid="launch-install-notice"')
    expect(markup).toContain('星芒AI马上更新')
    expect(markup).toContain('请点「是」')
    expect(markup).toContain('还有 5 秒开始安装。')
    expect(markup).toContain('role="status"')
    expect(markup).not.toContain('aria-label="关闭"')
  })
})
