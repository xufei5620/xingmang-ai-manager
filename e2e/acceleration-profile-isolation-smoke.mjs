import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Windows OSCrypt stores the profile key in Local State; macOS uses Keychain.
if (process.platform !== 'win32') {
  console.log('SKIP: Windows Electron Local State isolation smoke');
  process.exit(0);
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = require(path.join(repo, 'node_modules/typescript'));
const electron = require(path.join(repo, 'node_modules/electron'));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xm-electron-profile-smoke-')));
const application = path.join(root, 'application');
const desktopProfile = path.join(root, 'desktop-profile');
fs.mkdirSync(path.join(application, 'platform'), { recursive: true });
fs.mkdirSync(desktopProfile);
fs.writeFileSync(path.join(application, 'package.json'), JSON.stringify({ name: 'xingmang-ai-manager', version: '1.0.0', main: 'platform/entry.js' }));
for (const relative of ['platform/entry', 'acceleration-worker-entry', 'uninstall-cleanup-entry', 'acceleration-electron-profile', 'path-identity']) {
  const source = fs.readFileSync(path.join(repo, 'electron', relative + '.ts'), 'utf8');
  fs.writeFileSync(path.join(application, relative + '.js'), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText);
}
fs.writeFileSync(path.join(application, 'platform/desktop-entry.js'), `
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const directory = process.argv.find(value => value.startsWith('--xm-smoke-main=')).split('=').slice(1).join('=');
app.setPath('userData', directory);
app.setPath('sessionData', directory);
app.whenReady().then(() => {
  const file = path.join(directory, 'fixture-vault');
  if (process.argv.includes('--read-fixture')) {
    if (safeStorage.decryptString(fs.readFileSync(file)) !== 'temp-only-profile-sentinel') throw new Error('Fixture did not decrypt');
  } else {
    fs.writeFileSync(file, safeStorage.encryptString('temp-only-profile-sentinel'));
  }
  process.send({ ready: true, userData: app.getPath('userData'), sessionData: app.getPath('sessionData') }, () => app.quit());
});
`);
fs.writeFileSync(path.join(application, 'acceleration-development-worker.js'), `
const { app, safeStorage } = require('electron');
app.whenReady().then(() => {
  safeStorage.encryptString('isolated-worker-fixture');
  process.send({ ready: true, userData: app.getPath('userData'), sessionData: app.getPath('sessionData') }, () => app.quit());
});
`);
const { createAccelerationElectronProfile } = require(path.join(application, 'acceleration-electron-profile'));
const profiles = [];
const children = new Set();
// The evidence line used to hard-code the worker count and three `true`s, so
// it read the same whether or not the isolation held. Only names pushed after
// the matching assertion ran, and counts taken from the run itself, go in it.
const passedAssertions = [];
function recordPass(name) {
  passedAssertions.push(name);
}
function launch(args) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) if (['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())) delete environment[key];
    const child = spawn(electron, [application, ...args], { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: environment });
    children.add(child);
    let response;
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Electron fixture timeout')); }, 15000);
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('message', message => { response = message; });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      children.delete(child);
      if (code !== 0 || !response?.ready) reject(new Error('Electron fixture failed: ' + code + ' ' + stderr));
      else resolve(response);
    });
  });
}
(async () => {
  try {
    await launch(['--user-data-dir=' + desktopProfile, '--xm-smoke-main=' + desktopProfile]);
    const mainStatePath = path.join(desktopProfile, 'Local State');
    const before = fs.readFileSync(mainStatePath);
    const key = JSON.parse(before).os_crypt.encrypted_key;
    assert.ok(key);
    const first = createAccelerationElectronProfile();
    const second = createAccelerationElectronProfile();
    profiles.push(first, second);
    const results = await Promise.all(profiles.map(profile => launch(['--xingmang-acceleration-worker', profile.argument])));
    for (let index = 0; index < profiles.length; index++) {
      assert.equal(results[index].userData, profiles[index].directory);
      assert.equal(results[index].sessionData, profiles[index].directory);
      const state = JSON.parse(fs.readFileSync(path.join(profiles[index].directory, 'Local State'), 'utf8'));
      assert.ok(state.os_crypt.encrypted_key);
      assert.notEqual(state.os_crypt.encrypted_key, key);
    }
    recordPass('each-worker-gets-its-own-userdata-sessiondata-and-key');
    assert.deepEqual(fs.readFileSync(mainStatePath), before);
    recordPass('main-local-state-unchanged');
    await launch(['--user-data-dir=' + desktopProfile, '--xm-smoke-main=' + desktopProfile, '--read-fixture']);
    recordPass('original-vault-still-decrypts');
    console.log(JSON.stringify({ electron: require(path.join(repo, 'node_modules/electron/package.json')).version, workers: profiles.length, passedAssertions }));
  } finally {
    for (const child of children) child.kill();
    if (children.size === 0) {
      for (const profile of profiles) profile.cleanup();
      assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
      assert.match(path.basename(root), /^xm-electron-profile-smoke-/);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
