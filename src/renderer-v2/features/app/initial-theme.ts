import type { AppSettingsV2 } from '../../../../electron/ipc-contract'

/**
 * 第一帧用哪套颜色。主进程开窗时把存着的深浅色拼进地址的 `?theme=`
 * （main.ts 的 resolveMainWindowUrl），设置要等启动那一轮 IPC 回来才有；
 * 以前这里写死浅色，选了深色的人每次开窗先闪一块米白，登录着的要等账号
 * 恢复完才变深。只认 light、dark 两个值，别的一律按浅色：这个参数只用来在
 * 两套颜色里挑一套，设置回来后照旧以设置为准。
 */
export function initialTheme(search: string): AppSettingsV2['theme'] {
  return new URLSearchParams(search).get('theme') === 'dark' ? 'dark' : 'light'
}
