// Windows 安装包自己带的顶层条目：打包时按 win-unpacked 现场列出，写成 build/installer.nsh
// 要 !include 的那份 NSIS 文件（electron-builder.config.cjs 的 afterPack 调用）。
//
// 安装程序收尾时要记一份清单，下一次升级、卸载只动清单上的东西。以前清单是把安装目录里
// 看到的都记上，客户或管理员自己放进去的文件也被记成软件文件，下一次升级就被挪走删掉
// （11-18 复核 D05）。现在只记这里列出的、安装包确实带着的条目，外加模板随后写进去的
// 卸载程序；老版本记下的清单也拿这份名单划掉认不出来的项，见 installer.nsh 的
// xingmangForgetForeignInstalledEntries。
//
// 名单不写死在 installer.nsh 里：Electron 升级会增减顶层文件，写死的名单跟不上，跟不上的
// 那个文件就再也不进清单、卸载删不掉。现场列就永远跟这次装进去的一样。
const fs = require('node:fs')
const path = require('node:path')

// build/ 是 electron-builder 给 makensis 加的头文件目录，installer.nsh 按名字就能 !include 到。
// 这份文件是打包产物，.gitignore 里排除了，不进仓库。
const PACKAGE_ENTRIES_INCLUDE_NAME = 'installer-package-entries.nsh'
const PACKAGE_ENTRIES_DEFINE = 'XINGMANG_PACKAGE_ENTRIES'

// 名字要原样放进 NSIS 的双引号字符串，再用竖线拼成一串：竖线是分隔符；双引号会提前结束
// 字符串；$ 会被当成变量展开；控制字符会断行。Windows 文件名本来就不许有竖线、双引号和
// 控制字符，Electron 带的文件里也没有 $，真碰上了说明这次打包不对，停下来比装错强。
const unsafeEntryName = /[|"$\u0000-\u001f]/

function assertSafeEntryName(name) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || unsafeEntryName.test(name)) {
    throw new Error(`安装包顶层条目的名字没法写进安装程序：${JSON.stringify(name)}`)
  }
}

// 生成 installer-package-entries.nsh 的内容。名单排好序、去掉重复，同样的输入总是同样的文件。
// 主程序和 resources 一定在：缺了说明列的不是装进去的那个目录，宁可打包失败。
function buildPackageEntriesInclude(entries, executableName) {
  const names = [...new Set(entries)]
  for (const name of names) assertSafeEntryName(name)
  names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  for (const required of [executableName, 'resources']) {
    if (!names.includes(required)) {
      throw new Error(`安装包里没有 ${required}，列出的不是要装进去的目录：${names.join(', ')}`)
    }
  }
  return [
    '; 打包时由 scripts/windows-installer-package-entries.cjs 按 win-unpacked 写出，不要手改，也不进仓库。',
    '; build/installer.nsh 靠它认出安装目录里哪些是安装包自己的东西（11-18 复核 D05）。',
    `!define ${PACKAGE_ENTRIES_DEFINE} "|${names.join('|')}|"`,
    '',
  ].join('\n')
}

// 列出 appOutDir 的顶层条目，并进 collected（同一次打包要是出好几种架构，安装程序只有一个，
// 名单取它们的并集），写到 buildResourcesDir 下。返回写进去的名单。
function writePackageEntriesInclude({ appOutDir, buildResourcesDir, executableName, collected = new Set() }) {
  for (const name of fs.readdirSync(appOutDir)) collected.add(name)
  const contents = buildPackageEntriesInclude([...collected], executableName)
  fs.writeFileSync(path.join(buildResourcesDir, PACKAGE_ENTRIES_INCLUDE_NAME), contents, 'utf8')
  return [...collected]
}

module.exports = {
  PACKAGE_ENTRIES_DEFINE,
  PACKAGE_ENTRIES_INCLUDE_NAME,
  buildPackageEntriesInclude,
  writePackageEntriesInclude,
}
