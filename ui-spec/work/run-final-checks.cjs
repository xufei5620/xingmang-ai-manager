'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'qa', 'current-results');
const prototype = path.join(root, 'prototype', '星芒AI管理工具-可交互原型.html');
const integration = path.join(__dirname, 'integration-preview.html');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inside = relative => {
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root + path.sep)) throw new Error('Check path escaped ui-spec: ' + relative);
  return resolved;
};
const jobs = [
  ['onboarding', 'work/modules/10-check.cjs', ['--browser']],
  ['recovery', 'work/modules/12-check.cjs', ['--browser']],
  ['account', 'work/modules/20-check.cjs', []],
  ['extensions', 'work/modules/30-check.cjs', [prototype]],
  ['canvas', 'work/modules/45-check.cjs', [prototype]],
  ['platform', 'work/modules/50-check.cjs', [prototype]],
  ['components', 'work/modules/70-check.cjs', []],
  ['maintenance', 'work/modules/80-check.cjs', []],
  ['integration', 'work/modules/90-integration-check.cjs', [prototype]],
  ['journeys', 'work/reference-check.cjs', ['journeys']],
  ['layout', 'work/reference-check.cjs', ['layout']],
  ['icons', 'work/reference-check.cjs', ['icons']],
  ['shell-close', 'work/reference-check.cjs', ['shell-close']],
];

async function runJob([name, relative, args]) {
  const script = inside(relative);
  const started = Date.now();
  if (!fs.existsSync(script)) return { name, exitCode: -1, status: 'missing-script', script: relative, seconds: 0 };
  const result = await new Promise(resolve => {
    const child = cp.spawn(process.execPath, [script, ...args], {
      cwd: root, env: { ...process.env, XINGMANG_PLAYWRIGHT_MODULE: require.resolve('@playwright/test') },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = ''; let timedOut = false; let settled = false;
    const collect = buffer => { if (text.length < 4_000_000) text += String(buffer).replace(/data:image\/[^\s"'<>]+/g, '[image data omitted]'); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) cp.spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGKILL');
    }, 90_000);
    const done = (code, error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      fs.writeFileSync(path.join(output, name + '.log'), text + (error ? '\n' + error.message : ''), 'utf8');
      resolve({ name, exitCode: code ?? -1, status: timedOut ? 'timeout' : code === 0 ? 'passed' : 'failed', seconds: Math.round((Date.now() - started) / 100) / 10, log: name + '.log' });
    };
    child.once('error', error => done(-1, error)); child.once('close', code => done(code));
  });
  console.log(JSON.stringify(result));
  return result;
}

(async () => {
  if (!fs.existsSync(prototype)) throw new Error('Current public v3.1.1 prototype is missing');
  fs.mkdirSync(output, { recursive: true });
  const originalHash = digest(prototype);
  // Integration tests consume an exact generated copy; the public artifact is never rewritten.
  fs.copyFileSync(prototype, integration);
  const results = [];
  let cursor = 0;
  async function worker() { while (cursor < jobs.length) { const job = jobs[cursor++]; results.push(await runJob(job)); } }
  await Promise.all([worker(), worker()]);
  const sourceUnchanged = originalHash === digest(prototype);
  const report = { checkedAt: new Date().toISOString(), scope: 'Offline prototype and browser simulation; no product backend or native platform verification', groups: jobs.length, passed: results.filter(row => row.status === 'passed').length, sourceUnchanged, artifacts: { prototype: originalHash, integration: digest(integration), components: digest(path.join(root, 'prototype/components.html')) }, results: results.sort((a, b) => a.name.localeCompare(b.name)) };
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ groups: report.groups, passed: report.passed, sourceUnchanged, report: path.relative(root, path.join(output, 'summary.json')) }));
  if (report.passed !== report.groups || !sourceUnchanged) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
