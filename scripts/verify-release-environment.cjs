const {
  assertRemoteReleaseIsOlder,
  validateReleaseEnvironment,
  verifyRemoteFeed,
} = require('./update-release-utils.cjs')
const packageVersion = require('../package.json').version

async function main() {
  const { updateUrl, signing } = validateReleaseEnvironment()
  const feed = await verifyRemoteFeed({
    baseUrl: updateUrl,
    allowMissing: true,
    verifyAssets: false,
    platform: 'windows',
  })
  if (signing.releaseMode && !feed.missing) {
    assertRemoteReleaseIsOlder(feed.metadata.version, packageVersion)
  }
  const feedState = feed.missing ? '尚未发布 latest.yml（允许首次发布）' : `当前版本 ${feed.metadata.version}`
  console.log(`发布前置检查通过：${updateUrl}`)
  console.log(`更新源状态：${feedState}`)
  console.log(signing.releaseMode
    ? `发布模式：Authenticode 签名 Windows 安装程序（发布者：${signing.expectedPublisher}）`
    : '发布模式：本地开发校验；未执行正式签名门禁')
}

main().catch((error) => {
  console.error(`发布前置检查失败 [${error.code || 'UNKNOWN'}]：${error.message}`)
  process.exitCode = 1
})
