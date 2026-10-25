import type { RemoteChannelAdapter, RemoteChannelDependencies, RemoteChannelId } from './codex-remote-channel'
import { createFeishuRemoteChannel } from './codex-remote-feishu'

/**
 * 按渠道建适配器。没有 default 分支：remoteChannelIds 加了渠道而这里没跟上，是编译错。
 */
export function createRemoteChannelAdapter(channel: RemoteChannelId, deps: RemoteChannelDependencies): RemoteChannelAdapter {
  switch (channel) {
    case 'feishu':
      return createFeishuRemoteChannel(deps)
  }
}
