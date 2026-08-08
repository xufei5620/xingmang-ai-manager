import { Check } from 'lucide-react'

export function OnboardingStep({
  index,
  label,
  detail,
  active,
  complete,
}: {
  index: number
  label: string
  detail: string
  active: boolean
  complete: boolean
}) {
  return (
    <div className={`onboarding-step${active ? ' active' : ''}${complete ? ' complete' : ''}`}>
      <span>{complete ? <Check size={14} strokeWidth={3} /> : index}</span>
      <div>
        <strong>{label}</strong>
        <small>{detail}</small>
      </div>
    </div>
  )
}
