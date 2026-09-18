const {
  assertRemoteReleaseIsOlder,
  validateReleaseEnvironment,
  verifyRemoteFeed,
} = require('./update-release-utils.cjs')
const packageVersion = require('../package.json').version

// 无签名发布同样对外分发并带自动更新,所以「远端版本必须低于本地」这条在两种
// 发布模式下都要成立;只有本机调试构建可以跳过(审查总表 M-01)。抽成具名函数是
// 为了让这条判定可以单测——validateReleaseEnvironment 不接受本地 http 更新源,
// 走不了端到端的 feed fixture。
function assertRemoteVersionIsPublishable(signing, feed, localVersion) {
  if (!signing.publicReleaseMode || feed.missing) return false
  assertRemoteReleaseIsOlder(feed.metadata.version, localVersion)
  return true
}

async function main() {
  const { updateUrl, signing } = validateReleaseEnvironment(process.env, packageVersion)
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
  if (signing.releaseMode) {
    console.log(`发布模式：Authenticode 签名 Windows 安装程序（发布者：${signing.expectedPublisher}）`)
  } else if (signing.unsignedReleaseMode) {
    console.log('发布模式：无签名 Windows 安装程序（产品决定：暂无代码签名证书）')
    console.log('跳过：Authenticode 签名主体比对（无签名模式下没有可比对的证书主体）')
    console.log('照跑：远端版本必须低于本地、类型检查、全部单测、冒烟、加固校验、ASAR 篡改校验、latest.yml/SHA-512/blockmap 校验')
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

module.exports = { assertRemoteVersionIsPublishable }
