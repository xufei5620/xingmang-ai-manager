import { useMemo, useState } from 'react'
import type { DramaParseTables } from '../library/drama-model'
import { defaultDramaConfirmSelection, type DramaConfirmSelection } from '../library/drama-layout'

interface DramaParseConfirmProps {
  tables: DramaParseTables
  onCancel(): void
  onConfirm(selection: DramaConfirmSelection): void
}

function TableSection<T>({
  title,
  rows,
  idOf,
  labelOf,
  selected,
  renamed,
  onToggle,
  onRename,
}: {
  title: string
  rows: readonly T[]
  idOf(row: T): string
  labelOf(row: T): string
  selected: ReadonlySet<string>
  renamed: Record<string, string>
  onToggle(id: string): void
  onRename(id: string, name: string): void
}) {
  return (
    <section className="drama-confirm-section">
      <header><strong>{title}</strong><small>{selected.size}/{rows.length}</small></header>
      <ul>
        {rows.map((row) => {
          const id = idOf(row)
          return (
            <li key={id}>
              <label>
                <input type="checkbox" checked={selected.has(id)} onChange={() => onToggle(id)} />
                <input
                  value={renamed[id] ?? labelOf(row)}
                  aria-label={`${title}名称`}
                  onChange={(event) => onRename(id, event.target.value)}
                />
              </label>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function DramaParseConfirm({ tables, onCancel, onConfirm }: DramaParseConfirmProps) {
  const initial = useMemo(() => defaultDramaConfirmSelection(tables), [tables])
  const [characterIds, setCharacterIds] = useState(() => new Set(initial.characterIds))
  const [sceneIds, setSceneIds] = useState(() => new Set(initial.sceneIds))
  const [propIds, setPropIds] = useState(() => new Set(initial.propIds))
  const [shotIds, setShotIds] = useState(() => new Set(initial.shotIds))
  const [renamed, setRenamed] = useState<Record<string, string>>({})

  function toggle(set: (value: Set<string>) => void, current: Set<string>, id: string) {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    set(next)
  }

  const canConfirm = characterIds.size + sceneIds.size + propIds.size + shotIds.size > 0

  return (
    <div className="run-preflight-backdrop" role="presentation">
      <section className="run-preflight drama-parse-confirm" role="dialog" aria-modal="true" aria-label="确认剧本解析">
        <header>
          <span><strong>确认四表后落成节点</strong></span>
          <button type="button" onClick={onCancel} aria-label="关闭解析确认">×</button>
        </header>
        <p>只会生成圣经、资产和分镜，不会自动创建出图节点，也不会消耗生图额度。</p>
        <div className="drama-confirm-grid">
          <TableSection title="角色" rows={tables.characters} idOf={(row) => row.elementId} labelOf={(row) => row.name} selected={characterIds} renamed={renamed} onToggle={(id) => toggle(setCharacterIds, characterIds, id)} onRename={(id, name) => setRenamed((current) => ({ ...current, [id]: name }))} />
          <TableSection title="场景" rows={tables.scenes} idOf={(row) => row.elementId} labelOf={(row) => row.name} selected={sceneIds} renamed={renamed} onToggle={(id) => toggle(setSceneIds, sceneIds, id)} onRename={(id, name) => setRenamed((current) => ({ ...current, [id]: name }))} />
          <TableSection title="道具" rows={tables.props} idOf={(row) => row.elementId} labelOf={(row) => row.name} selected={propIds} renamed={renamed} onToggle={(id) => toggle(setPropIds, propIds, id)} onRename={(id, name) => setRenamed((current) => ({ ...current, [id]: name }))} />
          <TableSection title="镜头" rows={tables.shots} idOf={(row) => row.shotId} labelOf={(row) => row.shotId} selected={shotIds} renamed={renamed} onToggle={(id) => toggle(setShotIds, shotIds, id)} onRename={(id, name) => setRenamed((current) => ({ ...current, [id]: name }))} />
        </div>
        <footer>
          <button type="button" onClick={onCancel}>取消</button>
          <button
            type="button"
            className="is-primary"
            disabled={!canConfirm}
            onClick={() => onConfirm({
              characterIds: [...characterIds],
              sceneIds: [...sceneIds],
              propIds: [...propIds],
              shotIds: [...shotIds],
              renamed,
            })}
          >生成资产与分镜</button>
        </footer>
      </section>
    </div>
  )
}
