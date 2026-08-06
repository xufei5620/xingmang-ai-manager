const {
  DEFAULT_UPDATE_URL,
  verifyRemoteFeed,
} = require('./update-release-utils.cjs')

async function main() {
  const args = new Set(process.argv.slice(2))
  const explicitUrl = process.argv.slice(2).find((argument) => !argument.startsWith('--'))
  const allowLocalHttp = args.has('--allow-local')
  const verifyAssets = !args.has('--metadata-only')
  const baseUrl = explicitUrl || process.env.XINGMANG_UPDATE_URL || DEFAULT_UPDATE_URL
  const result = await verifyRemoteFeed({ baseUrl, allowLocalHttp, verifyAssets })
  const scope = verifyAssets ? '元数据、安装程序和 blockmap' : '元数据'
  console.log(`更新源校验通过：v${result.metadata.version}（${scope}）`)
}

main().catch((error) => {
  console.error(`更新源校验失败 [${error.code || 'UNKNOWN'}]：${error.message}`)
  process.exitCode = 1
})
