import type { SleepBlocker } from './cli-keep-awake'
import { remoteChannelIds, type CodexRemoteSnapshot, type RemoteChannelId } from './codex-remote-channel'

// 手机遥控就是给「人不在电脑跟前」用的，可 Windows 笔记本、Mac 默认十几二十分钟没人碰就睡，
// 一睡飞书长连接、微信长轮询都断了，手机上发消息没人理（0.2.22 审查 YK-1）。所以有渠道开着
// 就挡住系统自动睡眠，全关了就放开。Codex 自己的防睡开关（features.prevent_idle_sleep）只管
// 它跑一轮的时候，两轮之间等手机下一句话那段不管，所以这里不看 Codex 在不在干活。
//
// 跟 cli-keep-awake.ts 是同一种挡法：只挡「自动睡眠」，屏幕照样按用户的设置关，合盖照样睡；
// 不改任何系统电源设置，星芒退出时系统自己就放开了。不另设时长上限：遥控闲着 4 小时会自己
// 断开（codex-remote-service.ts 的 idleTimeoutMs），断开就放。

/**
 * 哪些渠道开着、还收得到手机上的消息：正在连、已连上、连不上正在重试（微信长轮询出错时报
 * error 再退避重试）。重试那一阵也得挡着，不然电脑早就闲够了时间，一放开马上就睡下去，
 * 网络恢复了也连不回来。要回电脑上重新登录的（needs-login）收不到消息，不挡。
 */
export function resolveCodexRemoteKeepAwakeChannels(snapshot: Pick<CodexRemoteSnapshot, 'channels'>): RemoteChannelId[] {
  return remoteChannelIds.filter((id) => {
    const channel = snapshot.channels[id]
    return channel.enabled && channel.status.state !== 'needs-login' && channel.status.state !== 'stopped'
  })
}

export interface CodexRemoteKeepAwakeOptions {
  blocker: SleepBlocker
  log?: (level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>) => void
}

export function createCodexRemoteKeepAwake(options: CodexRemoteKeepAwakeOptions) {
  let blockerId: number | null = null
  let listening: RemoteChannelId[] = []
  // 快照是异步拼好的，先后可能颠倒；只认比手上新的那份，旧的「已关」不能把新的「已开」放掉。
  let revision = Number.NEGATIVE_INFINITY
  let disposed = false

  function release(): void {
    if (blockerId === null) return
    try {
      options.blocker.stop(blockerId)
    } catch (error) {
      options.log?.('warn', 'codex-remote.keep-awake.stop-failed', '放开睡眠失败', { reason: error instanceof Error ? error.message : String(error) })
    }
    blockerId = null
    options.log?.('info', 'codex-remote.keep-awake.released', '手机遥控都关了，电脑可以照常睡眠')
  }

  function hold(): void {
    if (blockerId !== null) return
    try {
      blockerId = options.blocker.start('prevent-app-suspension')
      options.log?.('info', 'codex-remote.keep-awake.held', '手机遥控开着，先不让电脑自动睡眠', { channels: listening })
    } catch (error) {
      // 挡不上就算了，遥控照常；下一份快照来时再试一次。
      options.log?.('warn', 'codex-remote.keep-awake.start-failed', '挡住睡眠失败，遥控照常', { reason: error instanceof Error ? error.message : String(error) })
    }
  }

  return {
    observe(snapshot: CodexRemoteSnapshot): void {
      if (disposed || snapshot.revision <= revision) return
      revision = snapshot.revision
      listening = resolveCodexRemoteKeepAwakeChannels(snapshot)
      if (listening.length > 0) hold()
      else release()
    },
    /** 现在是不是正挡着睡眠；测试与日志用。 */
    holding(): boolean {
      return blockerId !== null
    },
    dispose(): void {
      disposed = true
      listening = []
      release()
    },
  }
}
