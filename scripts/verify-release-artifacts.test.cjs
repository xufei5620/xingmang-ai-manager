const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createHash } = require('node:crypto')
const { gzipSync } = require('node:zlib')
const { spawnSync } = require('node:child_process')
const YAML = require('yaml')
const {
  deriveWindowsSystemRoot,
  resolveTrustedWindowsPowerShell,
} = require('./windows-machine-paths.cjs')
const { verifyAuthenticode } = require('./verify-release-artifacts.cjs')

const packageVersion = require('../package.json').version

async function createUnsignedReleaseFixture(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xingmang-unsigned-release-'))
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }))
  const fileName = `XingMang-AI-Manager-${packageVersion}-Setup.exe`
  const contents = Buffer.from('unsigned-installer-fixture')
  const sha512 = createHash('sha512').update(contents).digest('base64')
  await fs.promises.writeFile(path.join(directory, fileName), contents)
  await fs.promises.writeFile(path.join(directory, `${fileName}.blockmap`), gzipSync(Buffer.from(JSON.stringify({
    version: '2',
    files: [{ name: 'file', offset: 0, checksums: ['YWJjZA=='], sizes: [4] }],
  }))))
  await fs.promises.writeFile(path.join(directory, 'latest.yml'), YAML.stringify({
    version: packageVersion,
    files: [{ url: fileName, sha512, size: contents.length }],
    path: fileName,
    sha512,
    releaseDate: '2026-09-18T00:00:00.000Z',
  }))
  return directory
}

function runVerifier(directory, environment) {
  return spawnSync(process.execPath, [path.join(__dirname, 'verify-release-artifacts.cjs'), directory], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, XINGMANG_RELEASE: '', XINGMANG_UNSIGNED_RELEASE: '', ...environment },
  })
}

// M-01 并入的《发版前检查清单》缺口:无签名模式下 release:verify 必挂,于是
// latest.yml 结构、文件大小、SHA-512 和 blockmap 的本地校验没有任何可用入口。
test('the unsigned mode verifies every artifact check except the signature', async (t) => {
  const directory = await createUnsignedReleaseFixture(t)
  const result = runVerifier(directory, { XINGMANG_UNSIGNED_RELEASE: '1' })

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /跳过 Authenticode 签名校验/)
  assert.match(result.stdout, new RegExp(`发布产物校验通过：v${packageVersion.replace(/\./g, '\\.')}`))
  assert.match(result.stdout, /个未签名安装程序/)
})

test('the unsigned mode still fails on a corrupted installer hash', async (t) => {
  const directory = await createUnsignedReleaseFixture(t)
  const installer = (await fs.promises.readdir(directory)).find((name) => name.endsWith('.exe'))
  await fs.promises.writeFile(path.join(directory, installer), Buffer.from('tampered-installer-fixture'))
  const result = runVerifier(directory, { XINGMANG_UNSIGNED_RELEASE: '1' })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /LOCAL_ARTIFACT_(?:HASH_MISMATCH|SIZE_MISMATCH)/)
})

test('the default mode still demands a signature check rather than silently passing', async (t) => {
  const directory = await createUnsignedReleaseFixture(t)
  const result = runVerifier(directory, {})

  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stdout, /发布产物校验通过/)
})

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

test('warns on bare-CN fallback matches without changing the verdict', () => {
  const withSubject = (subject, warn) => ({
    platform: 'win32',
    warn,
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

  const warnings = []
  const capture = (message) => warnings.push(message)
  assert.doesNotThrow(() => verifyAuthenticode(
    'D:\\release\\setup.exe',
    'Example Publisher',
    withSubject('CN=Example Publisher, O=Example', capture),
  ))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /裸公司名\(CN\)/)
  assert.match(warnings[0], /IMPROVEMENT-PLAN\.md 3\.4/)

  warnings.length = 0
  assert.doesNotThrow(() => verifyAuthenticode(
    'D:\\release\\setup.exe',
    'CN=Example Publisher, O=Example',
    withSubject('CN=Example Publisher, O=Example, C=CN', capture),
  ))
  assert.equal(warnings.length, 0)
})

test('refuses to verify an installer when no expected publisher is configured', () => {
  const validlySigned = {
    platform: 'win32',
    resolvePowerShell: () => ({
      systemRoot: 'D:\\Windows',
      system32: 'D:\\Windows\\System32',
      executable: 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    }),
    // A signature that is valid but issued to somebody else entirely.
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({ Status: 'Valid', Subject: 'CN=Some Other Company, O=Attacker' }),
      stderr: '',
    }),
  }

  // Without a publisher this used to return normally, reporting the installer
  // as verified purely because it carried some valid Authenticode signature.
  for (const missing of [undefined, null, '', '   ']) {
    assert.throws(
      () => verifyAuthenticode('D:\\release\\setup.exe', missing, validlySigned),
      { code: 'SIGNING_PUBLISHER_MISSING' },
      `expected publisher ${JSON.stringify(missing)} must fail closed`,
    )
  }

  // The default argument must fail closed too, not just an explicit empty value.
  assert.throws(
    () => verifyAuthenticode('D:\\release\\setup.exe', undefined, validlySigned),
    { code: 'SIGNING_PUBLISHER_MISSING' },
  )
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
