import type { ReactNode } from 'react'
import { Archive, ArrowRight, ArrowUpRight, Check, ChevronDown, Download, FileText, FolderOpen, Globe2, Home, Image, KeyRound, MessageSquare, Monitor, MoreHorizontal, Package, Play, Plug, RefreshCw, ScanLine, Search, Settings2, ShieldCheck, Sparkles, Terminal, UserRound, Wrench, Zap } from 'lucide-react'
import type { TutorialIllustrationId } from '../../registry/tutorials'
import './tutorial-illustration.css'

const illustrationDescriptions: Record<TutorialIllustrationId, { title: string; description: string; hint: string }> = {
  'desktop-home': { title: '点「打开」，进入 Codex 桌面端', description: '在星芒工具箱首页找到 Codex 桌面端这一行，点击打开。随后会出现独立的 Codex 桌面窗口，在新窗口里输入问题即可。', hint: '打开后，去新出现的 Codex 窗口里提问。' },
  'desktop-install': { title: '认准「Codex 桌面端」这一行', description: 'Windows 在星芒工具箱首页找到 Codex 桌面端，未安装时点击安装。Mac 在工具箱外完成安装后返回检测。已经安装过的用户先点击首页重新检测。', hint: '图示为 Windows 安装；Mac 在工具箱外安装后，回来重新检测。' },
  'desktop-config': { title: '用默认选择，保存配置', description: '在 Codex 桌面端配置中选择使用星芒账号，访问密钥选择自动准备，默认模型保留自动选择的结果，然后点击保存配置。', hint: '保存只改账号、密钥和模型，其他设置会留着。' },
  'desktop-message': { title: '先发一句话，看看它的回复', description: '在独立的 Codex 桌面窗口里输入一个简单的中文问题，例如请用中文告诉我你能帮我做什么，再发送并等待回复。简单提问不用先选项目文件夹。图中回复仅为示意。', hint: '能收到回复，就可以开始问自己的问题了。' },
  'desktop-project': { title: '处理文件时，选择本地项目', description: '需要处理本地文件时，在 Codex 桌面端里选择项目文件夹，再输入具体任务，等待并阅读回复。简单提问可以直接新建对话。示例问题要求先说明项目内容，不修改文件；图中回复仅为示意。', hint: '先用练习项目熟悉操作；允许改文件前，先看清它准备做什么。' },
  home: { title: '先认识三个常用入口', description: '首页工具区用于安装、配置和打开工具；左侧聊天可以直接提问；左下角账号入口用于登录和查看余额。', hint: '首页管工具，聊天直接用，左下角管账号。' },
  account: { title: '先登录自己的星芒账号', description: '点击工具箱左下角的未登录账号区域，按提示登录。完成后，左下角会显示自己的账号昵称，先确认登录的是自己准备使用的账号。图中不包含真实账号。', hint: '左下角出现自己的账号昵称，就完成这一步了。' },
  install: { title: '找到工具，点击安装', description: '在首页找到想使用的工具，点击它右侧的安装。CLI 需要的运行环境可在首页右侧运行环境区域检查。', hint: '先装一个需要的工具，不必一次全部安装。' },
  config: { title: '确认来源、密钥和模型', description: '配置窗口内选择星芒账号，确认访问密钥与默认模型，然后点击保存配置；其他自定义设置会保留。', hint: '点「保存配置」即可，其他自定义设置会保留。' },
  launch: { title: '在自己的文件夹里开始', description: '点击工具行的打开，按提示选择工作文件夹。CLI 会在这个文件夹打开，随后在工具窗口中输入自己的任务。', hint: '先用测试文件夹练习，再让 AI 处理正式项目。' },
  chat: { title: '不打开终端，也能直接提问', description: '左侧选择聊天，在输入框上方选择文本对话、分组和模型，输入具体问题，再点击输入框右侧的发送消息。', hint: '先确认分组和模型，再描述你希望完成的事。' },
  canvas: { title: '把提示词连到图像节点', description: '在画布中添加提示词和图像节点，连接两个节点，检查生成配置，再运行此节点。图中未执行生成。', hint: '连接节点后再运行；保存工作流不等于生成图片。' },
  acceleration: { title: '选线路，再开始加速', description: '在游戏加速页面选择加速线路，可以选智能分配；TUN 模式可用时按需开启，连接后须先停止加速再切换。不使用时点击停止加速。', hint: '连接后才计时；用完点击「停止加速」。' },
  extensions: { title: '先选工具，再添加能力', description: '在外接工具页面先选择要配置的 AI 工具，再点添加连接。技能和插件分别在自己的页面管理。', hint: '扩展按工具分别管理，先确认当前选中的是哪个工具。' },
  skills: { title: '技能要导入到对应的工具', description: '在技能页面先选择工具，例如 Codex CLI，再点击导入技能。列表可查看技能的来源与范围；系统内置技能只能查看。', hint: '不同工具的导入能力不同；先选工具，再看可用操作。' },
  plugins: { title: '在插件页面选择工具和来源', description: '在插件页面选择要使用插件的工具，再点击添加插件；已安装和市场是两个不同页签，市场能力以当前工具实际支持为准。', hint: '先确认插件适用的工具，再按作者提供的来源添加。' },
  backup: { title: '改设置前，先留一份配置备份', description: '在备份页面的马上备份区域选择工具，点击创建备份。随后核对列表中的工具和时间，通过预览确认包含的配置文件。图中未创建真实备份。', hint: '备份范围是工具配置；项目代码需要另外备份。' },
  health: { title: '有问题时，从检查开始', description: '进入检查页面运行检查，阅读异常项给出的处理建议，完成处理后重新检查；需要帮助时进入帮助与客服。', hint: '先看具体异常，再按建议处理，完成后重新检查。' },
}

function Marker({ children }: { children: ReactNode }) {
  return <span className="tutorial-illustration-marker">{children}</span>
}

function Control({ children, primary = false }: { children: ReactNode; primary?: boolean }) {
  return <span className={`tutorial-illustration-control${primary ? ' is-primary' : ''}`}>{children}</span>
}

function Pane({ title, children, className = '' }: { title: ReactNode; children: ReactNode; className?: string }) {
  return <div className={`tutorial-illustration-pane ${className}`}><div className="tutorial-illustration-pane-title">{title}</div>{children}</div>
}

function Diagram({ kind }: { kind: TutorialIllustrationId }) {
  switch (kind) {
    case 'desktop-home':
      return <div className="tutorial-illustration-desktop-home">
        <Pane title={<><Marker>1</Marker>星芒工具箱 · 首页</>}>
          <div className="tutorial-illustration-tool"><Monitor size={25} /><strong>Codex 桌面端</strong><Control primary>打开<ArrowUpRight size={14} /></Control></div>
          <p className="tutorial-illustration-note">找到这一行，点右侧「打开」</p>
        </Pane>
        <ArrowRight className="tutorial-illustration-arrow" size={22} />
        <Pane title={<><Marker>2</Marker>Codex 桌面端</>}>
          <div className="tutorial-illustration-desktop-destination"><Monitor size={26} /><div><strong>新打开的窗口</strong><small>在这里提问、看回复</small></div></div>
        </Pane>
      </div>
    case 'desktop-install':
      return <div className="tutorial-illustration-install">
        <div className="tutorial-illustration-row"><span><Marker>1</Marker>星芒工具箱 · 首页</span><span className="tutorial-illustration-muted">找到桌面端</span></div>
        <div className="tutorial-illustration-tool tutorial-illustration-highlight"><Monitor size={26} /><div className="tutorial-illustration-grow"><strong>Codex 桌面端</strong><small>在独立窗口里与 AI 一起处理项目</small></div><Control primary><Download size={15} />安装</Control><Marker>2</Marker></div>
        <div className="tutorial-illustration-row tutorial-illustration-runtime"><RefreshCw size={17} /><span>已经装过？</span><span className="tutorial-illustration-muted">先点首页右上角</span><Control>重新检测</Control></div>
      </div>
    case 'desktop-config':
      return <div className="tutorial-illustration-config">
        <div className="tutorial-illustration-row"><Monitor size={19} /><strong>Codex 桌面端</strong><Control primary><Marker>1</Marker>使用星芒账号</Control></div>
        <div className="tutorial-illustration-field"><span>访问密钥（Key）</span><span><KeyRound size={14} />自动准备（推荐）<ChevronDown size={14} /></span></div>
        <div className="tutorial-illustration-field"><span>默认模型</span><span>保留自动选择的模型<ChevronDown size={14} /></span></div>
        <div className="tutorial-illustration-row tutorial-illustration-save"><span>不用自己填写密钥</span><Control primary><Marker>2</Marker>保存配置<ArrowRight size={14} /></Control></div>
      </div>
    case 'desktop-message':
      return <Pane title={<><Monitor size={17} />Codex 桌面端 · 新打开的窗口</>}>
        <div className="tutorial-illustration-first-message">
          <div className="tutorial-illustration-first-message-step"><span><Marker>1</Marker>输入后发送</span><div className="tutorial-illustration-desktop-prompt"><MessageSquare size={17} /><p>请用中文告诉我，<br />你能帮我做什么？</p></div></div>
          <ArrowRight className="tutorial-illustration-arrow" size={22} />
          <div className="tutorial-illustration-first-message-step"><span><Marker>2</Marker>等待回复</span><div className="tutorial-illustration-desktop-reply"><small>回复示例 · 仅演示</small><p>我可以帮你写文案、整理资料，也能处理项目文件。</p></div></div>
        </div>
      </Pane>
    case 'desktop-project':
      return <div className="tutorial-illustration-desktop-project">
        <div className="tutorial-illustration-folder"><FolderOpen size={34} /><strong>我的练习项目</strong><span><Marker>1</Marker>选择本地文件夹</span></div>
        <ArrowRight className="tutorial-illustration-arrow" size={22} />
        <Pane title={<><Monitor size={17} />Codex 桌面端</>}>
          <div className="tutorial-illustration-desktop-conversation"><div className="tutorial-illustration-desktop-prompt"><Marker>2</Marker><p>请先看看这个项目，告诉我它是做什么的。先不要修改文件。</p></div><div className="tutorial-illustration-desktop-reply"><small>回复示例 · 仅演示</small><p>这个项目主要用于……<br />我会先说明结构和使用方式。</p></div></div>
        </Pane>
      </div>
    case 'home':
      return <div className="tutorial-illustration-split">
        <div className="tutorial-illustration-rail">
          <span className="is-selected"><Home size={16} />首页</span>
          <span><Marker>2</Marker>聊天</span>
          <span className="tutorial-illustration-rail-account"><Marker>3</Marker>账号</span>
        </div>
        <Pane title={<><Marker>1</Marker>首页工具区</>}>
          <div className="tutorial-illustration-tool"><Terminal size={22} /><strong>Claude Code</strong><Control primary>打开<ArrowUpRight size={14} /></Control><MoreHorizontal size={18} /></div>
          <div className="tutorial-illustration-tool"><Terminal size={22} /><strong>Codex CLI</strong><Control>安装</Control><MoreHorizontal size={18} /></div>
          <p className="tutorial-illustration-note">更多操作「⋯」里可以配置工具</p>
        </Pane>
      </div>
    case 'account':
      return <div className="tutorial-illustration-flow">
        <Pane title="左下角账号区域" className="tutorial-illustration-account">
          <div className="tutorial-illustration-person"><UserRound size={28} /><span><strong>未登录</strong><small>点账号区域开始登录</small></span><Marker>1</Marker></div>
          <div className="tutorial-illustration-row"><Control primary>登录</Control></div>
        </Pane>
        <ArrowRight className="tutorial-illustration-arrow" size={22} />
        <Pane title={<><Marker>2</Marker>登录后看这里</>}>
          <div className="tutorial-illustration-person"><UserRound size={28} /><span><strong>自己的账号昵称</strong><small>这里会显示你的账号</small></span></div>
          <p className="tutorial-illustration-note">确认是自己要使用的账号</p>
        </Pane>
      </div>
    case 'install':
      return <div className="tutorial-illustration-install">
        <div className="tutorial-illustration-row"><span><Marker>1</Marker>首页 · 还可以装</span><span className="tutorial-illustration-muted">按需选择</span></div>
        <div className="tutorial-illustration-tool tutorial-illustration-highlight"><Terminal size={24} /><div className="tutorial-illustration-grow"><strong>Claude Code</strong><small>在终端里和 AI 一起写代码</small></div><Control primary><Download size={15} />安装</Control><Marker>2</Marker></div>
        <div className="tutorial-illustration-row tutorial-illustration-runtime"><Settings2 size={16} /><span>运行环境</span><span className="tutorial-illustration-muted">Node.js · npm · Python</span><ArrowRight size={16} /><span>缺什么，再准备什么</span></div>
      </div>
    case 'config':
      return <div className="tutorial-illustration-config">
        <div className="tutorial-illustration-row"><span>用哪个账号使用 AI</span><Control primary><Check size={14} />使用星芒账号</Control></div>
        <div className="tutorial-illustration-field"><span>访问密钥（Key）</span><span><KeyRound size={14} />自动准备（推荐）<ChevronDown size={14} /></span></div>
        <div className="tutorial-illustration-field"><span>默认模型</span><span>选择想用的模型<ChevronDown size={14} /></span></div>
        <div className="tutorial-illustration-row tutorial-illustration-save"><span><Marker>1</Marker>核对密钥和模型</span><Control primary>保存配置</Control><Marker>2</Marker></div>
      </div>
    case 'launch':
      return <div className="tutorial-illustration-launch">
        <div className="tutorial-illustration-row"><strong>CLI 工具 · 首页</strong><Control primary>打开<ArrowUpRight size={14} /></Control></div>
        <div className="tutorial-illustration-flow"><div className="tutorial-illustration-folder"><FolderOpen size={32} /><strong>我的练习项目</strong><span><Marker>1</Marker>选择文件夹</span></div><ArrowRight className="tutorial-illustration-arrow" size={22} /><div className="tutorial-illustration-terminal"><span><Terminal size={15} />工具窗口</span><p>请先看看这个项目，<br />告诉我它是做什么的。</p><small><Marker>2</Marker>输入任务，开始对话</small></div></div>
      </div>
    case 'chat':
      return <div className="tutorial-illustration-chat">
        <div className="tutorial-illustration-row"><MessageSquare size={18} /><strong>聊天</strong><span className="tutorial-illustration-muted">先从一个具体问题开始</span></div>
        <div className="tutorial-illustration-options"><Marker>1</Marker><Control primary>文本对话</Control><Control>分组<ChevronDown size={14} /></Control><Control>模型<ChevronDown size={14} /></Control></div>
        <div className="tutorial-illustration-compose"><p>请帮我把这段工作笔记整理成一份清晰的待办清单。</p><span><Marker>2</Marker><Control primary>发送消息<ArrowUpRight size={15} /></Control></span></div>
      </div>
    case 'canvas':
      return <div className="tutorial-illustration-canvas">
        <div className="tutorial-illustration-node"><span><Marker>1</Marker>提示词</span><p>一张简洁的咖啡店海报<br />暖色调，留出标题位置</p><small>先写清画面要求</small></div>
        <div className="tutorial-illustration-edge"><span>连接</span><ArrowRight size={26} /></div>
        <div className="tutorial-illustration-node"><span><Image size={17} />图像节点</span><p>检查分组、模型<br />和图片尺寸</p><Control primary><Marker>2</Marker><Play size={14} />运行此节点</Control></div>
      </div>
    case 'acceleration':
      return <div className="tutorial-illustration-acceleration">
        <Pane title={<><Globe2 size={18} />加速线路</>}><div className="tutorial-illustration-row"><Marker>1</Marker><strong>智能分配</strong><ChevronDown size={16} /></div><p className="tutorial-illustration-note">也可选择线路并检测 Ping</p></Pane>
        <div className="tutorial-illustration-acceleration-actions"><div className="tutorial-illustration-row"><strong>TUN 模式</strong><span className="tutorial-illustration-muted">可用时按需开启</span></div><Control primary><Marker>2</Marker><Zap size={16} />开始加速</Control><small>不用时记得停止加速</small></div>
      </div>
    case 'extensions':
      return <div className="tutorial-illustration-extensions">
        <div className="tutorial-illustration-row"><Plug size={19} /><strong>外接工具</strong><Control>添加连接</Control><Marker>2</Marker></div>
        <div className="tutorial-illustration-options"><Marker>1</Marker><Control primary>Claude Code</Control><Control>Codex CLI</Control><Control>Gemini CLI</Control></div>
        <div className="tutorial-illustration-row tutorial-illustration-runtime"><ShieldCheck size={20} /><div><strong>确认它需要哪些权限</strong><small>只添加任务确实需要的连接</small></div></div>
      </div>
    case 'skills':
      return <div className="tutorial-illustration-extensions">
        <div className="tutorial-illustration-row"><Sparkles size={19} /><strong>技能</strong><Control>导入技能</Control><Marker>2</Marker></div>
        <div className="tutorial-illustration-options"><Marker>1</Marker><Control>Claude Code</Control><Control primary>Codex CLI</Control><Control>Gemini CLI</Control></div>
        <div className="tutorial-illustration-row tutorial-illustration-runtime"><FileText size={20} /><div><strong>看清来源与范围</strong><small>系统内置 · 我的（全局） · 当前项目</small></div></div>
      </div>
    case 'plugins':
      return <div className="tutorial-illustration-extensions">
        <div className="tutorial-illustration-row"><Package size={19} /><strong>插件</strong><Control>添加插件</Control><Marker>2</Marker></div>
        <div className="tutorial-illustration-options"><Marker>1</Marker><Control primary>Claude Code</Control><Control>Codex CLI</Control><Control>Gemini CLI</Control></div>
        <div className="tutorial-illustration-options"><Control primary>已安装</Control><Control>市场</Control><span className="tutorial-illustration-muted">市场能力以当前工具为准</span></div>
      </div>
    case 'backup':
      return <div className="tutorial-illustration-backup">
        <Pane title={<><Archive size={17} />备份</>}><div className="tutorial-illustration-backup-details"><strong>核对工具与时间</strong><span>时间 · 以实际创建记录为准</span><span>配置文件 · 在预览中核对</span><Control><FileText size={14} />预览</Control></div></Pane>
        <Pane title="马上备份"><div className="tutorial-illustration-backup-details"><div className="tutorial-illustration-row"><Marker>1</Marker><strong>Codex CLI</strong><ChevronDown size={14} /></div><Control primary><Marker>2</Marker><Archive size={15} />创建备份</Control><small>先选择准备调整的工具</small></div></Pane>
      </div>
    case 'health':
      return <div className="tutorial-illustration-health">
        <div className="tutorial-illustration-row"><ScanLine size={19} /><strong>检查</strong><Control primary>重新检查</Control><Marker>1</Marker></div>
        <div className="tutorial-illustration-health-item"><Search size={20} /><div><strong>阅读具体异常</strong><small>例如：环境未安装、配置缺失、网络不可达</small></div></div>
        <div className="tutorial-illustration-row tutorial-illustration-runtime"><Marker>2</Marker><Wrench size={17} /><span>按检查结果的建议处理</span><ArrowRight size={17} /><strong>回来复查</strong></div>
      </div>
  }
}

export function TutorialIllustration({ kind }: { kind: TutorialIllustrationId }) {
  const description = illustrationDescriptions[kind]
  return <figure className="tutorial-illustration" data-testid={`tutorial-illustration-${kind}`} data-tutorial-illustration={kind} role="img" aria-label={`${description.description} 操作示意，示例数据。`}>
    <div className="tutorial-illustration-heading"><span className="tutorial-illustration-heading-line" /><strong>{description.title}</strong></div>
    <div className="tutorial-illustration-image">
      <div aria-hidden="true"><Diagram kind={kind} /></div>
    </div>
    <figcaption><span>操作示意 · 示例数据</span><span>{description.hint}</span></figcaption>
  </figure>
}
