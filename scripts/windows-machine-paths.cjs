const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Which directory is the real SystemRoot is decided once, in
// electron/windows-system-root.ts, and the client builds every machine path on
// the same file, so the PowerShell this gate trusts is the one the client
// would trust (#1225). The gate has to run without a compiled main process
// (npm run release:verify on a fresh checkout), so the file is loaded from
// source rather than from dist-electron/. It is a leaf on purpose: it may
// require node: built-ins and nothing else, and the loader refuses anything
// more. Loading waits for the first lookup, so an unsigned or non-Windows run
// never reads it.
const SHARED_SYSTEM_ROOT_SOURCE = path.join(__dirname, '..', 'electron', 'windows-system-root.ts')
let sharedSystemRootModule = null

function sharedSystemRoot() {
  if (sharedSystemRootModule) return sharedSystemRootModule
  const ts = require('typescript')
  const { outputText } = ts.transpileModule(fs.readFileSync(SHARED_SYSTEM_ROOT_SOURCE, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: SHARED_SYSTEM_ROOT_SOURCE,
  })
  const module = { exports: {} }
  vm.compileFunction(outputText, ['require', 'module', 'exports'], { filename: SHARED_SYSTEM_ROOT_SOURCE })(
    function requireBuiltin(id) {
      if (!id.startsWith('node:')) {
        throw new Error(`electron/windows-system-root.ts 只能引用 node: 内置模块，不能引用 ${id}`)
      }
      return require(id)
    },
    module,
    module.exports,
  )
  sharedSystemRootModule = module.exports
  return sharedSystemRootModule
}

function pathError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  return error
}

function resolveWindowsSystemRoot(options = {}) {
  const platform = options.platform || process.platform
  if (platform !== 'win32') {
    throw pathError('WINDOWS_PLATFORM_UNSUPPORTED', 'Windows 机器路径解析仅支持 Windows')
  }
  const shared = sharedSystemRoot()
  // The shared module takes strings only, which a real loader report is
  // filtered down to. A list handed in here has no such guarantee, and this
  // gate has always passed over entries that are not strings.
  const sharedObjects = options.sharedObjects
    ? options.sharedObjects.filter((entry) => typeof entry === 'string')
    : undefined
  try {
    return shared.resolveWindowsSystemRoot({
      platform,
      sharedObjects,
      realpathSystemRoot: options.realpathSystemRoot,
    })
  } catch (cause) {
    throw pathError(
      'WINDOWS_SYSTEM_ROOT_UNTRUSTED',
      '无法通过 Windows 核心模块或系统设备路径解析真实 SystemRoot',
      cause,
    )
  }
}

function pathWithinWindowsRoot(candidate, root) {
  return sharedSystemRoot().pathWithinWindowsRoot(candidate, root)
}

function resolveTrustedWindowsPowerShell(options = {}) {
  const systemRoot = resolveWindowsSystemRoot(options)
  const system32 = path.win32.join(systemRoot, 'System32')
  const candidate = path.win32.join(
    system32,
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const lstatSync = options.lstatSync || fs.lstatSync
  const realpathSync = options.realpathSync || fs.realpathSync.native
  try {
    const stats = lstatSync(candidate)
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('not a regular file')
    const executable = path.win32.normalize(realpathSync(candidate))
    if (!pathWithinWindowsRoot(executable, system32)) throw new Error('canonical path escaped System32')
    return { systemRoot, system32, executable }
  } catch (cause) {
    throw pathError(
      'TRUSTED_POWERSHELL_MISSING',
      '未找到可信的系统 Windows PowerShell，已停止发布签名校验',
      cause,
    )
  }
}

module.exports = {
  pathWithinWindowsRoot,
  resolveTrustedWindowsPowerShell,
  resolveWindowsSystemRoot,
}
