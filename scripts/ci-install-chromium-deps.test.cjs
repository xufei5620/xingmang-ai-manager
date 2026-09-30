const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
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
