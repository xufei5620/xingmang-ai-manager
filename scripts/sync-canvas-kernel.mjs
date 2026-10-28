// Copies one xingmang-canvas kernel tag into canvas-v2/ (#1393):
//
//   node scripts/sync-canvas-kernel.mjs <xingmang-canvas clone> <tag>
//
// The files come from the tag's git objects, never from the clone's working
// tree, so an uncommitted change or a checked-out branch cannot slip in. Only
// canvas-v2/src/ and canvas-v2/shared/ are written; the desktop's own files
// (index.html with its CSP, vite.config.ts, tsconfig.json, package*.json,
// README.md) are never touched. Files that the tag no longer has are deleted,
// text is stored as LF, and canvas-v2/KERNEL_SOURCE.json records the tag, the
// commit and every file's sha256. Running it twice for the same tag changes
// nothing.
//
// xingmang-canvas is private and CI cannot fetch it, so whoever can read it
// runs this locally and opens the sync pull request.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const {
  kernelDirectories,
  kernelRepository,
  manifestName,
  isKernelPath,
  isTagName,
  manifestShapeErrors,
  normalizeLineEndings,
  readKernelTree,
  sha256,
} = require('./canvas-kernel-source.cjs')

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`[sync-canvas-kernel] ${message}`)
  process.exit(1)
}

function git(repository, args, input) {
  const result = spawnSync('git', ['-C', repository, ...args], { input, maxBuffer: 1024 * 1024 * 1024 })
  if (result.error) fail(`无法运行 git：${result.error.message}`)
  if (result.status !== 0) fail(`git ${args.join(' ')} 失败：${result.stderr.toString('utf8').trim()}`)
  return result.stdout
}

function parseArguments(argv) {
  const positional = []
  let canvasRoot = path.join(projectRoot, 'canvas-v2')
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--canvas-root') {
      // Tests point the sync at a scratch copy instead of this repository.
      canvasRoot = path.resolve(argv[index + 1] ?? fail('--canvas-root 后面要跟目录'))
      index += 1
    } else {
      positional.push(argv[index])
    }
  }
  if (positional.length !== 2) fail('用法：node scripts/sync-canvas-kernel.mjs <xingmang-canvas 本地克隆> <tag>')
  const [repository, tag] = positional
  if (!isTagName(tag)) fail(`${JSON.stringify(tag)} 不是 tag 名`)
  return { repository: path.resolve(repository), tag, canvasRoot }
}

/** Lists the regular files below one kernel directory of a commit. */
function listTree(repository, commit, directory) {
  const output = git(repository, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', directory]).toString('utf8')
  const entries = []
  for (const record of output.split('\0')) {
    if (!record) continue
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.+)$/s.exec(record)
    if (!match) fail(`看不懂 git ls-tree 的输出：${JSON.stringify(record)}`)
    const [, mode, type, object, file] = match
    if (!file.startsWith(`${directory}/`)) fail(`${file} 不在 ${directory} 下`)
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) fail(`${file} 不是普通文件（${mode} ${type}），内核里只能有普通文件`)
    entries.push({ object, file })
  }
  return entries
}

/** Reads many blobs through one `git cat-file --batch`. */
function readBlobs(repository, objects) {
  if (objects.length === 0) return []
  const output = git(repository, ['cat-file', '--batch'], `${objects.join('\n')}\n`)
  const blobs = []
  let offset = 0
  for (const object of objects) {
    const headerEnd = output.indexOf(10, offset)
    const header = output.subarray(offset, headerEnd).toString('utf8')
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(header)
    if (!match || match[1] !== object) fail(`读不出对象 ${object}：${header}`)
    const size = Number(match[2])
    blobs.push(output.subarray(headerEnd + 1, headerEnd + 1 + size))
    offset = headerEnd + 1 + size + 1
  }
  return blobs
}

function readPreviousManifest(canvasRoot) {
  const file = path.join(canvasRoot, manifestName)
  if (!fs.existsSync(file)) return null
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    return manifestShapeErrors(manifest).length ? null : manifest
  } catch {
    return null
  }
}

function sameFiles(left, right) {
  const leftKeys = Object.keys(left)
  return leftKeys.length === Object.keys(right).length && leftKeys.every((key) => left[key] === right[key])
}

function removeEmptyDirectories(directory) {
  if (!fs.existsSync(directory)) return
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectories(path.join(directory, entry.name))
  }
  if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory)
}

function main() {
  const { repository, tag, canvasRoot } = parseArguments(process.argv.slice(2))
  if (!fs.existsSync(path.join(canvasRoot, 'vite.config.ts'))) fail(`${canvasRoot} 不像 canvas-v2（没有 vite.config.ts）`)
  const commit = git(repository, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]).toString('utf8').trim()
  if (!/^[0-9a-f]{40}$/.test(commit)) fail(`tag ${tag} 没有指向一个提交`)

  const incoming = new Map()
  for (const directory of kernelDirectories) {
    const entries = listTree(repository, commit, directory.source)
    if (entries.length === 0) {
      if (directory.required) fail(`tag ${tag} 里没有 ${directory.source}`)
      continue
    }
    const blobs = readBlobs(repository, entries.map((entry) => entry.object))
    entries.forEach((entry, index) => {
      const target = `${directory.target}${entry.file.slice(directory.source.length)}`
      if (!isKernelPath(target)) fail(`${entry.file} 映射到 ${target}，不是内核路径`)
      incoming.set(target, normalizeLineEndings(blobs[index]))
    })
  }

  const current = readKernelTree(canvasRoot)
  let written = 0
  let removed = 0
  for (const [file, bytes] of incoming) {
    const existing = current.get(file)
    if (existing && existing.equals(bytes)) continue
    const destination = path.join(canvasRoot, ...file.split('/'))
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, bytes)
    written += 1
  }
  for (const file of current.keys()) {
    if (incoming.has(file)) continue
    fs.rmSync(path.join(canvasRoot, ...file.split('/')))
    removed += 1
  }
  for (const directory of kernelDirectories) removeEmptyDirectories(path.join(canvasRoot, directory.target))

  const files = Object.fromEntries([...incoming.keys()].sort().map((file) => [file, sha256(incoming.get(file))]))
  const previous = readPreviousManifest(canvasRoot)
  const unchanged = previous && previous.tag === tag && previous.commit === commit && sameFiles(previous.files, files)
  if (previous?.localPatches.length) {
    console.warn(`[sync-canvas-kernel] 这次同步清掉了 ${previous.localPatches.length} 个本地补丁，确认它们已经回到 xingmang-canvas：`)
    for (const patch of previous.localPatches) console.warn(`  ${patch.files.join('、')}（${patch.upstream}）`)
  }
  const manifest = {
    repository: kernelRepository,
    tag,
    commit,
    // Kept for an unchanged sync, so running it again leaves no diff.
    syncedAt: unchanged ? previous.syncedAt : new Date().toISOString(),
    files,
    localPatches: [],
  }
  fs.writeFileSync(path.join(canvasRoot, manifestName), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`[sync-canvas-kernel] 已同步 ${kernelRepository} ${tag}（${commit.slice(0, 12)}）：${incoming.size} 个文件，写入 ${written} 个，删除 ${removed} 个`)
}

main()
