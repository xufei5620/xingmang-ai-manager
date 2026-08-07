const {
  DEFAULT_UPDATE_URL,
  verifyRemoteFeed,
} = require('./update-release-utils.cjs')

async function main() {
  const rawArgs = process.argv.slice(2)
  const args = new Set(rawArgs)
  const explicitUrl = rawArgs.find((argument) => !argument.startsWith('--'))
  const platformArgument = rawArgs.find((argument) => argument.startsWith('--platform='))
  const platform = platformArgument?.slice('--platform='.length) || 'all'
  const allowLocalHttp = args.has('--allow-local')
  const verifyAssets = !args.has('--metadata-only')
  const baseUrl = explicitUrl || process.env.XINGMANG_UPDATE_URL || DEFAULT_UPDATE_URL
  const result = await verifyRemoteFeed({ baseUrl, allowLocalHttp, verifyAssets, platform })
  if (platform === 'windows') {
    const scope = verifyAssets ? 'Windows 元数据与引用文件、blockmap' : 'Windows 元数据'
    console.log(`更新源校验通过：Windows v${result.metadata.version}（${scope}）`)
    return
  }
  if (platform === 'macos') {
    const scope = verifyAssets ? 'macOS 元数据、双架构引用文件与 ZIP blockmap' : 'macOS 元数据'
    console.log(`更新源校验通过：macOS v${result.mac.metadata.version}（${scope}）`)
    return
  }
  const scope = verifyAssets
    ? '双平台元数据与引用文件、Windows blockmap、macOS 双架构 ZIP blockmap'
    : '双平台元数据'
  console.log(`更新源校验通过：Windows v${result.metadata.version}；macOS v${result.mac.metadata.version}（${scope}）`)
}

main().catch((error) => {
  console.error(`更新源校验失败 [${error.code || 'UNKNOWN'}]：${error.message}`)
  process.exitCode = 1
})
