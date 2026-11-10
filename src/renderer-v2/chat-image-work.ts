import { useEffect, useState } from 'react'

/**
 * 对话页正在出的图（D44）。gpt-image 一张要几十秒，换账号时主进程把旧账号的出图全停掉，
 * 对话页这份停了就不收（画布那份会收完），服务端可能已经扣了钱。所以「切换」之前要先问一句。
 * 退出登录、在「切换账号」框里去登录另一个账号也一样会停掉（主进程 account:logout 和
 * 登录前那次 quiesce 都把对话页的出图全停了，登录密码输错也照停），这两处问同一句。
 *
 * 对话页是按需加载的，切到别的页也挂着照样出图；「切换账号」框在主包里，不该为了问这一句把
 * 聊天的代码拉进来，所以对话页在这里登记，切换框只读这一处。
 */
const active = new Set<symbol>()

/** 换账号、退出登录前对话页还在出图时说的那一句（D44）。几处入口都用这一句，不另写。 */
export const chatImageSwitchWarning = '对话还在出图，换账号会停掉这张图，可能已经扣费。'

export function markChatImageWork(token: symbol, busy: boolean): void {
  if (busy) active.add(token)
  else active.delete(token)
}

export function chatImageWorkActive(): boolean {
  return active.size > 0
}

/** busy 为真时登记上，出完、停了或页面卸载（换了账号就会重新挂一份）时撤掉。 */
export function useChatImageWork(busy: boolean): void {
  const [token] = useState(() => Symbol('chat-image'))
  useEffect(() => {
    markChatImageWork(token, busy)
    return () => { markChatImageWork(token, false) }
  }, [token, busy])
}

/**
 * 退出登录确认框里补的那句：点「退出登录」那一刻对话页在出图才说，没在出图回空串，确认框照旧。
 * 只在点下去这一刻看一次，跟「切换」那一问一样；登记表不是界面状态，渲染时读会读到旧的。
 */
export function logoutChatImageNote(): string {
  return chatImageWorkActive() ? chatImageSwitchWarning : ''
}
