import { useEffect, useState } from 'react'

/**
 * 对话页正在出的图（D44）。gpt-image 一张要几十秒，换账号时主进程把旧账号的出图全停掉，
 * 对话页这份停了就不收（画布那份会收完），服务端可能已经扣了钱。所以「切换」之前要先问一句。
 *
 * 对话页是按需加载的，切到别的页也挂着照样出图；「切换账号」框在主包里，不该为了问这一句把
 * 聊天的代码拉进来，所以对话页在这里登记，切换框只读这一处。
 */
const active = new Set<symbol>()

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
