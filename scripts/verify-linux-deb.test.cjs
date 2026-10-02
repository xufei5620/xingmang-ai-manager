const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  assertControlFields,
  assertDesktopEntry,
  assertPackagedMetadata,
  assertPayloadEntries,
  assertPostinst,
  debianVersion,
  elfArchitecture,
  parseArguments,
  parseContentsListing,
  parseControlFields,
  parseDependencies,
  resolveDebPath,
} = require('./verify-linux-deb.cjs')

const CONTROL = [
  'Package: xingmang-ai-manager',
  'Version: 0.2.14~beta.1',
  'License: Proprietary',
  'Vendor: 绍兴星芒文化传媒有限责任公司',
  'Architecture: amd64',
  'Maintainer: 绍兴星芒文化传媒有限责任公司',
  'Installed-Size: 412345',
  'Depends: libgtk-3-0t64 | libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0t64 | libatspi2.0-0, libuuid1, libsecret-1-0, libgbm1, libasound2t64 | libasound2, libxkbcommon0, libcups2t64 | libcups2, libudev1',
  'Recommends: fonts-noto-cjk | fonts-wqy-microhei | fonts-wqy-zenhei, gnome-keyring | kwalletmanager',
  'Section: devel',
  'Priority: optional',
  'Homepage: https://github.com/xufei5620/xingmang-ai-manager',
  'Description: 星芒AI管理工具',
  ' 一键安装和配置 AI 编程工具。',
  '',
].join('\n')

function listing(lines) {
  return lines.map(([mode, owner, file]) => `${mode} ${owner}         0 2026-10-02 06:00 ${file}`).join('\n')
}

const PAYLOAD = [
  ['drwxr-xr-x', 'root/root', './'],
  ['drwxr-xr-x', 'root/root', './opt/'],
  ['drwxr-xr-x', 'root/root', './opt/xingmang-ai-manager/'],
  ['-rwxr-xr-x', 'root/root', './opt/xingmang-ai-manager/xingmang-ai-manager'],
  ['-rwxr-xr-x', 'root/root', './opt/xingmang-ai-manager/chrome-sandbox'],
  ['-rw-r--r--', 'root/root', './opt/xingmang-ai-manager/libffmpeg.so'],
  ['lrwxrwxrwx', 'root/root', './opt/xingmang-ai-manager/libvk.so -> libvulkan.so.1'],
  ['drwxr-xr-x', 'root/root', './opt/xingmang-ai-manager/resources/'],
  ['-rw-r--r--', 'root/root', './opt/xingmang-ai-manager/resources/app.asar'],
  ['-rw-r--r--', 'root/root', './opt/xingmang-ai-manager/resources/package-type'],
  ['drwxr-xr-x', 'root/root', './usr/'],
  ['drwxr-xr-x', 'root/root', './usr/share/'],
  ['drwxr-xr-x', 'root/root', './usr/share/applications/'],
  ['-rw-r--r--', 'root/root', './usr/share/applications/xingmang-ai-manager.desktop'],
  ['drwxr-xr-x', 'root/root', './usr/share/icons/'],
  ['drwxr-xr-x', 'root/root', './usr/share/icons/hicolor/'],
  ['-rw-r--r--', 'root/root', './usr/share/icons/hicolor/512x512/apps/xingmang-ai-manager.png'],
  ['drwxr-xr-x', 'root/root', './usr/share/doc/'],
  ['drwxr-xr-x', 'root/root', './usr/share/doc/xingmang-ai-manager/'],
  ['-rw-r--r--', 'root/root', './usr/share/doc/xingmang-ai-manager/changelog.gz'],
]

function payloadWith(replace) {
  return parseContentsListing(listing(PAYLOAD.map((line) => replace(line) ?? line)))
}

const POSTINST = [
  '#!/bin/bash',
  '',
  "if type update-alternatives 2>/dev/null >&1; then",
  "    update-alternatives --install '/usr/bin/xingmang-ai-manager' 'xingmang-ai-manager' '/opt/xingmang-ai-manager/xingmang-ai-manager' 100 || ln -sf '/opt/xingmang-ai-manager/xingmang-ai-manager' '/usr/bin/xingmang-ai-manager'",
  'fi',
  '',
  '# Upstream probed `unshare --user` here as root; we always install the helper.',
  "if ! { chown root:root '/opt/xingmang-ai-manager/chrome-sandbox' && chmod 4755 '/opt/xingmang-ai-manager/chrome-sandbox'; }; then",
  '    exit 1',
  'fi',
  '',
].join('\n')

const DESKTOP = [
  '[Desktop Entry]',
  'Name=星芒AI管理工具',
  'Exec=/opt/xingmang-ai-manager/xingmang-ai-manager %U',
  'Terminal=false',
  'Type=Application',
  'Icon=xingmang-ai-manager',
  'StartupWMClass=xingmang-ai-manager',
  'MimeType=x-scheme-handler/xingmang;',
  'Categories=Development;',
  '',
  '[Desktop Action Extra]',
  'Exec=/opt/xingmang-ai-manager/xingmang-ai-manager --other',
  '',
].join('\n')

function elfHeader({ elfClass = 2, endian = 1, machine = 62 } = {}) {
  const header = Buffer.alloc(64)
  header.writeUInt32BE(0x7f454c46, 0)
  header[4] = elfClass
  header[5] = endian
  header.writeUInt16LE(machine, 18)
  return header
}

test('Debian versions sort prereleases below the release they precede', () => {
  // dpkg orders "~" below everything, so 0.2.14~beta.1 upgrades to 0.2.14;
  // with "-" it would read as Debian revision "beta.1" of upstream 0.2.14.
  assert.equal(debianVersion('0.2.14-beta.1'), '0.2.14~beta.1')
  assert.equal(debianVersion('0.2.13'), '0.2.13')
})

test('control fields parse continuation lines and dependency alternatives', () => {
  const fields = parseControlFields(CONTROL)
  assert.equal(fields.get('Package'), 'xingmang-ai-manager')
  assert.equal(fields.get('Description'), '星芒AI管理工具\n一键安装和配置 AI 编程工具。')
  assert.deepEqual(parseDependencies('a, b | c (>= 1.2), d (<< 2)'), [['a'], ['b', 'c'], ['d']])
  assert.throws(() => parseControlFields(' orphan continuation'), /续行前面没有字段/)
  assert.throws(() => parseControlFields('not a field'), /无法解析控制文件/)
})

test('control fields must match the package being verified', () => {
  const fields = parseControlFields(CONTROL)
  assert.doesNotThrow(() => assertControlFields(fields, { version: '0.2.14-beta.1', arch: 'x64' }))
  assert.throws(() => assertControlFields(fields, { version: '0.2.14-beta.1', arch: 'arm64' }), /Architecture/)
  assert.throws(() => assertControlFields(fields, { version: '0.2.15', arch: 'x64' }), /Version/)
  assert.throws(() => assertControlFields(fields, { version: '0.2.14-beta.1', arch: 'ia32' }), /不支持的 Linux 架构/)

  const renamed = new Map(fields)
  renamed.set('Package', '星芒AI管理工具')
  assert.throws(() => assertControlFields(renamed, { version: '0.2.14-beta.1', arch: 'x64' }), /Package/)

  const noHomepage = new Map(fields)
  noHomepage.delete('Homepage')
  assert.throws(() => assertControlFields(noHomepage, { version: '0.2.14-beta.1', arch: 'x64' }), /Homepage 不能为空/)
})

test('control fields refuse dependency lists that break the first launch', () => {
  const base = parseControlFields(CONTROL)
  function withDepends(depends) {
    const fields = new Map(base)
    fields.set('Depends', depends)
    return fields
  }
  const options = { version: '0.2.14-beta.1', arch: 'x64' }
  // Without libsecret the keyring login cannot even load.
  assert.throws(() => assertControlFields(withDepends(base.get('Depends').replace('libsecret-1-0, ', '')), options), /libsecret-1-0/)
  // Only the t64 name breaks Ubuntu 22.04 and Debian 12.
  assert.throws(() => assertControlFields(withDepends(base.get('Depends').replace('libasound2t64 | libasound2', 'libasound2t64')), options), /libasound2t64 \| libasound2/)
  const withIndicator = new Map(base)
  withIndicator.set('Recommends', 'libappindicator3-1')
  assert.throws(() => assertControlFields(withIndicator, options), /libappindicator3-1/)
  withIndicator.set('Recommends', 'libayatana-appindicator3-1')
  assert.doesNotThrow(() => assertControlFields(withIndicator, options))
})

test('the contents listing keeps owners, permissions and link targets apart', () => {
  const entries = parseContentsListing(listing(PAYLOAD))
  const link = entries.find((entry) => entry.type === 'l')
  assert.equal(link.path, './opt/xingmang-ai-manager/libvk.so')
  assert.equal(link.target, 'libvulkan.so.1')
  const executable = entries.find((entry) => entry.path === './opt/xingmang-ai-manager/xingmang-ai-manager')
  assert.deepEqual(
    { type: executable.type, permissions: executable.permissions, owner: executable.owner, group: executable.group },
    { type: '-', permissions: 'rwxr-xr-x', owner: 'root', group: 'root' },
  )
  // Paths with spaces stay whole.
  assert.equal(parseContentsListing('-rw-r--r-- root/root 1 2026-10-02 06:00 ./usr/share/doc/xingmang-ai-manager/a b')[0].path, './usr/share/doc/xingmang-ai-manager/a b')
  assert.throws(() => parseContentsListing('garbage'), /无法解析 deb 内容清单/)
})

test('an untampered payload passes', () => {
  assert.doesNotThrow(() => assertPayloadEntries(parseContentsListing(listing(PAYLOAD))))
})

test('the payload refuses anything an ordinary user could rewrite', () => {
  const asar = './opt/xingmang-ai-manager/resources/app.asar'
  assert.throws(
    () => assertPayloadEntries(payloadWith(([mode, owner, file]) => (file === asar ? [mode, 'builder/builder', file] : null))),
    /属主是 builder\/builder/,
  )
  assert.throws(
    () => assertPayloadEntries(payloadWith(([, owner, file]) => (file === asar ? ['-rw-rw-r--', owner, file] : null))),
    /组或其他用户可写/,
  )
  assert.throws(
    () => assertPayloadEntries(payloadWith(([, owner, file]) => (file === './opt/xingmang-ai-manager/' ? ['drwxr-xrwx', owner, file] : null))),
    /组或其他用户可写/,
  )
})

test('the payload refuses setuid bits, stray locations and escaping links', () => {
  const sandbox = './opt/xingmang-ai-manager/chrome-sandbox'
  assert.throws(
    () => assertPayloadEntries(payloadWith(([, owner, file]) => (file === sandbox ? ['-rwsr-xr-x', owner, file] : null))),
    /setuid\/setgid/,
  )
  assert.throws(
    () => assertPayloadEntries(parseContentsListing(listing([...PAYLOAD, ['-rwxr-xr-x', 'root/root', './usr/bin/xingmang-ai-manager']]))),
    /意料之外的位置.*usr\/bin/,
  )
  assert.throws(
    () => assertPayloadEntries(parseContentsListing(listing([...PAYLOAD, ['-rw-r--r--', 'root/root', './etc/apparmor.d/xingmang']]))),
    /意料之外的位置/,
  )
  for (const target of ['/etc/shadow', '../../../etc/shadow']) {
    assert.throws(
      () => assertPayloadEntries(parseContentsListing(listing([...PAYLOAD, ['lrwxrwxrwx', 'root/root', `./opt/xingmang-ai-manager/evil -> ${target}`]]))),
      /指向包外的链接/,
      target,
    )
  }
})

test('the payload must carry the files a launch needs and not the Electron default app', () => {
  for (const required of [
    './opt/xingmang-ai-manager/xingmang-ai-manager',
    './opt/xingmang-ai-manager/chrome-sandbox',
    './opt/xingmang-ai-manager/resources/app.asar',
    './opt/xingmang-ai-manager/resources/package-type',
    './usr/share/applications/xingmang-ai-manager.desktop',
  ]) {
    const entries = parseContentsListing(listing(PAYLOAD.filter(([, , file]) => file !== required)))
    assert.throws(() => assertPayloadEntries(entries), new RegExp(`缺少 ${required.replace(/[.]/g, '\\.')}`), required)
  }
  assert.throws(
    () => assertPayloadEntries(parseContentsListing(listing([...PAYLOAD, ['-rw-r--r--', 'root/root', './opt/xingmang-ai-manager/resources/default_app.asar']]))),
    /default_app\.asar/,
  )
  assert.throws(
    () => assertPayloadEntries(payloadWith(([, owner, file]) => (file === './opt/xingmang-ai-manager/xingmang-ai-manager' ? ['-rw-r--r--', owner, file] : null))),
    /主程序不是可执行的普通文件/,
  )
  assert.throws(() => assertPayloadEntries([]), /内容清单是空的/)
})

test('postinst must always make chrome-sandbox setuid root', () => {
  assert.doesNotThrow(() => assertPostinst(POSTINST))
  assert.throws(() => assertPostinst(`# comment first\n${POSTINST}`), /第一行必须是 #!\/bin\/bash/)
  assert.throws(() => assertPostinst(POSTINST.replace('chmod 4755', 'chmod 0755')), /chmod 4755/)
  assert.throws(() => assertPostinst(POSTINST.replace('chown root:root', 'chown root')), /chown root:root/)
  // The upstream probe as a command is refused; the same word in a comment is not.
  assert.throws(() => assertPostinst(`${POSTINST}if unshare --user true; then chmod 0755 x; fi\n`), /用户命名空间/)
  assert.throws(() => assertPostinst(`${POSTINST}echo '--no-sandbox' >> /etc/environment\n`), /关闭沙箱/)
})

test('the menu entry has to start the app sandboxed and own its window and links', () => {
  assert.doesNotThrow(() => assertDesktopEntry(DESKTOP))
  assert.throws(
    () => assertDesktopEntry(DESKTOP.replace('%U\n', '--no-sandbox %U\n')),
    /关闭沙箱/,
  )
  assert.throws(() => assertDesktopEntry(DESKTOP.replace('Exec=/opt/xingmang-ai-manager/xingmang-ai-manager %U', 'Exec=xingmang-ai-manager %U')), /Exec/)
  assert.throws(() => assertDesktopEntry(DESKTOP.replace('StartupWMClass=xingmang-ai-manager', 'StartupWMClass=星芒AI管理工具')), /StartupWMClass/)
  assert.throws(() => assertDesktopEntry(DESKTOP.replace('MimeType=x-scheme-handler/xingmang;', 'MimeType=')), /xingmang:\/\//)
  assert.throws(() => assertDesktopEntry(DESKTOP.replace('Terminal=false', 'Terminal=true')), /Terminal/)
})

test('ELF headers decide which architecture a binary was built for', () => {
  assert.equal(elfArchitecture(elfHeader({ machine: 62 })), 'x64')
  assert.equal(elfArchitecture(elfHeader({ machine: 183 })), 'arm64')
  assert.throws(() => elfArchitecture(elfHeader({ machine: 3 })), /未知的 ELF 机器类型 3/)
  assert.throws(() => elfArchitecture(elfHeader({ elfClass: 1 })), /64 位小端/)
  assert.throws(() => elfArchitecture(Buffer.from('MZ not an elf file at all')), /不是 ELF/)
})

test('the packaged metadata keeps the menu link and the updater switched off', () => {
  const metadata = { name: 'xingmang-ai-manager', desktopName: 'xingmang-ai-manager.desktop', xingmangLocalBuild: true }
  assert.doesNotThrow(() => assertPackagedMetadata(metadata))
  assert.throws(() => assertPackagedMetadata({ ...metadata, desktopName: undefined }), /desktopName/)
  assert.throws(() => assertPackagedMetadata({ ...metadata, xingmangLocalBuild: false }), /xingmangLocalBuild/)
  assert.throws(() => assertPackagedMetadata({ ...metadata, name: 'other' }), /name 是 other/)
})

test('the release directory must hold exactly the expected deb', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-linux-deb-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  assert.throws(() => resolveDebPath(directory, '0.2.14-beta.1', 'x64'), /找不到 xingmang-ai-manager_0\.2\.14~beta\.1_amd64\.deb/)
  fs.writeFileSync(path.join(directory, 'xingmang-ai-manager_0.2.14~beta.1_amd64.deb'), '')
  assert.equal(resolveDebPath(directory, '0.2.14-beta.1', 'x64'), path.join(directory, 'xingmang-ai-manager_0.2.14~beta.1_amd64.deb'))
  assert.throws(() => resolveDebPath(directory, '0.2.14-beta.1', 'arm64'), /arm64\.deb/)
  fs.writeFileSync(path.join(directory, 'xingmang-ai-manager-0.2.14-beta.1.AppImage'), '')
  assert.throws(() => resolveDebPath(directory, '0.2.14-beta.1', 'x64'), /只出 deb.*AppImage/)
})

test('the command line takes a release directory and an explicit architecture', () => {
  assert.deepEqual(parseArguments(['out', '--arch', 'arm64']), { releaseDirectory: path.resolve('out'), arch: 'arm64' })
  assert.equal(parseArguments([]).releaseDirectory, path.resolve('release'))
  assert.throws(() => parseArguments(['release', '--arch', 'ia32']), /只接受 x64 或 arm64/)
})
