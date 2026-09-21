import { readLocalPreference, writeLocalPreference } from '../app/preferences'

/**
 * 界面导览（首页上一步步指着按钮讲的那三条提示）在本机的状态。
 *
 * 这份记录存在的理由只有一个：导览过去只是一个 useState，引导走完弹一次，
 * 用户没看完就关掉软件，之后再也没有第二个触发点。记下「还没看完」之后，
 * 下次回到首页会接着播，设置页也能把它重新置成待看。
 */
export type TourState = 'pending' | 'seen'

export function tourStateKey(scope: string): string {
  return `xingmang-v2-tour:${scope}`
}

/**
 * 没有记录的账号一律当作「不用播」：老用户升级上来不该被一段没要过的导览
 * 拦在首页上，只有引导完成或用户自己点了重看，才会写进待看。
 */
export function tourReplayPending(scope: string): boolean {
  return readLocalPreference(tourStateKey(scope)) === 'pending'
}

export function rememberTourPending(scope: string): boolean {
  return writeLocalPreference(tourStateKey(scope), 'pending')
}

/** 看完最后一步和中途关掉都算看过：关掉是用户自己的选择，不该每次启动再追着播。 */
export function rememberTourSeen(scope: string): boolean {
  return writeLocalPreference(tourStateKey(scope), 'seen')
}
