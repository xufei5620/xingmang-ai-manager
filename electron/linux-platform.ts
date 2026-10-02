import os from 'node:os'
import path from 'node:path'
import { managedNodeRuntimeBinDirectory, managedNpmBinDirectory, managedTerminalLauncherDirectory } from './managed-cli-paths'

/**
 * Where this app looks for node, npm and the four CLIs on Linux, without reading any shell
 * startup file (Linux 版拆分 ②).
 *
 * An app started from the desktop menu inherits the display manager's PATH, not the one the
 * user's ~/.bashrc builds, so nvm, ~/.npm-global and friends are usually missing from it.
 * The fixed user directories after the inherited PATH put the common ones back.
 *
 * The app-downloaded Node.js (linux-node-runtime.ts) goes first, the opposite of macOS
 * (darwinCommandPathCandidates puts it last). It is only ever installed when the scan found
 * no usable Node.js, and on Linux the usual reason is a distro package that is too old:
 * Ubuntu 22.04/24.04 and Debian 12 all ship one below what the CLIs need. Behind
 * /usr/bin/node it would never be reached, and npm's `#!/usr/bin/env node`, the CLIs'
 * postinstall scripts and the Node-hosted Codex/Gemini entry points would all keep running
 * under the old one. In front, the pinned and verified runtime wins whenever it exists.
 *
 * The managed npm bin directory comes next, as on macOS, so the copies this app installed
 * and verified are the ones it scans, updates and opens.
 *
 * The folder of terminal launchers (linux-shell-profile.ts) is dropped from the inherited
 * PATH. After the next sign-in the desktop session carries it, and a launcher found by the
 * scan would pass for an install, a stale one even for a CLI that is gone. The app finds
 * its own CLIs in the npm folder above and never needs the launchers.
 *
 * This is ordering only. On Linux the app never elevates, so this PATH is only ever used
 * within the current user's own rights; trustedCommandEnvironment builds the stricter one.
 */
export function linuxCommandPathCandidates(
  baseEnv: NodeJS.ProcessEnv = process.env,
  additionalPaths: readonly string[] = [],
  homeDirectory = baseEnv.HOME?.trim() || os.homedir(),
): string[] {
  const inheritedPath = baseEnv.PATH ?? baseEnv.Path ?? baseEnv.path ?? ''
  const managed: string[] = []
  let launcherDirectory: string | null = null
  try {
    const env = { ...baseEnv, HOME: homeDirectory }
    managed.push(managedNodeRuntimeBinDirectory(env, 'linux'), managedNpmBinDirectory(env, 'linux'))
    launcherDirectory = managedTerminalLauncherDirectory(env, 'linux')
  } catch {
    // No usable HOME: there is no product folder either, so nothing of ours to find.
  }
  const home = homeDirectory && path.posix.isAbsolute(homeDirectory) ? homeDirectory : null
  return [
    ...additionalPaths,
    ...whole(managed),
    ...inheritedPath.split(path.posix.delimiter).filter((entry) => !sameDirectory(entry, launcherDirectory)),
    ...whole([
      baseEnv.VOLTA_HOME ? path.posix.join(baseEnv.VOLTA_HOME, 'bin') : '',
      baseEnv.FNM_MULTISHELL_PATH ?? '',
    ]),
    ...(home
      ? whole([
          path.posix.join(home, '.local', 'bin'),
          path.posix.join(home, '.npm-global', 'bin'),
          path.posix.join(home, '.volta', 'bin'),
          path.posix.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
          path.posix.join(home, '.grok', 'bin'),
        ])
      : []),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/snap/bin',
  ]
}

/**
 * A ':' inside a HOME, XDG_DATA_HOME or VOLTA_HOME would split the joined PATH into pieces that
 * are no longer absolute, and a child would then look them up relative to its working directory,
 * which can be a project folder the CLI was just pointed at.
 */
function whole(entries: readonly string[]): string[] {
  return entries.filter((entry) => !entry.includes(path.posix.delimiter))
}

function sameDirectory(entry: string, directory: string | null): boolean {
  if (!directory) return false
  const trimmed = entry.trim().replace(/^"(.*)"$/, '$1')
  return Boolean(trimmed) && path.posix.normalize(trimmed).replace(/(.)\/+$/, '$1') === directory
}
