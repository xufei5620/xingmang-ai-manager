export type ManagedBootstrapStepId =
  | 'sync-keys'
  | 'authorize-codex'
  | 'inspect-environment'
  | 'prepare-node'
  | 'prepare-codex-cli'
  | 'prepare-codex-desktop'
  | 'scan-installed-clis'
  | 'configure-installed-clis'
  | 'verify-config'
  | 'enter-dashboard'

export type ManagedBootstrapStepStatus = 'pending' | 'active' | 'completed' | 'failed'

export interface ManagedBootstrapStep {
  id: ManagedBootstrapStepId
  label: string
  detail: string
  status: ManagedBootstrapStepStatus
  message: string | null
}

export interface ManagedBootstrapProgress {
  steps: ManagedBootstrapStep[]
  percent: number
  activeStep: ManagedBootstrapStep | null
}

export interface ManagedBootstrapProgressUpdate {
  id: ManagedBootstrapStepId
  status: Exclude<ManagedBootstrapStepStatus, 'pending'>
  message?: string
}

const stepDefinitions: ReadonlyArray<Omit<ManagedBootstrapStep, 'status' | 'message'>> = [
  { id: 'sync-keys', label: '同步专属 Key', detail: '创建并加密缓存账号分组 Key' },
  { id: 'authorize-codex', label: '写入 Codex 授权', detail: '配置 GPT-中转/订阅 Key 与默认模型' },
  { id: 'inspect-environment', label: '检测本机环境', detail: '核对 Node.js、npm 与 Codex 组件' },
  { id: 'prepare-node', label: '准备 Node.js', detail: '安装或验证 Node.js 和 npm' },
  { id: 'prepare-codex-cli', label: '准备 Codex CLI', detail: '安装并验证 @openai/codex' },
  { id: 'prepare-codex-desktop', label: '准备桌面端', detail: '安装或验证 Codex Desktop' },
  { id: 'scan-installed-clis', label: '扫描 AI 工具', detail: '发现已安装的四类 CLI' },
  { id: 'configure-installed-clis', label: '配置全部 CLI', detail: '写入各自分组 Key 和模型' },
  { id: 'verify-config', label: '读后验证', detail: '复核 Key、Relay 与模型' },
  { id: 'enter-dashboard', label: '进入工作台', detail: '保存完成状态并载入工作台' },
]

function deriveProgress(steps: ManagedBootstrapStep[]): ManagedBootstrapProgress {
  const completed = steps.filter((step) => step.status === 'completed').length
  const activeStep = steps.find((step) => step.status === 'active' || step.status === 'failed') ?? null
  return {
    steps,
    percent: Math.round((completed / steps.length) * 100),
    activeStep,
  }
}

export function createManagedBootstrapProgress(): ManagedBootstrapProgress {
  return deriveProgress(stepDefinitions.map((step) => ({
    ...step,
    status: 'pending',
    message: null,
  })))
}

export function updateManagedBootstrapProgress(
  current: ManagedBootstrapProgress,
  update: ManagedBootstrapProgressUpdate,
): ManagedBootstrapProgress {
  const targetIndex = current.steps.findIndex((step) => step.id === update.id)
  if (targetIndex < 0) return current
  const steps = current.steps.map((step, index) => {
    if (index < targetIndex && update.status !== 'failed' && step.status !== 'failed') {
      return { ...step, status: 'completed' as const }
    }
    if (index !== targetIndex) {
      return step.status === 'active' ? { ...step, status: 'pending' as const } : step
    }
    return {
      ...step,
      status: update.status,
      message: update.message?.trim() || null,
    }
  })
  return deriveProgress(steps)
}
