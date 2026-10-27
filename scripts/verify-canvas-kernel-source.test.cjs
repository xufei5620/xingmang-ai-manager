const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const {
  maintainedBySyncMessage,
  manifestName,
  manifestShapeErrors,
  readKernelTree,
  sha256,
  verifyKernelSource,
} = require('./canvas-kernel-source.cjs')

// canvas-v2/ has no KERNEL_SOURCE.json until the first kernel sync (#1393),
// so this file checks the sync script and the manifest rules on scratch
// copies. The sync pull request adds the check of the real canvas-v2/.

const script = path.join(__dirname, 'sync-canvas-kernel.mjs')
const scratch = []

function directory(prefix) {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  scratch.push(created)
  return created
}

test.afterEach(() => {
  for (const created of scratch.splice(0)) fs.rmSync(created, { recursive: true, force: true })
})

function git(repository, ...args) {
  const result = spawnSync('git', [
    '-c', 'user.name=Canvas Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.autocrlf=false',
    '-C', repository, ...args,
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function write(root, file, content) {
  const target = path.join(root, ...file.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

const binaryAsset = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0d, 0x0a])

/** A stand-in for xingmang-canvas with a kernel tag and website files around it. */
function kernelRepository() {
  const repository = directory('xingmang-kernel-repo-')
  git(repository, 'init', '--quiet')
  write(repository, 'canvas-kernel/src/main.tsx', "import './App'\r\nexport {}\r\n")
  write(repository, 'canvas-kernel/src/editor/App.tsx', 'export function App() { return null }\n')
  write(repository, 'canvas-kernel/src/assets/icon.png', binaryAsset)
  write(repository, 'canvas-kernel/shared/ui-tokens.css', ':root { --accent: #000; }\n')
  write(repository, 'app/page.tsx', "fetch('/api/projects')\n")
  write(repository, 'canvas-kernel-notes.md', 'not part of the kernel\n')
  git(repository, 'add', '.')
  git(repository, 'commit', '--quiet', '-m', 'kernel')
  git(repository, 'tag', 'kernel-1')
  return repository
}

function canvasRoot() {
  const root = directory('xingmang-canvas-v2-')
  write(root, 'vite.config.ts', 'export default {}\n')
  write(root, 'index.html', '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">\n')
  write(root, 'package.json', '{}\n')
  write(root, 'src/App.tsx', 'export const legacy = true\n')
  write(root, 'src/old/legacy.ts', 'export {}\n')
  return root
}

function sync(repository, tag, root) {
  return spawnSync(process.execPath, [script, repository, tag, '--canvas-root', root], { encoding: 'utf8' })
}

function readManifest(root) {
  return JSON.parse(fs.readFileSync(path.join(root, manifestName), 'utf8'))
}

test('copies one kernel tag into src and shared and leaves the desktop files alone', () => {
  const repository = kernelRepository()
  const root = canvasRoot()
  const indexBefore = fs.readFileSync(path.join(root, 'index.html'))

  const result = sync(repository, 'kernel-1', root)
  assert.equal(result.status, 0, result.stderr)

  assert.deepEqual([...readKernelTree(root).keys()].sort(), ['shared/ui-tokens.css', 'src/assets/icon.png', 'src/editor/App.tsx', 'src/main.tsx'])
  assert.equal(fs.readFileSync(path.join(root, 'src', 'main.tsx'), 'utf8'), "import './App'\nexport {}\n")
  assert.ok(fs.readFileSync(path.join(root, 'src', 'assets', 'icon.png')).equals(binaryAsset), 'binary files keep their bytes')
  assert.ok(!fs.existsSync(path.join(root, 'src', 'old')), 'files the tag does not have are removed with their folders')
  assert.ok(fs.readFileSync(path.join(root, 'index.html')).equals(indexBefore))
  assert.ok(fs.existsSync(path.join(root, 'vite.config.ts')))

  const manifest = readManifest(root)
  assert.equal(manifest.repository, 'xingmang-canvas')
  assert.equal(manifest.tag, 'kernel-1')
  assert.equal(manifest.commit, git(repository, 'rev-parse', 'kernel-1^{commit}'))
  assert.deepEqual(manifest.localPatches, [])
  assert.deepEqual(Object.keys(manifest.files), ['shared/ui-tokens.css', 'src/assets/icon.png', 'src/editor/App.tsx', 'src/main.tsx'])
  assert.equal(manifest.files['src/main.tsx'], sha256(Buffer.from("import './App'\nexport {}\n")))
  assert.deepEqual(manifestShapeErrors(manifest), [])
  assert.deepEqual(verifyKernelSource(root, manifest), { errors: [], warnings: [] })
})

test('changes nothing when the same tag is synced again', () => {
  const repository = kernelRepository()
  const root = canvasRoot()
  assert.equal(sync(repository, 'kernel-1', root).status, 0)
  const manifestBefore = fs.readFileSync(path.join(root, manifestName))
  const treeBefore = readKernelTree(root)

  const again = sync(repository, 'kernel-1', root)
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /写入 0 个，删除 0 个/)
  assert.ok(fs.readFileSync(path.join(root, manifestName)).equals(manifestBefore))
  assert.deepEqual(readKernelTree(root), treeBefore)
})

test('reads the tag itself, not the working tree or a branch of the same name', () => {
  const repository = kernelRepository()
  write(repository, 'canvas-kernel/src/editor/App.tsx', 'export const uncommitted = true\n')
  git(repository, 'branch', 'kernel-2')
  const root = canvasRoot()

  assert.equal(sync(repository, 'kernel-1', root).status, 0)
  assert.equal(fs.readFileSync(path.join(root, 'src', 'editor', 'App.tsx'), 'utf8'), 'export function App() { return null }\n')

  const branch = sync(repository, 'kernel-2', root)
  assert.notEqual(branch.status, 0)
  assert.equal(readManifest(root).tag, 'kernel-1', 'a failed sync leaves the manifest as it was')
})

test('refuses a tag name that could be read as a git option', () => {
  const repository = kernelRepository()
  const root = canvasRoot()
  for (const tag of ['--upload-pack=calc', 'kernel..1', '../kernel']) {
    const result = sync(repository, tag, root)
    assert.notEqual(result.status, 0, tag)
    assert.match(result.stderr, /不是 tag 名/)
  }
})

test('refuses a kernel tag that holds a symbolic link', () => {
  const repository = kernelRepository()
  const object = git(repository, 'hash-object', '-w', '--stdin', '--no-filters')
  git(repository, 'update-index', '--add', '--cacheinfo', `120000,${object},canvas-kernel/src/link`)
  git(repository, 'commit', '--quiet', '-m', 'link')
  git(repository, 'tag', 'kernel-link')
  const root = canvasRoot()

  const result = sync(repository, 'kernel-link', root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /不是普通文件/)
  assert.ok(fs.existsSync(path.join(root, 'src', 'App.tsx')), 'nothing is written before the tag is fully checked')
})

test('fails a kernel file that differs from the manifest, a missing one and an unlisted one', () => {
  const repository = kernelRepository()
  const root = canvasRoot()
  assert.equal(sync(repository, 'kernel-1', root).status, 0)
  const manifest = readManifest(root)

  write(root, 'src/editor/App.tsx', 'export function App() { return 1 }\n')
  fs.rmSync(path.join(root, 'shared', 'ui-tokens.css'))
  write(root, 'src/extra.ts', 'export {}\n')
  const { errors } = verifyKernelSource(root, manifest)

  assert.equal(errors.length, 1)
  assert.ok(errors[0].startsWith(maintainedBySyncMessage))
  assert.match(errors[0], /changed src\/editor\/App\.tsx/)
  assert.match(errors[0], /missing shared\/ui-tokens\.css/)
  assert.match(errors[0], /unlisted src\/extra\.ts/)
})

test('allows a registered local patch and only warns once it expires', () => {
  const repository = kernelRepository()
  const root = canvasRoot()
  assert.equal(sync(repository, 'kernel-1', root).status, 0)
  write(root, 'src/editor/App.tsx', 'export function App() { return 1 }\n')
  const manifest = {
    ...readManifest(root),
    localPatches: [{
      files: ['src/editor/App.tsx'],
      reason: '紧急修复',
      upstream: 'xufei5620/xingmang-canvas#99',
      registeredAt: '2026-11-01',
      expiresAt: '2026-11-15',
    }],
  }

  assert.deepEqual(verifyKernelSource(root, manifest, new Date('2026-11-15T12:00:00Z')), { errors: [], warnings: [] })
  const late = verifyKernelSource(root, manifest, new Date('2026-11-16T00:00:00Z'))
  assert.deepEqual(late.errors, [])
  assert.equal(late.warnings.length, 1)
  assert.match(late.warnings[0], /已过期/)
})

test('rejects a local patch without a reason, an upstream link or a deadline within two weeks', () => {
  const base = {
    repository: 'xingmang-canvas',
    tag: 'kernel-1',
    commit: 'a'.repeat(40),
    syncedAt: '2026-11-01T00:00:00.000Z',
    files: { 'src/main.tsx': 'b'.repeat(64) },
  }
  const patch = { files: ['src/main.tsx'], reason: '紧急修复', upstream: 'xufei5620/xingmang-canvas#99', registeredAt: '2026-11-01', expiresAt: '2026-11-15' }
  assert.deepEqual(manifestShapeErrors({ ...base, localPatches: [patch] }), [])
  for (const broken of [
    { ...patch, expiresAt: '2026-11-16' },
    { ...patch, expiresAt: '2026-10-31' },
    { ...patch, expiresAt: '2026-02-30' },
    { ...patch, reason: ' ' },
    { ...patch, upstream: '' },
    { ...patch, files: [] },
    { ...patch, files: ['index.html'] },
    { ...patch, files: ['src/../index.html'] },
    { ...patch, note: 'extra' },
  ]) {
    assert.notDeepEqual(manifestShapeErrors({ ...base, localPatches: [broken] }), [], JSON.stringify(broken))
  }
  assert.notDeepEqual(manifestShapeErrors({ ...base, localPatches: [], files: { 'vite.config.ts': 'b'.repeat(64) } }), [])
  assert.notDeepEqual(manifestShapeErrors({ ...base, localPatches: [], commit: 'main' }), [])
  assert.notDeepEqual(manifestShapeErrors({ ...base, localPatches: [], repository: 'other' }), [])
})
