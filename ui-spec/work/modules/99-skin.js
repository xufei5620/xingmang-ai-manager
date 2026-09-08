/* ============================================================
   99-skin · 多皮肤主题 + 欢迎页星轨视觉（行为层）
   - S.settings.skin：dawn（晨曦金，默认）/ tide（星潮青）/ aurora（极光紫）/ nova（曜石蓝）
   - 设置·外观面板在「主题」后插入皮肤选择器
   - 欢迎页右侧替换为代码绘制的星轨场景（canvas 星空 + 轨道卫星）
   - 检阅条追加皮肤切换，方便验收时逐套预览
   ============================================================ */

const SKINS = [['dawn', '晨曦金'], ['obsidian', '极夜黑金'], ['mist', '雾青'], ['aurora', '极光紫']];
const skinOf = () => SKINS.some(([k]) => k === S.settings.skin) ? S.settings.skin : 'dawn';

A.setSkin = function (k) {
  if (!SKINS.some(([id]) => id === k)) return;
  S.settings.skin = k;
  render();
  A.toast(`已切换到「${SKINS.find(([id]) => id === k)[1]}」皮肤`);
};

/* 品牌素材包 01_矢量标识/无字图形标：真矢量，直接内联。
   深底彩色用于暗色主题，标准渐变用于亮色主题（id 已加 xmc- 前缀防冲突） */
const CORE_SVG_DARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 288 256" role="img" aria-label="星芒"><defs>
  <linearGradient id="xmc-orbitLeftDark" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#A7D1F7"/><stop offset=".5" stop-color="#FAF7EE"/><stop offset="1" stop-color="#3D5B8F"/></linearGradient>
  <linearGradient id="xmc-orbitRightDark" x1="1" y1="0" x2="0" y2="1"><stop stop-color="#A7D1F7"/><stop offset=".45" stop-color="#FAF7EE"/><stop offset="1" stop-color="#3D5B8F"/></linearGradient>
  <linearGradient id="xmc-starDark" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#D4A355"/><stop offset=".5" stop-color="#FAF7EE"/><stop offset="1" stop-color="#D4A355"/></linearGradient>
 </defs><g transform="translate(19 24)"><g><path d="M 99 74 C 51 94 2 127 10 149 C 16 168 51 169 78 162 C 42 166 11 158 22 138 C 34 116 72 87 99 74 Z" fill="url(#xmc-orbitLeftDark)"/><path d="M 184 55 C 214 50 237 53 240 69 C 246 94 195 126 138 146 C 180 127 221 99 226 78 C 232 61 209 53 184 55 Z" fill="url(#xmc-orbitRightDark)"/><path d="M 118 6 C 124 87 115 100 179 110 C 127 115 127 126 118 198 C 109 128 117 118 58 110 C 109 105 111 98 118 6 Z" fill="url(#xmc-starDark)"/><path d="M 118 58 C 120 101 118 106 147 110 C 122 112 121 117 118 157 C 114 119 117 113 89 110 C 115 107 115 104 118 58 Z" fill="#FAF7EE"/><path d="M 167 51 C 168 63 169 66 180 68 C 169 70 168 73 167 84 C 166 73 164 70 155 68 C 165 66 166 63 167 51 Z" fill="#D4A355"/></g></g></svg>`;
const CORE_SVG_LIGHT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 288 256" role="img" aria-label="星芒"><defs>
  <linearGradient id="xmc-orbitLeft" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#0B1F3B"/><stop offset=".55" stop-color="#3D5B8F"/><stop offset="1" stop-color="#A7D1F7"/></linearGradient>
  <linearGradient id="xmc-orbitRight" x1="1" y1="0" x2="0" y2="1"><stop stop-color="#0B1F3B"/><stop offset=".46" stop-color="#3D5B8F"/><stop offset="1" stop-color="#A7D1F7"/></linearGradient>
  <linearGradient id="xmc-starBase" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#D4A355"/><stop offset=".34" stop-color="#D4A355"/><stop offset=".57" stop-color="#0B1F3B"/><stop offset=".73" stop-color="#D4A355"/><stop offset="1" stop-color="#D4A355"/></linearGradient>
  <radialGradient id="xmc-starFace" cx="118" cy="110" r="62" gradientUnits="userSpaceOnUse" gradientTransform="translate(0 -27.5) scale(1 1.25)"><stop offset="0" stop-color="#FAF7EE"/><stop offset=".26" stop-color="#D4A355"/><stop offset=".6" stop-color="#D4A355" stop-opacity=".6"/><stop offset="1" stop-color="#0B1F3B" stop-opacity="0"/></radialGradient>
 </defs><g transform="translate(19 24)"><g><path d="M 99 74 C 51 94 2 127 10 149 C 16 168 51 169 78 162 C 42 166 11 158 22 138 C 34 116 72 87 99 74 Z" fill="url(#xmc-orbitLeft)"/><path d="M 184 55 C 214 50 237 53 240 69 C 246 94 195 126 138 146 C 180 127 221 99 226 78 C 232 61 209 53 184 55 Z" fill="url(#xmc-orbitRight)"/><path d="M 118 6 C 124 87 115 100 179 110 C 127 115 127 126 118 198 C 109 128 117 118 58 110 C 109 105 111 98 118 6 Z M 118 58 C 120 101 118 106 147 110 C 122 112 121 117 118 157 C 114 119 117 113 89 110 C 115 107 115 104 118 58 Z" fill="url(#xmc-starBase)" fill-rule="evenodd"/><path d="M 118 6 C 124 87 115 100 179 110 C 127 115 127 126 118 198 C 109 128 117 118 58 110 C 109 105 111 98 118 6 Z M 118 58 C 120 101 118 106 147 110 C 122 112 121 117 118 157 C 114 119 117 113 89 110 C 115 107 115 104 118 58 Z" fill="url(#xmc-starFace)" fill-rule="evenodd"/><path d="M 167 51 C 168 63 169 66 180 68 C 169 70 168 73 167 84 C 166 73 164 70 155 68 C 165 66 166 63 167 51 Z" fill="#D4A355"/></g></g></svg>`;

/* ---------- 欢迎页：右侧换成星轨场景（无框融入版） ---------- */
welcomeHtml = (function (orig) {
  return function () {
    const html = orig();
    const scene = `<div class="preview xm-orbit-preview orbit-preview"><div class="xm-orbits" aria-hidden="true"><i></i><i></i><i></i><b></b></div><div class="glow"></div><div class="orbit-scene">
      <div class="orbit-beam" aria-hidden="true"></div>
      <div class="orbit-ring r1"><span class="sat ok" style="--a:20deg">${brand('claude')}Claude Code</span><span class="sat ok" style="--a:200deg">${brand('codex')}Codex CLI</span></div>
      <div class="orbit-ring r2"><span class="sat" style="--a:110deg">${brand('gemini')}Gemini CLI</span><span class="sat" style="--a:290deg">${brand('grok')}Grok CLI</span></div>
      <div class="orbit-core">${S.theme === 'light' ? CORE_SVG_LIGHT : CORE_SVG_DARK}</div>
      <div class="orbit-hud"><span>ENV OK</span><div class="scan"><i></i></div><span>KEY <b>4/4</b> SYNCED</span></div>
    </div></div>`;
    return html
      .replace(/<div class="preview[^"]*">[\s\S]*?\n\s*<div class="foot">/, scene + '\n    </div>\n      <div class="foot">')
      .replace(/(<div class="welcome[^"]*"[^>]*>)/, '$1<canvas class="sky" aria-hidden="true"></canvas>');
  };
})(welcomeHtml);

/* ---------- 设置·外观：插入皮肤选择器 ---------- */
settingsHtml = (function (orig) {
  return function () {
    const html = orig();
    const picker = `<div class="setting"><div class="l"><strong>界面皮肤</strong><span>四套配色，暗色和亮色模式下都适用，选完立即生效</span></div><div class="r"><div class="skin-row">${SKINS.map(([k, l]) => `<button class="skin-chip ${skinOf() === k ? 'on' : ''}" onclick="A.setSkin('${k}')"><span class="dot ${k}"></span>${l}</button>`).join('')}</div></div></div>`;
    return html.replace('<div class="setting" data-setting="uiScale">', picker + '<div class="setting" data-setting="uiScale">');
  };
})(settingsHtml);

/* ---------- render 挂钩：写 data-skin + 启动星空 ---------- */
render = (function (orig) {
  return function () {
    orig();
    const w = $('#win');
    if (w) w.dataset.skin = skinOf();
    /* 工作台 / 个人中心：主区域注入星空画布（render 重建 #main，需每次补回） */
    const main = $('#main');
    if (main && (S.view === 'app' || S.view === 'account')) {
      if (!main.querySelector(':scope > canvas.sky')) {
        main.insertAdjacentHTML('afterbegin', '<canvas class="sky" aria-hidden="true"></canvas>');
      }
    }
    startStarfield();
  };
})(render);

/* ---------- 检阅条：皮肤切换 ---------- */
later(() => {
  const bar = document.querySelector('.proto-bar');
  if (!bar || bar.querySelector('[data-testid="skin-selector"]')) return;
  const label = document.createElement('label');
  label.innerHTML = '皮肤 ';
  const select = document.createElement('select');
  select.setAttribute('data-testid', 'skin-selector');
  select.setAttribute('aria-label', '界面皮肤预览');
  select.innerHTML = SKINS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  select.value = skinOf();
  select.addEventListener('change', () => A.setSkin(select.value));
  label.append(select);
  bar.append(label);
}, 300);

/* ---------- 欢迎页全幅星空（含地平线光晕，呼应品牌主视觉） ---------- */
let starfieldRAF = 0;
function hexToRgba(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(212,163,85,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function startStarfield() {
  cancelAnimationFrame(starfieldRAF);
  /* 欢迎页：密而亮；工作台主区：稀疏、压低存在感，不干扰阅读 */
  const welcomeCanvas = document.querySelector('.welcome .sky');
  const mainCanvas = document.querySelector('.main > canvas.sky');
  const canvas = welcomeCanvas || mainCanvas;
  if (!canvas) return;
  const quiet = !welcomeCanvas;
  const host = canvas.parentElement;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = host.clientWidth, h = host.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const css = getComputedStyle(host);
  const accent = css.getPropertyValue('--accent').trim() || '#D4A355';
  const dark = document.getElementById('win')?.dataset.theme !== 'light';
  /* 星色：暗色用晨光蓝，浅色用次级文字色，保证两种模式下都可见 */
  const starColor = dark ? (css.getPropertyValue('--xm-sky').trim() || '#A7D1F7') : (css.getPropertyValue('--text-3').trim() || '#61718B');
  const density = quiet ? 70 : 170;
  const alphaCap = quiet ? (dark ? 0.55 : 0.32) : (dark ? 1 : 0.55);
  const linkAlpha = quiet ? (dark ? 0.05 : 0.035) : (dark ? 0.10 : 0.06);
  const horizonA = quiet ? 0.55 : 1;

  const rnd = (a, b) => a + Math.random() * (b - a);
  const stars = Array.from({ length: density }, () => ({
    x: rnd(0, w), y: rnd(0, h), r: rnd(0.4, 1.6), p: rnd(0, Math.PI * 2), s: rnd(0.4, 1.4),
    gold: Math.random() < 0.22,
  }));
  const meteors = [];
  const reduce = S.settings.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;

  function draw(t) {
    ctx.clearRect(0, 0, w, h);
    /* 地平线光晕：页面底部一道升起的暖光，品牌主视觉的标志性元素 */
    const hg = ctx.createRadialGradient(w / 2, h * 1.25, 0, w / 2, h * 1.25, w * 0.62);
    hg.addColorStop(0, hexToRgba(accent, (dark ? 0.16 : 0.10) * horizonA));
    hg.addColorStop(0.55, hexToRgba(accent, (dark ? 0.05 : 0.03) * horizonA));
    hg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = hg;
    ctx.fillRect(0, 0, w, h);
    /* 星星：明暗呼吸 */
    for (const st of stars) {
      const tw = reduce ? 0.7 : 0.45 + 0.4 * Math.sin(t / 900 * st.s + st.p);
      ctx.globalAlpha = Math.max(0.1, tw) * alphaCap;
      ctx.fillStyle = st.gold ? accent : starColor;
      ctx.beginPath();
      ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
      ctx.fill();
    }
    /* 星座连线：靠近的星之间拉细线 */
    ctx.globalAlpha = 1;
    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        const a = stars[i], b = stars[j];
        const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 < 90 * 90) {
          ctx.globalAlpha = linkAlpha * (1 - Math.sqrt(d2) / 90);
          ctx.strokeStyle = starColor;
          ctx.lineWidth = 0.6;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }
    /* 偶发流星（工作区更克制） */
    if (!reduce) {
      if (Math.random() < (quiet ? 0.006 : 0.012) && meteors.length < 2) {
        meteors.push({ x: rnd(w * 0.3, w * 1.05), y: rnd(-10, h * 0.3), vx: -rnd(4, 7), vy: rnd(1.6, 2.6), life: 1 });
      }
      for (let i = meteors.length - 1; i >= 0; i--) {
        const m = meteors[i];
        m.x += m.vx; m.y += m.vy; m.life -= 0.016;
        if (m.life <= 0 || m.x < -60) { meteors.splice(i, 1); continue; }
        const grad = ctx.createLinearGradient(m.x, m.y, m.x - m.vx * 9, m.y - m.vy * 9);
        grad.addColorStop(0, accent); grad.addColorStop(1, 'transparent');
        ctx.globalAlpha = Math.max(0, m.life) * (dark ? 0.8 : 0.45) * (quiet ? 0.6 : 1);
        ctx.strokeStyle = grad; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x - m.vx * 9, m.y - m.vy * 9); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    if (!reduce) starfieldRAF = requestAnimationFrame(draw);
  }
  draw(0);
}
