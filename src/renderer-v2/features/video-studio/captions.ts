export interface VideoStudioCaptionLayout {
  font: string
  fontSize: number
  lines: string[]
  centerX: number
  /** 每一行文字基线的纵坐标，从上到下。 */
  baselines: number[]
  strokeWidth: number
}

/** 画字幕要用到的那一小块 Canvas 2D 接口，测试里换成假的就能核对画了什么。 */
export interface VideoStudioCaptionPainter {
  font: string
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
  lineJoin: CanvasLineJoin
  lineWidth: number
  strokeStyle: string | CanvasGradient | CanvasPattern
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeText(text: string, x: number, y: number): void
  fillText(text: string, x: number, y: number): void
}

export type VideoStudioTextMeasure = (text: string, fontSize: number) => number

// 字体列表先放三个平台自带的中文黑体，最后才退到 sans-serif；Linux 上没装中文字体时
// 由系统自己找替代字形。
const captionFontFamily = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif'
const cjkCharacter = /[⺀-⿿぀-ヿ㄀-ㄯ㐀-䶿一-鿿가-힯豈-﫿]/u
// 不能放在行首的标点跟着前一个字走，不能放在行尾的开括号跟着后一个字走。
const closingMarks = new Set(Array.from('，。！？、；：,.!?;:)）]】}」』》〉”’…%～'))
const openingMarks = new Set(Array.from('（([【{「『《〈“‘'))

export function videoStudioCaptionFont(fontSize: number): string {
  return `600 ${fontSize}px ${captionFontFamily}`
}

// 拆成「不能再从中间断开」的小块：一个汉字是一块，一个英文单词连同它后面的空格是一块，
// 标点黏在它该黏的那一边。
export function splitCaptionUnits(text: string): string[] {
  const units: string[] = []
  let pendingOpen = ''
  let inWord = false
  for (const char of text) {
    const last = units.length - 1
    if (/\s/u.test(char)) {
      if (last >= 0 && !pendingOpen && !units[last].endsWith(' ')) units[last] += ' '
      inWord = false
      continue
    }
    const cjk = cjkCharacter.test(char)
    if (inWord && !cjk && !openingMarks.has(char)) {
      units[last] += char
      continue
    }
    if (closingMarks.has(char) && last >= 0 && !pendingOpen) {
      units[last] += char
      inWord = false
      continue
    }
    if (openingMarks.has(char)) {
      pendingOpen += char
      inWord = false
      continue
    }
    units.push(pendingOpen + char)
    pendingOpen = ''
    inWord = !cjk
  }
  if (pendingOpen) units.push(pendingOpen)
  return units
}

export function wrapCaptionParagraph(paragraph: string, maxWidth: number, measure: (text: string) => number): string[] {
  const lines: string[] = []
  let line = ''
  for (const unit of splitCaptionUnits(paragraph)) {
    const candidate = line + unit
    if (!line || measure(candidate.trimEnd()) <= maxWidth) {
      line = candidate
      continue
    }
    lines.push(line.trimEnd())
    line = unit
  }
  if (line.trim()) lines.push(line.trimEnd())
  // 一整块就比一行还宽（一长串网址、一个超长英文词）时，只好按字硬断。
  return lines.flatMap((text) => measure(text) > maxWidth ? breakByCharacter(text, maxWidth, measure) : [text])
}

function breakByCharacter(text: string, maxWidth: number, measure: (text: string) => number): string[] {
  const lines: string[] = []
  let line = ''
  for (const char of text) {
    if (line && measure(line + char) > maxWidth) {
      lines.push(line.trimEnd())
      line = char.trim()
      continue
    }
    line += char
  }
  if (line) lines.push(line)
  return lines
}

function ellipsize(text: string, maxWidth: number, measure: (text: string) => number): string {
  const chars = Array.from(text)
  while (chars.length && measure(`${chars.join('').trimEnd()}…`) > maxWidth) chars.pop()
  return `${chars.join('').trimEnd()}…`
}

// 字号按短边算，横竖屏看起来一样大。竖屏底下常被平台的按钮和文案压住，字幕抬到
// 下五分之一的位置；横屏贴底留一点边。放不下就缩两次字号，再放不下就截断加省略号。
export function layoutVideoStudioCaption(text: string, frame: { width: number, height: number }, measure: VideoStudioTextMeasure): VideoStudioCaptionLayout | null {
  const paragraphs = text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (!paragraphs.length) return null
  const portrait = frame.height > frame.width
  const maxLines = portrait ? 3 : 2
  const maxWidth = frame.width * 0.88
  const shortSide = Math.min(frame.width, frame.height)
  const minFontSize = Math.max(12, Math.round(shortSide * 0.035))
  let fontSize = Math.max(minFontSize, Math.round(shortSide * 0.055))
  let lines: string[] = []
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const size = fontSize
    lines = paragraphs.flatMap((paragraph) => wrapCaptionParagraph(paragraph, maxWidth, (value) => measure(value, size)))
    if (lines.length <= maxLines || fontSize === minFontSize) break
    if (attempt < 2) fontSize = Math.max(minFontSize, Math.round(fontSize * 0.85))
  }
  if (lines.length > maxLines) {
    const size = fontSize
    lines = [...lines.slice(0, maxLines - 1), ellipsize(lines[maxLines - 1], maxWidth, (value) => measure(value, size))]
  }
  const lineHeight = Math.round(fontSize * 1.3)
  const lastBaseline = Math.round(frame.height - frame.height * (portrait ? 0.2 : 0.08))
  return {
    font: videoStudioCaptionFont(fontSize),
    fontSize,
    lines,
    centerX: frame.width / 2,
    baselines: lines.map((_, index) => lastBaseline - (lines.length - 1 - index) * lineHeight),
    strokeWidth: Math.max(2, Math.round(fontSize * 0.14)),
  }
}

// 白字黑描边，不垫底色：浅色、深色画面上都看得清，也不会在画面上压一条黑带。
export function paintVideoStudioCaption(context: VideoStudioCaptionPainter, layout: VideoStudioCaptionLayout): void {
  context.font = layout.font
  context.textAlign = 'center'
  context.textBaseline = 'alphabetic'
  context.lineJoin = 'round'
  context.lineWidth = layout.strokeWidth
  context.strokeStyle = 'rgba(0, 0, 0, 0.85)'
  context.fillStyle = '#ffffff'
  layout.lines.forEach((line, index) => {
    context.strokeText(line, layout.centerX, layout.baselines[index])
    context.fillText(line, layout.centerX, layout.baselines[index])
  })
}
