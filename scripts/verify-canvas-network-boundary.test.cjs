const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

// 画布跑的是第三方前端代码，所有出网都在主进程完成（AGENTS.md I15、T13）。凭据写法由
// verify-canvas-renderer-boundary 守；这里守出网写法本身：画布源码和产物里不许出现站点接口
// 路径，fetch、XMLHttpRequest 这些只许出现在下面登记过的地方。真正拦住请求的是 index.html
// 的 CSP（connect-src 只放行 xingmang-asset:），这道门禁是让新增的出网代码在合并前就被看见。
//
// 换成 xingmang-canvas 内核以后（#1393），canvas-v2/ 由同步脚本维护，内核还会带进
// canvas-v2/shared/，两处一起扫。

const projectRoot = path.resolve(__dirname, '..')
const sourceRoots = ['canvas-v2/src', 'canvas-v2/shared']
const siteApiPath = /\/api\//g
const networkPrimitives = {
  fetch: /\bfetch\s*\(/g,
  XMLHttpRequest: /\bXMLHttpRequest\b/g,
  WebSocket: /\bWebSocket\b/g,
  EventSource: /\bEventSource\b/g,
  sendBeacon: /\bsendBeacon\b/g,
}

// 每条写明为什么它不算画布出网。次数要和文件里一模一样：多了是有人加了出网，少了说明这条该删。
const sourceAllowances = {
  'canvas-v2/src/components/MediaPreview.tsx': {
    counts: { fetch: 1 },
    reason: '画音频波形：先用 isLocalCanvasAssetUrl 确认是本地素材（xingmang-asset:），再读它的字节',
  },
  // 放宽：yoyo 10-28 亲手回「OpenCV放行同意」，只给这一个文件，个数钉死。
  'canvas-v2/src/vendor/opencv-grabcut/runtime/opencv-grabcut-2b3586b4fe00ea68120073e8902655b27997b6a61951074fd78a2df1ff74d6a5.js': {
    counts: { fetch: 1, XMLHttpRequest: 5 },
    reason: '随内核带进来的 OpenCV 抠图运行时（OpenCV 4.13.0 由 Emscripten 4.0.20 生成，WASM=0，来源见 docs/canvas-third-party.json）：这几处是 Emscripten 读外部文件用的通用代码，这份构建不读任何外部文件；画布 CSP 的 connect-src 只放行 xingmang-asset:，想连也连不出去',
  },
}

function codeFiles(directory, { includeTests }) {
  const result = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...codeFiles(candidate, { includeTests }))
    else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name) && (includeTests || !/\.test\./.test(entry.name))) result.push(candidate)
  }
  return result
}

function relative(file) {
  return path.relative(projectRoot, file).replaceAll('\\', '/')
}

function countMatches(content, pattern) {
  return content.match(pattern)?.length ?? 0
}

function primitiveCounts(content) {
  const counts = {}
  for (const [name, pattern] of Object.entries(networkPrimitives)) {
    const count = countMatches(content, pattern)
    if (count > 0) counts[name] = count
  }
  return counts
}

function existingSourceRoots() {
  return sourceRoots.map((root) => path.join(projectRoot, root)).filter((root) => fs.existsSync(root))
}

test('keeps site API paths and unregistered network calls out of the canvas source', () => {
  const seen = new Set()
  for (const root of existingSourceRoots()) {
    for (const file of codeFiles(root, { includeTests: false })) {
      const name = relative(file)
      const content = fs.readFileSync(file, 'utf8')
      assert.equal(countMatches(content, siteApiPath), 0, `${name} must not name a site API path; the canvas reaches every site through the host bridge`)
      const allowance = sourceAllowances[name]
      if (allowance) seen.add(name)
      assert.deepEqual(
        primitiveCounts(content),
        allowance?.counts ?? {},
        allowance
          ? `${name} no longer matches its registered network calls; update sourceAllowances with the reason`
          : `${name} makes a network call; the canvas sends every request through the host bridge (AGENTS.md I15)`,
      )
    }
  }
  assert.deepEqual(Object.keys(sourceAllowances).filter((name) => !seen.has(name)), [], 'remove allowances for files that no longer exist')
})

test('gives every registered canvas network call a reason', () => {
  for (const [name, allowance] of Object.entries(sourceAllowances)) {
    assert.ok(sourceRoots.some((root) => name.startsWith(`${root}/`)), `${name} is outside the scanned canvas source`)
    assert.ok(typeof allowance.reason === 'string' && allowance.reason.length > 0, `${name} needs a reason`)
    assert.ok(Object.keys(allowance.counts).every((primitive) => primitive in networkPrimitives), `${name} names an unknown primitive`)
  }
})

const canvasDist = path.join(projectRoot, 'dist-canvas')
// CI 在构建之后设它，产物缺了就算失败，不能悄悄跳过。
const distRequired = process.env.XINGMANG_REQUIRE_CANVAS_DIST === '1'

test('keeps the built canvas free of site API paths and of network calls the source does not register', { skip: !distRequired && !fs.existsSync(canvasDist) }, () => {
  assert.ok(fs.existsSync(canvasDist), 'dist-canvas is missing; build it with npm run canvas:prepare first')
  const files = [...codeFiles(canvasDist, { includeTests: true }), ...fs.readdirSync(canvasDist).filter((name) => name.endsWith('.html')).map((name) => path.join(canvasDist, name))]
  assert.ok(files.some((file) => /\.(?:js|mjs|cjs)$/.test(file)), 'dist-canvas must contain executable assets')
  const totals = {}
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8')
    assert.equal(countMatches(content, siteApiPath), 0, `${relative(file)} names a site API path`)
    for (const [primitive, count] of Object.entries(primitiveCounts(content))) totals[primitive] = (totals[primitive] ?? 0) + count
  }
  // The bundle merges source files, so compare totals: a dependency that
  // brings its own network call raises a total past what the source registers.
  const registered = {}
  for (const allowance of Object.values(sourceAllowances)) {
    for (const [primitive, count] of Object.entries(allowance.counts)) registered[primitive] = (registered[primitive] ?? 0) + count
  }
  assert.deepEqual(totals, registered, 'dist-canvas has network calls beyond the ones registered in the canvas source')
})
