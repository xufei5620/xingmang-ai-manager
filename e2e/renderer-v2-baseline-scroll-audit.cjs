'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const repository = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-head-scroll-'));
const revision = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
const relativeFiles = cp.execFileSync('git', ['ls-tree', '-r', '--name-only', revision, '--', 'src', 'electron', 'assets', 'e2e/shell-navigation-fixture.css', 'e2e/shell-navigation-fixture.html', 'e2e/shell-navigation-fixture.tsx', 'e2e/shell-navigation-interactions.test.mjs', 'package.json', 'tsconfig.json', 'vite.config.ts'], { cwd: repository, encoding: 'utf8', maxBuffer: 5_000_000 }).trim().split(/\r?\n/);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const copied = [];
for (const relative of relativeFiles) {
  const bytes = cp.execFileSync('git', ['show', revision + ':' + relative], { cwd: repository, maxBuffer: 30_000_000 });
  const target = path.join(temporary, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  copied.push({ file: relative, sha256: sha256(bytes) });
}
// The clean source and test stay byte-identical. Only isolated tool config selects
// React 18 from the already installed rollback workspace, with no package download.
const legacyRequire = createRequire(path.join(repository, 'tooling/legacy-renderer/package.json'));
const aliases = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'react-dom/server'].map(name => ({ find: name, replacement: legacyRequire.resolve(name).replaceAll('\\', '/') }));
fs.renameSync(path.join(temporary, 'vite.config.ts'), path.join(temporary, 'vite.config.head.ts'));
const config = [
  "import { defineConfig } from 'vite';",
  "import react from '@vitejs/plugin-react';",
  'export default defineConfig({plugins:[react()],base:"./",resolve:{alias:[',
  aliases.map(alias => '{find:new RegExp(' + JSON.stringify('^' + alias.find.replaceAll('.', '\\.') + '$') + '),replacement:' + JSON.stringify(alias.replacement) + '}').join(','),
  ']},server:{host:"127.0.0.1",port:5173,strictPort:true},build:{outDir:"dist",emptyOutDir:true}});',
].join('\n');
fs.writeFileSync(path.join(temporary, 'vite.config.ts'), config, 'utf8');
fs.symlinkSync(path.join(repository, 'node_modules'), path.join(temporary, 'node_modules'), 'junction');
const command = ['--test', '--test-name-pattern=^navigation restores filters and delayed content scroll, while account changes reset both$', 'e2e/shell-navigation-interactions.test.mjs'];
const started = Date.now();
const run = cp.spawnSync(process.execPath, command, { cwd: temporary, encoding: 'utf8', timeout: 55_000, windowsHide: true, maxBuffer: 3_000_000, env: { ...process.env, XINGMANG_RENDERER: '' } });
const filesChanged = copied.filter(row => row.file !== 'vite.config.ts' && sha256(fs.readFileSync(path.join(temporary, row.file))) !== row.sha256);
const tracked = copied.filter(row => ['src/components/shell/NavigationState.tsx', 'e2e/shell-navigation-fixture.tsx', 'e2e/shell-navigation-fixture.css', 'e2e/shell-navigation-fixture.html', 'e2e/shell-navigation-interactions.test.mjs', 'package.json', 'vite.config.ts'].includes(row.file));
const report = { checkedAt: new Date().toISOString(), revision, temporaryDirectory: temporary, exportedFiles: copied.length, runtime: { react: legacyRequire('react').version, reactDom: legacyRequire('react-dom').version, node: process.version }, command: [process.execPath, ...command], seconds: (Date.now() - started) / 1000, exitCode: run.status, signal: run.signal, error: run.error?.message, stdout: run.stdout, stderr: run.stderr, trackedSourceHashes: tracked, modifiedSourceFiles: filesChanged, toolConfig: 'HEAD source plus isolated dependency-only React 18 alias; original Vite config retained as vite.config.head.ts. node_modules junction is read-only dependency reuse.' };
const output = path.join(repository, 'docs/renderer-v2-review');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'baseline-scroll-audit.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(report, null, 2));
