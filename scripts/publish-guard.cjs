#!/usr/bin/env node
// publish-release 在往更新目录写任何东西之前的最后一道关（#493）：
//
//   --local <本次出的清单> --live <线上那一份> --name latest.yml|latest-mac.yml
//
// 线上那一份不存在（工作流拿到 404）时不传 --live，这个平台是第一次发，放行。
// 线上比本次旧：正常的升级，放行。线上比本次新：拒绝，这不是发布而是降级。
// 线上正好是这个版本：只有当它和本次出的清单引用的是同一批字节（逐个文件比 SHA-512
// 和大小）才放行——那是同一次出包的发布作业被重跑，重传一遍一模一样的文件没有害处。
// 否则拒绝：同一个版本号换一批字节，正在下载的人会校验失败，已经装上的人和新装的人
// 拿到的又不是同一个程序。
//
// 另外带上 --status <线上的 service-status.json>（#548）：本次要发的版本已经在撤回
// 名单里，一律拒绝。回退之后线上清单是旧版本，只比版本号会把「重跑一次坏版本的
// 发布」当成正常升级放行，清单又指回坏版本，还停在坏版本上的人就没有可退的版本了。
// 真要让它重新上线，先用 service-status 工作流把它移出撤回名单，再来发。状态文件
// 读回来看不懂时同样停下：不知道撤回名单里有什么，就不能断定这一版没被撤回。
//
// Windows 出包时 release:build:unsigned 自己会拒绝同版本，但 macOS 那条路没有这一步，
// 只发 Mac 时原来要到最后打 tag 那一步才发现，线上的 Mac 包那时已经被覆盖了。
const fs = require('node:fs')
const { compareReleaseVersions, parseLatestMetadata } = require('./update-release-utils.cjs')
const { parseCurrentStatus } = require('./service-status.cjs')

const MANIFEST_NAMES = new Set(['latest.yml', 'latest-mac.yml'])

class PublishGuardError extends Error {}

function fileFingerprints(metadata) {
  return metadata.files
    .map((file) => `${file.relativePath.toLowerCase()}\n${file.sha512}\n${file.size ?? ''}`)
    .sort()
    .join('\n\n')
}

/** 返回 'first' / 'upgrade' / 'same'；不能发时抛 PublishGuardError。 */
function assessPublish(localText, liveText, name) {
  if (!MANIFEST_NAMES.has(name)) throw new PublishGuardError(`不认识的更新清单：${name}`)
  const local = parseLatestMetadata(localText, name)
  if (liveText === null || liveText === undefined) return 'first'
  const live = parseLatestMetadata(liveText, name)
  const comparison = compareReleaseVersions(live.version, local.version)
  if (comparison < 0) return 'upgrade'
  if (comparison > 0) {
    throw new PublishGuardError(`线上的 ${name} 已经是更高的 ${live.version}，不能再发 ${local.version}；要退回旧版本请用 rollback-release`)
  }
  if (fileFingerprints(live) !== fileFingerprints(local)) {
    throw new PublishGuardError(`线上已经发布过 ${local.version} 的 ${name}，这次出的包和它不是同一批文件。同一个版本号不能换内容，请先提升版本号`)
  }
  return 'same'
}

/** statusText 为 null 表示线上没有状态文件（404），也就没有撤回名单。 */
function assertNotWithdrawn(localText, statusText, name) {
  if (statusText === null || statusText === undefined) return
  const version = String(parseLatestMetadata(localText, name).version).replace(/^v/i, '')
  let status
  try {
    status = parseCurrentStatus(statusText)
  } catch {
    throw new PublishGuardError('线上的 service-status.json 读回来看不懂，确认不了这一版有没有被撤回，线上什么都没改；过几分钟重跑')
  }
  const badVersions = status.badVersions
  if (badVersions === undefined) return
  if (!Array.isArray(badVersions)) {
    throw new PublishGuardError('线上 service-status.json 的撤回名单格式不对，确认不了这一版有没有被撤回，线上什么都没改')
  }
  if (badVersions.some((entry) => typeof entry === 'string' && entry.trim().replace(/^v/i, '') === version)) {
    throw new PublishGuardError(`${version} 已经被撤回，不能再发它的 ${name}：修好的版本请提升版本号再发；真要让它重新上线，先用 service-status 工作流把它移出撤回名单（填 -${version}）`)
  }
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    if (!flag.startsWith('--') || argv[index + 1] === undefined) throw new PublishGuardError(`参数不对：${flag}`)
    options[flag.slice(2)] = argv[index + 1]
  }
  return options
}

function main(argv) {
  const options = parseArguments(argv)
  if (!options.local || !options.name) {
    throw new PublishGuardError('用法：publish-guard.cjs --local <file> --name <latest.yml|latest-mac.yml> [--live <file>] [--status <file>]')
  }
  const liveText = options.live ? fs.readFileSync(options.live, 'utf8') : null
  const localText = fs.readFileSync(options.local, 'utf8')
  const verdict = assessPublish(localText, liveText, options.name)
  assertNotWithdrawn(localText, options.status ? fs.readFileSync(options.status, 'utf8') : null, options.name)
  const messages = {
    first: `线上还没有 ${options.name}，这是这个平台的第一次发布`,
    upgrade: `${options.name}：线上是旧版本，可以发`,
    same: `${options.name}：线上已经是同一批文件（重跑发布），重传不改变任何内容`,
  }
  console.log(messages[verdict])
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

module.exports = { PublishGuardError, assertNotWithdrawn, assessPublish }
