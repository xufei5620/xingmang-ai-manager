import type { ReactNode } from 'react'
import type { useToast } from '../../ui'
import type { createToolsApi } from '../tools/api'
import type { ToolId } from '../tools/model'
import type { useToolbox } from '../tools/useToolbox'
import type { createAppApi } from './api'

// App.tsx 拆出来的那几个 hook（#1070 第 8 步）都要拿的几样东西，类型写在一处。
export type AppApi = ReturnType<typeof createAppApi>
export type ToolsApi = ReturnType<typeof createToolsApi>
export type Toolbox = ReturnType<typeof useToolbox>
export type AppToast = ReturnType<typeof useToast>
/** App 的 perform：做一件事，没做成就弹统一的错误框（OperationErrorDialog），框里能重试。 */
export type Perform = (label: string, work: () => Promise<unknown>, tool?: ToolId) => Promise<void>

/** 等用户点头的确认框（Confirm）：点了确认那颗才做 work，做成了才关，没做成照旧开着、能重试。 */
export interface PendingConfirmation { title: string; body: ReactNode; label: string; danger?: boolean; /** 失败时「复制路径」要复制哪个工具的安装目录；与工具无关的确认不填。 */ tool?: ToolId; work(): Promise<void> }
