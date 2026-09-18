import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { RealmAccountError } from './realm-account'

// 双站点(xm.solov.cc 与 api.solov.cc)对用户是无感的:站点由登录的账号决定,
// 界面上既没有选站点的地方,也不该出现「站点」这个概念或内部后端代号。
// 这条门禁扫的是会被拼进上屏文案的字符串字面量,再写出一句
// 「当前站点暂不支持…」会当场红(D-06)。
const forbiddenWords = ['站点', 'Sub2API']

// 装配期自检:这三个文件里的「站点」只在打包配置写错时抛,正常用户碰不到,
// 保留原文是为了让排查的人一眼看出是站点表配错了。
const assemblyTimeFiles = new Set([
  path.join('electron', 'backend-registry.ts'),
  path.join('electron', 'relay-sites.ts'),
  path.join('electron', 'site-runtime.ts'),
])

function sourceFiles(root: string, directory: string): string[] {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(root, relative)
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return []
    return assemblyTimeFiles.has(relative) ? [] : [relative]
  })
}

function literalsOf(file: string): Array<{ line: number; text: string }> {
  const sourceText = fs.readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true)
  const found: Array<{ line: number; text: string }> = []
  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      found.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: node.text })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('user-facing wording', () => {
  it('never names a relay site or an internal backend in a shippable string', () => {
    const root = path.join(__dirname, '..')
    const files = [...sourceFiles(root, 'electron'), ...sourceFiles(root, 'src')]
    expect(files.length).toBeGreaterThan(100)
    const offenders = files.flatMap((relative) => literalsOf(path.join(root, relative))
      .filter((literal) => forbiddenWords.some((word) => literal.text.includes(word)))
      .map((literal) => `${relative}:${literal.line} ${literal.text}`))
    expect(offenders).toEqual([])
  })

  it('reports account-scoped realm failures without a site', () => {
    expect(new RealmAccountError('UNSUPPORTED').message).toBe('当前账号暂不支持此功能')
    expect(new RealmAccountError('DISABLED').message).toBe('当前账号服务尚未启用')
    expect(new RealmAccountError('TWO_FACTOR_REQUIRED').message).toBe('此账号需要双重验证，请先在官方网站完成验证')
  })
})
