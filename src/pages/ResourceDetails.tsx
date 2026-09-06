import { Drawer } from '../components/ui'

export interface ResourceDetailsValue {
  title: string
  fields: ReadonlyArray<readonly [string, string]>
}

export function ResourceDetails({ value, onClose }: { value: ResourceDetailsValue | null; onClose: () => void }) {
  return <Drawer open={value !== null} title={value?.title ?? '详情'} onClose={onClose} testId="resource-detail-drawer">
    <dl className="ui-detail-fields">{value?.fields.map(([label, content]) => <div key={label}><dt>{label}</dt><dd>{content || '未提供'}</dd></div>)}</dl>
  </Drawer>
}
