import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LaunchInstallNotice, launchInstallCountdownText, launchInstallSecondsLeft } from './LaunchInstallNotice'
import { StartupNotices } from './StartupNotices'

const notice = {
  version: '0.2.13',
  title: '星芒AI即将更新',
  body: '已下载的新版 0.2.13 将在几秒后开始安装，软件将先关闭，安装完成后自动打开。Windows 弹出授权窗口时，请点击「是」。',
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
    expect(launchInstallCountdownText(3)).toBe('3 秒后开始安装。')
    expect(launchInstallCountdownText(0)).toBe('正在开始安装，软件即将关闭。')
  })

  it('renders the same wording as the system notification in the startup corner, without a dismiss button', () => {
    const markup = renderToStaticMarkup(<StartupNotices notices={[]} onDismiss={() => undefined} onOpen={() => undefined}
      leading={[<LaunchInstallNotice key="launch" notice={notice} now={() => 5_000} />]} />)
    expect(markup).toContain('data-testid="startup-notices"')
    expect(markup).toContain('data-testid="launch-install-notice"')
    expect(markup).toContain('星芒AI即将更新')
    expect(markup).toContain('请点击「是」')
    expect(markup).toContain('5 秒后开始安装。')
    expect(markup).toContain('role="status"')
    expect(markup).not.toContain('aria-label="关闭"')
  })
})
