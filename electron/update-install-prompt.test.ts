import { describe, expect, it } from 'vitest'
import {
  IDLE_INSTALL_AFTER_PROMPT_MS,
  IDLE_INSTALL_IDLE_MS,
  IDLE_INSTALL_STATUS_WAIT_MS,
  IDLE_POLL_MS,
  PROMPT_POLL_MS,
  PROMPT_QUIET_INPUT_MS,
  buildInstallPrompt,
  createUpdateInstallPrompter,
  decideIdleInstall,
  isAwayFromComputer,
  resolveInstallPromptVersion,
  type IdleInstallInput,
  type InstallPrompt,
  type InstallPromptAnswer,
  type UpdateInstallPrompterOptions,
} from './update-install-prompt'
import type { UpdateSnapshot } from './updater'

function snapshot(patch: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    phase: 'downloaded',
    currentVersion: '0.2.21',
    availableVersion: '0.2.22',
    releaseName: null,
    releaseNotesText: null,
    checkedAt: null,
    progress: null,
    error: null,
    development: false,
    ...patch,
  }
}

function idleInput(patch: Partial<IdleInstallInput> = {}): IdleInstallInput {
  return {
    platform: 'darwin',
    unattended: true,
    autoUpdate: true,
    snapshot: snapshot(),
    idleMs: IDLE_INSTALL_IDLE_MS,
    locked: false,
    windowVisible: false,
    busy: false,
    toolsWorking: false,
    accelerationActive: false,
    attempted: false,
    promptOpen: false,
    notBefore: null,
    now: 1_000,
    ...patch,
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

interface Harness {
  options: UpdateInstallPrompterOptions
  state: { snapshot: UpdateSnapshot; idleMs: number; locked: boolean; now: number; windowVisible: boolean; standardAccount: boolean | null; attempted: string | null }
  timers: Array<{ callback: () => void; ms: number; cancelled: boolean }>
  asks: Array<{ prompt: InstallPrompt; signal: AbortSignal; answer(value: InstallPromptAnswer): void }>
  installedNow: string[]
  installedIdle: string[]
  events: string[]
  runTimers(): Promise<void>
}

function harness(platform: NodeJS.Platform = 'darwin', patch: Partial<UpdateInstallPrompterOptions> = {}): Harness {
  const state: Harness['state'] = { snapshot: snapshot(), idleMs: 0, locked: false, now: 1_000, windowVisible: false, standardAccount: false, attempted: null }
  const timers: Harness['timers'] = []
  const asks: Harness['asks'] = []
  const installedNow: string[] = []
  const installedIdle: string[] = []
  const events: string[] = []
  const options: UpdateInstallPrompterOptions = {
    platform,
    getState: () => state.snapshot,
    autoUpdate: () => true,
    standardAccount: () => state.standardAccount,
    unattended: () => true,
    elevated: () => false,
    idleMs: () => state.idleMs,
    locked: () => state.locked,
    windowVisible: () => state.windowVisible,
    busy: () => false,
    toolsWorking: () => false,
    accelerationActive: () => false,
    attempted: (version) => state.attempted === version,
    ask: (prompt, signal) => new Promise<InstallPromptAnswer>((resolve) => {
      // Electron closes an aborted message box as if the cancel button was pressed.
      signal.addEventListener('abort', () => resolve('later'))
      asks.push({ prompt, signal, answer: resolve })
    }),
    installNow: async (version) => { installedNow.push(version) },
    refreshServiceStatus: async () => null,
    installWhileIdle: async (version) => { installedIdle.push(version) },
    log: (_level, event) => { events.push(event) },
    now: () => state.now,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
    ...patch,
  }
  return {
    options,
    state,
    timers,
    asks,
    installedNow,
    installedIdle,
    events,
    async runTimers() {
      const due = timers.splice(0).filter((timer) => !timer.cancelled)
      for (const timer of due) timer.callback()
      await settle()
    },
  }
}

describe('update install prompt copy', () => {
  it('matches the wording approved on 2026-10-25 for each kind of computer', () => {
    expect(buildInstallPrompt('0.2.22', 'darwin', { unattended: true })).toEqual({
      title: '星芒AI管理工具',
      message: '新版 0.2.22 已经下好，现在装上吗？',
      detail: '装的时候星芒会先关掉，装好自动打开。现在不装也行：你不用电脑时星芒会自己装好，装完照旧待在菜单栏。',
      buttons: ['稍后再说', '现在安装'],
    })
    expect(buildInstallPrompt('0.2.22', 'darwin', { unattended: false }).detail)
      .toBe('装的时候星芒会先关掉，装好自动打开。现在不装也行：退出星芒或下次打开时自动装上。')
    expect(buildInstallPrompt('0.2.22', 'win32', { unattended: false }).detail)
      .toBe('装的时候星芒会先关掉，装好自动打开。Windows 弹出授权窗口时请点「是」。现在不装也行：关掉软件或下次打开时自动装上。')
    // Running elevated already, so no consent window appears.
    expect(buildInstallPrompt('0.2.22', 'win32', { unattended: false, elevated: true }).detail)
      .toBe('装的时候星芒会先关掉，装好自动打开。现在不装也行：关掉软件或下次打开时自动装上。')
  })

  it('puts the safe answer first so it is the default and the cancel button', () => {
    expect(buildInstallPrompt('0.2.22', 'win32', { unattended: false }).buttons[0]).toBe('稍后再说')
  })
})

describe('resolveInstallPromptVersion', () => {
  const base = { autoUpdate: true, snapshot: snapshot(), attempted: false, standardAccount: false }

  it('asks about a downloaded version that no automatic install has taken', () => {
    // Downloaded during this run, or downloaded before it while the launch install held it back
    // (a login launch waiting for the first window, or the two-minute launch window missed).
    expect(resolveInstallPromptVersion(base)).toBe('0.2.22')
  })

  it('leaves a version the launch install or another automatic install has taken to that install', () => {
    expect(resolveInstallPromptVersion({ ...base, attempted: true })).toBeNull()
  })

  it('does not ask when the customer cannot or did not choose to install automatically', () => {
    expect(resolveInstallPromptVersion({ ...base, autoUpdate: false })).toBeNull()
    expect(resolveInstallPromptVersion({ ...base, standardAccount: true })).toBeNull()
    // Whether the Windows account is an administrator is not known yet.
    expect(resolveInstallPromptVersion({ ...base, standardAccount: null })).toBeNull()
    expect(resolveInstallPromptVersion({ ...base, snapshot: snapshot({ installMethod: 'system-installer' }) })).toBeNull()
  })

  it('does not ask while the launch install notice is counting down or nothing is ready', () => {
    const notice = { version: '0.2.22', title: '星芒AI马上更新', body: '…', installAt: 5_000 }
    expect(resolveInstallPromptVersion({ ...base, snapshot: snapshot({ launchInstallNotice: notice }) })).toBeNull()
    expect(resolveInstallPromptVersion({ ...base, snapshot: snapshot({ phase: 'downloading' }) })).toBeNull()
    expect(resolveInstallPromptVersion({ ...base, snapshot: snapshot({ error: { code: 'X', message: '装失败了' } }) })).toBeNull()
  })
})

describe('decideIdleInstall', () => {
  it('installs on an idle or locked Mac that can install without asking for a password', () => {
    expect(decideIdleInstall(idleInput())).toBe('0.2.22')
    expect(decideIdleInstall(idleInput({ idleMs: 0, locked: true }))).toBe('0.2.22')
  })

  it('never installs unattended on Windows or on a Mac that would ask for a password', () => {
    expect(decideIdleInstall(idleInput({ platform: 'win32' }))).toBeNull()
    expect(decideIdleInstall(idleInput({ unattended: false }))).toBeNull()
    expect(decideIdleInstall(idleInput({ autoUpdate: false }))).toBeNull()
  })

  it('waits while someone may be using the computer or 星芒', () => {
    expect(decideIdleInstall(idleInput({ idleMs: IDLE_INSTALL_IDLE_MS - 1 }))).toBeNull()
    expect(decideIdleInstall(idleInput({ windowVisible: true }))).toBeNull()
    expect(decideIdleInstall(idleInput({ busy: true }))).toBeNull()
    expect(decideIdleInstall(idleInput({ toolsWorking: true }))).toBeNull()
    expect(decideIdleInstall(idleInput({ accelerationActive: true }))).toBeNull()
    expect(decideIdleInstall(idleInput({ promptOpen: true }))).toBeNull()
    expect(decideIdleInstall(idleInput({ notBefore: 1_001 }))).toBeNull()
    expect(decideIdleInstall(idleInput({ notBefore: 1_000 }))).toBe('0.2.22')
  })

  it('tries each version once', () => {
    expect(decideIdleInstall(idleInput({ attempted: true }))).toBeNull()
  })

  it('treats a locked screen or a long pause as nobody at the computer', () => {
    expect(isAwayFromComputer(0, true)).toBe(true)
    expect(isAwayFromComputer(IDLE_INSTALL_IDLE_MS, false)).toBe(true)
    expect(isAwayFromComputer(IDLE_INSTALL_IDLE_MS - 1, false)).toBe(false)
  })
})

describe('createUpdateInstallPrompter', () => {
  it('waits for a pause in typing, asks once, and holds the idle install until well after "later"', async () => {
    const test = harness()
    const prompter = createUpdateInstallPrompter(test.options)
    prompter.observe(test.state.snapshot)
    expect(test.timers.map((timer) => timer.ms)).toEqual([PROMPT_POLL_MS])
    await test.runTimers()
    expect(test.asks).toHaveLength(0)

    test.state.idleMs = PROMPT_QUIET_INPUT_MS
    await test.runTimers()
    expect(test.asks).toHaveLength(1)
    expect(test.asks[0].prompt.message).toBe('新版 0.2.22 已经下好，现在装上吗？')

    test.asks[0].answer('later')
    await settle()
    prompter.observe(test.state.snapshot)
    expect(test.asks).toHaveLength(1)

    test.state.idleMs = IDLE_INSTALL_IDLE_MS
    test.state.now += IDLE_INSTALL_AFTER_PROMPT_MS - 1
    await test.runTimers()
    expect(test.installedIdle).toEqual([])
    test.state.now += 1
    expect(test.timers.map((timer) => timer.ms)).toEqual([IDLE_POLL_MS])
    await test.runTimers()
    expect(test.installedIdle).toEqual(['0.2.22'])
    // One idle attempt per version: nothing keeps polling afterwards.
    await test.runTimers()
    expect(test.installedIdle).toEqual(['0.2.22'])
    expect(test.timers).toEqual([])
    prompter.dispose()
  })

  it('keeps the pending poll when the update state is reported again', async () => {
    const test = harness()
    const prompter = createUpdateInstallPrompter(test.options)
    prompter.observe(test.state.snapshot)
    prompter.observe(test.state.snapshot)
    prompter.observe(test.state.snapshot)
    expect(test.timers.filter((timer) => !timer.cancelled)).toHaveLength(1)
    expect(test.timers).toHaveLength(1)
    prompter.dispose()
  })

  it('installs the asked version when the customer clicks install, and not one that changed meanwhile', async () => {
    const accepted = harness('win32')
    const prompter = createUpdateInstallPrompter(accepted.options)
    accepted.state.idleMs = PROMPT_QUIET_INPUT_MS
    prompter.observe(accepted.state.snapshot)
    await accepted.runTimers()
    accepted.asks[0].answer('install')
    await settle()
    expect(accepted.installedNow).toEqual(['0.2.22'])
    prompter.dispose()

    const changed = harness('win32')
    const other = createUpdateInstallPrompter(changed.options)
    changed.state.idleMs = PROMPT_QUIET_INPUT_MS
    other.observe(changed.state.snapshot)
    await changed.runTimers()
    changed.state.snapshot = snapshot({ availableVersion: '0.2.23' })
    changed.asks[0].answer('install')
    await settle()
    expect(changed.installedNow).toEqual([])
    other.dispose()
  })

  it('skips the question and installs while idle when nobody is at the Mac', async () => {
    const test = harness()
    const prompter = createUpdateInstallPrompter(test.options)
    test.state.locked = true
    prompter.observe(test.state.snapshot)
    await test.runTimers()
    expect(test.asks).toHaveLength(0)
    expect(test.events).toContain('install.prompt.away')
    await test.runTimers()
    expect(test.installedIdle).toEqual(['0.2.22'])
    prompter.dispose()
  })

  it('reads the service status again before installing while idle and skips a version withdrawn meanwhile', async () => {
    const order: string[] = []
    const test = harness('darwin', {
      refreshServiceStatus: async () => {
        order.push('refresh')
        // The updater drops a downloaded offer the moment it learns it was withdrawn (withdrawOffer).
        if (test.state.snapshot.availableVersion === '0.2.22') test.state.snapshot = snapshot({ phase: 'idle', availableVersion: null })
        return null
      },
      installWhileIdle: async (version) => { order.push(`install ${version}`) },
    })
    const prompter = createUpdateInstallPrompter(test.options)
    test.state.locked = true
    prompter.observe(test.state.snapshot)
    await test.runTimers()
    await test.runTimers()
    expect(order).toEqual(['refresh'])
    expect(test.events).toContain('install.idle.withdrawn')
    expect(test.events).not.toContain('install.idle')

    // The fixed version downloaded later in the same run still installs while idle.
    test.state.snapshot = snapshot({ availableVersion: '0.2.23' })
    prompter.observe(test.state.snapshot)
    await test.runTimers()
    await test.runTimers()
    expect(order).toEqual(['refresh', 'refresh', 'install 0.2.23'])
    prompter.dispose()
  })

  it('installs on the last known withdrawal list when the service status is slow or unreadable', async () => {
    const slow = harness('darwin', { refreshServiceStatus: () => new Promise<never>(() => undefined) })
    const slowPrompter = createUpdateInstallPrompter(slow.options)
    slow.state.locked = true
    slowPrompter.observe(slow.state.snapshot)
    await slow.runTimers()
    await slow.runTimers()
    expect(slow.installedIdle).toEqual([])
    expect(slow.timers.filter((timer) => !timer.cancelled).map((timer) => timer.ms)).toEqual([IDLE_INSTALL_STATUS_WAIT_MS])
    await slow.runTimers()
    expect(slow.installedIdle).toEqual(['0.2.22'])
    slowPrompter.dispose()

    const failing = harness('darwin', { refreshServiceStatus: async () => { throw new Error('offline') } })
    const failingPrompter = createUpdateInstallPrompter(failing.options)
    failing.state.locked = true
    failingPrompter.observe(failing.state.snapshot)
    await failing.runTimers()
    await failing.runTimers()
    expect(failing.installedIdle).toEqual(['0.2.22'])
    // The wait timer is dropped once the read settles.
    expect(failing.timers.filter((timer) => timer.ms === IDLE_INSTALL_STATUS_WAIT_MS).every((timer) => timer.cancelled)).toBe(true)
    failingPrompter.dispose()
  })

  it('does not install while idle if 星芒 is closing while the service status is read', async () => {
    const test = harness('darwin', { refreshServiceStatus: () => new Promise<never>(() => undefined) })
    const prompter = createUpdateInstallPrompter(test.options)
    test.state.locked = true
    prompter.observe(test.state.snapshot)
    await test.runTimers()
    await test.runTimers()
    prompter.dispose()
    await test.runTimers()
    expect(test.installedIdle).toEqual([])
  })

  it('closes an unanswered question once the customer has walked away, then installs without the extra wait', async () => {
    const test = harness()
    const prompter = createUpdateInstallPrompter(test.options)
    test.state.idleMs = PROMPT_QUIET_INPUT_MS
    prompter.observe(test.state.snapshot)
    await test.runTimers()
    expect(test.asks).toHaveLength(1)
    // Still around: the question stays up.
    await test.runTimers()
    expect(test.asks[0].signal.aborted).toBe(false)

    test.state.idleMs = IDLE_INSTALL_IDLE_MS
    await test.runTimers()
    expect(test.asks[0].signal.aborted).toBe(true)
    expect(test.events).toContain('install.prompt.abandoned')
    await test.runTimers()
    expect(test.installedIdle).toEqual(['0.2.22'])
    expect(test.installedNow).toEqual([])
    prompter.dispose()
  })

  it('on Windows still asks when nobody is around and never installs on its own', async () => {
    const test = harness('win32', { unattended: () => false })
    const prompter = createUpdateInstallPrompter(test.options)
    test.state.idleMs = IDLE_INSTALL_IDLE_MS * 3
    prompter.observe(test.state.snapshot)
    await test.runTimers()
    expect(test.asks).toHaveLength(1)
    expect(test.asks[0].prompt.detail).toContain('Windows 弹出授权窗口时请点「是」。')
    // No poll while the question waits: nothing on Windows would close it.
    expect(test.timers).toEqual([])
    test.asks[0].answer('later')
    await settle()
    expect(test.timers).toEqual([])
    expect(test.installedIdle).toEqual([])
    prompter.dispose()
  })

  it('holds the question while network acceleration is on and asks once it is off', async () => {
    let accelerating = true
    const test = harness('win32', { unattended: () => false, accelerationActive: () => accelerating })
    const prompter = createUpdateInstallPrompter(test.options)
    test.state.idleMs = PROMPT_QUIET_INPUT_MS
    prompter.observe(test.state.snapshot)
    await test.runTimers()
    await test.runTimers()
    expect(test.asks).toHaveLength(0)
    // A gaming session can last hours: look slowly, and log the hold once.
    expect(test.timers.map((timer) => timer.ms)).toEqual([IDLE_POLL_MS])
    expect(test.events.filter((event) => event === 'install.prompt.held')).toHaveLength(1)

    accelerating = false
    await test.runTimers()
    expect(test.asks).toHaveLength(1)
    expect(test.installedNow).toEqual([])
    prompter.dispose()
  })

  it('does not treat a Mac gamer as away while acceleration is on', async () => {
    let accelerating = true
    const test = harness('darwin', { accelerationActive: () => accelerating })
    const prompter = createUpdateInstallPrompter(test.options)
    // Gamepad input does not reset the system idle time.
    test.state.idleMs = IDLE_INSTALL_IDLE_MS
    prompter.observe(test.state.snapshot)
    await test.runTimers()
    await test.runTimers()
    expect(test.events).not.toContain('install.prompt.away')
    expect(test.asks).toHaveLength(0)
    expect(test.installedIdle).toEqual([])

    accelerating = false
    test.state.idleMs = PROMPT_QUIET_INPUT_MS
    await test.runTimers()
    expect(test.asks).toHaveLength(1)
    prompter.dispose()
  })

  it('holds the question when it cannot tell whether acceleration is on', async () => {
    const test = harness('win32', {
      unattended: () => false,
      accelerationActive: () => { throw new Error('acceleration state unavailable') },
    })
    const prompter = createUpdateInstallPrompter(test.options)
    test.state.idleMs = PROMPT_QUIET_INPUT_MS
    prompter.observe(test.state.snapshot)
    await test.runTimers()
    expect(test.asks).toHaveLength(0)
    expect(test.events).toContain('install.prompt.held')
    prompter.dispose()
  })

  it('waits to ask until it is known whether the Windows account is an administrator', async () => {
    const test = harness('win32', { unattended: () => false })
    test.state.standardAccount = null
    test.state.idleMs = PROMPT_QUIET_INPUT_MS
    const prompter = createUpdateInstallPrompter(test.options)
    prompter.observe(test.state.snapshot)
    expect(test.timers).toEqual([])
    test.state.standardAccount = false
    prompter.observe(test.state.snapshot)
    await test.runTimers()
    expect(test.asks).toHaveLength(1)
    prompter.dispose()
  })

  it('asks about a version the launch install held for the first window on a Windows login launch', async () => {
    // The launch install decided 'window' and wrote nothing, so the question is the only way this
    // computer installs before it is shut down again.
    const test = harness('win32', { unattended: () => false })
    test.state.idleMs = PROMPT_QUIET_INPUT_MS
    const prompter = createUpdateInstallPrompter(test.options)
    prompter.observe(test.state.snapshot)
    await test.runTimers()
    expect(test.asks).toHaveLength(1)
    expect(test.asks[0].prompt.message).toBe('新版 0.2.22 已经下好，现在装上吗？')
    test.asks[0].answer('install')
    await settle()
    expect(test.installedNow).toEqual(['0.2.22'])
    prompter.dispose()
  })

  it('stops waiting to ask once the launch install takes the version', async () => {
    // The customer opened the window from the tray before the computer went quiet: the launch
    // install announced the version and marked it attempted.
    const test = harness('win32', { unattended: () => false })
    const prompter = createUpdateInstallPrompter(test.options)
    prompter.observe(test.state.snapshot)
    expect(test.timers.map((timer) => timer.ms)).toEqual([PROMPT_POLL_MS])
    test.state.attempted = '0.2.22'
    test.state.idleMs = PROMPT_QUIET_INPUT_MS
    await test.runTimers()
    expect(test.asks).toHaveLength(0)
    expect(test.timers).toEqual([])
    prompter.dispose()
  })

  it('does not ask when it cannot tell whether an automatic install has taken the version', async () => {
    const test = harness('win32', {
      unattended: () => false,
      attempted: () => { throw new Error('record unreadable') },
    })
    test.state.idleMs = PROMPT_QUIET_INPUT_MS
    const prompter = createUpdateInstallPrompter(test.options)
    prompter.observe(test.state.snapshot)
    await test.runTimers()
    expect(test.asks).toHaveLength(0)
    prompter.dispose()
  })

  it('leaves a version already tried by another automatic install alone', async () => {
    const test = harness()
    test.state.attempted = '0.2.22'
    test.state.locked = true
    const prompter = createUpdateInstallPrompter(test.options)
    prompter.observe(test.state.snapshot)
    await test.runTimers()
    await test.runTimers()
    expect(test.asks).toHaveLength(0)
    expect(test.installedIdle).toEqual([])
    prompter.dispose()
  })

  it('closes the question and stops polling when disposed', async () => {
    const test = harness()
    test.state.idleMs = PROMPT_QUIET_INPUT_MS
    const prompter = createUpdateInstallPrompter(test.options)
    prompter.observe(test.state.snapshot)
    await test.runTimers()
    prompter.dispose()
    expect(test.asks[0].signal.aborted).toBe(true)
    await settle()
    expect(test.timers.every((timer) => timer.cancelled)).toBe(true)
    expect(test.installedIdle).toEqual([])
  })
})
