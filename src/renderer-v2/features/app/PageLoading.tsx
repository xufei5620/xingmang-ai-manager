import { RefreshCw } from 'lucide-react'

// 按需加载的页面和聊天页读记录共用这一块：聊天页先等代码、再等记录，两段接着出现，转圈不换样子也不跳位置。
export function PageLoading() {
  return <div className="v2-business-loading" role="status" data-testid="route-loading"><RefreshCw size={24} className="xm-spin" aria-hidden="true" /><strong>正在加载页面...</strong></div>
}
