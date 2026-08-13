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

test('keeps the canvas renderer source free of credential-bearing request paths', () => {
  const files = sourceFiles(path.join(projectRoot, 'canvas-v2', 'src'))
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8')
    for (const pattern of forbidden) assert.doesNotMatch(content, pattern, `${path.relative(projectRoot, file)} violates the renderer boundary`)
  }
})

test('keeps the built canvas renderer free of credential-bearing request paths', { skip: !fs.existsSync(path.join(projectRoot, 'dist-canvas')) }, () => {
  const files = sourceFiles(path.join(projectRoot, 'dist-canvas'))
  assert.ok(files.length > 0, 'dist-canvas must contain executable assets')
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8')
    for (const pattern of forbidden) assert.doesNotMatch(content, pattern, `${path.relative(projectRoot, file)} violates the renderer boundary`)
  }
})
