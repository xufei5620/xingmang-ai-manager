/**
 * Refuses to run the desktop app as root, or as a different account than the one that
 * asked for it, on Linux.
 *
 * Chromium aborts as root unless --no-sandbox is passed, so whoever reaches this code as
 * root followed advice like `sudo ./app --no-sandbox`. Running on would install npm
 * packages and run CLIs from user-writable trees as root, leave root-owned files in the
 * customer's home when sudo kept HOME, and open the canvas without an OS sandbox. The
 * product rule is that the app never needs root on Linux, so refusing is the whole
 * design; there is deliberately no Linux "administrator mode" to fall back to, and the
 * app never chowns anything back.
 *
 * Windows and macOS are untouched: Windows has its own execution-mode model, and macOS
 * never reaches here as root through any supported launch.
 *
 * This module imports nothing so platform/desktop-entry.ts can consult it before any
 * other module loads.
 */

export type LinuxLaunchRefusal = 'root' | 'other-account'

export interface LinuxLaunchIdentity {
  platform: NodeJS.Platform
  /** `process.geteuid()`; undefined where Node does not provide it. */
  effectiveUid: number | undefined
  env: NodeJS.ProcessEnv
}

function parseUid(value: string | undefined): number | null {
  const trimmed = value?.trim()
  return trimmed && /^\d{1,10}$/.test(trimmed) ? Number(trimmed) : null
}

/**
 * sudo and run0 record the caller in SUDO_UID, pkexec in PKEXEC_UID. Either one naming
 * a uid other than the one now running means the app was started for somebody else,
 * which lands its files in the wrong account just as root does. A spoofed variable can
 * only make a user refuse their own launch, so trusting it costs nothing.
 */
export function linuxLaunchRefusal(identity: LinuxLaunchIdentity): LinuxLaunchRefusal | null {
  if (identity.platform === 'win32' || identity.platform === 'darwin') return null
  if (identity.effectiveUid === undefined) return null
  if (identity.effectiveUid === 0) return 'root'
  for (const key of ['SUDO_UID', 'PKEXEC_UID']) {
    const invoker = parseUid(identity.env[key])
    if (invoker !== null && invoker !== identity.effectiveUid) return 'other-account'
  }
  return null
}

export interface LinuxLaunchRefusalNotice {
  title: string
  message: string
}

export function linuxLaunchRefusalNotice(refusal: LinuxLaunchRefusal): LinuxLaunchRefusalNotice {
  return {
    title: '请用平时登录电脑的账号打开',
    message: refusal === 'root'
      ? '星芒AI管理工具不能用管理员身份打开。用管理员身份打开，装好的工具和设置会归管理员所有，之后平时的账号反而用不了。请关掉这个提示，从应用菜单里直接打开。这次什么都没有改动。'
      : '星芒AI管理工具是用另一个账号的身份打开的，工具和设置会装进那个账号里。请关掉这个提示，用平时登录电脑的账号从应用菜单里直接打开。这次什么都没有改动。',
  }
}
