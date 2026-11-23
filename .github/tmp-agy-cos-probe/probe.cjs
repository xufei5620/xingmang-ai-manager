// One-off probe: run the real Antigravity CLI bucket sync on this runner against an in-memory bucket,
// then check that the signature checks refuse a binary Google did not sign. No credentials.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const common = require('../../scripts/cos-sync-utils.cjs')
const sync = require('../../scripts/sync-antigravity-cli-cos.cjs')

const run = promisify(execFile)

function memoryStore() {
  const objects = new Map()
  let index = null
  return {
    objects,
    publicUrl(key) { return `https://probe-bucket.cos.ap-shanghai.myqcloud.com/${key}` },
    async readJson() { return index ? JSON.parse(JSON.stringify(index)) : null },
    async inspect(key) { return objects.get(key) || null },
    async publishFile(key, filePath, input) {
      const body = await fs.readFile(filePath)
      const sha256 = crypto.createHash('sha256').update(body).digest('hex')
      assert.equal(sha256, input.expectedSha256)
      assert.equal(body.length, input.expectedBytes)
      const result = { key, bytes: body.length, sha256, contentType: input.contentType, etag: `"${sha256.slice(0, 32)}"` }
      objects.set(key, result)
      return result
    },
    async publishJson(key, value) { index = JSON.parse(JSON.stringify(value)); return { key } },
  }
}

async function refusesForeignBinary(family, dependencies) {
  const workDirectory = await dependencies.createWorkDirectory()
  try {
    if (family === 'windows') {
      // node.exe is validly signed, by the OpenJS Foundation, not Google.
      const signature = await dependencies.inspectWindowsSignature(process.execPath, workDirectory)
      console.log('[probe] node.exe signature', JSON.stringify({ status: signature.status, subject: signature.subject, issuer: signature.issuer }))
      assert.throws(() => sync.validateWindowsSignature(signature))
    } else {
      // /bin/ls is signed by Apple, not by Google's team.
      const folder = path.join(workDirectory, 'pack')
      await fs.mkdir(folder)
      await fs.copyFile('/bin/ls', path.join(folder, 'antigravity'))
      const archive = path.join(workDirectory, 'foreign.tar.gz')
      await run('/usr/bin/tar', ['-czf', archive, '-C', folder, 'antigravity'])
      await assert.rejects(dependencies.inspectMacArchive(archive, workDirectory, 'arm64'), (error) => {
        console.log('[probe] foreign archive refused', JSON.stringify(sync.safeAntigravitySyncFailure(error)))
        return true
      })
    }
  } finally {
    await dependencies.removeWorkDirectory(workDirectory)
  }
}

async function main() {
  const family = sync.familyForRunner(process.platform)
  const dependencies = sync.createRuntimeDependencies(common)
  const store = memoryStore()
  const progress = function (event) { if (event.event !== 'transfer') console.log(`[sync] ${JSON.stringify(event)}`) }
  const first = await sync.synchronizeAntigravityCli({ store, dependencies, family, progress })
  console.log('[probe] index', JSON.stringify(first.index, null, 2))
  assert.equal(first.changed, true)
  assert.equal(first.index.releases[0].files.length, 2)
  const second = await sync.synchronizeAntigravityCli({ store, dependencies, family, progress })
  assert.equal(second.changed, false)
  console.log('[probe] second run unchanged, objects', store.objects.size)
  await refusesForeignBinary(family, dependencies)
  console.log(`[probe] ${family} ok on ${os.arch()}`)
}

main().catch(function (error) {
  console.error('[probe] failed', error && error.stack, JSON.stringify(sync.safeAntigravitySyncFailure(error)))
  process.exitCode = 1
})
