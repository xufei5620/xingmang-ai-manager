/**
 * Refuses to run the desktop app as root on macOS (D18), the same refusal Linux makes in
 * linux-launch-guard.ts and with the same wording.
 *
 * The app never needs root on macOS: it installs everything into the customer's home and
 * never asks for elevation. A root process here came from something like `sudo` on the
 * bundle's executable. The stock macOS sudoers keeps HOME, so Node would put the CLIs,
 * their configs and the managed runtime into the customer's home owned by root, and the
 * customer's own account could no longer update or remove them. Refusing before anything
 * loads is the whole design, as on Linux; there is no macOS "administrator mode" and
 * nothing is ever chowned back.
 *
 * Squirrel.Mac runs ShipIt as root when an update needs the login password, and ShipIt
 * relaunches the app when it is done. Should that relaunch ever arrive as root (not
 * reproduced), this refusal is still the right answer: the customer is told to open the
 * app normally instead of getting an empty root profile.
 *
 * Only root is refused. A launch for another account (`sudo -u`) is not detected here:
 * D18 approved the root wording only.
 *
 * This module imports nothing so platform/entry.ts can consult it before any other
 * module loads.
 */

export type MacosLaunchRefusal = 'root'

export interface MacosLaunchIdentity {
  platform: NodeJS.Platform
  /** `process.geteuid()`; undefined where Node does not provide it. */
  effectiveUid: number | undefined
}

export function macosLaunchRefusal(identity: MacosLaunchIdentity): MacosLaunchRefusal | null {
  if (identity.platform !== 'darwin') return null
  return identity.effectiveUid === 0 ? 'root' : null
}
