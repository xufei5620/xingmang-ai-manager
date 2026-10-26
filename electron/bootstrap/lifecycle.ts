// 主进程退出时（will-quit）要收拾的东西排成一张清单，按 main.ts 登记的先后挨个跑（#1070 第 4 步）。
// 以前是散在 main.ts 里的 7 个 app.once('will-quit')，谁先谁后全靠注册顺序，没写下来也没测试；
// 现在先后由 main.test.ts 按源码钉住。加速那几步按「先停各个提醒、再叫加速服务断开、最后放掉独立加速进程」
// 的先后发出去；后两步都是发出去就走，不等对方做完。独立加速进程被放掉后自己还原系统代理，整个退出只放一次。

/**
 * One will-quit listener runs every registered step in registration order.
 *
 * Steps are isolated from each other: when one throws, the failure is reported
 * by name and the remaining steps still run. With one will-quit listener per
 * group, a throw skipped the rest of its group and every later listener
 * (EventEmitter stops at the first throwing listener), and as an uncaught
 * exception it could reach the unexpected-exit handler before `appWillQuit`
 * was set, which relaunches an app the user had just asked to quit.
 */
export interface QuitCleanup {
  /**
   * Registers a step. A step registered after the cleanup ran never runs,
   * exactly like an app.once('will-quit') listener added after the event.
   */
  add(name: string, step: () => void): void
  /** Runs every registered step once, in registration order. Later calls do nothing. */
  run(): void
}

export interface QuitCleanupOptions {
  onStepFailed: (name: string, error: unknown) => void
}

export function createQuitCleanup(options: QuitCleanupOptions): QuitCleanup {
  const steps: Array<{ name: string, step: () => void }> = []
  let ran = false
  return {
    add(name, step) {
      if (ran) return
      steps.push({ name, step })
    },
    run() {
      if (ran) return
      ran = true
      for (const { name, step } of steps.splice(0)) {
        try {
          step()
        } catch (error) {
          // Reporting runs while the process is going away; it must not stop the remaining steps either.
          try { options.onStepFailed(name, error) } catch { /* nothing left to report to */ }
        }
      }
    },
  }
}
