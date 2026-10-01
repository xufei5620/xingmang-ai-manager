import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cliNativePackageCandidates, cliNativePackageMissingMessage, findMissingCliNativePackage } from './cli-native-package'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-cli-native-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

// Mirrors the published @anthropic-ai/claude-code@2.1.277 manifest.
const claudeManifest = {
  name: '@anthropic-ai/claude-code',
  version: '2.1.277',
  scripts: { postinstall: 'node install.cjs' },
  optionalDependencies: {
    '@anthropic-ai/claude-code-linux-x64': '2.1.277',
    '@anthropic-ai/claude-code-win32-x64': '2.1.277',
    '@anthropic-ai/claude-code-darwin-x64': '2.1.277',
    '@anthropic-ai/claude-code-linux-arm64': '2.1.277',
    '@anthropic-ai/claude-code-win32-arm64': '2.1.277',
    '@anthropic-ai/claude-code-darwin-arm64': '2.1.277',
    '@anthropic-ai/claude-code-linux-x64-musl': '2.1.277',
  },
}

// Codex publishes its platform builds as npm aliases of itself.
const codexManifest = {
  name: '@openai/codex',
  version: '0.159.3',
  optionalDependencies: {
    '@openai/codex-darwin-arm64': 'npm:@openai/codex@0.159.3-darwin-arm64',
    '@openai/codex-win32-x64': 'npm:@openai/codex@0.159.3-win32-x64',
  },
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value))
}

function installPackage(nodeModules: string, manifest: { name: string }): string {
  const root = path.join(nodeModules, ...manifest.name.split('/'))
  writeJson(path.join(root, 'package.json'), manifest)
  return root
}

describe('cliNativePackageCandidates', () => {
  it('lists every architecture published for the platform', () => {
    expect(cliNativePackageCandidates(claudeManifest, '@anthropic-ai/claude-code', 'darwin')).toEqual([
      '@anthropic-ai/claude-code-darwin-x64',
      '@anthropic-ai/claude-code-darwin-arm64',
    ])
    expect(cliNativePackageCandidates(claudeManifest, '@anthropic-ai/claude-code', 'linux')).toContain(
      '@anthropic-ai/claude-code-linux-x64-musl',
    )
  })

  it('needs nothing when the package ships no platform build', () => {
    const gemini = { optionalDependencies: { 'node-pty': '1.0.0', '@lydell/node-pty-darwin-arm64': '1.1.0' } }
    expect(cliNativePackageCandidates(gemini, '@google/gemini-cli', 'darwin')).toEqual([])
    expect(cliNativePackageCandidates({ name: 'x' }, '@google/gemini-cli', 'darwin')).toEqual([])
    expect(cliNativePackageCandidates(null, '@google/gemini-cli', 'darwin')).toEqual([])
  })

  it('ignores names that could walk out of node_modules', () => {
    const hostile = { optionalDependencies: { '@anthropic-ai/claude-code-darwin-../../x': '1' } }
    expect(cliNativePackageCandidates(hostile, '@anthropic-ai/claude-code', 'darwin')).toEqual([])
  })
})

describe('findMissingCliNativePackage', () => {
  it('reports the platform build npm silently skipped', async () => {
    const nodeModules = path.join(temporaryDirectory(), 'lib', 'node_modules')
    const root = installPackage(nodeModules, claudeManifest)
    await expect(findMissingCliNativePackage(root, '@anthropic-ai/claude-code', 'darwin')).resolves.toMatch(
      /^@anthropic-ai\/claude-code-darwin-(arm64|x64)$/,
    )
  })

  it('accepts the platform build nested under the package', async () => {
    const nodeModules = path.join(temporaryDirectory(), 'lib', 'node_modules')
    const root = installPackage(nodeModules, claudeManifest)
    installPackage(path.join(root, 'node_modules'), { name: '@anthropic-ai/claude-code-darwin-arm64' })
    await expect(findMissingCliNativePackage(root, '@anthropic-ai/claude-code', 'darwin')).resolves.toBeNull()
  })

  it('accepts a platform build hoisted to the global root', async () => {
    const nodeModules = path.join(temporaryDirectory(), 'node_modules')
    const root = installPackage(nodeModules, claudeManifest)
    installPackage(nodeModules, { name: '@anthropic-ai/claude-code-win32-x64' })
    await expect(findMissingCliNativePackage(root, '@anthropic-ai/claude-code', 'win32')).resolves.toBeNull()
  })

  it('accepts an aliased Codex platform build under its alias directory', async () => {
    const nodeModules = path.join(temporaryDirectory(), 'lib', 'node_modules')
    const root = installPackage(nodeModules, codexManifest)
    writeJson(path.join(root, 'node_modules', '@openai', 'codex-darwin-arm64', 'package.json'), {
      name: '@openai/codex',
      version: '0.159.3-darwin-arm64',
    })
    await expect(findMissingCliNativePackage(root, '@openai/codex', 'darwin')).resolves.toBeNull()
    await expect(findMissingCliNativePackage(root, '@openai/codex', 'win32')).resolves.toBe('@openai/codex-win32-x64')
  })

  it('does not count an empty directory left behind by an interrupted extract', async () => {
    const nodeModules = path.join(temporaryDirectory(), 'lib', 'node_modules')
    const root = installPackage(nodeModules, claudeManifest)
    fs.mkdirSync(path.join(root, 'node_modules', '@anthropic-ai', 'claude-code-darwin-arm64'), { recursive: true })
    await expect(findMissingCliNativePackage(root, '@anthropic-ai/claude-code', 'darwin')).resolves.not.toBeNull()
  })

  it('leaves a missing package to the version check', async () => {
    const root = path.join(temporaryDirectory(), 'node_modules', '@anthropic-ai', 'claude-code')
    await expect(findMissingCliNativePackage(root, '@anthropic-ai/claude-code', 'darwin')).resolves.toBeNull()
  })
})

describe('cliNativePackageMissingMessage', () => {
  it('tells the customer what to do without naming packages', () => {
    const message = cliNativePackageMissingMessage('Claude Code')
    expect(message).toContain('换个网络')
    expect(message).not.toMatch(/npm|optional|native|@/i)
  })
})
