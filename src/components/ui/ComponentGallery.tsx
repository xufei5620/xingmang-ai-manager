import { useState, type FormEvent } from 'react'
import { Check, Download, FilePlus2, Moon, RefreshCw, Search, Sun, Trash2 } from 'lucide-react'
import { Button, IconButton } from './Button'
import { Input, Password, Select, Textarea } from './Fields'
import { Checkbox, Radio, SkinChip, Switch } from './Choices'
import { Segment, Tabs } from './Selection'
import { Banner, Empty, Pill, Progress, Skeleton } from './Feedback'
import { Accordion, Avatar, Inline, PageHead, Stack } from './Layout'
import { resolveUiSkin, UI_SKINS, type UiSkin } from './types'
import { Popover } from './Popover'
import { Menu } from './Menu'
import { Combobox } from './Combobox'
import { DateRange } from './DateRange'
import { Coachmark } from './Coachmark'
import { Drawer } from './Drawer'
import { DialogBackdrop } from '../Dialog'
import './ui.css'

export function ComponentGallery() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [skin, setSkin] = useState<UiSkin | 'auto'>('auto')
  const [reducedMotion, setReducedMotion] = useState(false)
  const [name, setName] = useState('工作账号')
  const [password, setPassword] = useState('demo-key-not-a-real-credential')
  const [note, setNote] = useState('用于桌面工具的本地配置。')
  const [provider, setProvider] = useState('codex')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState<string>()
  const [enabled, setEnabled] = useState(true)
  const [checked, setChecked] = useState(false)
  const [radio, setRadio] = useState('merge')
  const [filter, setFilter] = useState('all')
  const [tab, setTab] = useState('overview')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [coachOpen, setCoachOpen] = useState(false)
  const [coachTarget, setCoachTarget] = useState('gallery-coach-target')
  const [legacyOpen, setLegacyOpen] = useState(false)
  const [nestedPopoverOpen, setNestedPopoverOpen] = useState(false)
  const [selectedModel, setSelectedModel] = useState('alpha')
  const [dateRange, setDateRange] = useState({ start: '2026-09-01', end: '2026-09-07' })

  const modelOptions = [
    { value: 'alpha', label: 'Alpha', description: '文本模型' },
    { value: 'disabled', label: '不可用模型', disabled: true },
    { value: 'beta', label: 'Beta', description: '推理模型' },
  ]

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) {
      setError('请填写配置名称。')
      document.getElementById('gallery-name')?.focus()
      return
    }
    setError(undefined)
    setSaved(true)
    setNotice(`已保存检阅草稿：${name}`)
  }

  return (
    <main className="ui-gallery" data-theme={theme} data-skin={resolveUiSkin(theme, skin)}
      data-reduced-motion={reducedMotion} data-testid="component-gallery">
      <div className="ui-gallery-inner">
        <PageHead title="星芒 AI / 组件检阅" actions={<Segment label="明暗主题" value={theme} onChange={setTheme}
          options={[{ value: 'light', label: '亮色', icon: Sun }, { value: 'dark', label: '暗色', icon: Moon }]} />} />
        <section className="ui-gallery-section" aria-label="外观">
          <Inline>{UI_SKINS.map((item) => <SkinChip key={item.value} skin={item.value} label={item.label}
            selected={resolveUiSkin(theme, skin) === item.value} onSelect={setSkin} />)}
            <Button size="sm" variant="ghost" onClick={() => setSkin('auto')}>默认皮肤</Button>
            <Switch label="减少动画" checked={reducedMotion} onChange={setReducedMotion} />
          </Inline>
        </section>

        <section className="ui-gallery-section">
          <h2>动作与状态</h2>
          <Stack>
            <Inline>
              <Button variant="primary" icon={Download} loading={busy} testId="gallery-primary" onClick={() => setBusy(true)}>下载更新</Button>
              <Button icon={RefreshCw} onClick={() => { setBusy(false); setNotice('已重置检阅状态') }}>重新检查</Button>
              <Button variant="ghost" icon={Search} size="sm" onClick={() => setNotice('当前没有匹配记录')}>查看记录</Button>
              <Button variant="danger" icon={Trash2} size="sm" onClick={() => setNotice('检阅草稿已移除')}>移除草稿</Button>
              <IconButton icon={FilePlus2} label="添加配置" onClick={() => document.getElementById('gallery-name')?.focus()} />
              <Button disabled size="xs">暂无更新</Button>
            </Inline>
            <Inline><Pill tone="ok" dot>已配好</Pill><Pill tone="warn" dot>有更新</Pill><Pill tone="bad" dot>需要处理</Pill><Pill dot>未安装</Pill><Pill tone="info">官方来源</Pill></Inline>
          </Stack>
        </section>

        <section className="ui-gallery-section">
          <h2>配置表单</h2>
          <form onSubmit={submit} noValidate>
            <div className="ui-gallery-grid">
              <Stack>
                <Input id="gallery-name" label="配置名称" value={name} onChange={(event) => { setName(event.target.value); if (event.target.value.trim()) setError(undefined) }}
                  error={error} hint="名称只用于本地识别。" required />
                <Password label="API Key" value={password} onChange={(event) => setPassword(event.target.value)} mono showLabel="显示 API Key" hideLabel="隐藏 API Key" />
                <Select label="工具" value={provider} onChange={(event) => setProvider(event.target.value)}>
                  <option value="codex">Codex CLI</option><option value="claude">Claude Code</option><option value="gemini">Gemini CLI</option>
                </Select>
                <Textarea label="备注" value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} showCount />
              </Stack>
              <Stack>
                <Switch label="完成后通知" description="配置准备完成后发送通知。" checked={enabled} onChange={setEnabled} />
                <Checkbox label="保留已有模型设置" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
                <Checkbox label="部分工具已选中" indeterminate checked={false} readOnly />
                <Switch label="启动时自动打开" checked={false} disabled onChange={() => undefined} />
                <fieldset><legend>保存方式</legend><Stack gap="xs">
                  <Radio name="gallery-save-mode" value="merge" label="合并配置" description="保留已有的自定义字段。" checked={radio === 'merge'} onChange={() => setRadio('merge')} />
                  <Radio name="gallery-save-mode" value="reset" label="重置配置" description="使用当前表单重新生成配置。" checked={radio === 'reset'} onChange={() => setRadio('reset')} />
                </Stack></fieldset>
                <Input label="配置路径" mono readOnly value={'C:\\Users\\Developer\\.codex\\config.toml'} />
                <Inline><Button variant="primary" type="submit" icon={Check}>保存草稿</Button>{saved && <Pill tone="ok">已保存</Pill>}</Inline>
              </Stack>
            </div>
          </form>
        </section>

        <section className="ui-gallery-section">
          <h2>列表视图</h2>
          <Stack>
            <Segment label="记录筛选" value={filter} onChange={setFilter} options={[
              { value: 'all', label: '全部' }, { value: 'recent', label: '最近' }, { value: 'archived', label: '已归档' },
            ]} />
            <Tabs label="账号内容" value={tab} onChange={setTab} items={[
              { value: 'overview', label: '账号概览', content: <Inline><Avatar name="星芒用户" status={{ label: '已登录', online: true }} /><span>星芒用户</span><Pill tone="ok">已登录</Pill></Inline> },
              { value: 'usage', label: '使用记录', content: <Empty title="没有使用记录" description="完成第一次调用后，记录会显示在这里。" /> },
              { value: 'disabled', label: '暂不可用', disabled: true, content: null },
              { value: 'devices', label: '登录设备', content: <span>当前设备 · Windows</span> },
            ]} />
          </Stack>
        </section>

        <section className="ui-gallery-section">
          <h2>反馈与恢复</h2>
          <div className="ui-gallery-grid">
            <Stack>
              <Banner title="配置已保存" tone="ok">工具将在下次启动时读取新配置。</Banner>
              <Banner title="环境检查未完成" tone="warn" actions={<Button size="sm" onClick={() => setNotice('检阅：保留当前配置')}>查看详情</Button>}>当前配置已保留。</Banner>
              <Banner title="请求未完成" tone="bad" actions={<Button size="sm" onClick={() => setNotice('检阅：重试请求')}>重试</Button>}>无法连接服务。请检查网络后重试。</Banner>
            </Stack>
            <Stack>
              <Progress value={65} label="正在下载" />
              <Progress label="正在检查运行环境" />
              <Skeleton label="正在读取记录" rows={3} />
              <Accordion title="配置文件详情">config.toml · UTF-8</Accordion>
            </Stack>
          </div>
        </section>
        <section className="ui-gallery-section" aria-label="浮层与筛选控件">
          <h2>浮层与筛选</h2>
          <Stack>
            <Inline>
              <Popover trigger={<Button>配置提示</Button>} label="配置提示" open={popoverOpen} onOpenChange={setPopoverOpen}>
                <p>保留当前配置，再选择模型。</p><Button size="sm" onClick={() => setPopoverOpen(false)}>知道了</Button>
              </Popover>
              <Menu trigger={<Button>更多动作</Button>} label="更多动作" items={[
                { id: 'open', label: '打开配置', onSelect: () => setNotice('已选择打开配置') },
                { id: 'disabled', label: '暂不可用', disabled: true, onSelect: () => setNotice('不应执行禁用项') },
                { id: 'remove', label: '移除配置', danger: true, onSelect: () => setNotice('已选择移除配置') },
              ]} />
              <Button onClick={() => setDrawerOpen(true)}>查看详细配置</Button>
              <Button id="gallery-coach-target" onClick={() => { setCoachTarget('gallery-coach-target'); setCoachOpen(true) }}>查看引导标记</Button>
              <Button onClick={() => setLegacyOpen(true)}>查看兼容弹窗</Button>
              <Menu trigger={<Button>文本操作</Button>} label="文本操作" items={[
                { id: 'save', label: 'Save draft', onSelect: () => setNotice('已保存文本草稿') },
                { id: 'send', label: 'Send draft', onSelect: () => setNotice('已选择发送文本草稿') },
              ]} />
            </Inline>
            <Combobox label="搜索模型" value={selectedModel} onChange={setSelectedModel} options={modelOptions} />
            <DateRange label="日期范围" value={dateRange} onChange={setDateRange} />
            <div className="ui-gallery-clipped" id="gallery-coach-scroll">
              <Button id="gallery-clipped-target" onClick={() => { setCoachTarget('gallery-clipped-target'); setCoachOpen(true) }}>查看局部滚动引导</Button>
              <div className="ui-gallery-clipped-space" aria-hidden="true" />
            </div>
          </Stack>
        </section>
        <Drawer open={drawerOpen} title="详细配置" onClose={() => setDrawerOpen(false)}>
          <Stack>
            <Combobox label="详情模型" value={selectedModel} onChange={setSelectedModel} options={modelOptions} />
            <Menu trigger={<Button>详情动作</Button>} label="详情动作" items={[
              { id: 'copy', label: '读取配置', onSelect: () => setNotice('已选择读取配置') },
              { id: 'reset', label: '恢复默认', onSelect: () => setSelectedModel('alpha') },
            ]} />
          </Stack>
        </Drawer>
        {legacyOpen && <DialogBackdrop className="config-modal-backdrop" onDismiss={() => setLegacyOpen(false)}>
          <section className="ui-gallery-legacy-dialog" role="dialog" aria-modal="true" aria-label="兼容弹窗">
            <h2>兼容弹窗</h2>
            <Button data-initial-focus>第一个动作</Button>
            <Popover trigger={<Button>附加选项</Button>} label="附加选项" open={nestedPopoverOpen} onOpenChange={setNestedPopoverOpen}>
              <Input label="内部字段" defaultValue="现有草稿" /><Button>最后一个动作</Button>
            </Popover>
            <Button onClick={() => setLegacyOpen(false)}>关闭兼容弹窗</Button>
          </section>
        </DialogBackdrop>}
        <Coachmark open={coachOpen} target={() => document.getElementById(coachTarget)} title="配置入口"
          onSkip={() => setCoachOpen(false)} onComplete={() => setCoachOpen(false)} onTargetMissing={() => setCoachOpen(false)}
          reducedMotion={reducedMotion} onReducedMotionChange={setReducedMotion}>当前目标可见时才显示标记。</Coachmark>
        <p className="ui-gallery-status" role="status" aria-live="polite">{notice}</p>
      </div>
    </main>
  )
}
