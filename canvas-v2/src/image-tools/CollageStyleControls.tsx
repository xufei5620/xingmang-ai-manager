import type { ImageCollageRecipe } from './recipe'
import { buildCollageLayout } from './collage-layout'
import { imageCollageTemplates, resolveImageCollageTemplate, type ImageCollageTemplate } from './collage-templates'
import './collage-templates.css'

interface CollageStyleControlsProps {
  recipe: ImageCollageRecipe
  onChange(value: Partial<ImageCollageRecipe>): void
}

function CollageTemplateThumbnail({ template }: { template: ImageCollageTemplate }) {
  const size = { width: 160, height: 100 }
  const cells = buildCollageLayout(Array.from({ length: template.inputCount }, () => size), { kind: 'collage', rows: 1, columns: 1, gap: 4, padding: 0, outputWidth: size.width, outputHeight: size.height, fit: 'cover', background: 'transparent', layout: template.layout }).cells
  return <svg className="collage-template-thumbnail" viewBox="0 0 160 100" aria-hidden="true" focusable="false">
    {cells.map((cell, index) => <g key={index} data-template-cell={`${cell.x},${cell.y},${cell.width},${cell.height}`}><rect {...cell} rx={5} /><text x={cell.x + cell.width / 2} y={cell.y + cell.height / 2} textAnchor="middle" dominantBaseline="central">{index + 1}</text></g>)}
  </svg>
}

export function CollageLayoutControls({ recipe, inputCount, onChange }: CollageStyleControlsProps & { inputCount: number }) {
  const layout = recipe.layout ?? 'grid'
  const heroUnavailable = inputCount < 2 || inputCount > 3
  const selectedTemplate = resolveImageCollageTemplate(layout)
  return <section className="image-tool-collage-layout" aria-label="拼图布局">
    <h3>拼图布局</h3>
    <div className="image-tool-layout-presets">
      {([['grid', '网格'], ['horizontal', '横向拼接'], ['vertical', '纵向拼接'], ['hero-left', '主图在左'], ['hero-top', '主图在上']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={layout === value} disabled={value.startsWith('hero-') && heroUnavailable} title={value.startsWith('hero-') && heroUnavailable ? '主辅图布局需要 2–3 张图片' : label} onClick={() => onChange({ layout: value, autoSize: value === 'horizontal' || value === 'vertical' })}>{label}</button>)}
    </div>
    {(layout === 'horizontal' || layout === 'vertical') && <label className="image-tool-checks"><input type="checkbox" checked={recipe.autoSize ?? false} onChange={(event) => onChange({ autoSize: event.currentTarget.checked })} />按图片比例自动确定输出尺寸</label>}
    <p className="image-tool-setting-hint">{selectedTemplate ? `${selectedTemplate.description} 需要恰好 ${selectedTemplate.inputCount} 张图片。` : layout === 'horizontal' ? '横向按共同高度连接，保留每张图片的宽高比。' : layout === 'vertical' ? '纵向按共同宽度连接，保留每张图片的宽高比。' : layout.startsWith('hero-') ? '第一张为主图，其余图片放入侧栏；支持 2–3 张输入。' : '按输入顺序放入格子；图片多于格数的布局不可选。'}</p>
    {layout === 'grid' && <div className="image-tool-layout-presets">{[[1, 2, '横向双图'], [2, 1, '竖向双图'], [2, 2, '四宫格'], [2, 3, '六宫格'], [3, 3, '九宫格'], [4, 4, '十六宫格']].map(([rows, columns, label]) => <button type="button" key={label} disabled={inputCount > Number(rows) * Number(columns)} aria-pressed={recipe.rows === rows && recipe.columns === columns} onClick={() => onChange({ rows: Number(rows), columns: Number(columns) })}>{label}</button>)}</div>}
    <div className="collage-template-heading"><h3>构图模板</h3><span>{inputCount} 张输入</span></div>
    <div className="collage-template-grid" aria-label="固定比例拼图模板">
      {imageCollageTemplates.map((template) => {
        const unavailable = inputCount !== template.inputCount
        return <button type="button" className="collage-template-card" key={template.layout} aria-label={`${template.title} · 需要 ${template.inputCount} 张图片`} aria-pressed={layout === template.layout} disabled={unavailable} title={unavailable ? `${template.title}需要恰好 ${template.inputCount} 张图片，当前 ${inputCount} 张` : template.description} onClick={() => onChange({ layout: template.layout, autoSize: false })}>
          <CollageTemplateThumbnail template={template} />
          <span className="collage-template-label"><strong>{template.title}</strong><span>{template.inputCount} 张</span></span>
        </button>
      })}
    </div>
    <p className="image-tool-setting-hint collage-template-note">模板按固定比例分区，可在预览中调整图片顺序。仅启用张数匹配的模板，所有输入都会保留。</p>
  </section>
}

function StyleNumber({ label, value, maximum, onChange }: { label: string; value: number; maximum: number; onChange(value: number): void }) {
  return <label>{label}<input type="number" aria-label={label} min={0} max={maximum} step={1} value={value} onChange={(event) => {
    const next = event.currentTarget.valueAsNumber
    if (Number.isFinite(next)) onChange(Math.round(Math.max(0, Math.min(maximum, next))))
  }} /></label>
}

export function CollageStyleControls({ recipe, onChange }: CollageStyleControlsProps) {
  const watermark = recipe.watermark
  return <section className="image-tool-collage-styles" aria-label="拼图样式">
    <h3>拼图样式</h3>
    <div className="image-tool-fields">
      <StyleNumber label="圆角（像素）" value={recipe.cornerRadius ?? 0} maximum={256} onChange={(cornerRadius) => onChange({ cornerRadius })} />
      <StyleNumber label="边框宽度（像素）" value={recipe.borderWidth ?? 0} maximum={64} onChange={(borderWidth) => onChange({ borderWidth })} />
    </div>
    <label>边框颜色<input type="color" aria-label="拼图边框颜色" value={(recipe.borderColor ?? '#ffffff').slice(0, 7)} disabled={!(recipe.borderWidth ?? 0)} onChange={(event) => onChange({ borderColor: event.currentTarget.value })} /></label>
    <label className="image-tool-checks"><input type="checkbox" checked={recipe.shadow ?? false} onChange={(event) => onChange({ shadow: event.currentTarget.checked })} />图片阴影</label>
    <p className="image-tool-setting-hint">样式会写入输出图片。圆角和内侧边框作用于格子；阴影在输出边缘裁切，可增加边距留白。</p>
    <label className="image-tool-checks"><input type="checkbox" checked={!!watermark} onChange={(event) => onChange({ watermark: event.currentTarget.checked ? { text: '', color: '#ffffff', opacity: 0.15, fontSize: 16 } : undefined })} />平铺文字水印</label>
    {watermark && <div className="image-tool-watermark-fields">
      <label>水印文字<input type="text" aria-label="拼图水印文字" placeholder="输入自己的品牌或署名" maxLength={160} value={watermark.text} onChange={(event) => onChange({ watermark: { ...watermark, text: event.currentTarget.value } })} /></label>
      <label>水印颜色<input type="color" aria-label="拼图水印颜色" value={watermark.color.slice(0, 7)} onChange={(event) => onChange({ watermark: { ...watermark, color: event.currentTarget.value } })} /></label>
      <div className="image-tool-fields">
        <StyleNumber label="水印不透明度 %" value={Math.round(watermark.opacity * 100)} maximum={100} onChange={(opacity) => onChange({ watermark: { ...watermark, opacity: opacity / 100 } })} />
        <label>水印字号<input type="number" aria-label="水印字号" min={10} max={128} step={1} value={watermark.fontSize} onChange={(event) => {
          const fontSize = event.currentTarget.valueAsNumber
          if (Number.isFinite(fontSize)) onChange({ watermark: { ...watermark, fontSize: Math.round(Math.min(128, Math.max(10, fontSize))) } })
        }} /></label>
      </div>
      <p className="image-tool-setting-hint">文字斜向重复覆盖整张输出，字号以输出像素计。{!watermark.text.trim() ? '填写文字后才会显示水印。' : ''}</p>
    </div>}
  </section>
}
