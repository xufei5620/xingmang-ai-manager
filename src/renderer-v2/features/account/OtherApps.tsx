import { Copy } from 'lucide-react'
import { Button, Card, ListRow, useToast } from '../../ui'
import type { AccountSiteId } from '../../account-context'
import { otherAppsAnchor } from '../../registry/business'
import {
  copyOtherAppAddress,
  otherAppAddresses,
  otherAppsFootnote,
  otherAppsLead,
  otherAppsRequestText,
  otherAppsTitle,
} from './other-apps'

/** 页面里的剪贴板；没有这个接口时当写不进去。 */
function writeClipboard(text: string): Promise<void> {
  return navigator.clipboard?.writeText ? navigator.clipboard.writeText(text) : Promise.reject(new Error('clipboard unavailable'))
}

/**
 * 密钥管理最下面「用在别的软件里」那张卡（Q1）：地址按当前账号给（星芒账号 xm，历史账号 api），
 * 客户改不了，也不写站点名。说明在 other-apps.ts。
 */
export function OtherAppsCard({
  siteId,
  onRequestApp,
  copyText = writeClipboard,
}: {
  siteId: AccountSiteId
  /** 「告诉我们」去反馈表单；缺省 = 不出最底下那一行。 */
  onRequestApp?: () => void
  /** 测试替身；缺省 = 页面里的剪贴板。 */
  copyText?: (text: string) => Promise<void>
}) {
  const toast = useToast()
  // 点按钮当下就写：Electron 45 里窗口没焦点时页面写不进剪贴板，先等别的再写，客户一切走就失败。
  function copy(url: string) {
    void copyOtherAppAddress(url, copyText, toast.show)
  }
  return (
    <section className="v2-acct-section v2-acct-other-apps" data-anchor={otherAppsAnchor}>
      <Card title={otherAppsTitle} meta={otherAppsLead} testId="account-other-apps">
        {otherAppAddresses(siteId).map((row) => (
          <ListRow
            key={row.id}
            title={<code className="v2-acct-other-apps-url">{row.url}</code>}
            desc={row.hint}
            actions={
              <Button size="sm" icon={Copy} aria-label={`复制 ${row.url}`} onClick={() => copy(row.url)} testId={`account-other-apps-copy-${row.id}`}>
                复制
              </Button>
            }
            testId={`account-other-apps-${row.id}`}
          />
        ))}
        <p className="v2-acct-muted v2-acct-other-apps-note">{otherAppsFootnote}</p>
        {onRequestApp && (
          <div className="v2-acct-other-apps-ask">
            <span>{otherAppsRequestText}</span>
            <Button variant="ghost" size="sm" onClick={onRequestApp} testId="account-other-apps-request">告诉我们</Button>
          </div>
        )}
      </Card>
    </section>
  )
}
