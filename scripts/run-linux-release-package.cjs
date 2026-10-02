const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { resolveEmptyReleaseOutputDirectory } = require('./update-release-utils.cjs')
const { assertArchitecture, unpackedDirectoryName } = require('./linux-artifact-names.cjs')
const packageVersion = require('../package.json').version

const root = path.resolve(__dirname, '..')

// Linux 发布包的出包门禁，publish-release 的 linux-build 作业每个架构跑一次。
//
// 与 run-release-build.cjs（Windows）的分工：类型检查与四套测试不在这里跑，由同一次
// 发布里的 linux-checks 作业在 x64 上跑一遍——两个架构共用一份源码，和
// package-for-testing 的 Linux 那半一样。这里只管「这个架构的 deb 能不能发」：线上
// 这个架构的清单比本次旧、编译出的是 renderer-v2、Electron 加固到位、deb 本身合格
// 且自动更新指向正式更新目录、更新清单与 deb 一致。装上真开一次要 apt、sudo 和一个
// 普通用户，留在工作流里做。
//
// 下面三项 Windows 门禁有、这里没有，每次都打印出来，免得被当成漏了：
const SKIPPED_CHECKS = Object.freeze([
  '类型检查与全部测试：由 publish-release 的 linux-checks 作业在 x64 上跑一遍，两个架构共用一份源码',
  'Electron 开发目录冒烟：开发目录里的 chrome-sandbox 不是 setuid root，Ubuntu 24.04 上起不来；改为在工作流里把 deb 装上、以普通用户真开',
  'ASAR 篡改校验：那根 fuse 在 Linux 程序里什么都不嵌（docs/LINUX.md），装好的程序靠 /opt 下全归 root',
])

// 继承来的这些变量会让这次出包变成别的东西：签名发布标记被配置拒掉、证书变量造出
// 一个「其实签了名」的包、XINGMANG_UPDATE_URL 让更新地址偏离这个版本该用的那个
// （deb 校验会按版本推出的地址核对）、加速资源目录没有 Linux 内核（第一版 Linux 不带
// 加速）。
const INHERITED_NAMES_TO_DROP = Object.freeze([
  'XINGMANG_RELEASE',
  'XINGMANG_MAC_FREE_RELEASE',
  'XINGMANG_MAC_CI_EPHEMERAL_SIGNING',
  'XINGMANG_MAC_RELEASE_REHEARSAL',
  'XINGMANG_UPDATE_DEV',
  'XINGMANG_UPDATE_URL',
  'XINGMANG_ACCELERATION_BUNDLE_DIR',
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_NAME',
  'CSC_FOR_PULL_REQUEST',
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
])

function buildLinuxReleaseEnvironment(environment, { releaseOutputDirectory }) {
  const releaseEnvironment = {
    ...environment,
    XINGMANG_LOCAL_BUILD: '0',
    XINGMANG_UNSIGNED_RELEASE: '1',
    XINGMANG_LINUX_PACKAGE: '1',
    XINGMANG_OUTPUT_DIR: releaseOutputDirectory,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  }
  for (const name of INHERITED_NAMES_TO_DROP) delete releaseEnvironment[name]
  return releaseEnvironment
}

function buildLinuxReleaseSteps({ npmCli, releaseOutputDirectory, arch }) {
  assertArchitecture(arch)
  const scripts = path.join(root, 'scripts')
  return [
    {
      label: `发布前置检查（Linux ${arch} 更新清单）`,
      executable: process.execPath,
      args: [path.join(scripts, 'verify-release-environment.cjs'), '--platform', 'linux', '--arch', arch],
    },
    { label: '编译应用', executable: process.execPath, args: [npmCli, 'run', 'compile'] },
    {
      label: `构建 Linux ${arch} 安装包`,
      executable: process.execPath,
      args: [
        path.join(root, 'node_modules', 'electron-builder', 'cli.js'),
        '--config',
        'electron-builder.config.cjs',
        '--linux',
        'deb',
        `--${arch}`,
        '--publish',
        'never',
      ],
    },
    {
      label: '校验 Electron 加固状态',
      executable: process.execPath,
      args: [path.join(scripts, 'verify-packaged-hardening.cjs'), path.join(releaseOutputDirectory, unpackedDirectoryName(arch))],
    },
    {
      label: '校验安装包与更新清单',
      executable: process.execPath,
      args: [path.join(scripts, 'verify-linux-deb.cjs'), releaseOutputDirectory, '--arch', arch, '--release'],
    },
  ]
}

function parseArchitecture(argv) {
  const index = argv.indexOf('--arch')
  if (index === -1 || !argv[index + 1]) throw new Error('要用 --arch x64 或 --arch arm64 指明出哪个架构的包')
  return assertArchitecture(argv[index + 1])
}

function main() {
  let arch
  let releaseOutputDirectory
  try {
    arch = parseArchitecture(process.argv.slice(2))
    releaseOutputDirectory = resolveEmptyReleaseOutputDirectory(root, packageVersion, process.env.XINGMANG_OUTPUT_DIR)
  } catch (error) {
    console.error(`[release:linux] ${error.code ? `[${error.code}] ` : ''}${error.message}`)
    process.exit(1)
  }

  const npmCli = process.env.npm_execpath
  if (!npmCli || !fs.existsSync(npmCli)) {
    console.error('[release:linux] 无法定位当前 npm CLI，请通过 npm run release:package:linux -- --arch <x64|arm64> 启动')
    process.exit(1)
  }

  const releaseEnvironment = buildLinuxReleaseEnvironment(process.env, { releaseOutputDirectory })
  console.log(`[release:linux] 已确认空发布目录：${releaseOutputDirectory}`)
  console.log(`[release:linux] 出包：Linux ${arch} deb（无代码签名，自动更新开着，靠 HTTPS 与 SHA-512）`)
  for (const reason of SKIPPED_CHECKS) console.log(`[release:linux] 不在这里跑 ${reason}`)
  for (const step of buildLinuxReleaseSteps({ npmCli, releaseOutputDirectory, arch })) {
    console.log(`\n[release:linux] ${step.label}`)
    const result = spawnSync(step.executable, step.args, { cwd: root, env: releaseEnvironment, stdio: 'inherit' })
    if (result.error) {
      console.error(`[release:linux] 无法启动 ${step.label}：${result.error.message}`)
      process.exit(1)
    }
    if (result.status !== 0) process.exit(result.status ?? 1)
    if (step.label === '编译应用' && !fs.existsSync(path.join(root, 'dist', 'renderer-v2.flag'))) {
      // 同 run-release-build.cjs：出货界面是 renderer-v2，编出 legacy 就是构建配置错了。
      console.error('[release:linux] 编译产物不是 renderer-v2：缺少 dist/renderer-v2.flag')
      process.exit(1)
    }
  }
  console.log(`\n[release:linux] Linux ${arch} 发布包已通过出包门禁`)
}

if (require.main === module) main()

module.exports = { SKIPPED_CHECKS, buildLinuxReleaseEnvironment, buildLinuxReleaseSteps, parseArchitecture }
