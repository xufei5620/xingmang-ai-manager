const assert = require('node:assert/strict')
const test = require('node:test')
const {
  deriveWindowsSystemRoot,
  resolveTrustedWindowsPowerShell,
} = require('./windows-machine-paths.cjs')
const { verifyAuthenticode } = require('./verify-release-artifacts.cjs')

const sharedObjects = [
  'D:\\Windows\\SYSTEM32\\ntdll.dll',
  'D:\\Windows\\System32\\KERNEL32.DLL',
]

test('derives SystemRoot from loaded core modules instead of polluted environment variables', () => {
  const previousSystemRoot = process.env.SystemRoot
  const previousWindir = process.env.WINDIR
  process.env.SystemRoot = 'E:\\attacker\\Windows'
  process.env.WINDIR = 'E:\\attacker\\Windows'
  try {
    assert.equal(deriveWindowsSystemRoot(sharedObjects), 'D:\\Windows')
    const resolved = resolveTrustedWindowsPowerShell({
      platform: 'win32',
      sharedObjects,
      lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
      realpathSync: (candidate) => candidate,
    })
    assert.deepEqual(resolved, {
      systemRoot: 'D:\\Windows',
      system32: 'D:\\Windows\\System32',
      executable: 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    })
  } finally {
    if (previousSystemRoot === undefined) delete process.env.SystemRoot
    else process.env.SystemRoot = previousSystemRoot
    if (previousWindir === undefined) delete process.env.WINDIR
    else process.env.WINDIR = previousWindir
  }
})

test('verifier launches only the resolved system PowerShell with a minimal trusted environment', () => {
  let invocation = null
  verifyAuthenticode('D:\\release\\setup.exe', 'Example Publisher', {
    platform: 'win32',
    resolvePowerShell: () => ({
      systemRoot: 'D:\\Windows',
      system32: 'D:\\Windows\\System32',
      executable: 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    }),
    spawnSync: (executable, argv, options) => {
      invocation = { executable, argv, options }
      return {
        status: 0,
        stdout: JSON.stringify({ Status: 'Valid', Subject: 'CN=Example Publisher, O=Example' }),
        stderr: '',
      }
    },
  })

  assert.equal(
    invocation.executable,
    'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  )
  assert.equal(invocation.options.env.SystemRoot, 'D:\\Windows')
  assert.equal(invocation.options.env.WINDIR, 'D:\\Windows')
  assert.equal(invocation.options.env.PATH, 'D:\\Windows\\System32')
  assert.equal(invocation.options.env.XINGMANG_SIGNATURE_TARGET, 'D:\\release\\setup.exe')
  assert.match(invocation.options.env.XINGMANG_SECURITY_MODULE, /^D:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\Modules\\/i)
  assert.equal(invocation.options.env.NODE_OPTIONS, undefined)
  assert.equal(invocation.options.env.npm_config_userconfig, undefined)
  assert.equal(invocation.options.env.PSModulePath, '')
  assert.match(invocation.argv.at(-1), /Microsoft\.PowerShell\.Security\\Get-AuthenticodeSignature/)
})

test('matches DN-form expected publishers attribute by attribute like the runtime verifier', () => {
  const withSubject = (subject) => ({
    platform: 'win32',
    resolvePowerShell: () => ({
      systemRoot: 'D:\\Windows',
      system32: 'D:\\Windows\\System32',
      executable: 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    }),
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({ Status: 'Valid', Subject: subject }),
      stderr: '',
    }),
  })

  assert.doesNotThrow(() => verifyAuthenticode(
    'D:\\release\\setup.exe',
    'CN=Example Publisher, O=Example',
    withSubject('CN=Example Publisher, O=Example, C=CN'),
  ))
  assert.throws(() => verifyAuthenticode(
    'D:\\release\\setup.exe',
    'CN=Example Publisher, O=Another Org',
    withSubject('CN=Example Publisher, O=Example'),
  ), { code: 'INSTALLER_PUBLISHER_MISMATCH' })
  assert.throws(() => verifyAuthenticode(
    'D:\\release\\setup.exe',
    'Other Publisher',
    withSubject('CN=Example Publisher, O=Example'),
  ), { code: 'INSTALLER_PUBLISHER_MISMATCH' })
})

test('fails closed when no trusted PowerShell exists', () => {
  assert.throws(() => resolveTrustedWindowsPowerShell({
    platform: 'win32',
    sharedObjects,
    lstatSync: () => {
      const error = new Error('missing')
      error.code = 'ENOENT'
      throw error
    },
  }), {
    code: 'TRUSTED_POWERSHELL_MISSING',
    message: /未找到可信的系统 Windows PowerShell/,
  })

  let spawned = false
  assert.throws(() => verifyAuthenticode('D:\\release\\setup.exe', null, {
    platform: 'win32',
    resolvePowerShell: () => {
      const error = new Error('no trusted PowerShell')
      error.code = 'TRUSTED_POWERSHELL_MISSING'
      throw error
    },
    spawnSync: () => {
      spawned = true
    },
  }), { code: 'TRUSTED_POWERSHELL_MISSING' })
  assert.equal(spawned, false)
})

test('rejects a PowerShell canonical path that escapes System32', () => {
  assert.throws(() => resolveTrustedWindowsPowerShell({
    platform: 'win32',
    sharedObjects,
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
    realpathSync: () => 'C:\\Users\\attacker\\powershell.exe',
  }), { code: 'TRUSTED_POWERSHELL_MISSING' })
})
