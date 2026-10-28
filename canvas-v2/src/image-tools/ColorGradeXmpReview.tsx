import type { ColorGradeXmpDifference, ColorGradeXmpWarning } from './layer-color-grade-xmp'

export function ColorGradeXmpReview({ mode, name, mappedFields, differences, warnings, onConfirm, onCancel }: { mode: 'import' | 'export'; name: string; mappedFields: readonly string[]; differences: readonly ColorGradeXmpDifference[]; warnings: readonly ColorGradeXmpWarning[]; onConfirm(): void; onCancel(): void }) {
  return <section className="color-grade-xmp-review" tabIndex={-1} aria-label={mode === 'import' ? 'XMP 导入参数核对' : 'XMP 导出参数核对'}>
    <header><strong>{mode === 'import' ? '核对后应用 XMP' : '核对后导出 XMP'}</strong><span>{name}</span></header>
    <p>{mode === 'import' ? '只替换文件中可映射的参数，缺失与不支持的参数保留当前值。确认只修改草稿，点击“完成调整”后才应用到图层。' : '导出 Camera Raw 参数子集。完整设置与曲线原始精度请同时保存 JSON。'}自研渲染与 Adobe 或其他工具不保证像素一致。</p>
    <details><summary>可映射参数（{mappedFields.length} 项）</summary><ul>{mappedFields.map((field) => <li key={field}>{field}</li>)}</ul></details>
    {mode === 'import' && <div className="color-grade-xmp-differences"><strong>参数变化（{differences.length} 项）</strong>{differences.length ? <table><thead><tr><th>参数</th><th>当前</th><th>导入后</th></tr></thead><tbody>{differences.map((entry) => <tr key={entry.field}><th>{entry.field}</th><td>{entry.before}</td><td>{entry.after}</td></tr>)}</tbody></table> : <p>可映射参数与当前草稿相同。</p>}</div>}
    {!!warnings.length && <details className="color-grade-xmp-warnings"><summary><strong>不支持项与互通限制（{warnings.length} 项）</strong><span>确认前请展开核对 · 未映射项不会应用</span></summary><ul>{warnings.map((entry, at) => <li key={`${entry.field}-${at}`}><b>{entry.field}</b>{entry.value && <code>{entry.value}</code>}<span>{entry.message}</span></li>)}</ul></details>}
    <div className="color-grade-xmp-actions"><button type="button" onClick={onCancel}>取消{mode === 'import' ? '导入' : '导出'}</button><button type="button" onClick={onConfirm}>{mode === 'import' ? '确认应用到草稿' : '确认并下载 XMP'}</button></div>
  </section>
}
