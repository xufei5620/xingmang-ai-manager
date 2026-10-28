// The canvas kernel comes from the private xingmang-canvas repository (#1393).
// sync-canvas-kernel.mjs copies one kernel tag into canvas-v2/ and writes
// canvas-v2/KERNEL_SOURCE.json; verify-canvas-kernel-source.test.cjs checks
// the tree against that manifest. Both read the rules from here.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

// 内核在 xingmang-canvas 里的目录和它在 canvas-v2/ 下的位置。K0（xingmang-canvas#3）还没定
// 内核目录，先按总纲（xingmang-canvas#1）写成 canvas-kernel/src 和 canvas-kernel/shared；
// K0 定了以后只改这里。src 必须有，shared 可以没有。
const kernelDirectories = [
  { source: 'canvas-kernel/src', target: 'src', required: true },
  { source: 'canvas-kernel/shared', target: 'shared', required: false },
]
const manifestName = 'KERNEL_SOURCE.json'
const kernelRepository = 'xingmang-canvas'
const maximumPatchDays = 14
const maintainedBySyncMessage = 'canvas-v2/ 由同步脚本维护：改画布请先改 xingmang-canvas、打 tag 再同步；紧急补丁按 T13 登记'
const dayMs = 24 * 60 * 60 * 1000

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function isBinary(bytes) {
  return bytes.includes(0)
}

/** The repository stores text as LF (.gitattributes), so the sync writes LF too. */
function normalizeLineEndings(bytes) {
  if (isBinary(bytes) || !bytes.includes(13)) return bytes
  return Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
}

/**
 * Kernel paths are POSIX paths below src/ or shared/ with no empty, dot or
 * dot-dot segment, so a crafted tree entry can never land outside them.
 */
function isKernelPath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > 400) return false
  if (/[\\\u0000-\u001f]/.test(relativePath)) return false
  const segments = relativePath.split('/')
  if (!kernelDirectories.some((directory) => directory.target === segments[0])) return false
  return segments.length > 1 && segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

/** Reads every kernel file under canvasRoot as { 'src/App.tsx': Buffer }. */
function readKernelTree(canvasRoot) {
  const files = new Map()
  function walk(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      const relativePath = `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) throw new Error(`${relativePath} is a symbolic link; the kernel tree holds regular files only`)
      if (entry.isDirectory()) walk(candidate, relativePath)
      else if (entry.isFile()) files.set(relativePath, fs.readFileSync(candidate))
      else throw new Error(`${relativePath} is not a regular file`)
    }
  }
  for (const directory of kernelDirectories) {
    const root = path.join(canvasRoot, directory.target)
    if (fs.existsSync(root)) walk(root, directory.target)
  }
  return files
}

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}

function dateValue(value) {
  return Date.parse(`${value}T00:00:00Z`)
}

/** Returns the shape problems of a parsed manifest; an empty list means it is well formed. */
function manifestShapeErrors(manifest) {
  const errors = []
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return [`${manifestName} must be a JSON object`]
  const expected = ['repository', 'tag', 'commit', 'syncedAt', 'files', 'localPatches']
  const extra = Object.keys(manifest).filter((key) => !expected.includes(key))
  if (extra.length) errors.push(`${manifestName} has unknown fields: ${extra.join(', ')}`)
  if (manifest.repository !== kernelRepository) errors.push(`${manifestName} repository must be ${kernelRepository}`)
  if (typeof manifest.tag !== 'string' || !isTagName(manifest.tag)) errors.push(`${manifestName} tag is not a tag name`)
  if (typeof manifest.commit !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.commit)) errors.push(`${manifestName} commit must be a full commit hash`)
  if (typeof manifest.syncedAt !== 'string' || Number.isNaN(Date.parse(manifest.syncedAt))) errors.push(`${manifestName} syncedAt must be a timestamp`)
  if (manifest.files === null || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    errors.push(`${manifestName} files must map kernel paths to sha256 hashes`)
  } else {
    for (const [file, hash] of Object.entries(manifest.files)) {
      if (!isKernelPath(file)) errors.push(`${manifestName} lists ${JSON.stringify(file)}, which is not a kernel path`)
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) errors.push(`${manifestName} has no sha256 hash for ${file}`)
    }
  }
  if (!Array.isArray(manifest.localPatches)) {
    errors.push(`${manifestName} localPatches must be a list`)
    return errors
  }
  manifest.localPatches.forEach((patch, index) => {
    const label = `${manifestName} localPatches[${index}]`
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) { errors.push(`${label} must be an object`); return }
    const patchKeys = ['files', 'reason', 'upstream', 'registeredAt', 'expiresAt']
    const unknown = Object.keys(patch).filter((key) => !patchKeys.includes(key))
    if (unknown.length) errors.push(`${label} has unknown fields: ${unknown.join(', ')}`)
    if (!Array.isArray(patch.files) || patch.files.length === 0 || !patch.files.every(isKernelPath)) errors.push(`${label} files must list kernel paths`)
    if (typeof patch.reason !== 'string' || patch.reason.trim().length === 0) errors.push(`${label} needs a reason`)
    if (typeof patch.upstream !== 'string' || patch.upstream.trim().length === 0) errors.push(`${label} needs the xingmang-canvas issue or pull request that takes it upstream`)
    if (!isCalendarDate(patch.registeredAt) || !isCalendarDate(patch.expiresAt)) {
      errors.push(`${label} registeredAt and expiresAt must be YYYY-MM-DD dates`)
    } else {
      const days = (dateValue(patch.expiresAt) - dateValue(patch.registeredAt)) / dayMs
      if (days < 0 || days > maximumPatchDays) errors.push(`${label} must expire within ${maximumPatchDays} days of registration`)
    }
  })
  return errors
}

function isTagName(tag) {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(tag) && !tag.includes('..') && !tag.endsWith('/') && !tag.endsWith('.lock')
}

/**
 * Compares the kernel tree with its manifest. Differences that a local patch
 * names are allowed; an expired patch only warns, so main never turns red on
 * a calendar date. xingmang-canvas's own reverse check chases those instead.
 */
function verifyKernelSource(canvasRoot, manifest, now = new Date()) {
  const errors = manifestShapeErrors(manifest)
  const warnings = []
  if (errors.length) return { errors, warnings }
  const patched = new Set(manifest.localPatches.flatMap((patch) => patch.files))
  const today = now.toISOString().slice(0, 10)
  for (const patch of manifest.localPatches) {
    if (today > patch.expiresAt) warnings.push(`本地补丁 ${patch.files.join('、')} 已过期（${patch.expiresAt}），请确认已回到 xingmang-canvas（${patch.upstream}）后重新同步`)
  }
  const tree = readKernelTree(canvasRoot)
  const problems = []
  for (const [file, hash] of Object.entries(manifest.files)) {
    if (patched.has(file)) continue
    const bytes = tree.get(file)
    if (!bytes) problems.push(`missing ${file}`)
    else if (sha256(bytes) !== hash) problems.push(`changed ${file}`)
  }
  for (const file of tree.keys()) {
    if (!(file in manifest.files) && !patched.has(file)) problems.push(`unlisted ${file}`)
  }
  if (problems.length) errors.push(`${maintainedBySyncMessage}\n  ${problems.join('\n  ')}`)
  return { errors, warnings }
}

module.exports = {
  kernelDirectories,
  kernelRepository,
  maintainedBySyncMessage,
  manifestName,
  maximumPatchDays,
  isKernelPath,
  isTagName,
  manifestShapeErrors,
  normalizeLineEndings,
  readKernelTree,
  sha256,
  verifyKernelSource,
}
