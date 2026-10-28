// 桌面 v2 编辑器的用例（桌面 000f9131 的 canvas-v2/src/components/template-catalog-markup.test.ts），#4 搬进内核。
// 内核有意和 v2 不一样的地方，期望改成内核的行为或退役，改动处写了为什么，汇总见 docs/canvas-kernel-v2-tests.md。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(path.join(import.meta.dirname, 'TemplateCatalog.tsx'), 'utf8')

describe('TemplateCatalog accessibility contract', () => {
  it('keeps the storefront and configurator semantics discoverable', () => {
    expect(source).toContain('role="dialog"')
    expect(source).toContain("'行业模板库'")
    expect(source).toContain('aria-label="行业筛选"')
    expect(source).toContain('aria-label="最大请求估算"')
    expect(source).toContain('role="note"')
    // 内核允许模型还没接入时先填写并保存工作流，按钮不再因此禁用，改在下面说明生成前要接入什么。
    expect(source).toContain('!canvasTemplateCompatibility(selected, imageModels, videoModels, textModels).available && <p className="template-unavailable">')
    // 内核还能从素材库选图，「导入本地素材」改叫「导入本地图片」。
    expect(source).toContain('导入本地图片')
  })
})
