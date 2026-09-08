import { RefreshCw } from 'lucide-react'
import { Button, Logo, Progress } from '../../ui'
import { AuthWindow } from './AuthWindow'
import './auth.css'

export interface SplashProps { phase: string; detail?: string; progress?: number; error?: string; onRetry?: () => void }

export function Splash({ phase, detail, progress, error, onRetry }: SplashProps) {
  return <AuthWindow><main className="auth-splash" data-testid="startup-splash" aria-busy={!error}>
    <Logo kind="symbol" height={132} /><Logo kind="wordmark" height={28} />
    <div role={error ? 'alert' : 'status'}><h1>{phase}</h1>{detail && <p>{detail}</p>}{error && <p className="auth-error">{error}</p>}</div>
    {typeof progress === 'number' && <Progress value={progress} label={`${Math.round(progress)}%`} testId="startup-splash-progress" />}
    {error && onRetry && <Button icon={RefreshCw} onClick={onRetry} testId="startup-splash-retry">重新开始</Button>}
  </main></AuthWindow>
}
