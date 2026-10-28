#!/usr/bin/env node
// 发版通过以后，把这一版的对照表（source map）传给 Sentry（商业级差距报告 G06）。只在 publish-release
// 工作流的 sentry-sourcemaps 作业里跑，怎么配见 docs/RELEASING.md「崩溃上报的 source map」。
//
// 客户端发来的报错，文件名已经改写成 app:///dist-electron/main.js、app:///dist/assets/index-xxx.js
// （electron/crash-report.ts resolveCrashFrameUrl），还带着 release「xingmang-ai-manager@版本」和
// dist「平台-芯片」。Sentry 只在这三样都对上时才用对照表，所以这里按同样的名字传：每个出包作业编译出来
// 的那一份，传到它装出来的每一种安装包的 dist 下。
//
// 只给 Sentry 写对照表：令牌是组织令牌，权限只够建 release、传对照表。命令一律 argv 数组，不经 shell（I1）。
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const RELEASE_PREFIX = 'xingmang-ai-manager@'
// 下载目录里每个子目录是一个出包作业的对照表（publish-release.yml 的下载步骤按这些名字放），后面是
// 它出的安装包在客户端上报的 dist（crashReportDist）。Mac 编译一次、出 Apple 芯片和 Intel 两个包。
const BUILDS = new Map([
  ['windows', ['win32-x64']],
  ['macos', ['darwin-arm64', 'darwin-x64']],
  ['linux-x64', ['linux-x64']],
  ['linux-arm64', ['linux-arm64']],
])
// 包里会被 Sentry 对上的两棵目录：主进程和主窗口渲染层。地址前缀和 resolveCrashFrameUrl 一致。
const TREES = [
  ['dist-electron', 'app:///dist-electron'],
  ['dist', 'app:///dist'],
]
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000

class SourceMapUploadError extends Error {}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!['--directory', '--version', '--cli', '--summary'].includes(key) || value === undefined || value === '') {
      throw new SourceMapUploadError(`参数无效：${key ?? '（空）'}`)
    }
    options[key.slice(2)] = value
  }
  for (const required of ['directory', 'version', 'cli']) {
    if (!options[required]) throw new SourceMapUploadError(`缺少 --${required}`)
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.version)) {
    throw new SourceMapUploadError(`版本号不对：${options.version}`)
  }
  return options
}

function countFiles(directory) {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length
}

/**
 * 看下载目录里有哪几份，排出要传的每一趟。认不出的子目录直接报错：多出来一份不知道属于哪种安装包的
 * 对照表，传错了 dist 比不传更糟（报错会被对到别的代码上）。一份都没有也报错，那是下载步骤出了问题。
 */
function planSourceMapUploads(directory) {
  if (!fs.existsSync(directory)) throw new SourceMapUploadError(`没有找到对照表目录：${directory}`)
  const uploads = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const dists = BUILDS.get(entry.name)
    if (!entry.isDirectory() || !dists) throw new SourceMapUploadError(`认不出的对照表：${entry.name}`)
    const trees = TREES
      .map(([tree, urlPrefix]) => ({ tree, urlPrefix, path: path.join(directory, entry.name, tree) }))
      .filter((tree) => fs.existsSync(tree.path))
    // 两棵都要有：缺了哪棵，那一半的报错就一直对不上，宁可这次红了去查。
    if (trees.length !== TREES.length) {
      throw new SourceMapUploadError(`${entry.name} 的对照表不全，要有 ${TREES.map(([tree]) => tree).join(' 和 ')}`)
    }
    for (const dist of dists) {
      for (const tree of trees) uploads.push({ build: entry.name, dist, ...tree, files: countFiles(tree.path) })
    }
  }
  if (uploads.length === 0) throw new SourceMapUploadError('下载目录里一份对照表都没有')
  return uploads.sort((left, right) => left.dist.localeCompare(right.dist) || left.tree.localeCompare(right.tree))
}

function buildCommands({ uploads, release, org, project }) {
  const scope = ['--org', org, '--project', project]
  return [
    ['releases', 'new', release, ...scope],
    ...uploads.map((upload) => [
      'sourcemaps', 'upload',
      '--release', release,
      '--dist', upload.dist,
      '--url-prefix', upload.urlPrefix,
      // 等 Sentry 处理完再算传好：处理失败在这里就看得见，不用等第一条报错对不上才发现。
      '--wait',
      ...scope,
      upload.path,
    ]),
    ['releases', 'finalize', release, '--org', org],
  ]
}

function runSentryCli(cli, args, env) {
  const result = spawnSync(cli, args, { env, stdio: 'inherit', timeout: COMMAND_TIMEOUT_MS, windowsHide: true })
  if (result.error) throw new SourceMapUploadError(`sentry-cli 起不来：${result.error.message}`)
  if (result.status !== 0) throw new SourceMapUploadError(`sentry-cli ${args.slice(0, 2).join(' ')} 失败（退出码 ${result.status ?? result.signal}）`)
}

function renderSummary(release, uploads) {
  const dists = [...new Set(uploads.map((upload) => upload.dist))]
  const lines = [
    `**Sentry 对照表**：${release} 已传，${dists.join('、')}。`,
    '',
    '| 安装包 | 主进程文件 | 界面文件 |',
    '|---|---:|---:|',
  ]
  for (const dist of dists) {
    const count = (tree) => uploads.find((upload) => upload.dist === dist && upload.tree === tree)?.files ?? 0
    lines.push(`| ${dist} | ${count('dist-electron')} | ${count('dist')} |`)
  }
  lines.push('', '文件数是对照表和配对的压缩代码加在一起。这一版以后的报错在 Sentry 里会直接显示源码行；更早的版本照旧。')
  return `${lines.join('\n')}\n`
}

function uploadSourceMaps({ directory, version, cli, env, run = runSentryCli }) {
  const org = env.SENTRY_ORG
  const project = env.SENTRY_PROJECT
  if (!env.SENTRY_AUTH_TOKEN) throw new SourceMapUploadError('没有 SENTRY_AUTH_TOKEN')
  if (!org || !project) throw new SourceMapUploadError('没有 SENTRY_ORG / SENTRY_PROJECT')
  const release = `${RELEASE_PREFIX}${version}`
  const uploads = planSourceMapUploads(directory)
  // 只把 sentry-cli 用得上的几样交给它，作业里别的环境变量不跟着进去。
  const cliEnv = {
    PATH: env.PATH ?? '',
    HOME: env.HOME ?? '',
    SENTRY_AUTH_TOKEN: env.SENTRY_AUTH_TOKEN,
    SENTRY_LOG_LEVEL: 'info',
    SENTRY_DISABLE_UPDATE_CHECK: 'true',
  }
  for (const args of buildCommands({ uploads, release, org, project })) run(cli, args, cliEnv)
  return { release, uploads }
}

function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv)
  const result = uploadSourceMaps({ directory: path.resolve(options.directory), version: options.version, cli: options.cli, env })
  const summary = renderSummary(result.release, result.uploads)
  if (options.summary) fs.appendFileSync(options.summary, `${summary}\n`)
  console.log(summary)
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`::error::Sentry 对照表没传上（发版本身已经完成，客户照常更新）：${error.message}`)
    process.exitCode = 1
  }
}

module.exports = {
  BUILDS,
  RELEASE_PREFIX,
  SourceMapUploadError,
  TREES,
  buildCommands,
  parseArguments,
  planSourceMapUploads,
  renderSummary,
  uploadSourceMaps,
}
