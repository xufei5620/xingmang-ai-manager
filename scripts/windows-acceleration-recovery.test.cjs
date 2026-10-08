const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const recoveryPath = path.resolve(__dirname, 'windows-acceleration-recovery.ps1')
const productProxyPath = path.resolve(__dirname, '..', 'electron', 'platform', 'windows-system-proxy.ts')

// The C# type definition, then Read-State through the end of Same-State, found after `from`.
function compiledProxyHelpers(file, from = '') {
  // The .ps1 is checked out with CRLF (.gitattributes) and the .ts with the platform default.
  const source = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
  const start = source.indexOf("Add-Type -TypeDefinition @'", source.indexOf(from))
  const end = source.indexOf("\n'@", start)
  const first = source.indexOf('\nfunction Read-State {', end)
  const last = source.indexOf('\nfunction Same-State(', first)
  const close = source.indexOf('\n}\n', last)
  assert.ok(source.includes(from) && start >= 0 && end > start && first > end && last > first && close > last, 'WinInet helper not found')
  return { typeDefinition: source.slice(start, end), stateFunctions: source.slice(first + 1, close + 2) }
}

test('customer recovery source is UTF-8 without BOM and remains readable in Windows PowerShell 5.1', () => {
  const bytes = fs.readFileSync(recoveryPath)
  assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'efbbbf')
  assert.ok([...bytes].every((value) => value < 128))
})

// The script's restore logic is driven for real by e2e/windows-powershell-probes-smoke.mjs in the
// Windows packaging job, beside the other real PowerShell checks; scripts/ci-workflow-config.test.cjs
// keeps the unit suites from starting powershell.exe. It used to run here, in the node --test shard beside dozens of other suites,
// where a cold Windows PowerShell start ran out its 30 seconds (#782) without a single check
// failing. The WinInet helper itself is compiled and driven against the real system proxy by
// windows-uninstall-smoke.yml, which dot-sources this script and runs on every change to it or
// to windows-system-proxy.ts. The app falls back to the same text when its in-memory WinInet
// declaration fails (windowsSystemProxyCompiledScript), and this keeps the two in step.
test('customer recovery carries the same WinInet helper and state functions the app falls back to', () => {
  const recovery = compiledProxyHelpers(recoveryPath)
  const product = compiledProxyHelpers(productProxyPath, 'export const windowsSystemProxyCompiledScript')
  assert.equal(recovery.typeDefinition, product.typeDefinition)
  assert.equal(recovery.stateFunctions, product.stateFunctions)
  assert.match(recovery.typeDefinition, /public static class XingmangWinInet/)
  assert.match(recovery.stateFunctions, /^function Write-State\(\$state\) \{$/m)
  assert.match(recovery.stateFunctions, /^function Same-State\(\$left,\$right\) \{$/m)
})
