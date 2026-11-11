// 出包时随包带的第三方许可清单（D97，许可合规 LC-1、LC-2、LC-4、LC-7）。
//
// 为什么要自己生成：界面和画布是 Vite 打包压缩的，压缩会把每个库自带的版权和许可注释全部
// 去掉，MIT、ISC、BSD 要求「随软件附上版权和许可文字」，装到客户电脑上的那份拷贝里却一行
// 都没有。所以出包时把实际打进去的库连同它们的许可原文拼成一份 THIRD-PARTY-NOTICES.txt，
// 用 extraResources 放在安装目录的 resources 里，客户不用解包就能看到。
//
// 清单分四块来源：
// - 界面（根目录 vite.config.ts）和画布（scripts/build-canvas.mjs）两次构建各自交出的
//   「打进产物的 node_modules 包」名单（scripts/third-party-collector.mjs 收，后台线程
//   Worker 的那一半也收，Vite 自带的 build.license 不管 Worker，mediabunny 就在那里）；
// - 主进程的生产依赖（原样进 app.asar，从 package.json 的 dependencies 往下走）；
// - 构建工具看不见、只能手工登记的几项（BUNDLED_EXTRAS）：Electron 与 Chromium、源码里抄的
//   lobe-icons 图标、画布抠图用的 OpenCV 运行时、Codex 型号名单、Windows 安装程序里的
//   Nsis7z 解压插件、随加速组件分发的 Mihomo。
//
// 画布那一半绕开 canvas-v2/ 另收（D97）：不改 canvas-v2/vite.config.ts，由根目录的
// build-canvas.mjs 用同一份配置构建，只多挂一个只读名单的插件。
//
// 门禁有三道：生成时每个包的许可必须在 ACCEPTED_LICENSES 里（GPL 一类混进界面要有人看）；
// 生成时每份名单必须对得上这一次的产物、几个已知的包必须在（后台线程或画布那份没收进来
// 时当场失败）；出包后 verify-packaged-hardening.cjs 与 verify-macos-free-artifacts.cjs
// 核对安装包里有这份清单、有 Electron 与 Chromium 的许可文件、app.asar 里的每个包都在清单上。
const fs = require('node:fs')
const path = require('node:path')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const OUTPUT_DIRECTORY_NAME = 'dist-third-party'
const NOTICES_FILE_NAME = 'THIRD-PARTY-NOTICES.txt'
const ELECTRON_LICENSE_FILE_NAME = 'LICENSE.electron.txt'
const CHROMIUM_LICENSE_FILE_NAME = 'LICENSES.chromium.html'
const MANIFEST_SCHEMA_VERSION = 1
const NOTICES_HEADING = '星芒AI管理工具 第三方组件许可清单 / XingMang AI Manager Third-Party Notices'

// 名单里每一份对应一次构建：界面打进 dist/，画布先打进 canvas-v2/dist/，
// 再由 copy-canvas-assets.mjs 整目录拷成 dist-canvas/ 进安装包。
const BUNDLES = {
  renderer: { label: 'interface', outDir: 'dist', packagedDir: 'dist' },
  canvas: { label: 'canvas', outDir: path.join('canvas-v2', 'dist'), packagedDir: 'dist-canvas' },
}

// 这几个包要是不在名单里，说明收名单那一步漏了一块，而不是它们不用了：mediabunny 只在
// 视频拼片的后台线程里，@xyflow/react 只在画布里。真不用了就从这里删掉对应那一行。
const EXPECTED_PACKAGES = {
  renderer: [
    { name: 'react', why: '界面' },
    { name: 'mediabunny', why: '视频拼片后台线程' },
  ],
  canvas: [
    { name: '@xyflow/react', why: '画布' },
  ],
}

// Licenses whose only condition on a minified or binary copy is carrying the
// notice text (MPL-2.0 adds telling the recipient where the source is, which
// every entry below does). Anything else reaching the interface or canvas
// bundle needs a person to read its terms first, so it fails the build.
const ACCEPTED_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MPL-2.0',
  'Python-2.0',
  'Unlicense',
])

const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying|notice)(\.|-|$)/i

function toPosix(value) {
  return value.replaceAll('\\', '/')
}

/**
 * 模块 id 落在哪个 node_modules 包里；不在 node_modules 里的（自己的源码、虚拟模块）返回 null。
 * 取最后一个 node_modules 后面那一段，嵌套安装和带 scope 的包都认得。
 */
function resolvePackageDirectoryFromModuleId(moduleId) {
  if (typeof moduleId !== 'string' || !moduleId || moduleId.startsWith('\0')) return null
  const clean = toPosix(moduleId.split('?')[0])
  const marker = '/node_modules/'
  const index = clean.lastIndexOf(marker)
  if (index < 0) return null
  const segments = clean.slice(index + marker.length).split('/')
  const depth = segments[0].startsWith('@') ? 2 : 1
  if (segments.length <= depth || segments.slice(0, depth).some((segment) => !segment || segment.startsWith('.'))) return null
  return clean.slice(0, index + marker.length) + segments.slice(0, depth).join('/')
}

/**
 * Vite 和 Rolldown 塞进产物的自家辅助代码（模块预加载、运行时）是带 \0 的虚拟模块，
 * 不在 node_modules 路径上，但代码确实来自这两个包。
 */
function resolveToolchainPackageFromModuleId(moduleId) {
  if (typeof moduleId !== 'string' || !moduleId.startsWith('\0')) return null
  const id = moduleId.slice(1)
  if (id.startsWith('vite/')) return 'vite'
  if (id.startsWith('rolldown/')) return 'rolldown'
  return null
}

function buildBundleManifest({ bundle, renderer, chunks, packageDirectories, toolchainPackages, workerBuilds }) {
  if (!Object.hasOwn(BUNDLES, bundle)) throw new Error(`未知的产物：${bundle}`)
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    bundle,
    renderer: renderer || null,
    chunks: [...new Set(chunks.map(toPosix))].sort(),
    workerBuilds,
    packageDirectories: [...new Set(packageDirectories.map(toPosix))].sort(),
    toolchainPackages: [...new Set(toolchainPackages)].sort(),
  }
}

function manifestPath(projectRoot, bundle) {
  return path.join(projectRoot, OUTPUT_DIRECTORY_NAME, `${bundle}.json`)
}

function writeBundleManifest(projectRoot, manifest) {
  const target = manifestPath(projectRoot, manifest.bundle)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const relative = {
    ...manifest,
    packageDirectories: manifest.packageDirectories.map((directory) => toPosix(path.relative(projectRoot, directory))),
  }
  fs.writeFileSync(target, `${JSON.stringify(relative, null, 2)}\n`)
  return target
}

function readJsonFile(filePath, label) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    throw new Error(`读不到${label}：${filePath}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label}不是有效的 JSON：${filePath}`)
  }
}

/**
 * 读回一次构建交出的名单，并核对它对得上安装包里那份产物：名单里记的每个 chunk
 * 都得在打包目录里。对不上（只重编了一半、或者画布用 XINGMANG_CANVAS_DIST 换了别的产物）
 * 就不能拿它写清单。
 */
function readBundleManifest(projectRoot, bundle) {
  const definition = BUNDLES[bundle]
  const label = `${definition.label === 'canvas' ? '画布' : '界面'}的第三方包名单`
  const manifest = readJsonFile(manifestPath(projectRoot, bundle), label)
  if (manifest?.schemaVersion !== MANIFEST_SCHEMA_VERSION || manifest.bundle !== bundle
    || !Array.isArray(manifest.chunks) || !Array.isArray(manifest.packageDirectories) || !Array.isArray(manifest.toolchainPackages)) {
    throw new Error(`${label}格式不对，请重新 npm run compile`)
  }
  if (manifest.chunks.length === 0) throw new Error(`${label}里一个 chunk 都没有，请重新 npm run compile`)
  for (const chunk of manifest.chunks) {
    if (typeof chunk !== 'string' || chunk.includes('..') || path.isAbsolute(chunk)
      || !fs.existsSync(path.join(projectRoot, definition.packagedDir, chunk))) {
      throw new Error(`${label}跟 ${definition.packagedDir}/ 里的产物对不上（缺 ${chunk}），请重新 npm run compile`)
    }
  }
  return manifest
}

function normalizeLicenseField(packageJson) {
  const field = packageJson.license ?? packageJson.licenses
  if (typeof field === 'string') return field.trim()
  if (field && typeof field === 'object' && !Array.isArray(field) && typeof field.type === 'string') return field.type.trim()
  if (Array.isArray(field)) {
    const types = field.map((entry) => (typeof entry === 'string' ? entry : entry?.type)).filter((type) => typeof type === 'string' && type.trim())
    if (types.length === 1) return types[0].trim()
    if (types.length > 1) return `(${types.map((type) => type.trim()).join(' OR ')})`
  }
  return null
}

/**
 * SPDX 表达式里的每一种都认识才算通过：OR 只要有一种能用，AND 要每一种都能用。
 * 括号只按最常见的一层处理，再复杂的表达式会被拒绝，交给人看。
 */
function isAcceptedLicense(expression) {
  if (typeof expression !== 'string' || !expression.trim()) return false
  const trimmed = expression.trim().replace(/^\((.*)\)$/, '$1').trim()
  if (/[()]/.test(trimmed)) return false
  if (/\sOR\s/.test(trimmed)) return trimmed.split(/\s+OR\s+/).some((part) => isAcceptedLicense(part))
  if (/\sAND\s/.test(trimmed)) return trimmed.split(/\s+AND\s+/).every((part) => isAcceptedLicense(part))
  return ACCEPTED_LICENSES.has(trimmed)
}

function normalizeRepositoryUrl(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url
  if (typeof raw !== 'string' || !raw.trim()) return null
  let value = raw.trim()
  const shorthand = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value)
  if (shorthand) return `https://github.com/${shorthand[1]}/${shorthand[2].replace(/\.git$/, '')}`
  value = value.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@/, 'https://').replace(/\.git$/, '')
  if (!/^https?:\/\//.test(value)) return null
  const directory = typeof repository === 'object' && typeof repository.directory === 'string' && repository.directory.trim()
    ? repository.directory.trim()
    : null
  return directory && /github\.com/.test(value) ? `${value}/tree/HEAD/${directory.replace(/^\/+/, '')}` : value
}

function readLicenseTexts(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, text: fs.readFileSync(path.join(directory, name), 'utf8') }))
}

/** 一个已经装好的 npm 包：名字、版本、许可、源码地址和随包的许可原文。 */
function inspectInstalledPackage(directory) {
  const packageJson = readJsonFile(path.join(directory, 'package.json'), '第三方包的 package.json')
  if (typeof packageJson.name !== 'string' || typeof packageJson.version !== 'string') {
    throw new Error(`第三方包缺少名字或版本：${directory}`)
  }
  const license = normalizeLicenseField(packageJson)
  const source = normalizeRepositoryUrl(packageJson.repository)
    || `https://www.npmjs.com/package/${packageJson.name}/v/${packageJson.version}`
  return {
    name: packageJson.name,
    version: packageJson.version,
    license,
    source,
    texts: readLicenseTexts(directory),
    packageJson,
  }
}

function resolveInstalledDependency(name, fromDirectory, projectRoot) {
  let current = fromDirectory
  for (;;) {
    const candidate = path.join(current, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    if (path.resolve(current) === path.resolve(projectRoot)) return null
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * 主进程的生产依赖：从根 package.json 的 dependencies 往下走，跟 electron-builder 往
 * app.asar 里装的是同一棵树。没装上的可选依赖跳过，装不上的必需依赖直接失败。
 */
function collectProductionPackageDirectories(projectRoot) {
  const rootPackage = readJsonFile(path.join(projectRoot, 'package.json'), '根目录 package.json')
  const visited = new Set()
  const pending = Object.keys(rootPackage.dependencies || {}).map((name) => ({ name, from: projectRoot, optional: false }))
  while (pending.length > 0) {
    const { name, from, optional } = pending.shift()
    const directory = resolveInstalledDependency(name, from, projectRoot)
    if (!directory) {
      if (optional) continue
      throw new Error(`主进程依赖 ${name} 没装好，请先 npm ci`)
    }
    const real = fs.realpathSync(directory)
    if (visited.has(real)) continue
    visited.add(real)
    const packageJson = readJsonFile(path.join(directory, 'package.json'), `${name} 的 package.json`)
    for (const dependency of Object.keys(packageJson.dependencies || {})) pending.push({ name: dependency, from: directory, optional: false })
    for (const dependency of Object.keys(packageJson.optionalDependencies || {})) pending.push({ name: dependency, from: directory, optional: true })
  }
  return [...visited].sort()
}

function readRequiredText(filePath, label) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    throw new Error(`读不到${label}：${filePath}`)
  }
  if (!text.trim()) throw new Error(`${label}是空的：${filePath}`)
  return text
}

/**
 * vendor-icons.tsx 文件头的 `//` 注释里就是 lobe-icons 的 MIT 全文。从那里取，图标代码和
 * 它的许可只维护一份；注释被改坏、取不出来就让构建失败，不悄悄少一段。
 */
function extractLobeIconsLicense(source) {
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === '// MIT License')
  if (start < 0) return null
  const collected = []
  for (const line of lines.slice(start)) {
    if (!line.startsWith('//')) break
    collected.push(line.replace(/^\/\/ ?/, ''))
  }
  const text = collected.join('\n').trim()
  return /Copyright \(c\) \d{4} LobeHub/.test(text) && /SOFTWARE\.$/.test(text) ? text : null
}

/**
 * 构建工具看不见、只能手工登记的几项。每一项的许可原文都从仓库里或已经装好的包里读，
 * 不在这里手抄。
 */
function buildBundledExtras(projectRoot) {
  const electronDirectory = path.join(projectRoot, 'node_modules', 'electron')
  const electron = readJsonFile(path.join(electronDirectory, 'package.json'), 'Electron 的 package.json')
  const vendorIcons = readRequiredText(path.join(projectRoot, 'src', 'renderer-v2', 'ui', 'vendor-icons.tsx'), '界面厂商图标源码')
  const lobeVersion = /copied from @lobehub\/icons (\d+\.\d+\.\d+)/.exec(vendorIcons)?.[1]
  const lobeLicense = extractLobeIconsLicense(vendorIcons)
  if (!lobeVersion || !lobeLicense) throw new Error('vendor-icons.tsx 文件头里取不出 lobe-icons 的版本和 MIT 许可全文')
  const grabcutDirectory = path.join(projectRoot, 'canvas-v2', 'src', 'vendor', 'opencv-grabcut')
  const grabcut = readJsonFile(path.join(grabcutDirectory, 'manifest.json'), '画布抠图运行时的构建记录')
  const opencvSource = grabcut.sourceArchives?.find((archive) => typeof archive?.name === 'string' && archive.name.startsWith('opencv-'))?.url
  const emsdkSource = grabcut.sourceArchives?.find((archive) => typeof archive?.name === 'string' && archive.name.startsWith('emsdk-'))?.url
  if (!grabcut.opencvVersion || !opencvSource || !emsdkSource) throw new Error('画布抠图运行时的构建记录里缺版本或源码地址')
  const codexDirectory = path.join(projectRoot, 'bundled-catalog', 'codex-models')
  return [
    {
      name: 'Electron',
      version: electron.version,
      license: 'MIT',
      source: 'https://github.com/electron/electron',
      usedIn: ['application runtime'],
      texts: [{ name: 'LICENSE', text: readRequiredText(path.join(electronDirectory, 'LICENSE'), 'Electron 许可') }],
      notes: [`Also shipped next to the application as ${ELECTRON_LICENSE_FILE_NAME}.`],
    },
    {
      name: 'Chromium (bundled with Electron, including FFmpeg and other components)',
      version: `as bundled with Electron ${electron.version}`,
      license: 'BSD-3-Clause and others, including LGPL-2.1 (FFmpeg)',
      source: 'https://source.chromium.org/chromium',
      usedIn: ['application runtime'],
      texts: [],
      notes: [
        `The licenses of Chromium and every component it contains are in ${CHROMIUM_LICENSE_FILE_NAME}:`,
        '  Windows and Linux: in the installation directory, next to the program;',
        '  macOS: in the application bundle, Contents/Resources/.',
      ],
    },
    {
      name: '@lobehub/icons',
      version: lobeVersion,
      license: 'MIT',
      source: 'https://github.com/lobehub/lobe-icons',
      usedIn: ['interface'],
      texts: [{ name: 'LICENSE', text: lobeLicense }],
      notes: ['The AI vendor marks in the interface are copied from this package.'],
    },
    {
      name: 'OpenCV GrabCut runtime (OpenCV and Emscripten)',
      version: `OpenCV ${grabcut.opencvVersion}, Emscripten ${grabcut.emscripten?.version || 'unknown'}`,
      license: 'Apache-2.0 and the other licenses reproduced below',
      source: `${opencvSource} ; ${emsdkSource}`,
      usedIn: ['canvas'],
      texts: [{ name: 'LICENSES.txt', text: readRequiredText(path.join(grabcutDirectory, 'LICENSES.txt'), '画布抠图运行时许可') }],
      notes: ['Used by the canvas for image cut-outs.'],
    },
    {
      name: 'OpenAI Codex model catalog',
      version: 'see bundled-catalog/codex-models',
      license: 'Apache-2.0',
      source: 'https://github.com/openai/codex',
      usedIn: ['main process'],
      texts: [
        { name: 'NOTICE', text: readRequiredText(path.join(codexDirectory, 'NOTICE'), 'Codex 型号名单 NOTICE') },
        { name: 'LICENSE', text: readRequiredText(path.join(codexDirectory, 'LICENSE'), 'Codex 型号名单许可') },
      ],
      notes: ['The model list written to Codex is copied unmodified from openai/codex.'],
    },
    {
      name: 'Nsis7z plug-in (based on 7-Zip by Igor Pavlov)',
      version: 'as bundled by electron-builder',
      license: 'LGPL-2.1',
      source: 'https://nsis.sourceforge.io/Nsis7z_plug-in ; https://www.7-zip.org/',
      usedIn: ['Windows installer'],
      texts: [],
      notes: [
        'Only used by the Windows installer to unpack the application while it installs; it is not installed.',
        `The full text of the GNU Lesser General Public License 2.1 is reproduced in ${CHROMIUM_LICENSE_FILE_NAME} (ffmpeg section).`,
      ],
    },
    {
      name: 'Mihomo',
      version: 'see resources/acceleration/THIRD-PARTY-NOTICES.txt',
      license: 'GPL-3.0',
      source: 'https://github.com/MetaCubeX/mihomo',
      usedIn: ['network acceleration component'],
      texts: [],
      notes: [
        'Shipped only when resources/acceleration/ is present. It runs as a separate program;',
        'that directory carries its full license text (LICENSE-mihomo.txt) and the exact version',
        'and corresponding source (THIRD-PARTY-NOTICES.txt).',
      ],
    },
  ]
}

function addPackage(entries, directory, usedIn) {
  const info = inspectInstalledPackage(directory)
  const key = `${info.name}@${info.version}`
  const existing = entries.get(key)
  if (existing) {
    existing.usedIn.add(usedIn)
    return
  }
  entries.set(key, { ...info, usedIn: new Set([usedIn]) })
}

function assertExpectedPackages(bundle, manifest, entries) {
  if (bundle === 'renderer' && manifest.renderer !== 'v2') return
  const label = BUNDLES[bundle].label
  for (const expected of EXPECTED_PACKAGES[bundle]) {
    const found = [...entries.values()].some((entry) => entry.name === expected.name && entry.usedIn.has(label))
    if (!found) {
      throw new Error(`${expected.why}的 ${expected.name} 不在第三方包名单里：要么这一块的名单没收上来，要么它已经不用了（不用了就把它从 EXPECTED_PACKAGES 删掉）`)
    }
  }
}

/** 把各块来源合成一张表，每个包只出现一次，并标出它在哪几块里用到。 */
function collectThirdPartyEntries(projectRoot = PROJECT_ROOT) {
  const entries = new Map()
  for (const bundle of Object.keys(BUNDLES)) {
    const manifest = readBundleManifest(projectRoot, bundle)
    const label = BUNDLES[bundle].label
    for (const directory of manifest.packageDirectories) addPackage(entries, path.resolve(projectRoot, directory), label)
    for (const name of manifest.toolchainPackages) {
      const directory = resolveInstalledDependency(name, projectRoot, projectRoot)
      if (!directory) throw new Error(`构建工具 ${name} 没装好，请先 npm ci`)
      addPackage(entries, directory, label)
    }
    assertExpectedPackages(bundle, manifest, entries)
  }
  for (const directory of collectProductionPackageDirectories(projectRoot)) addPackage(entries, directory, 'main process')
  const problems = []
  for (const entry of entries.values()) {
    if (!isAcceptedLicense(entry.license)) {
      problems.push(`${entry.name}@${entry.version}（${entry.license || '没写许可'}）`)
    }
  }
  if (problems.length > 0) {
    throw new Error(`这些包的许可不在已审过的范围里，先请人看过条款再决定能不能打进安装包：${problems.join('、')}`)
  }
  return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name, 'en') || left.version.localeCompare(right.version, 'en'))
}

const RULE = '='.repeat(80)
const THIN_RULE = '-'.repeat(80)

function normalizeText(text) {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()
}

function formatEntry(entry) {
  const lines = [
    RULE,
    `${entry.name} ${entry.version}`,
    `License: ${entry.license}`,
    `Source: ${entry.source}`,
    `Used in: ${[...entry.usedIn].sort().join(', ')}`,
    ...(entry.notes || []),
  ]
  // MPL-2.0 3.2: a recipient of the executable form must be told how to get the
  // source of that exact version, not just the project.
  if (/MPL-/.test(entry.license || '') && entry.packageJson) {
    lines.push(`Distributed unmodified. Source of this exact version: https://www.npmjs.com/package/${entry.name}/v/${entry.version}`)
  }
  if (entry.texts.length === 0 && !entry.notes?.length) {
    lines.push('(This package does not ship a license file; its license is the one named above.)')
  }
  for (const text of entry.texts) {
    lines.push(THIN_RULE, `${text.name}:`, '', normalizeText(text.text))
  }
  return lines.join('\n')
}

/** 整份清单的文字。packages 已经排好序，extras 排在最前面。 */
function buildThirdPartyNotices({ packages, extras }) {
  const header = [
    NOTICES_HEADING,
    '',
    '星芒AI管理工具包含下列第三方组件，它们各自遵循原有的许可。下面逐个列出名称、版本、许可、源码地址和许可原文；',
    '各组件的源码可从所列地址取得对应版本。',
    'This application includes the third-party components listed below. Each remains under its own license,',
    'reproduced below together with where its corresponding source can be obtained.',
    '',
    `Components: ${extras.length + packages.length}`,
  ]
  const body = [
    ...extras.map((extra) => formatEntry({ ...extra, usedIn: new Set(extra.usedIn) })),
    ...packages.map(formatEntry),
  ]
  return `${[header.join('\n'), ...body, RULE].join('\n\n')}\n`
}

function noticesOutputPath(projectRoot = PROJECT_ROOT) {
  return path.join(projectRoot, OUTPUT_DIRECTORY_NAME, NOTICES_FILE_NAME)
}

function generateThirdPartyNotices(projectRoot = PROJECT_ROOT) {
  const packages = collectThirdPartyEntries(projectRoot)
  const extras = buildBundledExtras(projectRoot)
  const text = buildThirdPartyNotices({ packages, extras })
  const target = noticesOutputPath(projectRoot)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text)
  return { target, packageCount: packages.length, extraCount: extras.length }
}

/**
 * macOS 出包时 electron-builder 会删掉 Electron 压缩包里的 LICENSE 和 LICENSES.chromium.html
 * （app-builder-lib electronMac.js 的 createMacApp），Windows、Linux 则留在安装目录里。
 * afterExtract 时它们还在解压目录的根上，这里先拷进 Electron.app 的 Contents/Resources，
 * 改名成星芒的 .app 时跟着走，签名前就在包里。
 */
function copyMacElectronLicenses(appOutDir, distMacOsAppName) {
  const resources = path.join(appOutDir, distMacOsAppName, 'Contents', 'Resources')
  if (!fs.statSync(resources, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`找不到 Electron 应用的资源目录：${resources}`)
  }
  const copies = [
    ['LICENSE', ELECTRON_LICENSE_FILE_NAME],
    [CHROMIUM_LICENSE_FILE_NAME, CHROMIUM_LICENSE_FILE_NAME],
  ]
  for (const [from, to] of copies) {
    const source = path.join(appOutDir, from)
    const stat = fs.lstatSync(source, { throwIfNoEntry: false })
    if (!stat?.isFile() || stat.size === 0) throw new Error(`Electron 压缩包里没有 ${from}，Mac 包补不上 Electron 与 Chromium 的许可文件`)
    fs.copyFileSync(source, path.join(resources, to))
  }
}

function assertNonEmptyRegularFile(filePath, label) {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false })
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) {
    throw new Error(`安装包里缺${label}：${filePath}`)
  }
}

/** app.asar 里 node_modules 下每个包的「名字 版本」，嵌套安装的也算。 */
function listAsarPackages(asarModule, asarPath) {
  const found = new Set()
  for (const entry of asarModule.listPackage(asarPath)) {
    const normalized = toPosix(entry).replace(/^\/+/, '')
    if (!normalized.endsWith('/package.json') || !normalized.startsWith('node_modules/')) continue
    const directory = normalized.slice(0, -'/package.json'.length)
    if (resolvePackageDirectoryFromModuleId(`/${directory}/package.json`) !== `/${directory}`) continue
    let packageJson
    try {
      packageJson = JSON.parse(asarModule.extractFile(asarPath, normalized).toString('utf8'))
    } catch {
      throw new Error(`读不到 app.asar 里的 ${normalized}`)
    }
    if (typeof packageJson.name === 'string' && typeof packageJson.version === 'string') {
      found.add(`${packageJson.name} ${packageJson.version}`)
    }
  }
  return [...found].sort()
}

/**
 * 出包后核对：清单在、Electron 与 Chromium 的许可文件在、app.asar 里的每个包都在清单上。
 * resourcesDirectory 是放清单的地方，electronLicenseDirectory 是放那两份 Electron 文件的地方
 * （Windows、Linux 是安装目录根，macOS 是 Contents/Resources）。
 */
function assertPackagedThirdPartyNotices({ resourcesDirectory, electronLicenseDirectory, asarPath, asarModule }) {
  const noticesPath = path.join(resourcesDirectory, NOTICES_FILE_NAME)
  assertNonEmptyRegularFile(noticesPath, '第三方许可清单')
  assertNonEmptyRegularFile(path.join(electronLicenseDirectory, ELECTRON_LICENSE_FILE_NAME), ' Electron 许可文件')
  assertNonEmptyRegularFile(path.join(electronLicenseDirectory, CHROMIUM_LICENSE_FILE_NAME), ' Chromium 许可文件')
  // 清单里 Nsis7z 那一条说 LGPL-2.1 全文在 Chromium 的许可文件里（ffmpeg 那一节），这里钉住，
  // 哪天 Electron 升级后那一节不再附全文，就得回来给清单补一份。
  const chromium = fs.readFileSync(path.join(electronLicenseDirectory, CHROMIUM_LICENSE_FILE_NAME), 'utf8')
  if (!chromium.includes('GNU LESSER GENERAL PUBLIC LICENSE') || !chromium.includes('Version 2.1, February 1999')) {
    throw new Error(`安装包里的 ${CHROMIUM_LICENSE_FILE_NAME} 不再附 LGPL-2.1 全文，第三方许可清单里 Nsis7z 那一条要补上全文`)
  }
  const notices = fs.readFileSync(noticesPath, 'utf8')
  if (!notices.startsWith(NOTICES_HEADING)) throw new Error('安装包里的第三方许可清单内容不对')
  const listed = new Set(notices.split('\n').filter((line, index, lines) => line && lines[index - 1] === RULE))
  const missing = listAsarPackages(asarModule, asarPath).filter((entry) => !listed.has(entry))
  if (missing.length > 0) throw new Error(`app.asar 里这些包不在第三方许可清单上：${missing.join('、')}`)
  return { noticesPath, listedCount: listed.size }
}

if (require.main === module) {
  try {
    const result = generateThirdPartyNotices()
    console.log(`[third-party-notices] 已写出 ${toPosix(path.relative(PROJECT_ROOT, result.target))}：${result.packageCount} 个 npm 包，${result.extraCount} 项手工登记`)
  } catch (error) {
    console.error(`[third-party-notices] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

module.exports = {
  ACCEPTED_LICENSES,
  BUNDLES,
  CHROMIUM_LICENSE_FILE_NAME,
  ELECTRON_LICENSE_FILE_NAME,
  EXPECTED_PACKAGES,
  NOTICES_FILE_NAME,
  NOTICES_HEADING,
  OUTPUT_DIRECTORY_NAME,
  assertPackagedThirdPartyNotices,
  buildBundleManifest,
  buildBundledExtras,
  buildThirdPartyNotices,
  collectProductionPackageDirectories,
  collectThirdPartyEntries,
  copyMacElectronLicenses,
  extractLobeIconsLicense,
  generateThirdPartyNotices,
  inspectInstalledPackage,
  isAcceptedLicense,
  listAsarPackages,
  noticesOutputPath,
  normalizeLicenseField,
  normalizeRepositoryUrl,
  readBundleManifest,
  resolvePackageDirectoryFromModuleId,
  resolveToolchainPackageFromModuleId,
  writeBundleManifest,
}
