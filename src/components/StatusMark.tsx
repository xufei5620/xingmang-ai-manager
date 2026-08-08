import { Check, LoaderCircle, X } from 'lucide-react'

export function StatusMark({ installed, loading }: { installed: boolean; loading?: boolean }) {
  if (loading) return <LoaderCircle size={16} className="spin" />
  return installed
    ? <span className="status-mark installed"><Check size={12} strokeWidth={3} /></span>
    : <span className="status-mark missing"><X size={12} strokeWidth={3} /></span>
}
