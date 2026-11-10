import { describe, expect, it, vi } from 'vitest'
import { providerIds } from './catalog'
import { externalToolIds } from './external-client-contract'
import { isKeepAwakeInstallKey } from './install-keep-awake'
import { codexRemoteLaunchQueueKey } from './provider-launch-service'
import {
  buildUnfinishedRestartWorkPrompt,
  confirmUpdateRestart,
  resolveInstallableUpdateOnQuit,
  resolveInterruptibleInstallTask,
  waitForUpdateInstallFailure,
  type InterruptibleInstallTask,
  type UnfinishedRestartWorkPrompt,
  type UpdateRestartConfirmation,
} from './quit-blocking-tasks'
import type { UpdateSnapshot } from './updater'

function snapshot(activeKey: string | null, pendingKeys: string[] = []) {
  return { activeKey, pendingKeys }
}

describe('interruptible install tasks', () => {
  it('reports nothing while the installation queue is idle', () => {
    expect(resolveInterruptibleInstallTask(snapshot(null))).toBeNull()
  })

  it('names the CLI whose installation is running', () => {
    expect(resolveInterruptibleInstallTask(snapshot('cli:install:claude'))).toEqual({
      key: 'cli:install:claude', description: '正在安装 Claude Code', count: 1,
    })
  })

  it('names the bundled runtimes and the Codex desktop download', () => {
    const descriptions = ['runtime:node', 'runtime:python', 'desktop:codex:install']
      .map((key) => resolveInterruptibleInstallTask(snapshot(key))?.description)
    expect(descriptions).toEqual(['正在安装 Node.js 运行环境', '正在安装 Python 运行环境', '正在安装 Codex 桌面端'])
  })

  it('names Git, which Windows installs right after Claude Code', () => {
    expect(resolveInterruptibleInstallTask(snapshot('runtime:git'))).toEqual({
      key: 'runtime:git', description: '正在安装 Git', count: 1,
    })
  })

  it('names the external client being installed', () => {
    const descriptions = ['external-client:install:workbuddy', 'external-client:install:claudeDesktop', 'external-client:install:opencode']
      .map((key) => resolveInterruptibleInstallTask(snapshot(key))?.description)
    expect(descriptions).toEqual(['正在安装 WorkBuddy', '正在安装 Claude Desktop', '正在安装 OpenCode'])
  })

  it('ignores launches and uninstalls, which lose nothing when interrupted', () => {
    const keys = ['cli:launch:codex', 'desktop:codex:launch:new:default', 'cli:uninstall:gemini', 'desktop:codex:uninstall', 'external-client:launch:workbuddy']
    for (const key of keys) expect(resolveInterruptibleInstallTask(snapshot(key, keys))).toBeNull()
  })

  // 手机遥控起 Codex 也排进安装队列（#1407 P3-3），但它和终端里打开 Codex 一样只是拉起进程：不拦退出、不挡睡眠。
  it('treats the remote control starting Codex as a launch', () => {
    expect(codexRemoteLaunchQueueKey.startsWith('cli:launch:')).toBe(true)
    expect(resolveInterruptibleInstallTask(snapshot(codexRemoteLaunchQueueKey))).toBeNull()
    expect(isKeepAwakeInstallKey(codexRemoteLaunchQueueKey)).toBe(false)
  })

  it('ignores an unknown or malformed provider so quitting is never blocked by a typo', () => {
    expect(resolveInterruptibleInstallTask(snapshot('cli:install:'))).toBeNull()
    expect(resolveInterruptibleInstallTask(snapshot('cli:install:__proto__'))).toBeNull()
    expect(resolveInterruptibleInstallTask(snapshot('something:else'))).toBeNull()
  })

  it('ignores an unknown or malformed external client the same way', () => {
    for (const key of ['external-client:install:', 'external-client:install:__proto__', 'external-client:install:cursor', 'external-client:install:claudedesktop']) {
      expect(resolveInterruptibleInstallTask(snapshot(key))).toBeNull()
    }
  })

  it('counts queued installs but keeps the name of the one the user is watching', () => {
    const result = resolveInterruptibleInstallTask(snapshot('cli:install:codex', ['cli:launch:grok', 'runtime:node']))
    expect(result).toEqual({ key: 'cli:install:codex', description: '正在安装 Codex CLI', count: 2 })
  })

  it('still warns when only a queued install is waiting behind a launch', () => {
    const result = resolveInterruptibleInstallTask(snapshot('cli:launch:grok', ['cli:install:gemini']))
    expect(result).toEqual({ key: 'cli:install:gemini', description: '正在安装 Gemini CLI', count: 1 })
  })

  it('counts a client queued behind the Git install and keeps naming Git', () => {
    const result = resolveInterruptibleInstallTask(snapshot('runtime:git', ['external-client:install:workbuddy']))
    expect(result).toEqual({ key: 'runtime:git', description: '正在安装 Git', count: 2 })
  })

  it('blocks quitting for exactly the queue keys that also keep the computer awake', () => {
    // 程序里会进安装队列的每一种 key。防睡和退出拦截各认一份，新加一种安装时两边要一起认，
    // 不然就是「电脑不睡了，退出却不拦」。
    const keys = [
      'runtime:node', 'runtime:python', 'runtime:git', 'maintenance:install-leftovers',
      'desktop:codex:install', 'desktop:codex:uninstall', 'desktop:codex:reset', 'desktop:codex:launch:new:zh-CN',
      ...providerIds.flatMap((provider) => [`cli:install:${provider}`, `cli:uninstall:${provider}`, `cli:launch:${provider}:new:/work`]),
      ...externalToolIds.flatMap((tool) => [`external-client:install:${tool}`, `external-client:launch:${tool}`]),
    ]
    const blocking = keys.map((key) => [key, resolveInterruptibleInstallTask(snapshot(key)) !== null])
    expect(blocking).toEqual(keys.map((key) => [key, isKeepAwakeInstallKey(key)]))
  })
})

function updateSnapshot(overrides: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    phase: 'downloaded',
    currentVersion: '0.2.8',
    availableVersion: '0.2.9',
    releaseName: null,
    releaseNotesText: null,
    checkedAt: null,
    progress: null,
    error: null,
    failedStep: null,
    development: false,
    ...overrides,
  }
}

describe('unfinished work before restarting to install an update', () => {
  it('says nothing when none of the listed work is running', () => {
    expect(buildUnfinishedRestartWorkPrompt([])).toBeNull()
  })

  it('uses the approved sentence word for word when all three are running', () => {
    expect(buildUnfinishedRestartWorkPrompt(['canvas', 'chat', 'video-compose'])).toEqual({
      kinds: ['chat', 'video-compose', 'canvas'],
      message: '还有任务没做完',
      detail: '对话还在回复或出图，视频剪辑还在拼接，或者画布还在生成。现在重启会把它们停下，出到一半的图可能已经扣费。',
      buttons: ['等它做完', '仍然重启'],
    })
  })

  it('lists only the work that is actually running', () => {
    expect(buildUnfinishedRestartWorkPrompt(['chat'])?.detail).toBe('对话还在回复或出图。现在重启会把它们停下，出到一半的图可能已经扣费。')
    expect(buildUnfinishedRestartWorkPrompt(['video-compose'])?.detail).toBe('视频剪辑还在拼接。现在重启会把它们停下，出到一半的图可能已经扣费。')
    expect(buildUnfinishedRestartWorkPrompt(['canvas'])?.detail).toBe('画布还在生成。现在重启会把它们停下，出到一半的图可能已经扣费。')
    expect(buildUnfinishedRestartWorkPrompt(['canvas', 'chat'])?.detail).toBe('对话还在回复或出图，或者画布还在生成。现在重启会把它们停下，出到一半的图可能已经扣费。')
  })

  it('names each kind once however often it is reported', () => {
    expect(buildUnfinishedRestartWorkPrompt(['chat', 'chat'])?.kinds).toEqual(['chat'])
  })
})

describe('confirming a restart to install an update', () => {
  const task: InterruptibleInstallTask = { key: 'cli:install:claude', description: '正在安装 Claude Code', count: 1 }
  const work = buildUnfinishedRestartWorkPrompt(['chat']) as UnfinishedRestartWorkPrompt

  function steps(overrides: Partial<UpdateRestartConfirmation> = {}) {
    return {
      installTask: vi.fn(() => null),
      confirmInstall: vi.fn(async () => true),
      unfinishedWork: vi.fn(() => null),
      confirmWork: vi.fn(async () => true),
      log: vi.fn(),
      ...overrides,
    } satisfies UpdateRestartConfirmation
  }

  it('installs without asking when nothing would be interrupted', async () => {
    const host = steps()
    await expect(confirmUpdateRestart(host)).resolves.toBe(true)
    expect(host.confirmInstall).not.toHaveBeenCalled()
    expect(host.confirmWork).not.toHaveBeenCalled()
    expect(host.log).not.toHaveBeenCalled()
  })

  it('asks about chat, video editing and canvas work even when no tool is installing', async () => {
    const host = steps({ unfinishedWork: () => work })
    await expect(confirmUpdateRestart(host)).resolves.toBe(true)
    expect(host.confirmWork).toHaveBeenCalledWith(work)
    expect(host.confirmInstall).not.toHaveBeenCalled()
  })

  it('keeps the downloaded update for later when the user waits for the work to finish', async () => {
    const host = steps({ unfinishedWork: () => work, confirmWork: vi.fn(async () => false) })
    await expect(confirmUpdateRestart(host)).resolves.toBe(false)
    expect(host.log).toHaveBeenLastCalledWith('install.postponed', '还有任务没做完，这次不装新版本，新版本留着')
  })

  it('asks about the running install first and stops there when the user keeps installing', async () => {
    const unfinishedWork = vi.fn(() => work)
    const host = steps({ installTask: () => task, confirmInstall: vi.fn(async () => false), unfinishedWork })
    await expect(confirmUpdateRestart(host)).resolves.toBe(false)
    expect(host.confirmInstall).toHaveBeenCalledWith(task)
    expect(unfinishedWork).not.toHaveBeenCalled()
    expect(host.confirmWork).not.toHaveBeenCalled()
  })

  it('still asks about the other work after the user agreed to interrupt the install, since that box never mentioned it', async () => {
    const host = steps({ installTask: () => task, unfinishedWork: () => work, confirmWork: vi.fn(async () => false) })
    await expect(confirmUpdateRestart(host)).resolves.toBe(false)
    expect(host.confirmInstall).toHaveBeenCalledOnce()
    expect(host.confirmWork).toHaveBeenCalledOnce()
  })

  it('reads the running work only after the install question, which can take the user minutes to answer', async () => {
    const order: string[] = []
    const host = steps({
      installTask: () => task,
      confirmInstall: async () => { order.push('install-asked'); return true },
      unfinishedWork: () => { order.push('work-read'); return null },
    })
    await expect(confirmUpdateRestart(host)).resolves.toBe(true)
    expect(order).toEqual(['install-asked', 'work-read'])
  })
})

describe('update ready to install on quit', () => {
  it('offers the verified package waiting on disk', () => {
    expect(resolveInstallableUpdateOnQuit(updateSnapshot())).toEqual({ version: '0.2.9' })
  })

  it('stays quiet until the download and its verification are finished', () => {
    const phases = ['disabled', 'idle', 'checking', 'available', 'not-available', 'downloading', 'cancelled', 'error'] as const
    for (const phase of phases) {
      expect(resolveInstallableUpdateOnQuit(updateSnapshot({ phase }))).toBeNull()
    }
  })

  it('stays quiet when the installer already failed on this package', () => {
    const failed = updateSnapshot({ error: { code: 'UPDATE_INSTALL_LAUNCH_TIMEOUT', message: '更新程序未能启动' }, failedStep: 'install' })
    expect(resolveInstallableUpdateOnQuit(failed)).toBeNull()
  })

  it('never offers an install in development, where the updater refuses it anyway', () => {
    expect(resolveInstallableUpdateOnQuit(updateSnapshot({ development: true }))).toBeNull()
  })

  it('still offers the install when the snapshot carries no version to name', () => {
    expect(resolveInstallableUpdateOnQuit(updateSnapshot({ availableVersion: null }))).toEqual({ version: null })
  })
})

describe('waiting on the Mac installer at quit', () => {
  function updates() {
    const listeners = new Set<(snapshot: UpdateSnapshot) => void>()
    return {
      listeners,
      subscribe(listener: (snapshot: UpdateSnapshot) => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      emit(snapshot: UpdateSnapshot) {
        for (const listener of [...listeners]) listener(snapshot)
      },
    }
  }

  it('settles once the installer reports it could not install, and stops listening', async () => {
    const source = updates()
    let settled = false
    const waiting = waitForUpdateInstallFailure(source).then(() => { settled = true })
    source.emit(updateSnapshot())
    source.emit(updateSnapshot({ phase: 'downloading' }))
    await Promise.resolve()
    expect(settled).toBe(false)
    source.emit(updateSnapshot({ error: { code: 'UPDATE_SIGNATURE_REJECTED', message: '校验没通过' }, failedStep: 'install' }))
    await waiting
    expect(settled).toBe(true)
    expect(source.listeners.size).toBe(0)
  })

  it('keeps waiting through a failure in another step, which the installer did not report', async () => {
    const source = updates()
    let settled = false
    void waitForUpdateInstallFailure(source).then(() => { settled = true })
    source.emit(updateSnapshot({ phase: 'error', error: { code: 'UPDATE_ERROR', message: '下载失败' }, failedStep: 'download' }))
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(source.listeners.size).toBe(1)
  })

  it('keeps waiting through the launch watchdog, which only means the installer has not quit yet', async () => {
    const source = updates()
    let settled = false
    void waitForUpdateInstallFailure(source).then(() => { settled = true })
    source.emit(updateSnapshot({ error: { code: 'UPDATE_INSTALL_LAUNCH_TIMEOUT', message: '新版本没装上：安装程序没起来。' }, failedStep: 'install' }))
    await Promise.resolve()
    expect(settled).toBe(false)
    // 看门狗之后才到的验签结果照样算数（updater.ts 的 macInstallHandoffRegistered 那条）。
    source.emit(updateSnapshot({ error: { code: 'UPDATE_SIGNATURE_REJECTED', message: '校验没通过' }, failedStep: 'install' }))
    await Promise.resolve()
    expect(settled).toBe(true)
  })

  it('copes with a source that reports its current state while subscribing', async () => {
    const failed = updateSnapshot({ error: { code: 'UPDATE_ERROR', message: '没装上' }, failedStep: 'install' })
    const listeners = new Set<(snapshot: UpdateSnapshot) => void>()
    const source = {
      subscribe(listener: (snapshot: UpdateSnapshot) => void) {
        listeners.add(listener)
        listener(failed)
        return () => { listeners.delete(listener) }
      },
    }
    await waitForUpdateInstallFailure(source)
    expect(listeners.size).toBe(0)
  })
})
