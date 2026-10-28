const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const projectRoot = path.resolve(__dirname, '..')
const forbidden = [
  /Authorization\s*:/i,
  /Bearer\s+\$\{/i,
  /\.apiKey\b/i,
  /\bgetAuthToken\b/i,
  /\bgetAccessToken\b/i,
  /\bgetRefreshToken\b/i,
]

function sourceFiles(directory) {
  const result = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...sourceFiles(candidate))
    else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) result.push(candidate)
  }
  return result
}

// canvas-v2/shared/ comes with the xingmang-canvas kernel (#1393) and is
// canvas renderer source like canvas-v2/src/.
const sourceRoots = ['src', 'shared']
  .map((name) => path.join(projectRoot, 'canvas-v2', name))
  .filter((root) => fs.existsSync(root))

test('keeps the canvas renderer source free of credential-bearing request paths', () => {
  const files = sourceRoots.flatMap((root) => sourceFiles(root))
  assert.ok(files.length > 0, 'canvas-v2/src must contain source files')
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8')
    for (const pattern of forbidden) assert.doesNotMatch(content, pattern, `${path.relative(projectRoot, file)} violates the renderer boundary`)
  }
})

// The main window's AI pages follow the same rule as the canvas (I15): every
// relay request, and the key it carries, stays in the main process. The video
// studio also runs a third-party muxer in a worker thread, so a page or worker
// that grows its own credential-bearing request must fail here, not in review.
test('keeps the main window video studio and chat pages free of credential-bearing request paths', () => {
  const directories = ['video-studio', 'chat'].map((name) => path.join(projectRoot, 'src', 'renderer-v2', 'features', name))
  const files = directories.flatMap((directory) => sourceFiles(directory))
  assert.ok(files.some((file) => file.endsWith('compose-worker.ts')), 'the video studio worker must be scanned')
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8')
    for (const pattern of forbidden) assert.doesNotMatch(content, pattern, `${path.relative(projectRoot, file)} violates the renderer boundary`)
  }
})

// CI sets this after building, so a missing build fails instead of skipping.
const distRequired = process.env.XINGMANG_REQUIRE_CANVAS_DIST === '1'

test('keeps the built canvas renderer free of credential-bearing request paths', { skip: !distRequired && !fs.existsSync(path.join(projectRoot, 'dist-canvas')) }, () => {
  const files = sourceFiles(path.join(projectRoot, 'dist-canvas'))
  assert.ok(files.length > 0, 'dist-canvas must contain executable assets')
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8')
    for (const pattern of forbidden) assert.doesNotMatch(content, pattern, `${path.relative(projectRoot, file)} violates the renderer boundary`)
  }
})
