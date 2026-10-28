import type { AssetLibrarySource } from './official-asset-browser-model'
import './official-asset-browser.css'
export function AssetSourceTabs({ value, onChange, official = true, disabled = false }: { value: AssetLibrarySource; onChange(value: AssetLibrarySource): void; official?: boolean; disabled?: boolean }) {
  return <nav className="asset-source-tabs" aria-label="素材来源">{([{ id: 'official', label: '官方素材' }, { id: 'mine', label: '我的素材' }, { id: 'recent', label: '最近使用' }] as const).filter((item) => official || item.id !== 'official').map((item) => <button type="button" key={item.id} disabled={disabled} aria-pressed={value === item.id} className={value === item.id ? 'is-active' : ''} onClick={() => { if (value !== item.id) onChange(item.id) }}>{item.label}</button>)}</nav>
}
