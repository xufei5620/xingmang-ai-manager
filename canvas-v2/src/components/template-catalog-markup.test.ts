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
    expect(source).toContain('disabled={!canvasTemplateCompatibility')
    expect(source).toContain('导入本地素材')
  })
})
