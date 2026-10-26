const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const script = path.join(__dirname, 'ci-install-chromium-deps.sh')
// setsid, fuser and a GNU timeout only exist where the script actually runs.
const linuxOnly = { skip: process.platform !== 'linux' && 'the apt installer only runs on the Linux CI runner' }

// A stand-in for `playwright install-deps`: the first call starts a holder that
// escapes the caller's process group (as sudo's apt-get did on #695) and keeps
// the lock file open, then hangs; later calls fail fast like apt on a held lock.
function writeFakeInstaller(dir) {
  const holder = path.join(dir, 'xmfakeaptget')
  fs.copyFileSync(fs.realpathSync(spawnSync('bash', ['-c', 'command -v sleep']).stdout.toString().trim()), holder)
  fs.chmodSync(holder, 0o755)
  const installer = path.join(dir, 'fake-install-deps.sh')
  fs.writeFileSync(installer, `#!/bin/bash
count=$(( $(cat "${dir}/calls" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "${dir}/calls"
if fuser "${dir}/lock-frontend" > /dev/null 2>&1; then
  echo "E: Could not get lock ${dir}/lock-frontend" >&2
  exit 100
fi
if [[ "$count" == 1 ]]; then
  setsid bash -c 'exec 9> "${dir}/lock-frontend"; exec "${holder}" 300' < /dev/null > /dev/null 2>&1 &
  sleep 300
fi
exit 0
`)
  fs.chmodSync(installer, 0o755)
  return { installer, holder }
}

function runInstaller(dir, installer, overrides = {}) {
  return spawnSync('bash', [script], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      CI_APT_ATTEMPT_SECONDS: '2 5',
      CI_APT_LOCK_WAIT_SECONDS: '6',
      CI_APT_SUDO: '',
      CI_APT_PROCESS_NAMES: 'xmfakeaptget',
      CI_APT_LOCK_FILES: path.join(dir, 'lock-frontend'),
      CI_APT_INSTALL_COMMAND: installer,
      CI_APT_REPAIR_COMMAND: '',
      // npm test runs inside a CI step, whose own output file and cache
      // folder must stay out of these runs.
      CI_APT_DEB_CACHE_DIR: '',
      GITHUB_OUTPUT: '',
      ...overrides,
    },
  })
}

// A killed holder can linger as a zombie where PID 1 does not reap (containers);
// only a live one would still hold the lock.
function holderRunning() {
  const states = spawnSync('ps', ['-C', 'xmfakeaptget', '-o', 'stat='], { encoding: 'utf8' }).stdout
  return states.split('\n').some((state) => state.trim() !== '' && !state.trim().startsWith('Z'))
}

test('a timed-out attempt is cleaned up so the retry does not hit a held apt lock', linuxOnly, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-ci-apt-'))
  t.after(() => {
    spawnSync('pkill', ['-KILL', '-x', 'xmfakeaptget'])
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const { installer } = writeFakeInstaller(dir)

  const result = runInstaller(dir, installer)

  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim(), '2')
  assert.match(result.stdout, /attempt 1 failed or ran past 2s/)
  assert.equal(holderRunning(), false, 'the escaped apt stand-in must not outlive the cleanup')
})

test('without the leftover cleanup the retry fails on the lock, as #695 did', linuxOnly, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-ci-apt-'))
  t.after(() => {
    spawnSync('pkill', ['-KILL', '-x', 'xmfakeaptget'])
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const { installer } = writeFakeInstaller(dir)

  // Nothing matches this name, so the holder survives like sudo's apt-get did.
  const result = runInstaller(dir, installer, { CI_APT_PROCESS_NAMES: 'not-a-running-process' })

  assert.equal(result.status, 1)
  assert.match(result.stdout, /locks still held after 6s/)
  assert.match(result.stdout, /after 1 bounded attempts/)
})

function writeScript(file, body) {
  fs.writeFileSync(file, `#!/bin/bash\n${body}`)
  fs.chmodSync(file, 0o755)
  return file
}

function cacheFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-ci-apt-cache-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const cache = path.join(dir, 'cache')
  const archives = path.join(dir, 'archives')
  fs.mkdirSync(archives)
  return {
    dir,
    cache,
    archives,
    output: path.join(dir, 'github-output'),
    env: {
      CI_APT_DEB_CACHE_DIR: cache,
      CI_APT_ARCHIVES_DIR: archives,
      CI_APT_LOCK_FILES: path.join(dir, 'no-such-lock'),
      CI_APT_PROCESS_NAMES: 'xmnotrunning',
      GITHUB_OUTPUT: path.join(dir, 'github-output'),
    },
  }
}

function readOutput(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

// Stands in for `apt-cache show <package>`: the records this runner's signed
// package index holds, each followed by a blank line as apt-cache prints them.
function writeFakeIndex(dir, records) {
  const body = records.map((record) => (
    `Package: ${record.package}\nVersion: ${record.version}\nArchitecture: ${record.arch}\nSHA256: ${record.sha256}\n`
  )).join('\n')
  fs.writeFileSync(path.join(dir, 'index-records'), `${body}\n`)
  return writeScript(path.join(dir, 'apt-cache.sh'), `
[[ "$1" == show ]] || exit 2
shift
echo "$@" >> "${dir}/index-queries"
for package in "$@"; do
  awk -v RS= -v ORS='\\n\\n' -v want="Package: $package" 'index($0, want "\\n") == 1' "${dir}/index-records"
done
`)
}

test('cached .deb files that match the package index reach apt before the first attempt, and only the installed versions are kept', linuxOnly, (t) => {
  const fixture = cacheFixture(t)
  fs.mkdirSync(fixture.cache)
  fs.writeFileSync(path.join(fixture.cache, 'fonts-wqy-zenhei_0.9.45-8_all.deb'), 'cached font')
  // apt itself only compares a cached file's size before installing it as root.
  fs.writeFileSync(path.join(fixture.cache, 'fonts-unifont_1%3a15.1.01-1build1_all.deb'), 'tampered')
  // The second of two versions in the index.
  fs.writeFileSync(path.join(fixture.cache, 'libnss3_2%3a3.98-1ubuntu0.1_amd64.deb'), 'new nss')
  // Newer than this runner's index knows about.
  fs.writeFileSync(path.join(fixture.cache, 'libnss3_2%3a3.98-1ubuntu0.2_amd64.deb'), 'newer nss')
  const index = writeFakeIndex(fixture.dir, [
    { package: 'fonts-wqy-zenhei', version: '0.9.45-8', arch: 'all', sha256: sha256('cached font') },
    { package: 'fonts-unifont', version: '1:15.1.01-1build1', arch: 'all', sha256: sha256('genuine unifont') },
    { package: 'libnss3', version: '2:3.98-1build1', arch: 'amd64', sha256: sha256('old nss') },
    { package: 'libnss3', version: '2:3.98-1ubuntu0.1', arch: 'amd64', sha256: sha256('new nss') },
  ])
  // Stands in for apt: only the two files that match may be waiting for it,
  // and it downloads unifont itself.
  const installer = writeScript(path.join(fixture.dir, 'install.sh'), `
[[ "$(ls "${fixture.archives}" | tr '\\n' ' ')" == 'fonts-wqy-zenhei_0.9.45-8_all.deb libnss3_2%3a3.98-1ubuntu0.1_amd64.deb ' ]] || exit 1
echo "genuine unifont" > "${fixture.archives}/fonts-unifont_1%3a15.1.01-1build1_all.deb"
`)
  const installed = writeScript(path.join(fixture.dir, 'installed.sh'), `
printf '%s\\n' fonts-wqy-zenhei_0.9.45-8_all.deb fonts-unifont_1:15.1.01-1build1_all.deb 'libnss3_2:3.98-1ubuntu0.1_amd64.deb' bash_5.2.21-2ubuntu4_amd64.deb
`)

  const result = runInstaller(fixture.dir, installer, {
    ...fixture.env,
    CI_APT_INDEX_COMMAND: index,
    CI_APT_INSTALLED_COMMAND: installed,
  })

  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /Seeded apt's download folder with 2 of 4 cached \.deb files/)
  assert.equal(fs.readFileSync(path.join(fixture.dir, 'index-queries'), 'utf8').trim().split('\n').length, 1,
    'the index is read once for all cached files')
  assert.match(result.stdout, /The other 2 did not match this runner's package index/)
  assert.deepEqual(fs.readdirSync(fixture.cache).sort(), [
    'fonts-unifont_1%3a15.1.01-1build1_all.deb',
    'fonts-wqy-zenhei_0.9.45-8_all.deb',
    'libnss3_2%3a3.98-1ubuntu0.1_amd64.deb',
  ])
  assert.equal(fs.readFileSync(path.join(fixture.cache, 'fonts-unifont_1%3a15.1.01-1build1_all.deb'), 'utf8').trim(), 'genuine unifont')
  assert.match(result.stdout, /Kept 3 \.deb files/)
  assert.match(readOutput(fixture.output), /^cache-ready=true$/m)
})

test('an install that downloaded nothing does not ask the workflow to save an empty cache', linuxOnly, (t) => {
  const fixture = cacheFixture(t)
  const installer = writeScript(path.join(fixture.dir, 'install.sh'), 'exit 0\n')
  const installed = writeScript(path.join(fixture.dir, 'installed.sh'), 'echo bash_5.2.21-2ubuntu4_amd64.deb\n')

  const result = runInstaller(fixture.dir, installer, { ...fixture.env, CI_APT_INSTALLED_COMMAND: installed })

  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /No cached \.deb files to start from/)
  assert.match(result.stdout, /Kept 0 \.deb files/)
  assert.doesNotMatch(readOutput(fixture.output), /cache-ready/)
})

test('a failed install keeps nothing for the cache and is not cleaned up after its last attempt', linuxOnly, (t) => {
  const fixture = cacheFixture(t)
  fs.writeFileSync(path.join(fixture.archives, 'fonts-unifont_1%3a15.1.01-1build1_all.deb'), 'half a font')
  const installer = writeScript(path.join(fixture.dir, 'install.sh'), 'exit 100\n')
  const repairs = path.join(fixture.dir, 'repairs')
  const repair = writeScript(path.join(fixture.dir, 'repair.sh'), `echo repaired >> "${repairs}"\n`)

  const result = runInstaller(fixture.dir, installer, {
    ...fixture.env,
    CI_APT_ATTEMPT_SECONDS: '5 5 5',
    CI_APT_REPAIR_COMMAND: repair,
  })

  assert.equal(result.status, 1)
  assert.match(result.stdout, /after 3 bounded attempts/)
  assert.equal(fs.readFileSync(repairs, 'utf8').trim().split('\n').length, 2, 'cleaned up between attempts only')
  assert.equal(fs.existsSync(fixture.cache), false)
  assert.doesNotMatch(readOutput(fixture.output), /cache-ready/)
})
