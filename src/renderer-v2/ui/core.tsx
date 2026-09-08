import { forwardRef, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Archive, ChevronDown, FolderOpen, MoreHorizontal, RefreshCw } from 'lucide-react';
import { tools } from '../registry/tools';
import { statuses } from '../registry/status';
import { BrandIcon, Kbd, type ToolId } from './brand';
import { Menu, type MenuItem } from './floating';
import { cx, iconSize, useBalanceTier, useUiText, type BaseProps, type Icon, type Size, type Tone } from './shared';

export type ButtonProps = BaseProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'style' | 'color'> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent' | 'balance'; size?: Size; icon?: Icon; iconRight?: Icon; loading?: boolean; kbd?: string;
};
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', icon: Icon, iconRight: Right, loading, disabled, kbd, children, testId, type = 'button', ...props }, ref) {
  const tier = useBalanceTier();
  return <button {...props} ref={ref} className={cx('xm-btn', 'xm-btn-' + variant, 'xm-btn-' + size, !children && 'xm-btn-icon')} data-balance-tier={variant === 'balance' ? tier : undefined} data-testid={testId} disabled={disabled || loading} aria-busy={loading || undefined} type={type}>
    {loading ? <RefreshCw className="xm-spin" size={iconSize[size]} aria-hidden="true" /> : Icon ? <Icon size={iconSize[size]} aria-hidden="true" /> : null}
    {children && <span>{children}</span>}{Right && <Right size={iconSize[size]} aria-hidden="true" />}{kbd && <Kbd keys={kbd} />}
  </button>;
});
export function Pill({ tone = 'neutral', dot = false, children, testId }: BaseProps & { tone?: Tone; dot?: boolean; children?: ReactNode }) {
  return <span className={'xm-pill xm-tone-' + tone} data-testid={testId}>{dot && <i aria-hidden="true" />}{children}</span>;
}
export function Card({ title, meta, actions, collapsible, padding = 'md', children, testId }: BaseProps & { title?: ReactNode; meta?: ReactNode; actions?: ReactNode; collapsible?: boolean; padding?: 'none' | 'md'; children?: ReactNode }) {
  const [open, setOpen] = useState(true); const bodyId = useId(); const t = useUiText();
  return <section className={'xm-card xm-card-' + padding} data-testid={testId}>{title && <header className="xm-card-head"><div><h2>{title}</h2>{meta && <small>{meta}</small>}</div><div className="xm-card-actions">{actions}{collapsible && <Button variant="ghost" size="sm" icon={ChevronDown} aria-label={open ? t('collapse') : t('expand')} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)} />}</div></header>}<div id={bodyId} hidden={Boolean(collapsible && !open)} className="xm-card-body">{children}</div></section>;
}
export function ListRow({ icon: Icon, title, badge, desc, descMono, meta, actions, off, testId }: BaseProps & { icon?: Icon; title: ReactNode; badge?: ReactNode; desc?: ReactNode; descMono?: boolean; meta?: ReactNode; actions?: ReactNode; off?: boolean }) {
  return <div className={cx('xm-list-row', off && 'is-off')} data-testid={testId}>{Icon && <span className="xm-row-icon"><Icon size={18} aria-hidden="true" /></span>}<div className="xm-row-main"><div className="xm-row-title">{title}{badge}</div>{desc && <div className={cx('xm-row-desc', descMono && 'xm-mono')}>{desc}</div>}</div>{meta && <div className="xm-row-meta">{meta}</div>}<div className="xm-row-actions">{actions}</div></div>;
}
export type ToolStatus = keyof typeof statuses.tool;
export function ToolRow({ tool, status, version, model, extraAction, primaryAction, menu, progress, testId }: BaseProps & { tool: ToolId; status: ToolStatus; version?: string; model?: string; extraAction?: ReactNode; primaryAction: ReactNode; menu?: Array<MenuItem | 'divider'>; progress?: number }) {
  const definition = tools.find(item => item.id === tool); const [text, tone] = statuses.tool[status]; const t = useUiText();
  const subtitle = version ? `${version.startsWith('v') ? version : 'v' + version}${model ? ' · ' + model : ''}` : definition?.vendor;
  return <div className="xm-tool-row" data-testid={testId}><BrandIcon tool={tool} size={40} variant="tile" /><div className="xm-tool-name"><strong>{definition?.name ?? tool}</strong><small title={subtitle}>{subtitle}</small></div><div className="xm-tool-status"><Pill tone={tone} dot>{text}{(status === 'installing' || status === 'updating') && typeof progress === 'number' ? ' ' + Math.round(progress) + '%' : ''}</Pill></div><div className="xm-tool-extra">{extraAction}</div><div className="xm-tool-primary">{primaryAction}</div><div className="xm-tool-menu">{menu && <Menu items={menu} label={t('more')} anchor={<Button size="sm" icon={MoreHorizontal} variant="ghost" aria-label={t('more')} />} />}</div>{typeof progress === 'number' && <div className="xm-tool-progress"><Progress value={progress} /></div>}</div>;
}
export function SessionRow({ tool, title, path, model, count, when, archived, onOpen, testId }: BaseProps & { tool: ToolId; title: string; path: string; model: string; count: number; when: string; archived?: boolean; onOpen: () => void }) {
  const t = useUiText(); const definition = tools.find(item => item.id === tool);
  return <ListRow testId={testId} icon={Archive} title={title} badge={archived && <Pill>{t('archived')}</Pill>} desc={path} descMono meta={<span>{definition?.name ?? tool} · {model} · {count} · {when}</span>} actions={<Button size="sm" icon={FolderOpen} onClick={onOpen}>{t('open')}</Button>} />;
}
type Choice = { value: string; label: string; icon?: Icon; disabled?: boolean; panelId?: string };
function Choices({ options, value, onChange, testId, kind, label, activation = kind === 'tabs' ? 'manual' : 'automatic' }: BaseProps & { options: Choice[]; value: string; onChange: (value: string) => void; kind: 'segment' | 'tabs'; label?: string; activation?: 'manual' | 'automatic' }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]); const baseId = useId();
  const selected = options.findIndex(item => item.value === value && !item.disabled);
  const entry = selected >= 0 ? selected : options.findIndex(item => !item.disabled);
  return <div className={'xm-' + kind} role={kind === 'tabs' ? 'tablist' : 'group'} aria-label={label} data-testid={testId}>{options.map(({ value: itemValue, label: itemLabel, icon: Icon, disabled, panelId }, index) => <button id={baseId + '-' + index} className={itemValue === value ? 'is-active' : ''} ref={node => { refs.current[index] = node; }} disabled={disabled} key={itemValue} tabIndex={index === entry ? 0 : -1} aria-selected={kind === 'tabs' ? itemValue === value : undefined} aria-pressed={kind === 'segment' ? itemValue === value : undefined} aria-controls={panelId} onClick={() => onChange(itemValue)} onKeyDown={event => {
    if (event.nativeEvent.isComposing || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const enabled = options.map((item, i) => item.disabled ? -1 : i).filter(i => i >= 0); const current = enabled.indexOf(index);
    const next = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled[enabled.length - 1] : enabled[(current + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length];
    if (next !== undefined) { refs.current[next]?.focus(); if (activation === 'automatic') onChange(options[next].value); }
  }} role={kind === 'tabs' ? 'tab' : undefined} type="button">{Icon && <Icon size={15} aria-hidden="true" />}{itemLabel}</button>)}</div>;
}
export function Segment(props: BaseProps & { options: Choice[]; value: string; onChange: (value: string) => void; label?: string }) { return <Choices {...props} kind="segment" />; }
export function Tabs({ items, ...props }: BaseProps & { items: Choice[]; value: string; onChange: (value: string) => void; label?: string; activation?: 'manual' | 'automatic' }) { return <Choices {...props} options={items} kind="tabs" />; }
export function Empty({ icon: Icon, title, description, action, testId }: BaseProps & { icon: Icon; title: ReactNode; description: ReactNode; action?: ReactNode }) {
  return <div className="xm-empty" data-testid={testId}><Icon size={28} aria-hidden="true" /><h3>{title}</h3>{description && <p>{description}</p>}{action}</div>;
}
export function Progress({ value, tone = 'accent', label, testId }: BaseProps & { value: number; tone?: Tone; label?: ReactNode }) {
  const safeValue = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0; const labelId = useId(); const t = useUiText();
  return <div className="xm-progress" data-testid={testId}><div className="xm-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={safeValue} aria-labelledby={label ? labelId : undefined} aria-label={label ? undefined : t('progress')}><div className={'xm-progress-bar xm-tone-' + tone} style={{ width: safeValue + '%' }} /></div>{label && <span id={labelId}>{label}</span>}</div>;
}
export function Skeleton({ rows = 3, testId }: BaseProps & { rows?: number }) {
  const t = useUiText();
  return <div className="xm-skeleton" data-testid={testId} aria-busy="true" aria-label={t('loading')}>{Array.from({ length: Math.max(1, Math.min(50, Math.floor(rows))) }, (_, index) => <i key={index} aria-hidden="true" />)}</div>;
}
type TableRow = Record<string, ReactNode>;
export function Table({ columns, rows, rowKey, onRowClick, empty, testId, label }: BaseProps & { columns: Array<{ key: string; label: string }>; rows: TableRow[]; rowKey: (row: TableRow) => string; onRowClick?: (row: TableRow) => void; empty: ReactNode; label?: string }) {
  const isAction = (target: EventTarget | null, row: EventTarget) => target instanceof HTMLElement && target !== row && Boolean(target.closest('button, a, input, select, textarea'));
  return <div className="xm-table-wrap" data-testid={testId}>{rows.length ? <table aria-label={label}><thead><tr>{columns.map(column => <th scope="col" key={column.key}>{column.label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={rowKey(row)} tabIndex={onRowClick ? 0 : undefined} aria-label={onRowClick ? String(row[columns[0]?.key] ?? rowKey(row)) : undefined} onClick={event => { if (!isAction(event.target, event.currentTarget)) onRowClick?.(row); }} onKeyDown={event => { if (onRowClick && event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onRowClick(row); } }}>{columns.map(column => <td key={column.key}>{row[column.key]}</td>)}</tr>)}</tbody></table> : <Empty icon={Archive} title={empty} description="" />}</div>;
}
export function PageHead({ title, lead, actions, testId }: BaseProps & { title: ReactNode; lead?: ReactNode; actions?: ReactNode }) { return <header className="xm-page-head" data-testid={testId}><div className="xm-page-head-copy"><h1>{title}</h1>{lead && <p>{lead}</p>}</div>{actions && <div className="xm-page-head-actions">{actions}</div>}</header>; }
export function Toolbar({ left, search, right, testId }: BaseProps & { left?: ReactNode; search?: ReactNode; right?: ReactNode }) { return <div className="xm-toolbar" data-testid={testId}>{left && <div className="xm-toolbar-left">{left}</div>}{search && <div className="xm-toolbar-search">{search}</div>}{right && <div className="xm-toolbar-right">{right}</div>}</div>; }
export function SettingRow({ title, description, control, testId }: BaseProps & { title: ReactNode; description: ReactNode; control: ReactNode }) { return <div className="xm-setting-row" data-testid={testId}><div><strong>{title}</strong><p>{description}</p></div><div>{control}</div></div>; }
