import { FolderCog, LoaderCircle } from 'lucide-react'
import './asset-category-controls.css'

export interface AssetCategoryOption { id: string; name: string }

export interface AssetCategorySelectProps {
  items: readonly AssetCategoryOption[]
  value: string | null | undefined
  onChange(value: string | null | undefined): void
  mode?: 'filter' | 'destination'
  label?: string
  disabled?: boolean
  loading?: boolean
  directoryConfirmed?: boolean
  onManage?(): void
}

export function AssetCategorySelect({ items, value, onChange, mode = 'filter', label = '素材分类', disabled = false, loading = false, directoryConfirmed = true, onManage }: AssetCategorySelectProps) {
  const encoded = value === null ? 'uncategorized' : value === undefined ? mode === 'filter' ? 'all' : '' : value
  const missing = typeof value === 'string' && !items.some((item) => item.id === value)
  function change(next: string) {
    if (disabled || loading) return
    if (next === 'all' && mode === 'filter') onChange(undefined)
    else if (next === 'uncategorized') onChange(null)
    else if (items.some((item) => item.id === next)) onChange(next)
  }
  return <div className="asset-category-select-row">
    <label><span>{label}</span><select aria-label={label} value={encoded} disabled={disabled || loading} onChange={(event) => change(event.target.value)}>
      {mode === 'filter' ? <option value="all">全部分类</option> : <option value="" disabled>选择目标分类</option>}
      <option value="uncategorized">未分类</option>
      {missing && <option value={value ?? ''} disabled>{loading ? '正在核对所选分类…' : directoryConfirmed ? '原分类已不可用，请重新选择' : '所选分类待核对'}</option>}
      {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>
    {loading && <span className="asset-category-reading" role="status"><LoaderCircle size={13} />读取分类…</span>}
    {onManage && <button type="button" className="asset-category-manage-button" aria-label="管理素材分类" disabled={disabled || loading} onClick={onManage}><FolderCog size={14} /><span>管理分类</span></button>}
  </div>
}

export function AssetCategoryFilter(props: Omit<AssetCategorySelectProps, 'mode'>) { return <AssetCategorySelect {...props} mode="filter" /> }
