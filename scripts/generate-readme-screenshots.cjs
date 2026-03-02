const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'docs', 'readme-shots')
const WIDTH = 1660
const HEIGHT = 980

function read(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), 'utf-8')
}

function safeMatch(content, regex, fallback = '') {
  const match = content.match(regex)
  return match ? match[1] : fallback
}

function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function extractBlock(content, marker) {
  const markerIndex = content.indexOf(marker)
  if (markerIndex < 0) return ''

  const braceStart = content.indexOf('{', markerIndex)
  if (braceStart < 0) return ''

  let depth = 0
  for (let i = braceStart; i < content.length; i += 1) {
    const ch = content[i]
    if (ch === '{') depth += 1
    if (ch === '}') depth -= 1
    if (depth === 0) {
      return content.slice(braceStart + 1, i)
    }
  }

  return ''
}

function parseCssVars(block) {
  const vars = {}
  const regex = /--([\w-]+)\s*:\s*([^;]+);/g
  let m = regex.exec(block)
  while (m) {
    vars[m[1]] = m[2].trim()
    m = regex.exec(block)
  }
  return vars
}

function parseColorStops(gradient) {
  const m = gradient.match(/linear-gradient\(([^)]+)\)/)
  if (!m) return ['#F0EEE9', '#E8E6E1']
  const parts = m[1].split(',').map((x) => x.trim())
  if (parts.length < 3) return ['#F0EEE9', '#E8E6E1']
  const first = parts[1].split(' ')[0]
  const second = parts[2].split(' ')[0]
  return [first, second]
}

function loadTheme(mode) {
  const mainScss = read('src/styles/main.scss')
  const rootVars = parseCssVars(extractBlock(mainScss, ':root'))
  const marker = mode === 'light'
    ? '[data-theme="cloud-dancer"][data-mode="light"]'
    : '[data-theme="cloud-dancer"][data-mode="dark"]'
  const blockVars = parseCssVars(extractBlock(mainScss, marker))

  const pick = (name, fallback) => blockVars[name] || rootVars[name] || fallback

  return {
    mode,
    primary: pick('primary', mode === 'light' ? '#8B7355' : '#C9A86C'),
    primaryLight: pick('primary-light', mode === 'light' ? 'rgba(139, 115, 85, 0.1)' : 'rgba(201, 168, 108, 0.15)'),
    bgPrimary: pick('bg-primary', mode === 'light' ? '#F0EEE9' : '#1a1816'),
    bgSecondary: pick('bg-secondary', mode === 'light' ? 'rgba(255, 255, 255, 0.7)' : 'rgba(40, 36, 32, 0.9)'),
    bgTertiary: pick('bg-tertiary', mode === 'light' ? 'rgba(0, 0, 0, 0.03)' : 'rgba(255, 255, 255, 0.05)'),
    bgHover: pick('bg-hover', mode === 'light' ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.08)'),
    textPrimary: pick('text-primary', mode === 'light' ? '#3d3d3d' : '#F0EEE9'),
    textSecondary: pick('text-secondary', mode === 'light' ? '#666666' : '#b3b0aa'),
    textTertiary: pick('text-tertiary', mode === 'light' ? '#999999' : '#807d78'),
    border: pick('border-color', mode === 'light' ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.1)'),
    bgGradient: pick('bg-gradient', mode === 'light'
      ? 'linear-gradient(135deg, #F0EEE9 0%, #E8E6E1 100%)'
      : 'linear-gradient(135deg, #1a1816 0%, #252220 100%)'),
    cardBg: pick('card-bg', mode === 'light' ? 'rgba(255, 255, 255, 0.7)' : 'rgba(40, 36, 32, 0.9)'),
    success: mode === 'light' ? '#16a34a' : '#34d399',
    warning: mode === 'light' ? '#d97706' : '#fbbf24',
    danger: mode === 'light' ? '#ef4444' : '#fb7185'
  }
}

function loadSidebarModel() {
  const tsx = read('src/components/Sidebar.tsx')
  const scss = read('src/components/Sidebar.scss')

  const exportLabel = safeMatch(tsx, /to="\/export"[\s\S]*?<span className="nav-label">([^<]+)<\/span>/, '导出')
  const taskLabel = safeMatch(tsx, /<GlobalTaskCenter[^>]*label="([^"]+)"/, '任务')
  const settingsLabel = safeMatch(tsx, /to="\/settings"[\s\S]*?<span className="nav-label">([^<]+)<\/span>/, '设置')

  const modeLabels = tsx.match(/themeMode === 'light' \? '([^']+)' : themeMode === 'dark' \? '([^']+)' : '([^']+)'/)
  const themeLabels = modeLabels
    ? { light: modeLabels[1], dark: modeLabels[2], system: modeLabels[3] }
    : { light: '浅色', dark: '深色', system: '跟随' }

  const width = Number.parseInt(safeMatch(scss, /\.sidebar\s*\{[\s\S]*?width:\s*(\d+)px/, '140'), 10)
  const navFontSize = Number.parseInt(safeMatch(scss, /\.nav-label\s*\{[\s\S]*?font-size:\s*(\d+)px/, '14'), 10)

  return {
    width: Number.isNaN(width) ? 140 : width,
    navFontSize: Number.isNaN(navFontSize) ? 14 : navFontSize,
    exportLabel,
    taskLabel,
    settingsLabel,
    themeLabels
  }
}

function loadAppRoutes() {
  const appTsx = read('src/App.tsx')
  return Array.from(appTsx.matchAll(/<Route\s+path="([^"]+)"/g)).map((x) => x[1])
}

function loadExportModel() {
  const tsx = read('src/pages/ExportPage.tsx')
  const scss = read('src/pages/ExportPage.scss')

  const sideCardLabels = Array.from(
    new Set(Array.from(tsx.matchAll(/<span className="emoji-overview-trigger-title">([^<]+)<\/span>/g)).map((m) => m[1].trim()))
  )

  const sessionTypeLabels = Array.from(
    new Set(Array.from(tsx.matchAll(/<span>(私聊|群聊|公众号)<\/span>/g)).map((m) => m[1]))
  )

  const listOnlyWithNoSelection = /\{selectedSession && <div className="chat-session-drawer-backdrop"/.test(tsx)
  const drawerConditional = /\{selectedSession && \(/.test(tsx)

  const drawerWidth = Number.parseInt(safeMatch(scss, /\.chat-session-drawer\s*\{[\s\S]*?width:\s*min\((\d+)px/, '760'), 10)
  const sideCardMinWidth = Number.parseInt(safeMatch(scss, /\.emoji-overview-trigger-card\s*\{[\s\S]*?min-width:\s*(\d+)px/, '136'), 10)
  const sideCardMaxWidth = Number.parseInt(safeMatch(scss, /\.emoji-overview-trigger-card\s*\{[\s\S]*?max-width:\s*(\d+)px/, '176'), 10)

  return {
    sideCardLabels: sideCardLabels.length > 0 ? sideCardLabels : ['聊天文本', '表情包', '语音', '图片', '视频', '朋友圈'],
    sessionTypeLabels: sessionTypeLabels.length > 0 ? sessionTypeLabels : ['私聊', '群聊', '公众号'],
    listOnlyWithNoSelection,
    drawerConditional,
    drawerWidth: Number.isNaN(drawerWidth) ? 760 : drawerWidth,
    sideCardMinWidth: Number.isNaN(sideCardMinWidth) ? 136 : sideCardMinWidth,
    sideCardMaxWidth: Number.isNaN(sideCardMaxWidth) ? 176 : sideCardMaxWidth
  }
}

function renderMainSidebar(theme, sidebar, active, modeLabel) {
  const item = (y, label, isActive, badge) => `
    <rect x="24" y="${y}" width="${sidebar.width - 16}" height="40" rx="20" fill="${isActive ? theme.primary : 'transparent'}" />
    <circle cx="40" cy="${y + 20}" r="6" fill="${isActive ? '#fff' : theme.textSecondary}" />
    <text x="56" y="${y + 25}" fill="${isActive ? '#fff' : theme.textSecondary}" font-size="${sidebar.navFontSize}" font-weight="500">${esc(label)}</text>
    ${badge ? `<rect x="${sidebar.width - 18}" y="${y + 10}" width="18" height="18" rx="9" fill="${theme.primary}" /><text x="${sidebar.width - 12}" y="${y + 23}" fill="#fff" font-size="10" font-weight="700">2</text>` : ''}
  `

  return `
    <rect x="16" y="16" width="${sidebar.width}" height="948" rx="16" fill="${theme.bgSecondary}" stroke="${theme.border}" />
    <text x="36" y="56" fill="${theme.primary}" font-size="22" font-weight="700">VX</text>
    <text x="68" y="56" fill="${theme.textPrimary}" font-size="14" font-weight="600">daochu</text>

    ${item(132, sidebar.exportLabel, active === 'export', false)}
    ${item(182, sidebar.taskLabel, active === 'task', true)}

    <line x1="24" y1="852" x2="${sidebar.width + 8}" y2="852" stroke="${theme.border}" />
    ${item(868, sidebar.settingsLabel, active === 'settings', false)}
    ${item(914, modeLabel, false, false)}
  `
}

function renderWindowTitle(theme, x, y, w, title, subtitle) {
  return `
    <rect x="${x}" y="${y}" width="${w}" height="38" rx="12" fill="${theme.bgTertiary}" stroke="${theme.border}" />
    <circle cx="${x + 14}" cy="${y + 19}" r="4" fill="${theme.danger}" />
    <circle cx="${x + 28}" cy="${y + 19}" r="4" fill="${theme.warning}" />
    <circle cx="${x + 42}" cy="${y + 19}" r="4" fill="${theme.success}" />
    <text x="${x + 62}" y="${y + 18}" fill="${theme.textPrimary}" font-size="14" font-weight="600">${esc(title)}</text>
    <text x="${x + 62}" y="${y + 31}" fill="${theme.textSecondary}" font-size="10">${esc(subtitle)}</text>
  `
}

function renderExportContent(theme, model, x, y, w, h, withSelection) {
  const headerH = 150
  const controlsH = 86
  const tableY = y + headerH + controlsH
  const tableH = h - headerH - controlsH - 12

  const cardWidth = Math.min(model.sideCardMaxWidth, Math.max(model.sideCardMinWidth, 150))
  const cardGap = 8
  const cardsPerRow = 3
  const cardRows = Math.ceil(model.sideCardLabels.length / cardsPerRow)

  const cards = model.sideCardLabels.map((label, idx) => {
    const row = Math.floor(idx / cardsPerRow)
    const col = idx % cardsPerRow
    const blockW = cardsPerRow * cardWidth + (cardsPerRow - 1) * cardGap
    const startX = x + w - 18 - blockW
    const cx = startX + col * (cardWidth + cardGap)
    const cy = y + 14 + row * 54

    return `
      <rect x="${cx}" y="${cy}" width="${cardWidth}" height="46" rx="10" fill="${theme.bgPrimary}" stroke="${theme.border}" />
      <text x="${cx + 10}" y="${cy + 18}" fill="${theme.textSecondary}" font-size="10">${esc(label)}</text>
      <text x="${cx + 10}" y="${cy + 34}" fill="${theme.textPrimary}" font-size="12" font-weight="600">1,284 / 6,204</text>
      <rect x="${cx + cardWidth - 46}" y="${cy + 26}" width="36" height="14" rx="7" fill="${theme.primaryLight}" />
      <text x="${cx + cardWidth - 34}" y="${cy + 36}" fill="${theme.primary}" font-size="9">导出</text>
    `
  }).join('')

  const typeButtons = model.sessionTypeLabels.map((type, idx) => {
    const tx = x + 22 + idx * 94
    const active = idx === 0
    return `
      <rect x="${tx}" y="${y + headerH + 18}" width="86" height="32" rx="16" fill="${active ? theme.primary : theme.bgTertiary}" stroke="${theme.border}" />
      <text x="${tx + 30}" y="${y + headerH + 39}" fill="${active ? '#fff' : theme.textSecondary}" font-size="11" font-weight="600">${esc(type)}</text>
    `
  }).join('')

  const rows = [
    ['产品讨论群', '群聊', '32,984', '+128', '2026-03-01 23:12'],
    ['陈小北', '私聊', '8,214', '+0', '2026-03-01 18:46'],
    ['家人群', '群聊', '14,502', '+42', '2026-03-01 09:03'],
    ['Arkme 项目组', '群聊', '22,306', '+87', '2026-02-28 21:50'],
    ['技术支持', '私聊', '4,299', '+13', '2026-02-28 16:31']
  ]

  const tableRows = rows.map((row, idx) => {
    const ry = tableY + 44 + idx * 62
    return `
      <line x1="${x + 12}" y1="${ry}" x2="${x + w - 12}" y2="${ry}" stroke="${theme.border}" />
      <text x="${x + 24}" y="${ry + 38}" fill="${theme.textPrimary}" font-size="12" font-weight="${idx === 0 ? '600' : '500'}">${row[0]}</text>
      <text x="${x + 286}" y="${ry + 38}" fill="${theme.textSecondary}" font-size="11">${row[1]}</text>
      <text x="${x + 372}" y="${ry + 38}" fill="${theme.textPrimary}" font-size="11">${row[2]}</text>
      <text x="${x + 468}" y="${ry + 38}" fill="${row[3] === '+0' ? theme.textTertiary : theme.success}" font-size="11" font-weight="600">${row[3]}</text>
      <text x="${x + 562}" y="${ry + 38}" fill="${theme.textSecondary}" font-size="11">${row[4]}</text>
    `
  }).join('')

  const drawerW = Math.min(model.drawerWidth, w - 20)
  const drawerX = x + w - drawerW - 10

  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${theme.cardBg}" stroke="${theme.border}" />

    <rect x="${x}" y="${y}" width="${w}" height="${headerH}" fill="${theme.cardBg}" stroke="${theme.border}" />
    <rect x="${x + 20}" y="${y + 16}" width="40" height="40" rx="10" fill="${theme.bgSecondary}" stroke="${theme.border}" />
    <text x="${x + 32}" y="${y + 42}" fill="${theme.textSecondary}" font-size="13">我</text>
    <text x="${x + 72}" y="${y + 35}" fill="${theme.textPrimary}" font-size="14" font-weight="600">当前账号（已连接数据库）</text>
    <text x="${x + 72}" y="${y + 56}" fill="${theme.textSecondary}" font-size="11">微信号: vx_demo · wxid: wxid_demo_2026</text>
    <text x="${x + 72}" y="${y + 78}" fill="${theme.success}" font-size="11">已连接数据库 · 数据管理 · 导出目录 D:/VXdaochu/Export</text>

    ${cards}

    <rect x="${x}" y="${y + headerH}" width="${w}" height="${controlsH}" fill="${theme.cardBg}" stroke="${theme.border}" />
    ${typeButtons}
    <rect x="${x + 318}" y="${y + headerH + 18}" width="${w - 338}" height="32" rx="8" fill="${theme.bgTertiary}" stroke="${theme.border}" />
    <text x="${x + 332}" y="${y + headerH + 39}" fill="${theme.textTertiary}" font-size="11">搜索联系人或群组...</text>
    <text x="${x + 22}" y="${y + headerH + 68}" fill="${theme.textTertiary}" font-size="10">提示：默认仅显示会话列表，点击会话后弹出右侧详情抽屉</text>

    <rect x="${x + 8}" y="${tableY}" width="${w - 16}" height="${tableH}" rx="10" fill="${theme.bgTertiary}" stroke="${theme.border}" />
    <rect x="${x + 12}" y="${tableY + 10}" width="${w - 24}" height="34" rx="8" fill="${theme.primaryLight}" />
    <text x="${x + 24}" y="${tableY + 31}" fill="${theme.textSecondary}" font-size="10">会话</text>
    <text x="${x + 286}" y="${tableY + 31}" fill="${theme.textSecondary}" font-size="10">类型</text>
    <text x="${x + 372}" y="${tableY + 31}" fill="${theme.textSecondary}" font-size="10">消息数</text>
    <text x="${x + 468}" y="${tableY + 31}" fill="${theme.textSecondary}" font-size="10">增量</text>
    <text x="${x + 562}" y="${tableY + 31}" fill="${theme.textSecondary}" font-size="10">最近导出</text>
    ${tableRows}

    ${withSelection && model.drawerConditional ? `
      <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(15, 23, 42, 0.12)" />
      <rect x="${drawerX}" y="${y + 10}" width="${drawerW}" height="${h - 20}" rx="16" fill="${theme.cardBg}" stroke="${theme.border}" />
      <circle cx="${drawerX + drawerW - 24}" cy="${y + 30}" r="14" fill="${theme.bgSecondary}" stroke="${theme.border}" />
      <text x="${drawerX + drawerW - 28}" y="${y + 34}" fill="${theme.textSecondary}" font-size="14">×</text>

      <rect x="${drawerX + 18}" y="${y + 20}" width="${drawerW - 56}" height="84" rx="12" fill="${theme.primaryLight}" stroke="${theme.border}" />
      <text x="${drawerX + 34}" y="${y + 50}" fill="${theme.textPrimary}" font-size="14" font-weight="600">产品讨论群</text>
      <text x="${drawerX + 34}" y="${y + 70}" fill="${theme.textSecondary}" font-size="11">wxid: wxid_team_product_2026 · 最近导出 2026-03-01 23:12</text>

      <rect x="${drawerX + 18}" y="${y + 116}" width="${drawerW - 36}" height="148" rx="10" fill="${theme.bgTertiary}" stroke="${theme.border}" />
      <text x="${drawerX + 34}" y="${y + 146}" fill="${theme.textPrimary}" font-size="13" font-weight="600">会话详情与导出设置</text>
      <text x="${drawerX + 34}" y="${y + 168}" fill="${theme.textSecondary}" font-size="11">消息总数：32,984 · 图片：2,143 · 视频：132 · 语音：418 · 表情：265</text>
      <text x="${drawerX + 34}" y="${y + 188}" fill="${theme.textSecondary}" font-size="11">格式：JSON / HTML / CSV / Excel / SQL / VCF / ChatLab</text>
      <text x="${drawerX + 34}" y="${y + 208}" fill="${theme.textSecondary}" font-size="11">时间范围：2024-01-01 至 2026-03-02 · 跳过规则：无新增则跳过</text>

      <rect x="${drawerX + 34}" y="${y + 224}" width="138" height="34" rx="8" fill="${theme.primary}" />
      <text x="${drawerX + 74}" y="${y + 246}" fill="#fff" font-size="12" font-weight="600">导出此会话</text>

      <rect x="${drawerX + 18}" y="${y + 278}" width="${drawerW - 36}" height="${h - 306}" rx="10" fill="${theme.bgTertiary}" stroke="${theme.border}" />
      <text x="${drawerX + 34}" y="${y + 308}" fill="${theme.textPrimary}" font-size="13" font-weight="600">最近导出记录</text>
      <text x="${drawerX + 34}" y="${y + 330}" fill="${theme.textSecondary}" font-size="11">2026-03-01 23:12 · HTML + JSON · 32,856 条</text>
      <text x="${drawerX + 34}" y="${y + 350}" fill="${theme.textSecondary}" font-size="11">2026-02-28 20:45 · CSV · 32,721 条</text>
    ` : ''}
  `
}

function renderDataContent(theme, x, y, w, h) {
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${theme.cardBg}" stroke="${theme.border}" />

    <rect x="${x + 16}" y="${y + 14}" width="100" height="30" rx="15" fill="${theme.primary}" />
    <text x="${x + 48}" y="${y + 34}" fill="#fff" font-size="12" font-weight="600">数据库</text>
    <rect x="${x + 126}" y="${y + 14}" width="112" height="30" rx="15" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <text x="${x + 160}" y="${y + 34}" fill="${theme.primary}" font-size="12" font-weight="600">图片解密</text>

    <rect x="${x + 16}" y="${y + 56}" width="${w - 32}" height="112" rx="10" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <text x="${x + 34}" y="${y + 86}" fill="${theme.textPrimary}" font-size="14" font-weight="600">解密进度总览</text>
    <rect x="${x + 34}" y="${y + 98}" width="${w - 68}" height="12" rx="6" fill="${theme.bgSecondary}" stroke="${theme.border}" />
    <rect x="${x + 34}" y="${y + 98}" width="${Math.floor((w - 68) * 0.73)}" height="12" rx="6" fill="${theme.primary}" />
    <text x="${x + 34}" y="${y + 138}" fill="${theme.textSecondary}" font-size="11">当前任务：图片批量解密（2,184 / 3,000，预计剩余 3 分钟）</text>

    <rect x="${x + 16}" y="${y + 182}" width="${Math.floor((w - 44) * 0.55)}" height="${h - 198}" rx="10" fill="${theme.bgTertiary}" stroke="${theme.border}" />
    <rect x="${x + 28}" y="${y + 194}" width="${Math.floor((w - 44) * 0.55) - 24}" height="52" rx="8" fill="${theme.cardBg}" stroke="${theme.border}" />
    <text x="${x + 40}" y="${y + 216}" fill="${theme.textPrimary}" font-size="12" font-weight="600">MSG0.db</text>
    <text x="${x + 40}" y="${y + 234}" fill="${theme.textSecondary}" font-size="10">12.8 MB · 已解密</text>

    <rect x="${x + 28}" y="${y + 254}" width="${Math.floor((w - 44) * 0.55) - 24}" height="52" rx="8" fill="${theme.cardBg}" stroke="${theme.border}" />
    <text x="${x + 40}" y="${y + 276}" fill="${theme.textPrimary}" font-size="12" font-weight="600">MediaMSG0.db</text>
    <text x="${x + 40}" y="${y + 294}" fill="${theme.textSecondary}" font-size="10">84.3 MB · 需更新</text>

    <rect x="${x + 28}" y="${y + 314}" width="${Math.floor((w - 44) * 0.55) - 24}" height="52" rx="8" fill="${theme.cardBg}" stroke="${theme.border}" />
    <text x="${x + 40}" y="${y + 336}" fill="${theme.textPrimary}" font-size="12" font-weight="600">MicroMsg.db</text>
    <text x="${x + 40}" y="${y + 354}" fill="${theme.textSecondary}" font-size="10">63.1 MB · 已解密</text>

    <rect x="${x + Math.floor((w - 44) * 0.55) + 28}" y="${y + 182}" width="${w - Math.floor((w - 44) * 0.55) - 56}" height="${h - 198}" rx="10" fill="${theme.bgTertiary}" stroke="${theme.border}" />
    <text x="${x + Math.floor((w - 44) * 0.55) + 44}" y="${y + 212}" fill="${theme.textPrimary}" font-size="13" font-weight="600">图片与路径任务</text>
    <text x="${x + Math.floor((w - 44) * 0.55) + 44}" y="${y + 238}" fill="${theme.textSecondary}" font-size="11">images/2026/03：成功 2,184 · 失败 12 · 排队 804</text>
    <text x="${x + Math.floor((w - 44) * 0.55) + 44}" y="${y + 260}" fill="${theme.textSecondary}" font-size="11">Emojis/2025：成功 836 · 失败 0</text>
  `
}

function renderChatStandalone(theme, x, y, w, h) {
  return `
    ${renderWindowTitle(theme, x, y, w, '聊天窗口', 'standalone /chat-window')}
    <rect x="${x}" y="${y + 38}" width="${w}" height="${h - 38}" fill="${theme.bgSecondary}" stroke="${theme.border}" />
    <text x="${x + 20}" y="${y + 74}" fill="${theme.textPrimary}" font-size="14" font-weight="600">此图展示聊天独立窗口结构（来源 ChatPage standalone 样式）</text>
    <rect x="${x + 18}" y="${y + 90}" width="324" height="${h - 130}" rx="10" fill="${theme.cardBg}" stroke="${theme.border}" />
    <rect x="${x + 354}" y="${y + 90}" width="${w - 372}" height="${h - 130}" rx="10" fill="${theme.cardBg}" stroke="${theme.border}" />
  `
}

function renderMomentsStandalone(theme, x, y, w, h) {
  return `
    ${renderWindowTitle(theme, x, y, w, '朋友圈窗口', 'standalone /moments-window')}
    <rect x="${x}" y="${y + 38}" width="${w}" height="${h - 38}" fill="${theme.bgPrimary}" stroke="${theme.border}" />
    <rect x="${x}" y="${y + 38}" width="280" height="${h - 38}" fill="${theme.bgSecondary}" stroke="${theme.border}" />
    <rect x="${x + 280}" y="${y + 38}" width="${w - 280}" height="${h - 38}" fill="${theme.cardBg}" stroke="${theme.border}" />
  `
}

function renderPanel(theme, sidebar, routes, exportModel, panel) {
  const [bg1, bg2] = parseColorStops(theme.bgGradient)

  let body = ''
  if (panel === 'export' || panel === 'export-selected' || panel === 'data') {
    const contentX = 16 + sidebar.width
    const contentW = WIDTH - contentX - 16

    body += renderMainSidebar(
      theme,
      sidebar,
      panel === 'data' ? 'none' : 'export',
      theme.mode === 'light' ? sidebar.themeLabels.light : sidebar.themeLabels.dark
    )

    if (panel === 'data') {
      body += renderWindowTitle(theme, contentX, 16, contentW, '数据管理', routes.includes('/data-management') ? '路由 /data-management（主窗口）' : '数据管理（主窗口）')
      body += renderDataContent(theme, contentX, 54, contentW, HEIGHT - 70)
    } else {
      const subtitle = exportModel.listOnlyWithNoSelection
        ? '路由 /export：默认仅列表，选中会话后显示详情抽屉'
        : '路由 /export'
      body += renderWindowTitle(theme, contentX, 16, contentW, panel === 'export' ? '导出数据主界面（未选中会话）' : '导出数据主界面（已选中会话）', subtitle)
      body += renderExportContent(theme, exportModel, contentX, 54, contentW, HEIGHT - 70, panel === 'export-selected')
    }
  }

  if (panel === 'chat') {
    body += renderChatStandalone(theme, 16, 16, WIDTH - 32, HEIGHT - 32)
  }

  if (panel === 'moments') {
    body += renderMomentsStandalone(theme, 16, 16, WIDTH - 32, HEIGHT - 32)
  }

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${bg1}" />
          <stop offset="100%" stop-color="${bg2}" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)" />
      ${body}
    </svg>
  `
}

function main() {
  const sidebar = loadSidebarModel()
  const routes = loadAppRoutes()
  const exportModel = loadExportModel()
  const themes = [loadTheme('light'), loadTheme('dark')]
  const panels = ['chat', 'export', 'export-selected', 'moments', 'data']

  fs.mkdirSync(OUT_DIR, { recursive: true })

  for (const theme of themes) {
    for (const panel of panels) {
      const outputPath = path.join(OUT_DIR, `${theme.mode}-${panel}.svg`)
      fs.writeFileSync(outputPath, renderPanel(theme, sidebar, routes, exportModel, panel), 'utf-8')
      console.log(`[readme-shots] wrote ${outputPath}`)
    }
  }
}

main()
