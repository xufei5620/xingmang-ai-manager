import { describe, expect, it } from 'vitest'
import { isCodexConfigBroken } from './codex-config-syntax'

const relayConfig = [
  'model_provider = "XingmangAI"',
  'model = "gpt-6-sol"',
  'approval_policy = "on-request"',
  'notify = ["C:\\\\Program Files\\\\nodejs\\\\node.exe", "C:\\\\Users\\\\张三\\\\hook.cjs"]',
  '',
  '[model_providers.XingmangAI]',
  'name = "XingmangAI"',
  'base_url = "https://xm.solov.cc/v1"',
  'wire_api = "responses"',
  '',
  '[projects."C:\\\\Users\\\\张三\\\\项目"]',
  'trust_level = "trusted"',
  '',
].join('\n')

function broken(text: string): boolean {
  return isCodexConfigBroken(Buffer.from(text, 'utf8'))
}

describe('isCodexConfigBroken', () => {
  it('accepts the config the app writes, with or without a byte order mark', () => {
    expect(broken(relayConfig)).toBe(false)
    expect(broken(`\uFEFF${relayConfig}`)).toBe(false)
    expect(broken(relayConfig.replace(/\n/g, '\r\n'))).toBe(false)
    expect(broken('')).toBe(false)
    expect(broken('# 只有注释\n')).toBe(false)
  })

  // Codex 0.159.0-alpha.12.1 (the Codex Desktop 26.930 build) reads each of
  // these; the bundled TOML 0.5 parser rejects them all. They must not be
  // reported as broken, or the home page would offer to reset a working file.
  it('does not report TOML 1.1 syntax that Codex reads but the bundled parser does not', () => {
    for (const line of [
      'xm = [1, "a"]',
      'xm = {\n  a = 1, # 注释\n  b = 2,\n}',
      'xm = "\\e[0m \\x41"',
      'xm = 07:32',
      'xm = 1979-05-27T07:32Z',
      'xm = """a"""""',
      "xm = '''a'''''",
    ]) {
      expect(broken(`${line}\n${relayConfig}`), line).toBe(false)
    }
  })

  it('reports a file Codex cannot decode as UTF-8', () => {
    // 「张三」 saved by Notepad as GBK (ANSI on a Chinese Windows).
    const gbk = Buffer.concat([Buffer.from('[projects."C:\\\\Users\\\\'), Buffer.from([0xd5, 0xc5, 0xc8, 0xfd]), Buffer.from('"]\ntrust_level = "trusted"\n')])
    expect(isCodexConfigBroken(gbk)).toBe(true)
  })

  it('reports control characters that TOML forbids even in comments', () => {
    // A power cut right after a save can leave the whole file as zero bytes.
    expect(isCodexConfigBroken(Buffer.alloc(300))).toBe(true)
    expect(broken(`# a\u0001b\n${relayConfig}`)).toBe(true)
    expect(broken(`# a\u007fb\n${relayConfig}`)).toBe(true)
    expect(broken('xm = 1\rmodel = "a"\n')).toBe(true)
  })

  it('reports duplicate keys and tables written by other tools', () => {
    expect(broken(`model = "dup"\n${relayConfig}`)).toBe(true)
    expect(broken(`${relayConfig}[model_providers.XingmangAI]\nname = "again"\n`)).toBe(true)
    expect(broken('xm = { a = 1 }\nxm.b = 2\n')).toBe(true)
    expect(broken('xm = [1]\n[[xm]]\n')).toBe(true)
  })

  it('reports a file that stops half way through', () => {
    expect(broken('model = "gpt-6-sol"\nmodel_reasoning_effort = "xhi')).toBe(true)
    expect(broken('model = "gpt-6-sol"\nmodel_reasoning_eff')).toBe(true)
    expect(broken('model = "gpt-6-sol"\nmodel_reasoning_effort =')).toBe(true)
    expect(broken('model = "gpt-6-sol"\n[model_providers.Xingm')).toBe(true)
    expect(broken('developer_instructions = """abc\n')).toBe(true)
  })

  it('reports hand edits Codex refuses', () => {
    expect(broken('xm = "C:\\Users\\a"\n')).toBe(true)
    expect(broken('xm = "D:\\projects"\n')).toBe(true)
    expect(broken('model = “gpt-6-sol”\n')).toBe(true)
    expect(broken('model ＝ "gpt-6-sol"\n')).toBe(true)
    expect(broken('<<<<<<< HEAD\nmodel = "a"\n=======\nmodel = "b"\n>>>>>>> other\n')).toBe(true)
    expect(broken('{"model": "gpt-6-sol"}\n')).toBe(true)
  })
})
