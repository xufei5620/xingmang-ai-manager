// TEMPORARY: run both syncs against the real sources with an in-memory bucket. Never touches COS.
const path = require('node:path')
const common = require('./cos-sync-utils.cjs')

function memoryStore() {
  const objects = new Map()
  let latest = null
  return {
    publicUrl(key) { return `https://xingmang-downloads-1342302199.cos.ap-shanghai.myqcloud.com/${key}` },
    async readJson() { return latest ? JSON.parse(JSON.stringify(latest)) : null },
    async inspect(key) { return objects.get(key) || null },
    async publishFile(key, filePath, input) {
      const hash = await common.hashFile(filePath)
      if (hash.bytes !== input.expectedBytes || hash.sha256 !== input.expectedSha256) throw new Error('hash mismatch')
      const result = { key, bytes: hash.bytes, sha256: hash.sha256, contentType: input.contentType, etag: `"mem-${hash.sha256.slice(0, 8)}"` }
      objects.set(key, result)
      return result
    },
    async publishJson(key, value) { latest = JSON.parse(JSON.stringify(value)); return { key } },
  }
}

async function main() {
  const which = process.argv[2]
  const started = Date.now()
  function progress(event) {
    if (event.event !== 'transfer') console.log(`[${which}] ${JSON.stringify(event)}`)
  }
  if (which === 'grok') {
    const sync = require('./sync-grok-cos.cjs')
    const source = await common.readBoundedRegularFile(path.join(__dirname, '..', 'electron', 'cli-verified-versions.ts'), { maxBytes: 256 * 1024 })
    const recommendedVersion = sync.readRecommendedGrokVersion(source.toString('utf8'))
    const dependencies = sync.createRuntimeDependencies(common)
    const inspect = dependencies.inspectSignature
    dependencies.inspectSignature = async function (filePath, directory) {
      const result = await inspect(filePath, directory)
      console.log(`[grok] signature ${path.basename(filePath)} ${JSON.stringify(result)}`)
      return result
    }
    const store = memoryStore()
    try {
      const result = await sync.synchronizeGrok({ store, dependencies, recommendedVersion, progress })
      console.log(JSON.stringify({ recommendedVersion, result }, null, 2))
      const second = await sync.synchronizeGrok({ store, dependencies, recommendedVersion, progress })
      console.log(`[grok] second run changed=${second.changed}`)
    } catch (error) {
      console.log(`[grok] FAILED ${error.message} ${JSON.stringify(sync.safeGrokSyncFailure(error))}`)
      process.exitCode = 1
    }
  } else {
    const sync = require('./sync-opencode-cos.cjs')
    const dependencies = sync.createRuntimeDependencies(common)
    const inspect = dependencies.inspectPackage
    dependencies.inspectPackage = async function (filePath, directory, machine) {
      const result = await inspect(filePath, directory, machine)
      console.log(`[opencode] package ${machine} ${JSON.stringify(result)}`)
      return result
    }
    try {
      const result = await sync.synchronizeOpenCode({ store: memoryStore(), dependencies, progress })
      console.log(JSON.stringify(result, null, 2))
    } catch (error) {
      console.log(`[opencode] FAILED ${error.message} ${JSON.stringify(sync.safeOpenCodeSyncFailure(error))}`)
      process.exitCode = 1
    }
  }
  console.log(`[${which}] elapsed ${Math.round((Date.now() - started) / 1000)}s`)
}

main()
