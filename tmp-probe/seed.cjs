// 临时探测：照客户端那样替 Claude Desktop 放程序，打印每一步的日志和结果。
const os = require('node:os')
const seed = require('../dist-electron/claude-desktop-code-seed.js')

async function main() {
  const [installationPath, profile] = process.argv.slice(2)
  let lastPercent = -1
  const seeder = seed.createClaudeDesktopCodeSeeder({
    platform: 'win32',
    architecture: 'x64',
    executionMode: 'same-user',
    fetch: globalThis.fetch,
    userHome: os.homedir(),
    resolveProfileDirectory: async () => profile,
    onProgress: (event) => {
      const percent = event.total ? Math.floor(event.transferred * 100 / event.total / 10) * 10 : -1
      if (percent !== lastPercent) { lastPercent = percent; console.log('progress', JSON.stringify(event)) }
    },
    log: (level, event, message, detail) => console.log(level, event, message, JSON.stringify(detail ?? {})),
  })
  const started = Date.now()
  const outcome = await seeder.prepare({ path: installationPath, running: false, isRunning: async () => false })
  console.log('outcome', JSON.stringify(outcome), 'ms', Date.now() - started)
  if (outcome.status === 'skipped') process.exitCode = 1
}

main()
