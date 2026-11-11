const fs = require('node:fs')
const path = require('node:path')

// canvas:prepare 用的是根目录的依赖，CI 和发布从来不装 canvas-v2/ 自己那份锁文件；
// 它只服务于有人照 canvas-v2/README.md 单独装依赖开发。所以它的每一项都从根目录锁文件里
// 原样裁出来（同一位置、同一版本、同一地址和 SHA-512），不另外解析：根目录那份过了
// audit:ci 的官方源检查和漏洞审计，裁出来的就是审过的那一套，单独装出来的画布也跟发出去的一样。
// 以前这份锁是另外解析的，100 项里 88 项来自国内镜像，React 还是 18（D102）。

function resolveLocation(packages, from, name) {
  let base = from
  for (;;) {
    const candidate = `${base ? `${base}/` : ''}node_modules/${name}`
    if (packages[candidate] && packages[candidate].link !== true) return candidate
    if (!base) return null
    const index = base.lastIndexOf('/node_modules/')
    base = index === -1 ? '' : base.slice(0, index)
  }
}

// What a fresh install of the manifest pulls in: dependencies, optionalDependencies and
// required peers. Optional peers are left out, as npm leaves them out; npm also lists
// every platform's optional binary, so those stay even when they never install here.
function collectReachableLocations(packages, manifest) {
  const reached = new Set()
  const pending = []
  function reach(from, name, optional) {
    const location = resolveLocation(packages, from, name)
    if (!location) {
      if (optional) return
      throw new Error(`根目录锁文件里找不到 ${name}（${from || '画布清单'}要用），先在根目录装上它`)
    }
    if (reached.has(location)) return
    reached.add(location)
    pending.push(location)
  }
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) reach('', name, false)
  while (pending.length) {
    const location = pending.shift()
    const entry = packages[location]
    for (const name of Object.keys(entry.dependencies ?? {})) reach(location, name, false)
    for (const name of Object.keys(entry.optionalDependencies ?? {})) reach(location, name, true)
    const peerMeta = entry.peerDependenciesMeta ?? {}
    for (const name of Object.keys(entry.peerDependencies ?? {})) {
      if (peerMeta[name]?.optional !== true) reach(location, name, false)
    }
  }
  return reached
}

function buildCanvasLockfile(rootLock, manifest) {
  const packages = rootLock?.packages
  if (rootLock?.lockfileVersion !== 3 || !packages || typeof packages !== 'object') {
    throw new Error('根目录 package-lock.json 不是 npm lockfileVersion 3')
  }
  const root = { name: manifest.name, version: manifest.version }
  if (manifest.dependencies) root.dependencies = manifest.dependencies
  if (manifest.devDependencies) root.devDependencies = manifest.devDependencies
  const lockfile = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: { '': root },
  }
  // The dev / optional flags still describe the root tree; npm recomputes them for the
  // canvas tree in the second step the command line prints.
  for (const location of [...collectReachableLocations(packages, manifest)].sort()) {
    lockfile.packages[location] = { ...packages[location] }
  }
  return lockfile
}

if (require.main === module) {
  const projectRoot = path.resolve(__dirname, '..')
  const rootLock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'))
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'canvas-v2', 'package.json'), 'utf8'))
  const lockfile = buildCanvasLockfile(rootLock, manifest)
  fs.writeFileSync(path.join(projectRoot, 'canvas-v2', 'package-lock.json'), `${JSON.stringify(lockfile, null, 2)}\n`)
  console.log(`已从根目录锁文件裁出 ${Object.keys(lockfile.packages).length - 1} 项写进 canvas-v2/package-lock.json`)
  console.log('接着在 canvas-v2 里跑一次，让 npm 按画布自己的依赖重算 dev / optional 标记（不会改版本）：')
  console.log('  npm install --package-lock-only --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/')
}

module.exports = {
  buildCanvasLockfile,
}
