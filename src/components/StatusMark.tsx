import { Check, LoaderCircle, TriangleAlert, X } from 'lucide-react'

export function StatusMark({
  installed,
  loading,
  failed,
}: {
  installed: boolean
  loading?: boolean
  failed?: boolean
}) {
  if (loading) return <LoaderCircle size={16} className="spin" />
  // Detection failure must render distinctly from "confirmed not installed" —
  // an X would otherwise read as a definite answer we do not actually have.
  if (failed) return <span className="status-mark failed"><TriangleAlert size={12} strokeWidth={3} /></span>
  return installed
    ? <span className="status-mark installed"><Check size={12} strokeWidth={3} /></span>
    : <span className="status-mark missing"><X size={12} strokeWidth={3} /></span>
}
