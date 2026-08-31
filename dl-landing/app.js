const EMAIL_PATTERN = /^[^\s@]+@qq\.com$/i
const AFF_COOKIE_NAME = 'xingmang_aff'
const AFF_COOKIE_DAYS = 180
const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 20
const MAX_USERNAME_LENGTH = 20
const MAX_AFF_CODE_LENGTH = 32
const VERIFICATION_CODE_COOLDOWN_SECONDS = 60
const DOWNLOAD_GUIDE_URL = 'https://s4621e8xzb.feishu.cn/wiki/WpBUwh4PhiAs2skvWfmcnM5vnDb?from=from_copylink'
const legalFiles = {
  'user-agreement': { title: '用户协议', path: '/legal/user-agreement.md' },
  'privacy-policy': { title: '隐私政策', path: '/legal/privacy-policy.md' }
}

const accountErrorPatterns = [
  [/username\s+already\s+exists|用户名已存在/i, '该用户名已被注册，请更换用户名'],
  [/email(\s+address)?\s+is\s+already\s+in\s+use|邮箱地址已被占用|该邮箱已注册/i, '该邮箱已被注册，请更换邮箱后重试'],
  [/verification\s+code.*(incorrect|invalid|expired)|验证码(错误|不正确|已过期|已失效)/i, '验证码错误或已过期，请重新获取验证码'],
  [/email verification is enabled|please enter email address and verification code|请输入邮箱地址和验证码/i, '请输入邮箱地址并获取验证码'],
  [/registration has been disabled|注册(功能)?已(关闭|禁用)/i, '当前暂未开放注册，请稍后重试'],
  [/database error|数据库出错/i, '服务暂时不可用，请稍后重试']
]

const els = {
  registerView: document.getElementById('register-view'),
  successView: document.getElementById('success-view'),
  downloadView: document.getElementById('download-view'),
  inviteHint: document.getElementById('invite-hint'),
  fallbackHint: document.querySelector('.invite-hint.fallback'),
  username: document.getElementById('username'),
  password: document.getElementById('password'),
  confirmPassword: document.getElementById('confirm-password'),
  email: document.getElementById('email'),
  verificationRow: document.getElementById('verification-row'),
  verificationCode: document.getElementById('verification-code'),
  sendCode: document.getElementById('send-code'),
  inviteCode: document.getElementById('invite-code'),
  inviteOptional: document.getElementById('invite-optional'),
  inviteLockedHint: document.getElementById('invite-locked-hint'),
  agreement: document.getElementById('agreement'),
  submit: document.getElementById('submit'),
  formAlert: document.getElementById('form-alert'),
  publicDownloads: document.getElementById('public-downloads'),
  publicReleaseVersion: document.getElementById('public-release-version'),
  downloads: document.getElementById('downloads'),
  releaseVersion: document.getElementById('release-version'),
  legalBackdrop: document.getElementById('legal-backdrop'),
  legalTitle: document.getElementById('legal-title'),
  legalBody: document.getElementById('legal-body'),
  legalClose: document.getElementById('legal-close')
}

const state = {
  affCode: '',
  inviteSource: '',
  inviteLocked: false,
  emailVerification: true,
  latest: null,
  cooldown: 0,
  sendingCode: false,
  submitting: false,
  legalCache: {}
}

function looksLikeInviteLink(value) {
  return /^https?:\/\//i.test(value)
    || value.includes('aff=')
    || /\/(sign-up|register)\b/i.test(value)
}

function parseInviteAffCode(raw) {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (!looksLikeInviteLink(trimmed)) return trimmed
  const query = trimmed.includes('?') ? trimmed.slice(trimmed.indexOf('?') + 1) : trimmed
  return new URLSearchParams(query).get('aff')?.trim() ?? ''
}

function validateInviteCode(value) {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = parseInviteAffCode(trimmed)
  if (looksLikeInviteLink(trimmed) && !parsed) return '请粘贴完整邀请链接，或只填邀请码'
  if (parsed.length > MAX_AFF_CODE_LENGTH) return `邀请码不能超过 ${MAX_AFF_CODE_LENGTH} 位`
  return null
}

function readCookie(name) {
  const prefix = `${name}=`
  const found = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))
  return found ? decodeURIComponent(found.slice(prefix.length)) : ''
}

function writeAffCookie(affCode) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  const expires = new Date(Date.now() + AFF_COOKIE_DAYS * 24 * 60 * 60 * 1000).toUTCString()
  document.cookie = `${AFF_COOKIE_NAME}=${encodeURIComponent(affCode)}; Path=/; Expires=${expires}; SameSite=Lax${secure}`
}

function readStoredAffCode() {
  const parsed = parseInviteAffCode(readCookie(AFF_COOKIE_NAME))
  return parsed.length > 0 && parsed.length <= MAX_AFF_CODE_LENGTH ? parsed : ''
}

function resolveAffFromVisit() {
  const fromUrl = parseInviteAffCode(new URLSearchParams(window.location.search).get('aff') || '')
  if (fromUrl && fromUrl.length <= MAX_AFF_CODE_LENGTH) {
    writeAffCookie(fromUrl)
    return { affCode: fromUrl, source: 'link' }
  }
  const fromCookie = readStoredAffCode()
  return fromCookie ? { affCode: fromCookie, source: 'cookie' } : { affCode: '', source: '' }
}

function validateUsername(value) {
  const trimmed = value.trim()
  if (!trimmed) return '请输入用户名'
  if (trimmed.length > MAX_USERNAME_LENGTH) return `用户名不能超过 ${MAX_USERNAME_LENGTH} 位`
  return null
}

function validateEmail(value) {
  const trimmed = value.trim()
  if (!trimmed) return '请输入邮箱地址'
  if (!EMAIL_PATTERN.test(trimmed)) return '请使用 QQ 邮箱注册，例如 xxx@qq.com'
  return null
}

function validatePassword(value) {
  if (!value) return '请输入密码'
  if (value.length < MIN_PASSWORD_LENGTH) return `密码至少需要 ${MIN_PASSWORD_LENGTH} 位`
  if (value.length > MAX_PASSWORD_LENGTH) return `密码不能超过 ${MAX_PASSWORD_LENGTH} 位`
  return null
}

function validateConfirmPassword(password, confirmPassword) {
  if (!confirmPassword) return '请再次输入密码'
  if (confirmPassword !== password) return '两次输入的密码不一致'
  return null
}

function validateVerificationCode(value) {
  if (!value.trim()) return '请输入验证码'
  return null
}

function validateAgreement(agreed) {
  if (!agreed) return '请先阅读并同意用户协议和隐私政策'
  return null
}

function validateRegisterForm(values) {
  const errors = {
    username: validateUsername(values.username),
    email: validateEmail(values.email),
    password: validatePassword(values.password),
    confirmPassword: validateConfirmPassword(values.password, values.confirmPassword),
    verificationCode: values.requireVerification ? validateVerificationCode(values.verificationCode) : null,
    inviteCode: values.inviteLocked ? null : validateInviteCode(values.inviteCode),
    agreement: validateAgreement(values.agreedToTerms)
  }
  return Object.fromEntries(Object.entries(errors).filter(([, message]) => Boolean(message)))
}

function resolveAccountErrorMessage(message) {
  const trimmed = String(message || '').trim()
  if (!trimmed) return '注册失败，请稍后重试'
  const matched = accountErrorPatterns.find(([test]) => test.test(trimmed))
  return matched ? matched[1] : trimmed
}

function setFieldError(name, message) {
  const node = document.querySelector(`[data-error="${name}"]`)
  if (!node) return
  if (message) {
    node.hidden = false
    node.textContent = message
  } else {
    node.hidden = true
    node.textContent = ''
  }
}

function clearErrors() {
  document.querySelectorAll('[data-error]').forEach((node) => {
    node.hidden = true
    node.textContent = ''
  })
  els.formAlert.hidden = true
  els.formAlert.textContent = ''
}

function showFormAlert(message) {
  els.formAlert.hidden = !message
  els.formAlert.textContent = message || ''
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderInline(text) {
  return escapeHtml(text)
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

function renderMarkdown(source) {
  const html = []
  let list = null
  function flushList() {
    if (!list) return
    html.push(`<ul>${list.join('')}</ul>`)
    list = null
  }
  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) {
      flushList()
      continue
    }
    if (line.trim() === '---') {
      flushList()
      html.push('<hr>')
      continue
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      flushList()
      html.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`)
      continue
    }
    const item = line.match(/^[-*]\s+(.+)$/)
    if (item) {
      list = list || []
      list.push(`<li>${renderInline(item[1])}</li>`)
      continue
    }
    flushList()
    html.push(`<p>${renderInline(line)}</p>`)
  }
  flushList()
  return html.join('')
}

async function readJson(response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('服务响应格式异常')
  }
}

async function apiGet(path) {
  const response = await fetch(path, { method: 'GET', headers: { Accept: 'application/json' } })
  const payload = await readJson(response)
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || `请求失败（${response.status}）`)
  }
  return payload.data ?? payload
}

async function apiPost(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  const payload = await readJson(response)
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || `请求失败（${response.status}）`)
  }
  return payload
}

function applyInviteField(affCode, source) {
  state.affCode = affCode
  state.inviteSource = source
  state.inviteLocked = Boolean(affCode)
  els.inviteCode.value = affCode
  els.inviteCode.readOnly = state.inviteLocked
  if (state.inviteLocked) {
    els.inviteHint.hidden = false
    els.fallbackHint.hidden = true
    els.inviteOptional.hidden = true
    els.inviteLockedHint.hidden = false
    els.inviteLockedHint.textContent = source === 'cookie'
      ? '已从本机邀请记录带入，不可修改'
      : '已从邀请链接带入，不可修改'
  } else {
    els.inviteHint.hidden = true
    els.fallbackHint.hidden = false
    els.inviteOptional.hidden = false
    els.inviteLockedHint.hidden = true
  }
}

function resolveSubmitAffCode(rawInvite) {
  if (state.inviteLocked) return state.affCode
  return parseInviteAffCode(rawInvite)
}

function renderDownloads(latest, downloadsNode = els.downloads, releaseNode = els.releaseVersion) {
  const items = [
    { title: 'Windows', detail: '64 位安装包 · .exe', icon: 'windows' },
    { title: 'macOS Apple Silicon', detail: 'M 系列芯片 · .dmg', icon: 'mac' },
    { title: 'macOS Intel', detail: 'Intel 芯片 · .dmg', icon: 'mac' }
  ]
  const icons = {
    windows: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M1 2.4 7.1 1.5v6.1H1zm7.2-.9L15 0v7.6H8.2zM1 8.6h6.1V15L1 14zm7.2 0H15V16l-6.8-1z"/></svg>',
    mac: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11.6 8.6c0-2 1.6-2.9 1.7-3-1-1.4-2.4-1.6-2.9-1.6-1.2-.1-2.4.7-3 .7s-1.6-.7-2.7-.7c-1.4 0-2.7.8-3.4 2.1-1.5 2.6-.4 6.4 1 8.5.7 1 1.5 2.2 2.6 2.1 1 0 1.4-.7 2.7-.7s1.6.7 2.7.7 1.8-1 2.5-2c.8-1.1 1.1-2.2 1.1-2.3-.1 0-2.1-.8-2.1-3.8zM10 2.8c.6-.7 1-1.7.9-2.8-.9.1-1.9.6-2.5 1.3-.6.6-1.1 1.6-1 2.6 1 .1 1.9-.5 2.6-1.1z"/></svg>'
  }
  downloadsNode.replaceChildren(...items.map((item) => {
    const link = document.createElement('a')
    link.className = 'download'
    link.href = DOWNLOAD_GUIDE_URL
    link.innerHTML = `<span class="download-icon" aria-hidden="true">${icons[item.icon]}</span><span><strong>${item.title}</strong><small>${item.detail}</small></span><b>下载</b>`
    return link
  }))
  if (!latest.macArm64 || !latest.macX64) {
    const note = document.createElement('p')
    note.className = 'download-note'
    note.textContent = 'macOS 安装包正在准备中，完成后会自动出现在这里。'
    downloadsNode.append(note)
  }
  releaseNode.textContent = latest.version ? `当前版本 ${latest.version}` : ''
}

async function loadLatest() {
  if (state.latest) return state.latest
  const response = await fetch('/latest.json', { headers: { Accept: 'application/json' }, cache: 'no-store' })
  const latest = await readJson(response)
  if (!response.ok || !latest.win) {
    throw new Error('清单不完整')
  }
  state.latest = latest
  return state.latest
}

async function showSuccess() {
  els.registerView.hidden = true
  els.successView.hidden = false
  els.releaseVersion.textContent = '正在读取安装包…'
  try {
    renderDownloads(await loadLatest(), els.downloads, els.releaseVersion)
  } catch {
    els.releaseVersion.textContent = '安装包清单稍后提供'
  }
}

async function loadPublicDownloads() {
  try {
    renderDownloads(await loadLatest(), els.publicDownloads, els.publicReleaseVersion)
  } catch {
    els.publicReleaseVersion.textContent = '安装包清单稍后提供'
  }
}

function tickCooldown() {
  if (state.cooldown <= 0) {
    els.sendCode.disabled = false
    els.sendCode.textContent = '获取验证码'
    return
  }
  els.sendCode.disabled = true
  els.sendCode.textContent = `${state.cooldown}s 后重试`
  window.setTimeout(() => {
    state.cooldown -= 1
    tickCooldown()
  }, 1000)
}

async function requestVerificationCode() {
  const emailError = validateEmail(els.email.value)
  setFieldError('email', emailError)
  if (emailError || state.sendingCode || state.cooldown > 0) return
  state.sendingCode = true
  state.cooldown = VERIFICATION_CODE_COOLDOWN_SECONDS
  tickCooldown()
  try {
    await apiGet(`/api/verification?email=${encodeURIComponent(els.email.value.trim())}`)
    showFormAlert('')
  } catch (error) {
    showFormAlert(resolveAccountErrorMessage(error.message))
  } finally {
    state.sendingCode = false
  }
}

async function submitRegister(event) {
  event.preventDefault()
  if (state.submitting) return
  clearErrors()
  const values = {
    username: els.username.value,
    email: els.email.value,
    password: els.password.value,
    confirmPassword: els.confirmPassword.value,
    verificationCode: els.verificationCode.value,
    inviteCode: els.inviteCode.value,
    inviteLocked: state.inviteLocked,
    agreedToTerms: els.agreement.checked,
    requireVerification: state.emailVerification
  }
  const errors = validateRegisterForm(values)
  Object.entries(errors).forEach(([name, message]) => setFieldError(name, message))
  if (Object.keys(errors).length > 0) return

  const affCode = resolveSubmitAffCode(values.inviteCode)
  const body = {
    username: values.username.trim(),
    password: values.password,
    email: values.email.trim()
  }
  if (state.emailVerification) body.verification_code = values.verificationCode.trim()
  if (affCode) body.aff_code = affCode

  state.submitting = true
  els.submit.disabled = true
  els.submit.textContent = '正在注册…'
  try {
    await apiPost('/api/user/register', body)
    await showSuccess()
  } catch (error) {
    showFormAlert(resolveAccountErrorMessage(error.message))
  } finally {
    state.submitting = false
    els.submit.disabled = false
    els.submit.textContent = '注册并下载'
  }
}

async function openLegal(kind) {
  const meta = legalFiles[kind]
  if (!meta) return
  els.legalTitle.textContent = meta.title
  els.legalBody.textContent = '正在加载…'
  els.legalBackdrop.hidden = false
  try {
    if (!state.legalCache[kind]) {
      const response = await fetch(meta.path)
      if (!response.ok) throw new Error('文档暂不可用')
      state.legalCache[kind] = await response.text()
    }
    els.legalBody.innerHTML = renderMarkdown(state.legalCache[kind])
  } catch {
    els.legalBody.textContent = '文档暂时无法打开，请稍后重试。'
  }
}

function closeLegal() {
  els.legalBackdrop.hidden = true
}

const eyeOpenSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 5c5.2 0 9.4 3.4 11 7-1.6 3.6-5.8 7-11 7S2.6 15.6 1 12c1.6-3.6 5.8-7 11-7zm0 2C8.1 7 4.9 9.3 3.4 12 4.9 14.7 8.1 17 12 17s7.1-2.3 8.6-5C19.1 9.3 15.9 7 12 7zm0 2.2A2.8 2.8 0 1 1 12 14.8 2.8 2.8 0 0 1 12 9.2z"/></svg>'
const eyeOffSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3.3 2.5 21 20.2l-1.4 1.4-3.2-3.2A12.7 12.7 0 0 1 12 19C6.8 19 2.6 15.6 1 12c.7-1.5 1.8-2.9 3.2-4L1.9 3.9 3.3 2.5zm5 6.4C7.6 9.7 7 10.8 7 12a5 5 0 0 0 6.1 4.9l-1.5-1.5A3 3 0 0 1 9 12c0-.4.1-.8.2-1.1L8.3 8.9zM12 5c5.2 0 9.4 3.4 11 7-.6 1.3-1.4 2.5-2.5 3.5l-1.5-1.5c.8-.8 1.4-1.7 1.9-2.5C19.1 9.3 15.9 7 12 7c-.7 0-1.3.1-1.9.2L8.6 5.7C9.7 5.2 10.8 5 12 5z"/></svg>'

function bindPasswordToggle(button) {
  const input = document.getElementById(button.getAttribute('data-toggle-password') || '')
  if (!input) return
  function render() {
    const hidden = input.type === 'password'
    button.innerHTML = hidden ? eyeOpenSvg : eyeOffSvg
    button.setAttribute('aria-label', hidden ? '显示密码' : '隐藏密码')
  }
  button.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password'
    render()
  })
  render()
}

function bindEvents() {
  els.registerView.addEventListener('submit', submitRegister)
  els.sendCode.addEventListener('click', () => {
    void requestVerificationCode()
  })
  document.querySelectorAll('[data-toggle-password]').forEach((button) => bindPasswordToggle(button))
  ;['username', 'password', 'confirm-password', 'email', 'verification-code', 'invite-code'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => {
      const map = {
        username: 'username',
        password: 'password',
        'confirm-password': 'confirmPassword',
        email: 'email',
        'verification-code': 'verificationCode',
        'invite-code': 'inviteCode'
      }
      setFieldError(map[id], null)
    })
  })
  els.agreement.addEventListener('change', () => setFieldError('agreement', null))
  document.querySelectorAll('[data-legal]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void openLegal(button.getAttribute('data-legal'))
    })
  })
  els.legalClose.addEventListener('click', closeLegal)
  els.legalBackdrop.addEventListener('click', (event) => {
    if (event.target === els.legalBackdrop) closeLegal()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !els.legalBackdrop.hidden) closeLegal()
  })
}

function isLocalSuccessPreview() {
  const host = window.location.hostname
  if (host !== '127.0.0.1' && host !== 'localhost') return false
  return new URLSearchParams(window.location.search).get('preview') === 'success'
}

function isPublicDownloadRoute() {
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/'
  if (pathname === '/download') return true
  return new URLSearchParams(window.location.search).get('download') === '1'
}

async function boot() {
  bindEvents()
  const invite = resolveAffFromVisit()
  applyInviteField(invite.affCode, invite.source)
  if (isPublicDownloadRoute()) {
    els.registerView.hidden = true
    els.downloadView.hidden = false
    await loadPublicDownloads()
    return
  }
  try {
    const status = await apiGet('/api/status')
    state.emailVerification = status.email_verification === true
  } catch {
    state.emailVerification = true
  }
  els.verificationRow.hidden = !state.emailVerification
  if (isLocalSuccessPreview()) await showSuccess()
}

void boot()
