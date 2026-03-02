const fs = require('fs')
const path = require('path')

const WIDTH = 1660
const HEIGHT = 980
const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'readme-shots')

const THEMES = {
  light: {
    bgStart: '#F0EEE9',
    bgEnd: '#E8E6E1',
    shell: 'rgba(255,255,255,0.72)',
    sidebar: 'rgba(255,255,255,0.74)',
    panel: 'rgba(255,255,255,0.84)',
    panelStrong: '#FFFFFF',
    border: 'rgba(0,0,0,0.08)',
    text: '#3d3d3d',
    textSecondary: '#666666',
    textTertiary: '#999999',
    primary: '#8B7355',
    primaryHover: '#7A6548',
    primaryLight: 'rgba(139,115,85,0.12)',
    success: '#16a34a',
    warning: '#d97706',
    danger: '#ef4444',
    messageSelf: '#e8dfd1',
    messageOther: '#ffffff'
  },
  dark: {
    bgStart: '#1a1816',
    bgEnd: '#252220',
    shell: 'rgba(34,30,27,0.78)',
    sidebar: 'rgba(40,36,32,0.9)',
    panel: 'rgba(40,36,32,0.9)',
    panelStrong: '#2f2a26',
    border: 'rgba(255,255,255,0.1)',
    text: '#F0EEE9',
    textSecondary: '#b3b0aa',
    textTertiary: '#807d78',
    primary: '#C9A86C',
    primaryHover: '#D9B87C',
    primaryLight: 'rgba(201,168,108,0.2)',
    success: '#34d399',
    warning: '#fbbf24',
    danger: '#fb7185',
    messageSelf: '#4f4334',
    messageOther: '#302a25'
  }
}

const NAV_ITEMS = [
  { key: 'export', label: '导出数据' },
  { key: 'chat', label: '聊天记录' },
  { key: 'moments', label: '朋友圈' },
  { key: 'data', label: '数据管理' },
  { key: 'settings', label: '设置' }
]

function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function getPanelMeta(panel) {
  if (panel === 'chat') {
    return {
      title: '聊天记录查看',
      subtitle: '会话检索、消息流预览与关键内容定位',
      nav: 'chat'
    }
  }

  if (panel === 'export') {
    return {
      title: '多格式数据导出',
      subtitle: '会话筛选、导出统计、增量判断与格式配置',
      nav: 'export'
    }
  }

  if (panel === 'moments') {
    return {
      title: '朋友圈浏览',
      subtitle: '按联系人和时间范围查看动态，支持媒体归档',
      nav: 'moments'
    }
  }

  return {
    title: '数据管理与解密',
    subtitle: '数据库状态、批量解密进度与缓存路径管理',
    nav: 'data'
  }
}

function renderNav(theme, activeKey) {
  const navStartY = 134

  return NAV_ITEMS.map((item, index) => {
    const y = navStartY + index * 58
    const isActive = item.key === activeKey

    return `
      <rect x="32" y="${y}" width="124" height="44" rx="22" fill="${isActive ? theme.primary : 'transparent'}" />
      <circle cx="52" cy="${y + 22}" r="7" fill="${isActive ? '#ffffff' : theme.textSecondary}" />
      <text x="68" y="${y + 28}" fill="${isActive ? '#ffffff' : theme.textSecondary}" font-size="14" font-weight="500">${item.label}</text>
    `
  }).join('')
}

function renderShell(themeName, panel) {
  const theme = THEMES[themeName]
  const meta = getPanelMeta(panel)

  return `
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${theme.bgStart}" />
        <stop offset="100%" stop-color="${theme.bgEnd}" />
      </linearGradient>
      <linearGradient id="titlebar" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${theme.panelStrong}" stop-opacity="0.7" />
        <stop offset="100%" stop-color="${theme.panelStrong}" stop-opacity="0.45" />
      </linearGradient>
    </defs>

    <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)" />

    <rect x="16" y="16" width="1628" height="948" rx="24" fill="${theme.shell}" stroke="${theme.border}" />

    <rect x="24" y="24" width="140" height="932" rx="18" fill="${theme.sidebar}" stroke="${theme.border}" />
    <text x="52" y="70" fill="${theme.primary}" font-size="24" font-weight="700">VX</text>
    <text x="82" y="70" fill="${theme.text}" font-size="16" font-weight="600">daochu</text>
    <text x="32" y="98" fill="${theme.textTertiary}" font-size="11">core preview</text>
    ${renderNav(theme, meta.nav)}

    <rect x="180" y="24" width="1456" height="932" rx="18" fill="${theme.panel}" stroke="${theme.border}" />
    <rect x="180" y="24" width="1456" height="84" rx="18" fill="url(#titlebar)" />
    <circle cx="208" cy="53" r="6" fill="${theme.danger}" opacity="0.85" />
    <circle cx="228" cy="53" r="6" fill="${theme.warning}" opacity="0.85" />
    <circle cx="248" cy="53" r="6" fill="${theme.success}" opacity="0.85" />

    <text x="286" y="61" fill="${theme.text}" font-size="21" font-weight="600">${meta.title}</text>
    <text x="286" y="87" fill="${theme.textSecondary}" font-size="13">${meta.subtitle}</text>

    <rect x="1420" y="40" width="88" height="30" rx="15" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <text x="1438" y="60" fill="${theme.primary}" font-size="12" font-weight="600">Cloud</text>
    <rect x="1516" y="40" width="104" height="30" rx="15" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <text x="1534" y="60" fill="${theme.primary}" font-size="12" font-weight="600">${themeName === 'dark' ? 'Dark' : 'Light'} Mode</text>
  `
}

function renderChatPanel(themeName) {
  const theme = THEMES[themeName]

  const sessions = [
    ['产品讨论群', '导出目录已经按账号隔离好了', '10:42', 3, true],
    ['陈小北', '周报我晚点补上', '09:58', 0, false],
    ['家人群', '[图片] 周末聚会安排', '昨天', 12, false],
    ['设计协作', '这版卡片阴影更舒服', '昨天', 0, false],
    ['Arkme 项目组', '请确认新版本导出字段', '周六', 0, false],
    ['技术支持', '已收到日志包，处理中', '周五', 1, false]
  ]

  const sessionRows = sessions.map((session, index) => {
    const y = 202 + index * 104
    const isActive = session[4]

    return `
      <rect x="210" y="${y}" width="340" height="90" rx="12" fill="${isActive ? theme.primaryLight : 'transparent'}" stroke="${isActive ? theme.primary : theme.border}" stroke-opacity="${isActive ? '0.35' : '1'}" />
      <circle cx="244" cy="${y + 45}" r="19" fill="${theme.primary}" />
      <text x="236" y="${y + 51}" fill="#fff" font-size="14" font-weight="700">${esc(String(session[0]).slice(0, 1))}</text>
      <text x="272" y="${y + 36}" fill="${theme.text}" font-size="15" font-weight="600">${esc(session[0])}</text>
      <text x="272" y="${y + 60}" fill="${theme.textSecondary}" font-size="12">${esc(session[1])}</text>
      <text x="504" y="${y + 34}" fill="${theme.textTertiary}" font-size="11">${esc(session[2])}</text>
      ${session[3] ? `<rect x="516" y="${y + 48}" width="24" height="20" rx="10" fill="#ef4444" /><text x="523" y="${y + 62}" fill="#fff" font-size="11" font-weight="700">${session[3]}</text>` : ''}
    `
  }).join('')

  return `
    <rect x="198" y="124" width="364" height="820" rx="14" fill="${theme.panelStrong}" fill-opacity="0.74" stroke="${theme.border}" />
    <rect x="214" y="140" width="332" height="44" rx="10" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <text x="232" y="168" fill="${theme.textSecondary}" font-size="12">搜索会话 / 联系人 / 关键词</text>
    ${sessionRows}

    <rect x="578" y="124" width="1040" height="820" rx="14" fill="${theme.panelStrong}" fill-opacity="0.74" stroke="${theme.border}" />
    <rect x="578" y="124" width="1040" height="64" rx="14" fill="${theme.primaryLight}" />
    <text x="608" y="163" fill="${theme.text}" font-size="17" font-weight="600">产品讨论群</text>
    <text x="716" y="163" fill="${theme.textSecondary}" font-size="12">(32984 条消息)</text>
    <text x="1470" y="163" fill="${theme.success}" font-size="12">实时同步中</text>

    <rect x="602" y="214" width="220" height="52" rx="14" fill="${theme.messageOther}" stroke="${theme.border}" />
    <text x="618" y="246" fill="${theme.text}" font-size="14">导出前能看到历史记录吗？</text>

    <rect x="998" y="288" width="540" height="52" rx="14" fill="${theme.messageSelf}" stroke="${theme.border}" />
    <text x="1014" y="320" fill="${theme.text}" font-size="14">可以，会展示每次导出时间和消息增量。</text>

    <rect x="602" y="362" width="260" height="52" rx="14" fill="${theme.messageOther}" stroke="${theme.border}" />
    <text x="618" y="394" fill="${theme.text}" font-size="14">我想先看最近 30 天。</text>

    <rect x="944" y="436" width="594" height="52" rx="14" fill="${theme.messageSelf}" stroke="${theme.border}" />
    <text x="960" y="468" fill="${theme.text}" font-size="14">已支持日期筛选，语音/图片也能单独导出。</text>

    <rect x="602" y="510" width="324" height="52" rx="14" fill="${theme.messageOther}" stroke="${theme.border}" />
    <text x="618" y="542" fill="${theme.text}" font-size="14">那导出目录能按账号隔离吗？</text>

    <rect x="1018" y="584" width="520" height="52" rx="14" fill="${theme.messageSelf}" stroke="${theme.border}" />
    <text x="1034" y="616" fill="${theme.text}" font-size="14">可以，已支持共享目录和账号子目录策略。</text>

    <rect x="598" y="866" width="884" height="54" rx="12" fill="${theme.panelStrong}" stroke="${theme.border}" />
    <text x="620" y="900" fill="${theme.textTertiary}" font-size="13">输入消息、过滤关键词或跳转日期...</text>
    <rect x="1492" y="866" width="106" height="54" rx="12" fill="${theme.primary}" />
    <text x="1528" y="899" fill="#fff" font-size="16" font-weight="600">发送</text>
  `
}

function renderExportPanel(themeName) {
  const theme = THEMES[themeName]

  const rows = [
    ['产品讨论群', '群聊', '32,984', '+128', 'HTML/JSON'],
    ['陈小北', '私聊', '8,214', '+0', 'CSV'],
    ['家人群', '群聊', '14,502', '+42', 'Excel'],
    ['Arkme 项目组', '群聊', '22,306', '+87', 'HTML']
  ]

  const tableRows = rows.map((row, index) => {
    const y = 328 + index * 74
    return `
      <line x1="216" y1="${y}" x2="722" y2="${y}" stroke="${theme.border}" />
      <text x="228" y="${y + 44}" fill="${theme.text}" font-size="13">${row[0]}</text>
      <text x="430" y="${y + 44}" fill="${theme.textSecondary}" font-size="12">${row[1]}</text>
      <text x="500" y="${y + 44}" fill="${theme.text}" font-size="12">${row[2]}</text>
      <text x="576" y="${y + 44}" fill="${row[3] === '+0' ? theme.textTertiary : theme.success}" font-size="12" font-weight="600">${row[3]}</text>
      <text x="634" y="${y + 44}" fill="${theme.textSecondary}" font-size="12">${row[4]}</text>
    `
  }).join('')

  return `
    <rect x="198" y="124" width="536" height="820" rx="14" fill="${theme.panelStrong}" fill-opacity="0.74" stroke="${theme.border}" />
    <text x="222" y="160" fill="${theme.text}" font-size="15" font-weight="600">会话列表</text>
    <rect x="306" y="138" width="180" height="28" rx="14" fill="${theme.primaryLight}" />
    <text x="320" y="157" fill="${theme.primary}" font-size="11">仅群聊和私聊 · 排除公众号</text>

    <rect x="216" y="182" width="500" height="56" rx="10" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <text x="236" y="205" fill="${theme.textSecondary}" font-size="12">关键词筛选</text>
    <text x="236" y="224" fill="${theme.text}" font-size="13">产品 / 导出 / 增量</text>

    <rect x="216" y="256" width="506" height="660" rx="10" fill="${theme.panelStrong}" stroke="${theme.border}" />
    <rect x="216" y="256" width="506" height="44" rx="10" fill="${theme.primaryLight}" />
    <text x="228" y="284" fill="${theme.textTertiary}" font-size="11">会话</text>
    <text x="430" y="284" fill="${theme.textTertiary}" font-size="11">类型</text>
    <text x="500" y="284" fill="${theme.textTertiary}" font-size="11">消息</text>
    <text x="576" y="284" fill="${theme.textTertiary}" font-size="11">增量</text>
    <text x="634" y="284" fill="${theme.textTertiary}" font-size="11">格式</text>
    ${tableRows}

    <rect x="750" y="124" width="868" height="820" rx="14" fill="${theme.panelStrong}" fill-opacity="0.74" stroke="${theme.border}" />

    <rect x="774" y="148" width="820" height="110" rx="12" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <circle cx="812" cy="203" r="22" fill="${theme.primary}" />
    <text x="803" y="210" fill="#fff" font-size="15" font-weight="700">群</text>
    <text x="846" y="192" fill="${theme.text}" font-size="16" font-weight="600">产品讨论群</text>
    <text x="846" y="216" fill="${theme.textSecondary}" font-size="12">wxid_team_product_2026</text>
    <text x="846" y="238" fill="${theme.success}" font-size="12">连接正常 · 最近导出 2026-03-01 23:12</text>

    <rect x="774" y="278" width="252" height="92" rx="10" fill="${theme.panelStrong}" stroke="${theme.border}" />
    <text x="792" y="306" fill="${theme.textTertiary}" font-size="11">消息总数</text>
    <text x="792" y="346" fill="${theme.text}" font-size="28" font-weight="700">32,984</text>

    <rect x="1042" y="278" width="252" height="92" rx="10" fill="${theme.panelStrong}" stroke="${theme.border}" />
    <text x="1060" y="306" fill="${theme.textTertiary}" font-size="11">待同步增量</text>
    <text x="1060" y="346" fill="${theme.success}" font-size="28" font-weight="700">+128</text>

    <rect x="1310" y="278" width="284" height="92" rx="10" fill="${theme.panelStrong}" stroke="${theme.border}" />
    <text x="1328" y="306" fill="${theme.textTertiary}" font-size="11">导出目录</text>
    <text x="1328" y="334" fill="${theme.textSecondary}" font-size="12">D:/VXdaochu/Export/产品讨论群</text>

    <rect x="774" y="388" width="820" height="220" rx="12" fill="${theme.panelStrong}" stroke="${theme.border}" />
    <text x="792" y="420" fill="${theme.text}" font-size="14" font-weight="600">导出格式</text>

    <rect x="792" y="438" width="92" height="32" rx="16" fill="${theme.primaryLight}" /><text x="820" y="460" fill="${theme.primary}" font-size="12">JSON</text>
    <rect x="894" y="438" width="92" height="32" rx="16" fill="${theme.primaryLight}" /><text x="924" y="460" fill="${theme.primary}" font-size="12">HTML</text>
    <rect x="996" y="438" width="92" height="32" rx="16" fill="${theme.primaryLight}" /><text x="1028" y="460" fill="${theme.primary}" font-size="12">CSV</text>
    <rect x="1098" y="438" width="92" height="32" rx="16" fill="${theme.primaryLight}" /><text x="1126" y="460" fill="${theme.primary}" font-size="12">Excel</text>
    <rect x="1200" y="438" width="92" height="32" rx="16" fill="${theme.primaryLight}" /><text x="1231" y="460" fill="${theme.primary}" font-size="12">SQL</text>
    <rect x="1302" y="438" width="92" height="32" rx="16" fill="${theme.primaryLight}" /><text x="1335" y="460" fill="${theme.primary}" font-size="12">VCF</text>
    <rect x="1404" y="438" width="132" height="32" rx="16" fill="${theme.primaryLight}" /><text x="1434" y="460" fill="${theme.primary}" font-size="12">ChatLab</text>

    <text x="792" y="514" fill="${theme.textSecondary}" font-size="12">时间范围：2024-01-01 至 2026-03-02</text>
    <text x="792" y="538" fill="${theme.textSecondary}" font-size="12">媒体选项：图片、语音、视频、表情</text>
    <text x="792" y="562" fill="${theme.textSecondary}" font-size="12">跳过规则：无新增时自动跳过</text>

    <rect x="792" y="626" width="188" height="44" rx="10" fill="${theme.primary}" />
    <text x="842" y="654" fill="#fff" font-size="15" font-weight="600">导出此会话</text>
    <rect x="992" y="626" width="188" height="44" rx="10" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <text x="1042" y="654" fill="${theme.primary}" font-size="15" font-weight="600">批量导出</text>
    <rect x="1192" y="626" width="188" height="44" rx="10" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <text x="1238" y="654" fill="${theme.primary}" font-size="15" font-weight="600">打开目录</text>

    <rect x="774" y="686" width="820" height="230" rx="12" fill="${theme.panelStrong}" stroke="${theme.border}" />
    <text x="792" y="718" fill="${theme.text}" font-size="14" font-weight="600">最近导出记录</text>
    <line x1="792" y1="738" x2="1574" y2="738" stroke="${theme.border}" />
    <text x="792" y="766" fill="${theme.textSecondary}" font-size="12">2026-03-01 23:12  ·  HTML + JSON  ·  32,856 条</text>
    <text x="792" y="792" fill="${theme.textSecondary}" font-size="12">2026-02-28 20:45  ·  CSV         ·  32,721 条</text>
    <text x="792" y="818" fill="${theme.textSecondary}" font-size="12">2026-02-25 09:20  ·  Excel       ·  32,312 条</text>
  `
}

function renderMomentsPanel(themeName) {
  const theme = THEMES[themeName]

  return `
    <rect x="198" y="124" width="304" height="820" rx="14" fill="${theme.panelStrong}" fill-opacity="0.74" stroke="${theme.border}" />
    <text x="222" y="160" fill="${theme.text}" font-size="15" font-weight="600">筛选条件</text>

    <rect x="222" y="178" width="256" height="46" rx="10" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <text x="238" y="207" fill="${theme.textSecondary}" font-size="12">时间范围：最近 90 天</text>

    <rect x="222" y="236" width="256" height="46" rx="10" fill="${theme.panelStrong}" stroke="${theme.border}" />
    <text x="238" y="265" fill="${theme.textSecondary}" font-size="12">联系人：全部（32）</text>

    <rect x="222" y="294" width="256" height="46" rx="10" fill="${theme.panelStrong}" stroke="${theme.border}" />
    <text x="238" y="323" fill="${theme.textSecondary}" font-size="12">媒体：图文 + 视频</text>

    <rect x="222" y="360" width="256" height="42" rx="10" fill="${theme.primary}" />
    <text x="300" y="387" fill="#fff" font-size="14" font-weight="600">导出当前筛选</text>

    <rect x="222" y="420" width="256" height="500" rx="10" fill="${theme.panelStrong}" stroke="${theme.border}" />
    <text x="238" y="446" fill="${theme.textSecondary}" font-size="12">常用联系人</text>
    <rect x="238" y="456" width="224" height="44" rx="8" fill="${theme.primaryLight}" />
    <text x="254" y="483" fill="${theme.primary}" font-size="13">林予安  ·  45 条动态</text>
    <rect x="238" y="508" width="224" height="44" rx="8" fill="${theme.panelStrong}" stroke="${theme.border}" />
    <text x="254" y="535" fill="${theme.textSecondary}" font-size="13">周同学  ·  28 条动态</text>
    <rect x="238" y="560" width="224" height="44" rx="8" fill="${theme.panelStrong}" stroke="${theme.border}" />
    <text x="254" y="587" fill="${theme.textSecondary}" font-size="13">工作群助手 · 19 条动态</text>

    <rect x="518" y="124" width="1118" height="820" rx="14" fill="${theme.panelStrong}" fill-opacity="0.74" stroke="${theme.border}" />

    <rect x="542" y="148" width="1070" height="334" rx="12" fill="${theme.panelStrong}" stroke="${theme.border}" />
    <circle cx="574" cy="184" r="18" fill="${theme.primary}" />
    <text x="603" y="190" fill="${theme.text}" font-size="15" font-weight="600">林予安</text>
    <text x="603" y="212" fill="${theme.textSecondary}" font-size="12">3月2日 09:21 · iPhone 15 Pro</text>
    <text x="574" y="248" fill="${theme.text}" font-size="14">终于把 2025 年的出行照片整理完了，顺便导出做了个时间轴。</text>

    <rect x="574" y="272" width="328" height="166" rx="10" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <rect x="914" y="272" width="328" height="166" rx="10" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <rect x="1254" y="272" width="328" height="166" rx="10" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <text x="708" y="360" fill="${theme.textSecondary}" font-size="13">图片 A</text>
    <text x="1048" y="360" fill="${theme.textSecondary}" font-size="13">图片 B</text>
    <text x="1388" y="360" fill="${theme.textSecondary}" font-size="13">图片 C</text>
    <text x="574" y="468" fill="${theme.textTertiary}" font-size="12">点赞 45 · 评论 18 · 收藏 3</text>

    <rect x="542" y="498" width="1070" height="420" rx="12" fill="${theme.panelStrong}" stroke="${theme.border}" />
    <circle cx="574" cy="534" r="18" fill="${theme.primary}" />
    <text x="603" y="540" fill="${theme.text}" font-size="15" font-weight="600">周同学</text>
    <text x="603" y="562" fill="${theme.textSecondary}" font-size="12">3月1日 21:03 · Mac</text>
    <text x="574" y="598" fill="${theme.text}" font-size="14">昨天那场分享会的提纲，发在这里备忘。</text>

    <rect x="574" y="622" width="500" height="228" rx="10" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <rect x="1086" y="622" width="500" height="228" rx="10" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <text x="798" y="740" fill="${theme.textSecondary}" font-size="13">图片 D</text>
    <text x="1310" y="740" fill="${theme.textSecondary}" font-size="13">图片 E</text>
    <text x="574" y="884" fill="${theme.textTertiary}" font-size="12">点赞 27 · 评论 9</text>
  `
}

function renderDataPanel(themeName) {
  const theme = THEMES[themeName]

  const dbRows = [
    ['MSG0.db', '已解密', '12.8 MB', 'success'],
    ['MediaMSG0.db', '需更新', '84.3 MB', 'warning'],
    ['MicroMsg.db', '已解密', '63.1 MB', 'success'],
    ['OpenIMContact.db', '待处理', '1.3 MB', 'pending']
  ]

  const dbRowElements = dbRows.map((row, index) => {
    const y = 388 + index * 74
    const statusColor = row[3] === 'success'
      ? theme.success
      : row[3] === 'warning'
        ? theme.warning
        : theme.textTertiary

    return `
      <rect x="222" y="${y}" width="684" height="60" rx="10" fill="${theme.panelStrong}" stroke="${theme.border}" />
      <text x="246" y="${y + 24}" fill="${theme.text}" font-size="13" font-weight="600">${row[0]}</text>
      <text x="246" y="${y + 44}" fill="${theme.textSecondary}" font-size="11">缓存文件大小：${row[2]}</text>
      <rect x="790" y="${y + 16}" width="90" height="28" rx="14" fill="${theme.primaryLight}" />
      <text x="816" y="${y + 34}" fill="${statusColor}" font-size="12">${row[1]}</text>
    `
  }).join('')

  return `
    <rect x="198" y="124" width="1438" height="820" rx="14" fill="${theme.panelStrong}" fill-opacity="0.74" stroke="${theme.border}" />

    <rect x="222" y="146" width="128" height="34" rx="17" fill="${theme.primary}" />
    <text x="264" y="168" fill="#fff" font-size="12" font-weight="600">数据库</text>
    <rect x="360" y="146" width="128" height="34" rx="17" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <text x="397" y="168" fill="${theme.primary}" font-size="12" font-weight="600">图片解密</text>

    <rect x="222" y="204" width="1390" height="132" rx="12" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <text x="246" y="238" fill="${theme.text}" font-size="15" font-weight="600">解密进度总览</text>
    <rect x="246" y="254" width="1342" height="16" rx="8" fill="${theme.panelStrong}" stroke="${theme.border}" />
    <rect x="246" y="254" width="980" height="16" rx="8" fill="${theme.primary}" />
    <text x="246" y="298" fill="${theme.textSecondary}" font-size="12">当前任务：图片批量解密（2,184 / 3,000，预计剩余 3 分钟）</text>

    <rect x="222" y="356" width="706" height="564" rx="12" fill="${theme.panelStrong}" stroke="${theme.border}" />
    <text x="246" y="386" fill="${theme.text}" font-size="14" font-weight="600">数据库列表</text>
    ${dbRowElements}

    <rect x="948" y="356" width="664" height="280" rx="12" fill="${theme.panelStrong}" stroke="${theme.border}" />
    <text x="972" y="386" fill="${theme.text}" font-size="14" font-weight="600">图片解密任务</text>
    <rect x="972" y="406" width="616" height="58" rx="10" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <text x="996" y="431" fill="${theme.text}" font-size="13" font-weight="600">images/2026/03</text>
    <text x="996" y="451" fill="${theme.textSecondary}" font-size="11">成功 2,184 · 失败 12 · 排队 804</text>

    <rect x="972" y="476" width="616" height="58" rx="10" fill="${theme.panelStrong}" stroke="${theme.border}" />
    <text x="996" y="501" fill="${theme.text}" font-size="13" font-weight="600">Emojis/2025</text>
    <text x="996" y="521" fill="${theme.textSecondary}" font-size="11">成功 836 · 失败 0 · 已完成</text>

    <rect x="972" y="556" width="198" height="42" rx="10" fill="${theme.primary}" />
    <text x="1024" y="582" fill="#fff" font-size="13" font-weight="600">开始解密</text>
    <rect x="1182" y="556" width="198" height="42" rx="10" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <text x="1232" y="582" fill="${theme.primary}" font-size="13" font-weight="600">增量更新</text>
    <rect x="1392" y="556" width="196" height="42" rx="10" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <text x="1456" y="582" fill="${theme.primary}" font-size="13" font-weight="600">切换目录</text>

    <rect x="948" y="652" width="664" height="268" rx="12" fill="${theme.panelStrong}" stroke="${theme.border}" />
    <text x="972" y="682" fill="${theme.text}" font-size="14" font-weight="600">路径配置</text>

    <rect x="972" y="702" width="616" height="56" rx="10" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <text x="996" y="726" fill="${theme.textSecondary}" font-size="11">数据库目录</text>
    <text x="996" y="746" fill="${theme.text}" font-size="13">D:/WeChat/Data</text>

    <rect x="972" y="770" width="616" height="56" rx="10" fill="${theme.primaryLight}" stroke="${theme.border}" />
    <text x="996" y="794" fill="${theme.textSecondary}" font-size="11">缓存目录</text>
    <text x="996" y="814" fill="${theme.text}" font-size="13">D:/VXdaochu/Cache</text>

    <text x="972" y="864" fill="${theme.textTertiary}" font-size="11">最近同步：2026-03-02 10:58 · 自动更新间隔：30 秒</text>
  `
}

function renderPanel(themeName, panel) {
  let content = ''

  if (panel === 'chat') content = renderChatPanel(themeName)
  if (panel === 'export') content = renderExportPanel(themeName)
  if (panel === 'moments') content = renderMomentsPanel(themeName)
  if (panel === 'data') content = renderDataPanel(themeName)

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
      ${renderShell(themeName, panel)}
      ${content}
    </svg>
  `
}

async function main() {
  const panels = ['chat', 'export', 'moments', 'data']
  const themes = ['light', 'dark']

  fs.mkdirSync(OUT_DIR, { recursive: true })

  for (const theme of themes) {
    for (const panel of panels) {
      const outputPath = path.join(OUT_DIR, `${theme}-${panel}.svg`)
      fs.writeFileSync(outputPath, renderPanel(theme, panel), 'utf-8')
      console.log(`[readme-shots] wrote ${outputPath}`)
    }
  }
}

main().catch((error) => {
  console.error('[readme-shots] generation failed:', error)
  process.exit(1)
})
