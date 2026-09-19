const fs = require('node:fs')
const path = require('node:path')
const {
  ReleaseValidationError,
  assertRemoteReleaseIsOlder,
  validateReleaseEnvironment,
  verifyRemoteFeed,
} = require('./update-release-utils.cjs')
const packageVersion = require('../package.json').version

const releaseNotesFile = 'release-notes.md'

// 无签名发布同样对外分发并带自动更新,所以「远端版本必须低于本地」这条在两种
// 发布模式下都要成立;只有本机调试构建可以跳过(审查总表 M-01)。抽成具名函数是
// 为了让这条判定可以单测——validateReleaseEnvironment 不接受本地 http 更新源,
// 走不了端到端的 feed fixture。
function assertRemoteVersionIsPublishable(signing, feed, localVersion) {
  if (!signing.publicReleaseMode || feed.missing) return false
  assertRemoteReleaseIsOlder(feed.metadata.version, localVersion)
  return true
}

// release-notes.md 里的版本是一行光秃秃的版本号,上面没有 Markdown 标题,所以
// 「第一个非空行」就是这份文件当前声明的版本。
function readReleaseNotesVersion(source) {
  const line = source.replace(/\r\n/g, '\n').split('\n').map((entry) => entry.trim()).find((entry) => entry !== '')
  return line ?? ''
}

// electron-builder 的 releaseInfo.releaseNotesFile 指着这份文件,打包时整份原样写进
// latest.yml 的 releaseNotes,客户端更新页显示的就是它。发版时忘了把「未发布」改成
// 版本号,付费用户在更新页看到的第一行就是「未发布」,本次的条目还会被读成上一个版本
// 的内容 —— 而打包、签名、latest.yml/SHA-512 校验全都会通过,此前没有任何一道门禁
// 看这份文件一眼(审查总表 P-14)。
function assertReleaseNotesVersionIsPublishable(signing, source, localVersion) {
  if (!signing.publicReleaseMode) return false
  const declared = readReleaseNotesVersion(source)
  if (declared !== localVersion) {
    throw new ReleaseValidationError(
      'RELEASE_NOTES_VERSION_MISMATCH',
      `${releaseNotesFile} 的第一行是「${declared || '（空文件）'}」，`
      + `与 package.json 的版本 ${localVersion} 不一致。`
      + '发版前请先运行 npm run changelog:collect 汇总变更分片，'
      + `再把 ${releaseNotesFile} 的「未发布」改成 ${localVersion}。`,
    )
  }
  return true
}

async function main() {
  const { updateUrl, signing } = validateReleaseEnvironment(process.env, packageVersion)
  const releaseNotes = fs.readFileSync(path.join(__dirname, '..', releaseNotesFile), 'utf8')
  assertReleaseNotesVersionIsPublishable(signing, releaseNotes, packageVersion)
  const feed = await verifyRemoteFeed({
    baseUrl: updateUrl,
    allowMissing: true,
    verifyAssets: false,
    platform: 'windows',
  })
  assertRemoteVersionIsPublishable(signing, feed, packageVersion)
  const feedState = feed.missing ? '尚未发布 latest.yml（允许首次发布）' : `当前版本 ${feed.metadata.version}`
  console.log(`发布前置检查通过：${updateUrl}`)
  console.log(`更新源状态：${feedState}`)
  console.log(`更新说明版本行：${readReleaseNotesVersion(releaseNotes)}（${releaseNotesFile}）`)
  if (signing.releaseMode) {
    console.log(`发布模式：Authenticode 签名 Windows 安装程序（发布者：${signing.expectedPublisher}）`)
  } else if (signing.unsignedReleaseMode) {
    console.log('发布模式：无签名 Windows 安装程序（产品决定：暂无代码签名证书）')
    console.log('跳过：Authenticode 签名主体比对（无签名模式下没有可比对的证书主体）')
    console.log('照跑：远端版本必须低于本地、更新说明版本行、类型检查、全部单测、冒烟、加固校验、ASAR 篡改校验、latest.yml/SHA-512/blockmap 校验')
  } else {
    console.log('发布模式：本地开发校验；未执行正式签名门禁')
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`发布前置检查失败 [${error.code || 'UNKNOWN'}]：${error.message}`)
    process.exitCode = 1
  })
}

module.exports = {
  assertReleaseNotesVersionIsPublishable,
  assertRemoteVersionIsPublishable,
  readReleaseNotesVersion,
}
