#!/usr/bin/env node
// publish-release 一开始跑的那一步：这一版的 tag 该怎么办。只做判断，不碰 tag。
//
// 为什么 tag 要在一开始就占上，而不是发完再打：作业用的 GITHUB_TOKEN 是 GitHub App
// 令牌，没有、也拿不到 workflows 权限。GitHub 对这种令牌的规矩是，要建的 ref（0.2.8 的
// git push 撞过：refusing to allow a GitHub App to create or update workflow）和建 Release
// 时的 target_commitish（REST 文档「Create a release」/「Update a release」的原话），只要
// 指向的提交里 .github/workflows/ 下的文件和默认分支对不上，就一律拒绝。出包要一个多小时，
// 两次批准之间可能隔一整夜，这期间 main 合进任何一个改工作流的提交，收尾时就再也打不上
// tag、建不了 Release：0.2.14 的 #774、#776 在出包之后合进 main，publish 作业最后两次都是
// HTTP 403，tag 是事后用产品所有者的账号补推的，Release 也只能手工建。
//
// 本次出包的提交是触发那一刻 main 的最新提交。占 tag 的作业一开始跑就动手，只要 main 的
// 工作流文件在这之前没变，GitHub 就接受；真变了（比如排在前一次发布后面等了很久），那一步
// 停下、说清楚从最新的 main 重新触发，那时什么都还没发。收尾时 tag 已经在了，建 Release
// 不传 target_commitish（缺省按默认分支的最新提交判断，必然一致），挂到这个已有的 tag 上。
//
// 这一步和动手的那一步在同一个作业里，作业拿着写权限，所以不装任何依赖：只用 Node 自带的
// 模块和仓库里不依赖第三方包的脚本，线上清单也只读最外层的 version 一行。重跑时判断和
// 动手一起重来，不会拿上一次的判断去动 tag。
//
//   create：还没有这个 tag，建在本次出包的提交上。
//   keep：  tag 已经指向本次出包的提交（重跑，或者同一个提交上补发另一个平台）。
//   move：  tag 指向别的提交，但那一版从没发出去过：上一次触发占了 tag，之后取消、
//           合进修复再重新触发（「补进来重出包」）。挪到这次的提交上。
// 其余情况一律停下：这个版本已经被撤回，线上清单已经比它高，或者它已经从别的提交发过
// （GitHub 上有它的 Release，或者线上清单已经是它）。哪一样查不清，都当成「不能动」，
// 不当成「没有」。
const fs = require('node:fs')
const path = require('node:path')
const { UPDATE_MANIFEST_NAMES, compareReleaseVersions } = require('./update-release-utils.cjs')
const { parseCurrentStatus } = require('./service-status.cjs')

// 与 parseLatestMetadata 认的版本号同一个写法：tag 名就是 v 加它，动手那一步还要把它拼进
// 接口地址。
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
// electron-builder 写出来的清单，版本号总在最外层的 `version: x.y.z` 这一行。
const MANIFEST_VERSION_LINE = /^version:[ \t]*(['"]?)([^'"\s#]+)\1[ \t]*(?:#.*)?$/

class ReleaseTagPlanError extends Error {}

function shortCommit(sha) {
  return sha.slice(0, 7)
}

function manifestVersion(text, name) {
  const versions = String(text).split(/\r?\n/)
    .map((line) => MANIFEST_VERSION_LINE.exec(line))
    .filter(Boolean)
    .map((match) => match[2])
  if (versions.length !== 1 || !VERSION_PATTERN.test(versions[0])) {
    throw new ReleaseTagPlanError(`线上的 ${name} 读回来看不懂，确认不了这个版本有没有发过；tag 没动，过几分钟重新触发`)
  }
  return versions[0]
}

/** statusText 为 null 表示线上没有状态文件（404），也就没有撤回名单。 */
function isWithdrawn(version, statusText) {
  if (statusText === null || statusText === undefined) return false
  let status
  try {
    status = parseCurrentStatus(statusText)
  } catch {
    throw new ReleaseTagPlanError('线上的 service-status.json 读回来看不懂，确认不了这个版本有没有被撤回；tag 没动，过几分钟重新触发')
  }
  const badVersions = status.badVersions
  if (badVersions === undefined) return false
  if (!Array.isArray(badVersions)) {
    throw new ReleaseTagPlanError('线上 service-status.json 的撤回名单格式不对，确认不了这个版本有没有被撤回；tag 没动')
  }
  return badVersions.some((entry) => typeof entry === 'string' && entry.trim().replace(/^v/i, '') === version)
}

/**
 * tagTarget：tag 现在指向的 commit（附注 tag 已解引用），没有这个 tag 时为空串。
 * releaseExists：GitHub 上有没有这个 tag 的 Release（草稿也算）。
 * liveManifests：{ 清单名: 线上那一份的文本 }，线上没有（404）的不放进来。
 * statusText：线上的 service-status.json，没有（404）时传 null。
 *
 * 返回 { action: 'create' } / { action: 'keep' } / { action: 'move', from }；不能动时抛
 * ReleaseTagPlanError。
 */
function planReleaseTag({ version, shippedSha, tagTarget = '', releaseExists = false, liveManifests = {}, statusText = null }) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new ReleaseTagPlanError(`${version} 不是有效的版本号；tag 没动`)
  }
  if (typeof shippedSha !== 'string' || !COMMIT_PATTERN.test(shippedSha)) {
    throw new ReleaseTagPlanError(`本次出包的提交号不对（${shippedSha}）；tag 没动`)
  }
  if (typeof tagTarget !== 'string' || (tagTarget && !COMMIT_PATTERN.test(tagTarget))) {
    throw new ReleaseTagPlanError(`读不出 v${version} 指向哪个提交（${tagTarget}）；tag 没动`)
  }
  const tag = `v${version}`
  // #548：撤回的版本不论从哪个提交都不能再发。上传前那道关也会拦，这里早一个多小时拦下。
  if (isWithdrawn(version, statusText)) {
    throw new ReleaseTagPlanError(`${version} 已经被撤回，不能再发；修好的版本请提升版本号再发；tag 没动`)
  }
  const shipped = []
  for (const name of UPDATE_MANIFEST_NAMES) {
    const text = liveManifests[name]
    if (text === undefined || text === null) continue
    const live = manifestVersion(text, name)
    const comparison = compareReleaseVersions(live, version)
    if (comparison > 0) {
      throw new ReleaseTagPlanError(`线上的 ${name} 已经是更高的 ${live}，不能再发 ${version}；tag 没动`)
    }
    if (comparison === 0) shipped.push(name)
  }
  // 同一个提交上重跑、补发另一个平台：线上已经是这一版、也有 Release，照样放行。
  if (tagTarget === shippedSha) return { action: 'keep' }

  if (tagTarget && releaseExists) {
    throw new ReleaseTagPlanError(`${tag} 已经从 ${shortCommit(tagTarget)} 发过（GitHub 上有这个版本的 Release），同一个版本号不能从别的提交再发，请先提升版本号；tag 没动`)
  }
  if (shipped.length > 0) {
    // 没有 tag 却已经上过更新源：只有本工作流之前的老版本、或者有人手动删了 tag 才会
    // 这样。说不清当初是从哪个提交发的，把 tag 建在这次的提交上可能就建错了。
    throw new ReleaseTagPlanError(tagTarget
      ? `${tag} 已经从 ${shortCommit(tagTarget)} 上过更新源（线上的 ${shipped[0]} 就是 ${version}），同一个版本号不能从别的提交再发，请先提升版本号；tag 没动`
      : `线上的 ${shipped[0]} 已经是 ${version}，仓库里却没有 ${tag}，确认不了它是从哪个提交发的；tag 没动。要在原来的提交上补发，先把 ${tag} 建在那个提交上再触发，否则请先提升版本号`)
  }
  return tagTarget ? { action: 'move', from: tagTarget } : { action: 'create' }
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    if (!flag.startsWith('--') || argv[index + 1] === undefined) throw new ReleaseTagPlanError(`参数不对：${flag}`)
    options[flag.slice(2)] = argv[index + 1]
  }
  return options
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

function main(argv) {
  const options = parseArguments(argv)
  if (!options.version || !options.shipped || !options['live-dir'] || options['tag-target'] === undefined
    || !['true', 'false'].includes(options['release-exists'])) {
    throw new ReleaseTagPlanError('用法：release-tag-plan.cjs --version <x.y.z> --shipped <commit> --tag-target <commit 或空串> --release-exists <true|false> --live-dir <目录> [--status <文件>]')
  }
  const liveManifests = {}
  for (const name of UPDATE_MANIFEST_NAMES) {
    const text = readIfPresent(path.join(options['live-dir'], name))
    if (text !== null) liveManifests[name] = text
  }
  const plan = planReleaseTag({
    version: options.version,
    shippedSha: options.shipped,
    tagTarget: options['tag-target'],
    releaseExists: options['release-exists'] === 'true',
    liveManifests,
    statusText: options.status ? fs.readFileSync(options.status, 'utf8') : null,
  })
  // 原样追加进 $GITHUB_OUTPUT：只有这两行，取值都已经在上面对过格式。
  const lines = [`action=${plan.action}`]
  if (plan.from) lines.push(`from=${plan.from}`)
  process.stdout.write(`${lines.join('\n')}\n`)
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

module.exports = { ReleaseTagPlanError, planReleaseTag }
