const fs = require('fs')
const path = require('path')

const WIDTH = 1560
const HEIGHT = 980
const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'readme-shots')

const THEMES = {
  light: {
    bgStart: '#f5f7fb',
    bgEnd: '#eaf2ff',
    surface: '#ffffff',
    border: '#d8e2f0',
    text: '#10203b',
    subtle: '#617192',
    accent: '#1f7ae0',
    soft: '#e5f0ff',
    good: '#159957',
    warn: '#d97706'
  },
  dark: {
    bgStart: '#1a2842',
    bgEnd: '#0a101c',
    surface: '#14213a',
    border: '#31415f',
    text: '#e4edff',
    subtle: '#9cb1d6',
    accent: '#5ea7ff',
    soft: '#23395f',
    good: '#34d399',
    warn: '#fbbf24'
  }
}

function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function header(themeName, title, subtitle) {
  const theme = THEMES[themeName]
  return `
    <text x="62" y="92" fill="${theme.text}" font-size="46" font-weight="700">${esc(title)}</text>
    <text x="62" y="132" fill="${theme.subtle}" font-size="23">${esc(subtitle)}</text>
    <rect x="1180" y="52" width="145" height="40" rx="20" fill="${theme.surface}" stroke="${theme.border}" />
    <text x="1204" y="78" fill="${theme.subtle}" font-size="18">VXdaochu 2.2.5</text>
    <rect x="1338" y="52" width="160" height="40" rx="20" fill="${theme.surface}" stroke="${theme.border}" />
    <text x="1365" y="78" fill="${theme.subtle}" font-size="18">${themeName === 'dark' ? 'Dark Mode' : 'Light Mode'}</text>
  `
}

function panelShell(themeName) {
  const theme = THEMES[themeName]
  return `
    <rect x="40" y="168" width="1480" height="772" rx="30" fill="${theme.surface}" stroke="${theme.border}" />
  `
}

function chatContent(themeName) {
  const theme = THEMES[themeName]
  const sessions = [
    ['产品讨论群', '导出目录已经按账号隔离好了', '10:42', '3'],
    ['陈小北', '周报我晚点补上', '09:58', ''],
    ['家人群', '[图片] 周末聚会安排', '昨天', '12'],
    ['设计协作', '这版卡片阴影更舒服', '昨天', '']
  ]

  const sessionRows = sessions.map((session, index) => {
    const y = 242 + index * 116
    return `
      <rect x="80" y="${y}" width="430" height="100" rx="14" fill="${index === 0 ? theme.soft : 'transparent'}" stroke="${theme.border}" />
      <circle cx="120" cy="${y + 50}" r="22" fill="${theme.accent}" />
      <text x="158" y="${y + 40}" fill="${theme.text}" font-size="22" font-weight="600">${esc(session[0])}</text>
      <text x="158" y="${y + 73}" fill="${theme.subtle}" font-size="18">${esc(session[1])}</text>
      <text x="460" y="${y + 40}" fill="${theme.subtle}" font-size="16">${esc(session[2])}</text>
      ${session[3] ? `<rect x="468" y="${y + 58}" width="34" height="26" rx="13" fill="#f43f5e" /><text x="479" y="${y + 76}" fill="#fff" font-size="14">${session[3]}</text>` : ''}
    `
  }).join('')

  return `
    <rect x="70" y="222" width="450" height="690" rx="20" fill="${theme.surface}" stroke="${theme.border}" />
    ${sessionRows}

    <rect x="540" y="222" width="940" height="690" rx="20" fill="${theme.surface}" stroke="${theme.border}" />
    <rect x="944" y="246" width="132" height="34" rx="17" fill="${theme.soft}" stroke="${theme.border}" />
    <text x="971" y="270" fill="${theme.subtle}" font-size="17">2026-03-02</text>

    <rect x="580" y="316" width="420" height="64" rx="16" fill="${theme.soft}" stroke="${theme.border}" />
    <text x="604" y="355" fill="${theme.text}" font-size="21">导出前能看到历史记录吗？</text>

    <rect x="836" y="408" width="610" height="64" rx="16" fill="${theme.soft}" stroke="${theme.border}" />
    <text x="860" y="447" fill="${theme.text}" font-size="21">可以，会展示每次导出时间和消息增量。</text>

    <rect x="580" y="500" width="420" height="64" rx="16" fill="${theme.soft}" stroke="${theme.border}" />
    <text x="604" y="539" fill="${theme.text}" font-size="21">那我想先看最近 30 天。</text>

    <rect x="760" y="592" width="686" height="64" rx="16" fill="${theme.soft}" stroke="${theme.border}" />
    <text x="784" y="631" fill="${theme.text}" font-size="21">已支持日期筛选，语音/图片也能单独导出。</text>

    <rect x="580" y="820" width="740" height="58" rx="12" fill="${theme.surface}" stroke="${theme.border}" />
    <text x="604" y="856" fill="${theme.subtle}" font-size="19">请输入关键词搜索历史消息...</text>
    <rect x="1338" y="820" width="108" height="58" rx="12" fill="${theme.accent}" />
    <text x="1372" y="856" fill="#fff" font-size="21">发送</text>
  `
}

function exportContent(themeName) {
  const theme = THEMES[themeName]
  const stats = [
    ['会话总数', '318'],
    ['总消息量', '1,348,912'],
    ['最近导出', '2 分钟前'],
    ['待同步增量', '+168']
  ]

  const statCards = stats.map((item, index) => {
    const x = 80 + index * 360
    return `
      <rect x="${x}" y="232" width="340" height="120" rx="14" fill="${theme.surface}" stroke="${theme.border}" />
      <text x="${x + 20}" y="268" fill="${theme.subtle}" font-size="17">${esc(item[0])}</text>
      <text x="${x + 20}" y="320" fill="${theme.text}" font-size="36" font-weight="700">${esc(item[1])}</text>
    `
  }).join('')

  const formats = ['JSON', 'HTML', 'CSV', 'Excel', 'SQL', 'VCF', 'ChatLab']
  const formatPills = formats.map((name, index) => {
    const x = 80 + index * 112
    return `
      <rect x="${x}" y="378" width="96" height="40" rx="20" fill="${theme.soft}" stroke="${theme.border}" />
      <text x="${x + 24}" y="404" fill="${theme.subtle}" font-size="17">${name}</text>
    `
  }).join('')

  const rows = [
    ['wxid_a71k2', '18,243', '+126', 'HTML + JSON', '2026-03-01 23:12'],
    ['wxid_team88', '5,231', '+0', 'CSV', '2026-02-28 18:46'],
    ['wxid_family9', '14,052', '+42', 'Excel + VCF', '2026-03-01 09:03']
  ]

  const tableRows = rows.map((row, index) => {
    const y = 526 + index * 106
    return `
      <line x1="80" y1="${y}" x2="1480" y2="${y}" stroke="${theme.border}" />
      <text x="104" y="${y + 54}" fill="${theme.text}" font-size="22">${row[0]}</text>
      <text x="430" y="${y + 54}" fill="${theme.text}" font-size="22">${row[1]}</text>
      <text x="660" y="${y + 54}" fill="${row[2] === '+0' ? theme.subtle : theme.good}" font-size="22" font-weight="700">${row[2]}</text>
      <text x="860" y="${y + 54}" fill="${theme.text}" font-size="22">${row[3]}</text>
      <text x="1180" y="${y + 54}" fill="${theme.subtle}" font-size="22">${row[4]}</text>
    `
  }).join('')

  return `
    ${statCards}
    ${formatPills}
    <rect x="80" y="454" width="1400" height="438" rx="14" fill="${theme.surface}" stroke="${theme.border}" />
    <rect x="80" y="454" width="1400" height="70" rx="14" fill="${theme.soft}" />
    <text x="104" y="500" fill="${theme.subtle}" font-size="18">账号</text>
    <text x="430" y="500" fill="${theme.subtle}" font-size="18">消息总数</text>
    <text x="660" y="500" fill="${theme.subtle}" font-size="18">增量</text>
    <text x="860" y="500" fill="${theme.subtle}" font-size="18">导出格式</text>
    <text x="1180" y="500" fill="${theme.subtle}" font-size="18">最近导出</text>
    ${tableRows}
  `
}

function momentsContent(themeName) {
  const theme = THEMES[themeName]
  return `
    <rect x="80" y="222" width="320" height="690" rx="16" fill="${theme.surface}" stroke="${theme.border}" />
    <text x="106" y="270" fill="${theme.text}" font-size="26" font-weight="700">筛选条件</text>
    <rect x="106" y="296" width="268" height="58" rx="10" fill="${theme.soft}" stroke="${theme.border}" />
    <text x="124" y="333" fill="${theme.subtle}" font-size="19">时间范围：最近 90 天</text>
    <rect x="106" y="370" width="268" height="58" rx="10" fill="${theme.soft}" stroke="${theme.border}" />
    <text x="124" y="407" fill="${theme.subtle}" font-size="19">联系人：全部</text>
    <rect x="106" y="444" width="268" height="58" rx="10" fill="${theme.soft}" stroke="${theme.border}" />
    <text x="124" y="481" fill="${theme.subtle}" font-size="19">媒体类型：图文 + 视频</text>
    <rect x="106" y="526" width="268" height="54" rx="10" fill="${theme.accent}" />
    <text x="168" y="561" fill="#fff" font-size="21" font-weight="700">导出当前筛选</text>

    <rect x="420" y="222" width="1060" height="320" rx="16" fill="${theme.surface}" stroke="${theme.border}" />
    <circle cx="458" cy="264" r="20" fill="${theme.accent}" />
    <text x="492" y="270" fill="${theme.text}" font-size="24" font-weight="700">林予安</text>
    <text x="492" y="302" fill="${theme.subtle}" font-size="17">3月2日 09:21</text>
    <text x="458" y="352" fill="${theme.text}" font-size="21">终于把 2025 年的出行照片整理完了，顺便导出做了个时间轴。</text>
    <rect x="458" y="380" width="296" height="126" rx="12" fill="${theme.soft}" stroke="${theme.border}" />
    <rect x="772" y="380" width="296" height="126" rx="12" fill="${theme.soft}" stroke="${theme.border}" />
    <rect x="1086" y="380" width="296" height="126" rx="12" fill="${theme.soft}" stroke="${theme.border}" />
    <text x="570" y="450" fill="${theme.subtle}" font-size="20">图片 A</text>
    <text x="884" y="450" fill="${theme.subtle}" font-size="20">图片 B</text>
    <text x="1198" y="450" fill="${theme.subtle}" font-size="20">图片 C</text>
    <text x="458" y="530" fill="${theme.subtle}" font-size="18">点赞 45 · 评论 18</text>

    <rect x="420" y="560" width="1060" height="352" rx="16" fill="${theme.surface}" stroke="${theme.border}" />
    <circle cx="458" cy="604" r="20" fill="${theme.accent}" />
    <text x="492" y="610" fill="${theme.text}" font-size="24" font-weight="700">周同学</text>
    <text x="492" y="642" fill="${theme.subtle}" font-size="17">3月1日 21:03</text>
    <text x="458" y="692" fill="${theme.text}" font-size="21">昨天那场分享会的提纲，发在这里备忘。</text>
    <rect x="458" y="720" width="460" height="126" rx="12" fill="${theme.soft}" stroke="${theme.border}" />
    <rect x="938" y="720" width="460" height="126" rx="12" fill="${theme.soft}" stroke="${theme.border}" />
    <text x="648" y="792" fill="${theme.subtle}" font-size="20">图片 D</text>
    <text x="1128" y="792" fill="${theme.subtle}" font-size="20">图片 E</text>
    <text x="458" y="888" fill="${theme.subtle}" font-size="18">点赞 27 · 评论 9</text>
  `
}

function dataContent(themeName) {
  const theme = THEMES[themeName]
  return `
    <rect x="80" y="222" width="1400" height="190" rx="16" fill="${theme.surface}" stroke="${theme.border}" />
    <text x="108" y="270" fill="${theme.text}" font-size="28" font-weight="700">解密进度</text>
    <rect x="108" y="292" width="1344" height="22" rx="11" fill="${theme.soft}" stroke="${theme.border}" />
    <rect x="108" y="292" width="981" height="22" rx="11" fill="${theme.accent}" />
    <text x="108" y="354" fill="${theme.subtle}" font-size="20">当前任务：图片批量解密（预计剩余 3 分钟）</text>

    <rect x="80" y="432" width="690" height="220" rx="14" fill="${theme.surface}" stroke="${theme.border}" />
    <text x="108" y="474" fill="${theme.text}" font-size="24" font-weight="700">数据库校验</text>
    <rect x="608" y="444" width="134" height="34" rx="17" fill="${theme.soft}" stroke="${theme.border}" />
    <text x="654" y="468" fill="${theme.good}" font-size="18">完成</text>
    <text x="108" y="538" fill="${theme.subtle}" font-size="20">12/12 个库可读</text>

    <rect x="790" y="432" width="690" height="220" rx="14" fill="${theme.surface}" stroke="${theme.border}" />
    <text x="818" y="474" fill="${theme.text}" font-size="24" font-weight="700">图片解密</text>
    <rect x="1318" y="444" width="134" height="34" rx="17" fill="${theme.soft}" stroke="${theme.border}" />
    <text x="1344" y="468" fill="${theme.accent}" font-size="18">进行中</text>
    <text x="818" y="538" fill="${theme.subtle}" font-size="20">2,184 / 3,000</text>

    <rect x="80" y="672" width="690" height="220" rx="14" fill="${theme.surface}" stroke="${theme.border}" />
    <text x="108" y="714" fill="${theme.text}" font-size="24" font-weight="700">表情修复</text>
    <rect x="608" y="684" width="134" height="34" rx="17" fill="${theme.soft}" stroke="${theme.border}" />
    <text x="654" y="708" fill="${theme.good}" font-size="18">完成</text>
    <text x="108" y="778" fill="${theme.subtle}" font-size="20">836 / 836</text>

    <rect x="790" y="672" width="690" height="220" rx="14" fill="${theme.surface}" stroke="${theme.border}" />
    <text x="818" y="714" fill="${theme.text}" font-size="24" font-weight="700">缓存迁移</text>
    <rect x="1318" y="684" width="134" height="34" rx="17" fill="${theme.soft}" stroke="${theme.border}" />
    <text x="1364" y="708" fill="${theme.warn}" font-size="18">待执行</text>
    <text x="818" y="778" fill="${theme.subtle}" font-size="20">目标盘符 D:</text>
  `
}

function renderPanel(themeName, panel) {
  const theme = THEMES[themeName]
  let content = ''
  let title = ''
  let subtitle = ''

  if (panel === 'chat') {
    title = '聊天记录查看'
    subtitle = '会话检索 + 消息预览 + 多媒体还原'
    content = chatContent(themeName)
  }

  if (panel === 'export') {
    title = '多格式数据导出'
    subtitle = '会话统计 + 历史记录 + 增量判断'
    content = exportContent(themeName)
  }

  if (panel === 'moments') {
    title = '朋友圈浏览'
    subtitle = '按时间流查看动态，支持媒体下载与归档'
    content = momentsContent(themeName)
  }

  if (panel === 'data') {
    title = '数据管理与解密'
    subtitle = '数据库扫描、媒体解密、缓存迁移一体化'
    content = dataContent(themeName)
  }

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${theme.bgStart}" />
          <stop offset="100%" stop-color="${theme.bgEnd}" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)" />
      ${header(themeName, title, subtitle)}
      ${panelShell(themeName)}
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
      const svg = renderPanel(theme, panel)
      const outputPath = path.join(OUT_DIR, `${theme}-${panel}.svg`)
      fs.writeFileSync(outputPath, svg, 'utf-8')
      console.log(`[readme-shots] wrote ${outputPath}`)
    }
  }
}

main().catch((error) => {
  console.error('[readme-shots] generation failed:', error)
  process.exit(1)
})
