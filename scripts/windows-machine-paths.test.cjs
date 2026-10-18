const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')
const releaseCopy = require('./windows-machine-paths.cjs')

const projectRoot = path.resolve(__dirname, '..')

// 发版校验（verify-release-artifacts.cjs）要在没编译主程序时也能跑，以前自带一份「Windows
// 系统目录在哪」的解析，抄自 electron/windows-machine-paths.ts，两份在核心模块路径带 NUL 时
// 认法不同（#1225）。现在两边都用 electron/windows-system-root.ts 这一份：客户端照常 import，
// 发版脚本从源码现转。这里仍给两个入口喂同一组输入、比结果，再把结果钉成绝对值，防的是哪天
// 有一边绕开了共用的那份、或者共用的那份悄悄改了认法。

// The client copy reaches the object manager through fs.realpathSync.native
// with no injection point of its own, so it is loaded with an fs whose native
// realpath answers from the same stub the release copy is handed. On the paths
// exercised here that is the only native realpath the client makes, so every
// call it records is an object-manager lookup. Everything else is the real
// module, transpiled from source so the suite needs no prior compile.
const objectManager = { answer: unavailable, asked: [] }
const clientFs = {
  ...fs,
  realpathSync: Object.assign(function realpathSync(...args) {
    return fs.realpathSync(...args)
  }, {
    native(candidate) {
      objectManager.asked.push(candidate)
      return objectManager.answer()
    },
  }),
}
const clientModules = new Map()

function clientModule(name) {
  if (clientModules.has(name)) return clientModules.get(name)
  assert.ok(['windows-machine-paths', 'windows-system-root', 'powershell-module-imports'].includes(name), name)
  const file = path.join(projectRoot, 'electron', `${name}.ts`)
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  clientModules.set(name, module.exports)
  vm.compileFunction(compiled, ['require', 'module', 'exports'], { filename: file })(
    (id) => id.startsWith('./') ? clientModule(id.slice(2)) : id === 'node:fs' ? clientFs : require(id),
    module,
    module.exports,
  )
  return module.exports
}

const clientCopy = clientModule('windows-machine-paths')

function unavailable() {
  throw Object.assign(new Error('object manager unavailable'), { code: 'ENOENT' })
}

// Known folders come from the registry in the client and are not part of the
// release copy at all; pinning them keeps SystemRoot the only thing that can
// make the client refuse.
const fixedKnownFolders = { programFiles: 'C:\\Program Files', programData: 'C:\\ProgramData' }

function releaseSystemRoot(sharedObjects, answer) {
  const asked = []
  try {
    const systemRoot = releaseCopy.resolveWindowsSystemRoot({
      platform: 'win32',
      sharedObjects,
      realpathSystemRoot(candidate) {
        asked.push(candidate)
        return answer()
      },
    })
    return { systemRoot, asked }
  } catch {
    return { refused: true, asked }
  }
}

function clientMachinePaths(sharedObjects, answer) {
  objectManager.asked = []
  objectManager.answer = answer
  return clientCopy.resolveWindowsMachinePaths({
    platform: 'win32',
    sharedObjects,
    resolveKnownFolders: () => fixedKnownFolders,
  })
}

function clientSystemRoot(sharedObjects, answer) {
  try {
    const { systemRoot } = clientMachinePaths(sharedObjects, answer)
    return { systemRoot, asked: objectManager.asked }
  } catch {
    return { refused: true, asked: objectManager.asked }
  }
}

// What a loader report (process.report sharedObjects) can look like. undefined
// makes both copies read this very process's report: on the Windows runner
// that is the real ntdll.dll and kernel32.dll, elsewhere it holds neither and
// both fall back to the object manager.
const loaderReports = {
  'the real process report': undefined,
  'nothing loaded': [],
  'both core modules': ['C:\\Windows\\System32\\ntdll.dll', 'C:\\Windows\\System32\\kernel32.dll'],
  'mixed case': ['D:\\Windows\\SYSTEM32\\NTDLL.DLL', 'D:\\WINDOWS\\System32\\kernel32.dll'],
  'forward slashes': ['C:/Windows/System32/ntdll.dll', 'C:/Windows/System32/kernel32.dll'],
  'dot segments': ['C:\\Windows\\.\\System32\\ntdll.dll', 'C:\\Windows\\.\\System32\\kernel32.dll'],
  'a parent segment in only one of the pair': [
    'C:\\Windows\\System32\\ntdll.dll',
    'C:\\Temp\\..\\Windows\\System32\\kernel32.dll',
  ],
  'a trailing space on the root': ['C:\\Windows \\System32\\ntdll.dll', 'C:\\Windows \\System32\\kernel32.dll'],
  'a UNC root': ['\\\\host\\share\\System32\\ntdll.dll', '\\\\host\\share\\System32\\kernel32.dll'],
  'a device-prefixed root': ['\\\\?\\C:\\Windows\\System32\\ntdll.dll', '\\\\?\\C:\\Windows\\System32\\kernel32.dll'],
  'a Windows directory at the drive root': ['C:\\System32\\ntdll.dll', 'C:\\System32\\kernel32.dll'],
  'only ntdll': ['C:\\Windows\\System32\\ntdll.dll'],
  'only kernel32': ['C:\\Windows\\System32\\kernel32.dll'],
  'the pair split across roots': ['C:\\Windows\\System32\\ntdll.dll', 'E:\\Other\\System32\\kernel32.dll'],
  'two complete pairs': [
    'E:\\Other\\System32\\ntdll.dll',
    'E:\\Other\\System32\\kernel32.dll',
    'C:\\Windows\\System32\\ntdll.dll',
    'C:\\Windows\\System32\\kernel32.dll',
  ],
  'the pair outside System32': ['C:\\Windows\\SysWOW64\\ntdll.dll', 'C:\\Windows\\SysWOW64\\kernel32.dll'],
  'a look-alike System32': ['C:\\Windows\\System32x\\ntdll.dll', 'C:\\Windows\\System32x\\kernel32.dll'],
  'a look-alike kernel32': [
    'C:\\Windows\\System32\\ntdll.dll',
    'C:\\Windows\\System32\\kernelbase.dll',
    'C:\\Windows\\System32\\kernel32.dll.mui',
  ],
  'a look-alike ntdll': ['C:\\Windows\\System32\\ntdll.dll.mui', 'C:\\Windows\\System32\\kernel32.dll'],
  'relative module paths': ['Windows\\System32\\ntdll.dll', 'Windows\\System32\\kernel32.dll'],
  'decoys around the pair': [
    'C:\\Program Files\\App\\app.exe',
    'C:\\Windows\\System32\\ntdll.dll',
    'C:\\Program Files\\App\\kernel32.dll',
    'C:\\Windows\\System32\\KERNELBASE.dll',
    'C:\\Windows\\System32\\kernel32.dll',
  ],
}

// What the object manager (\\?\GLOBALROOT\SystemRoot) can answer when the
// loader report does not settle SystemRoot.
const objectManagerAnswers = {
  unavailable,
  'a plain directory': () => 'E:\\Windows',
  'a trailing separator': () => 'E:\\Windows\\',
  'surrounding whitespace': () => '  E:\\Windows  ',
  'a device-prefixed path': () => '\\\\?\\E:\\Windows',
  'a drive root': () => 'E:\\',
  'a relative path': () => 'Windows',
  'an empty answer': () => '',
  'an embedded NUL': () => 'E:\\Win\0dows',
}

test('both copies settle on the same SystemRoot for every loader report and object-manager answer', () => {
  const seen = new Set()
  for (const [report, sharedObjects] of Object.entries(loaderReports)) {
    for (const [answerName, answer] of Object.entries(objectManagerAnswers)) {
      const release = releaseSystemRoot(sharedObjects, answer)
      const client = clientSystemRoot(sharedObjects, answer)
      assert.deepEqual(client, release, `${report} / object manager: ${answerName}`)
      seen.add(release.refused ? 'refused' : release.asked.length ? 'object manager' : 'loader report')
    }
  }
  // Guards the comparison itself: a loader that broke both copies the same way
  // would otherwise pass by refusing everything.
  assert.deepEqual([...seen].sort(), ['loader report', 'object manager', 'refused'])
})

// The comparison above only says the two copies agree; this pins what they
// agree on, so that folding them into one cannot quietly move the answer for
// both at once. Each loader report either settles SystemRoot by itself (the
// root, or 'refused') without asking the object manager, or settles nothing
// (null) and leaves it to the object manager, whose answer is then held to the
// same check. The real process report is left out: off Windows it settles
// nothing, on the Windows runner it names the runner's own root.
const settledByLoaderReport = {
  'nothing loaded': null,
  'both core modules': 'C:\\Windows',
  'mixed case': 'D:\\WINDOWS',
  'forward slashes': 'C:\\Windows',
  'dot segments': 'C:\\Windows',
  'a parent segment in only one of the pair': null,
  'a trailing space on the root': 'C:\\Windows',
  'a UNC root': '\\\\host\\share',
  'a device-prefixed root': '\\\\?\\C:\\Windows',
  'a Windows directory at the drive root': 'C:',
  'only ntdll': null,
  'only kernel32': null,
  'the pair split across roots': null,
  'two complete pairs': 'E:\\Other',
  'the pair outside System32': null,
  'a look-alike System32': null,
  'a look-alike kernel32': null,
  'a look-alike ntdll': null,
  'relative module paths': null,
  'decoys around the pair': 'C:\\Windows',
}

const settledByObjectManager = {
  unavailable: 'refused',
  'a plain directory': 'E:\\Windows',
  'a trailing separator': 'E:\\Windows',
  'surrounding whitespace': 'E:\\Windows',
  'a device-prefixed path': '\\\\?\\E:\\Windows',
  'a drive root': 'E:',
  'a relative path': 'refused',
  'an empty answer': 'refused',
  'an embedded NUL': 'refused',
}

function expectedOutcome(report, answerName) {
  const settled = settledByLoaderReport[report]
  const outcome = settled === null ? settledByObjectManager[answerName] : settled
  const asked = settled === null ? ['\\\\?\\GLOBALROOT\\SystemRoot'] : []
  return outcome === 'refused' ? { refused: true, asked } : { systemRoot: outcome, asked }
}

test('the client settles SystemRoot where it always has for every loader report and object-manager answer', () => {
  assert.deepEqual(
    Object.keys(settledByLoaderReport),
    Object.keys(loaderReports).filter((report) => report !== 'the real process report'),
  )
  assert.deepEqual(Object.keys(settledByObjectManager), Object.keys(objectManagerAnswers))
  for (const report of Object.keys(settledByLoaderReport)) {
    for (const [answerName, answer] of Object.entries(objectManagerAnswers)) {
      assert.deepEqual(
        clientSystemRoot(loaderReports[report], answer),
        expectedOutcome(report, answerName),
        `${report} / object manager: ${answerName}`,
      )
    }
  }
})

test('both copies consult the same object-manager device path', () => {
  const release = releaseSystemRoot([], () => 'E:\\Windows')
  const client = clientSystemRoot([], () => 'E:\\Windows')
  assert.deepEqual(release.asked, ['\\\\?\\GLOBALROOT\\SystemRoot'])
  assert.deepEqual(client.asked, release.asked)
})

// The release copy goes on to lstat and realpath the executable before it
// trusts it; those checks have no client counterpart and are covered in
// verify-release-artifacts.test.cjs. Here they are stubbed to pass so only the
// System32 and PowerShell paths each copy derives are compared.
test('both copies derive System32 and the system PowerShell from SystemRoot the same way', () => {
  const resolvedRoots = {
    'both core modules': loaderReports['both core modules'],
    'mixed case': loaderReports['mixed case'],
    'forward slashes': loaderReports['forward slashes'],
    'a trailing space on the root': loaderReports['a trailing space on the root'],
    'a UNC root': loaderReports['a UNC root'],
    'a device-prefixed root': loaderReports['a device-prefixed root'],
    'a Windows directory at the drive root': loaderReports['a Windows directory at the drive root'],
    'the object-manager fallback': [],
  }
  for (const [name, sharedObjects] of Object.entries(resolvedRoots)) {
    const answer = objectManagerAnswers['a trailing separator']
    const release = releaseCopy.resolveTrustedWindowsPowerShell({
      platform: 'win32',
      sharedObjects,
      realpathSystemRoot: answer,
      lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
      realpathSync: (candidate) => candidate,
    })
    const machinePaths = clientMachinePaths(sharedObjects, answer)
    const probe = clientCopy.buildProgramFilesAclProbe(
      path.win32.join(machinePaths.programFiles, 'App'),
      machinePaths.programFiles,
      machinePaths,
    )
    assert.deepEqual({
      systemRoot: machinePaths.systemRoot,
      system32: machinePaths.system32,
      executable: probe.file,
    }, release, name)
  }
})

test('both copies draw the same System32 containment line', () => {
  const paths = [
    'C:\\Windows\\System32',
    'C:\\Windows\\System32\\',
    'c:\\windows\\system32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    'C:\\Windows\\System32x\\powershell.exe',
    'C:\\Windows\\System32\\..\\System32x\\powershell.exe',
    'C:\\Windows\\System32\\\\WindowsPowerShell',
    'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe',
    'D:\\Windows\\System32\\powershell.exe',
    '\\\\?\\C:\\Windows\\System32\\powershell.exe',
    '\\\\host\\share\\System32\\powershell.exe',
    '\\\\host\\share\\System32',
    'C:\\Users\\someone\\powershell.exe',
    'Windows\\System32\\powershell.exe',
    'C:System32\\powershell.exe',
    'C:\\',
    'C:',
    '',
  ]
  for (const candidate of paths) {
    for (const root of paths) {
      assert.equal(
        clientCopy.pathWithinWindowsRoot(candidate, root),
        releaseCopy.pathWithinWindowsRoot(candidate, root),
        `${JSON.stringify(candidate)} within ${JSON.stringify(root)}`,
      )
    }
  }
})

test('both copies refuse to resolve SystemRoot off Windows', () => {
  const sharedObjects = loaderReports['both core modules']
  for (const platform of ['darwin', 'linux']) {
    assert.throws(() => releaseCopy.resolveWindowsSystemRoot({ platform, sharedObjects }), Error, platform)
    assert.throws(() => clientCopy.resolveWindowsMachinePaths({
      platform,
      sharedObjects,
      resolveKnownFolders: () => fixedKnownFolders,
    }), Error, platform)
  }
})

// A real loader report is filtered down to strings before either copy reads
// it, so only a hand-built list can hold anything else. The release gate has
// always passed over such entries; it keeps doing so in front of the shared
// module, which is typed for strings only.
test('the release gate passes over loader entries that are not strings', () => {
  const pair = loaderReports['both core modules']
  for (const sharedObjects of [[42, ...pair], [null, ...pair], [...pair, {}]]) {
    assert.deepEqual(releaseSystemRoot(sharedObjects, objectManagerAnswers['a plain directory']), {
      systemRoot: 'C:\\Windows',
      asked: [],
    })
  }
})

test('the client refuses a core-module pair under a NUL root without asking the object manager', () => {
  const sharedObjects = ['C:\\Win\0dows\\System32\\ntdll.dll', 'C:\\Win\0dows\\System32\\kernel32.dll']
  for (const [answerName, answer] of Object.entries(objectManagerAnswers)) {
    assert.deepEqual(clientSystemRoot(sharedObjects, answer), { refused: true, asked: [] }, answerName)
  }
})

// A loader report cannot hold a NUL on a real machine, so this never mattered
// in practice, but it is where the two copies used to part: the release copy
// rejected the NUL root inside its derivation and fell back to the object
// manager, while the client refuses it outright. The client's answer stands
// (#1225): a root the core modules do name is not traded for a second opinion.
test('both copies treat a core-module pair under a NUL root the same way', () => {
  const sharedObjects = ['C:\\Win\0dows\\System32\\ntdll.dll', 'C:\\Win\0dows\\System32\\kernel32.dll']
  for (const [answerName, answer] of Object.entries(objectManagerAnswers)) {
    assert.deepEqual(
      clientSystemRoot(sharedObjects, answer),
      releaseSystemRoot(sharedObjects, answer),
      `object manager: ${answerName}`,
    )
  }
})
