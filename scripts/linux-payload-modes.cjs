// Linux 安装包内容的权限收口：electron-builder 打完 linux-unpacked、交给 fpm 之前，
// 去掉每个文件和目录的组写、其他人写。
//
// Electron 45's Linux zips store their entries as 0666/0777 (43 and 44 shipped
// 0644/0755), and electron-builder copies those modes into linux-unpacked
// verbatim, umask or not. fpm packs that tree as it stands, so dpkg would
// install /opt/xingmang-ai-manager writable by every local user: anyone could
// replace the main binary, a shared library, or chrome-sandbox right before
// postinst makes it setuid root. verify-linux-deb.cjs refuses such a deb; this
// makes the build produce one it accepts instead of relying on upstream modes.
const fs = require('node:fs/promises')
const path = require('node:path')

const GROUP_AND_OTHER_WRITE = 0o022

// Symlinks are skipped, not followed: chmod on a link changes its target, which
// may sit outside the payload, and Linux has no lchmod. verify-linux-deb.cjs
// already rejects any link that points out of the package.
async function ensureNoGroupOrOtherWrite(directory) {
  const changed = []
  async function visit(entryPath) {
    const stats = await fs.lstat(entryPath)
    if (stats.isSymbolicLink()) return
    const mode = stats.mode & 0o7777
    if (mode & GROUP_AND_OTHER_WRITE) {
      await fs.chmod(entryPath, mode & ~GROUP_AND_OTHER_WRITE)
      changed.push(entryPath)
    }
    if (!stats.isDirectory()) return
    for (const name of await fs.readdir(entryPath)) await visit(path.join(entryPath, name))
  }
  await visit(directory)
  return changed
}

module.exports = {
  ensureNoGroupOrOtherWrite,
}
