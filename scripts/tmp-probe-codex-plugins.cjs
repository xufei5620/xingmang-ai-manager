// 临时：在 GitHub 的机器上用真的 GitHub 接口和 codeload 跑一遍插件目录同步，只写进内存里的假桶（开 PR 前删）。
const common = require('./cos-sync-utils.cjs')
const { synchronizeCodexPlugins, createRuntimeDependencies, archiveUrl, safeCodexPluginsSyncFailure } = require('./sync-codex-plugins-cos.cjs')

function memoryStore() {
  const objects = new Map()
  let latest = null
  return {
    publicUrl(key) { return `https://xingmang-downloads-1342302199.cos.ap-shanghai.myqcloud.com/${key}` },
    async readJson() { return latest && JSON.parse(JSON.stringify(latest)) },
    async inspect(key) { return objects.get(key) || null },
    async publishFile(key, filePath, input) {
      const hash = await common.hashFile(filePath)
      if (hash.sha256 !== input.expectedSha256 || hash.bytes !== input.expectedBytes) throw new Error('hash mismatch')
      const value = { bytes: hash.bytes, sha256: hash.sha256, etag: `"${hash.md5Base64}"`, contentType: input.contentType }
      objects.set(key, value)
      return value
    },
    async publishJson(key, value) { latest = JSON.parse(JSON.stringify(value)); console.log(`[probe] latest ${key} = ${JSON.stringify(value, null, 2)}`) },
  }
}

async function main() {
  const store = memoryStore()
  const dependencies = createRuntimeDependencies(common)
  const progress = function (event) { if (event.event !== 'transfer') console.log(`[probe] ${JSON.stringify(event)}`) }
  for (const [label, token] of [['with token', process.env.GITHUB_TOKEN], ['again, unchanged', process.env.GITHUB_TOKEN]]) {
    const started = Date.now()
    try {
      const result = await synchronizeCodexPlugins({ store, dependencies, token, progress })
      console.log(`[probe] ${label}: changed=${result.changed} commit=${result.manifest.source.commit} bytes=${result.manifest.artifact.bytes} plugins=${JSON.stringify(result.plugins || null)} ms=${Date.now() - started}`)
    } catch (error) {
      console.log(`[probe] ${label} FAILED: ${JSON.stringify(safeCodexPluginsSyncFailure(error))} ${error.message}`)
      process.exitCode = 1
    }
  }
  try {
    const anonymous = await common.fetchText({ url: 'https://api.github.com/repos/openai/plugins/commits/main', allowedHosts: ['api.github.com'], maxBytes: 256,
      headers: { accept: 'application/vnd.github.sha', 'user-agent': 'xingmang-codex-plugins-cos-sync/1' } })
    console.log(`[probe] anonymous commit lookup: ${anonymous.trim()}`)
  } catch (error) {
    console.log(`[probe] anonymous commit lookup failed: ${JSON.stringify(common.safeSyncFailure(error))}`)
  }
}

main()
