import { useId } from 'react'

/** Decorative network geometry, deliberately independent of actual routes or telemetry. */
export function Globe() {
  const id = useId().replaceAll(':', '')
  const dots = []
  for (let latitude = -72; latitude <= 72; latitude += 12) {
    const lat = latitude * Math.PI / 180
    for (let longitude = -84; longitude <= 84; longitude += 12) {
      const lon = longitude * Math.PI / 180
      dots.push({
        x: 240 + Math.cos(lat) * Math.sin(lon) * 128,
        y: 173 + Math.sin(lat) * 128,
        opacity: .18 + Math.cos(lat) * Math.cos(lon) * .53,
      })
    }
  }
  return <svg className="acceleration-globe" viewBox="0 0 480 348" fill="none" aria-hidden="true">
    <defs>
      <radialGradient id={`${id}-atmosphere`}><stop stopColor="var(--xm-sky)" stopOpacity=".16" /><stop offset="1" stopColor="var(--xm-sky)" stopOpacity="0" /></radialGradient>
      <radialGradient id={`${id}-surface`} cx=".28" cy=".25" r=".9"><stop stopColor="var(--xm-slate)" stopOpacity=".5" /><stop offset=".66" stopColor="var(--xm-navy)" stopOpacity=".24" /><stop offset="1" stopColor="var(--xm-navy)" stopOpacity=".8" /></radialGradient>
      <linearGradient id={`${id}-orbit`}><stop stopColor="var(--xm-sky)" stopOpacity=".04" /><stop offset=".55" stopColor="var(--xm-gold)" stopOpacity=".86" /><stop offset="1" stopColor="var(--xm-sky)" stopOpacity=".2" /></linearGradient>
    </defs>
    <circle cx="240" cy="173" r="174" fill={`url(#${id}-atmosphere)`} />
    <g className="acceleration-globe-orbits" stroke="var(--xm-sky)">
      <ellipse cx="240" cy="173" rx="191" ry="63" transform="rotate(-24 240 173)" strokeOpacity=".12" strokeDasharray="2 7" />
      <ellipse cx="240" cy="173" rx="168" ry="157" strokeOpacity=".07" />
      <path d="M 42 173 H 63 M 417 173 H 438 M 240 12 V 23 M 240 324 V 335" strokeOpacity=".35" />
      <circle cx="240" cy="173" r="144" strokeOpacity=".09" strokeDasharray="1 10" />
    </g>
    <circle cx="240" cy="173" r="128" fill={`url(#${id}-surface)`} stroke="var(--xm-sky)" strokeOpacity=".35" />
    <g transform="rotate(-18 240 173)" stroke="var(--xm-sky)" strokeWidth=".7" strokeOpacity=".2">
      <ellipse cx="240" cy="173" rx="45" ry="128" />
      <ellipse cx="240" cy="173" rx="91" ry="128" />
      <ellipse cx="240" cy="173" rx="119" ry="128" />
      <ellipse cx="240" cy="173" rx="128" ry="32" />
      <ellipse cx="240" cy="173" rx="128" ry="73" />
      <ellipse cx="240" cy="173" rx="128" ry="111" />
      <path d="M 112 173 H 368 M 240 45 V 301" />
    </g>
    <g fill="var(--xm-sky)" transform="rotate(-18 240 173)">{dots.map((dot, index) => <circle key={index} cx={dot.x} cy={dot.y} r="1.15" opacity={dot.opacity} />)}</g>
    <ellipse className="acceleration-globe-orbit" cx="240" cy="173" rx="191" ry="63" transform="rotate(-24 240 173)" stroke={`url(#${id}-orbit)`} strokeWidth="1.4" />
    <path className="acceleration-globe-route" d="M 143 228 C 152 98 287 82 336 145" stroke="var(--xm-gold)" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="4 5" />
    <path d="M 187 90 C 234 135 264 164 317 258" stroke="var(--xm-sky)" strokeOpacity=".55" strokeLinecap="round" />
    <g fill="var(--xm-gold)">
      <circle cx="143" cy="228" r="4" /><circle cx="143" cy="228" r="10" fillOpacity=".14" />
      <circle cx="336" cy="145" r="3" /><circle cx="336" cy="145" r="8" fillOpacity=".14" />
    </g>
    <g fill="var(--xm-sky)"><circle cx="187" cy="90" r="3" /><circle cx="317" cy="258" r="3" /></g>
  </svg>
}
