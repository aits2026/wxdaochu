import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import * as http from 'http'
import { createHash } from 'crypto'
import Database from 'better-sqlite3'
import { app } from 'electron'
import { ConfigService } from './config'
import { voiceTranscribeService } from './voiceTranscribeService'
import * as XLSX from 'xlsx'
import { HtmlExportGenerator } from './htmlExportGenerator'
import { imageDecryptService } from './imageDecryptService'
import { videoService } from './videoService'
import { exportRecordService } from './exportRecordService'

// ChatLab 0.0.2 格式类型定义
interface ChatLabHeader {
  version: string
  exportedAt: number
  generator: string
  description?: string
}

interface ChatLabMeta {
  name: string
  platform: string
  type: 'group' | 'private'
  groupId?: string
  groupAvatar?: string
  ownerId?: string
  groupWechatId?: string | null
  groupWechatAlias?: string | null
  ownerWechatId?: string | null
  ownerWechatAlias?: string | null
}

interface MemberRole {
  id: string
  name?: string
}

interface ChatLabMember {
  platformId: string
  accountName: string
  wechatId?: string | null
  wechatAlias?: string | null
  groupNickname?: string
  avatar?: string
  roles?: MemberRole[]
}

interface ChatLabMessage {
  sender: string
  accountName: string
  senderWechatId?: string | null
  senderWechatAlias?: string | null
  groupNickname?: string
  timestamp: number
  type: number
  content: string | null
  platformMessageId?: string
  replyToMessageId?: string
  chatRecords?: ChatRecordItem[]  // 嵌套的聊天记录
}

interface ChatRecordItem {
  sender: string
  accountName: string
  senderWechatId?: string | null
  senderWechatAlias?: string | null
  timestamp: number
  type: number
  content: string
  avatar?: string
}

interface ChatLabExport {
  chatlab: ChatLabHeader
  meta: ChatLabMeta
  members: ChatLabMember[]
  messages: ChatLabMessage[]
}

// 消息类型映射：微信 localType -> ChatLab type
const MESSAGE_TYPE_MAP: Record<number, number> = {
  1: 0,      // 文本 -> TEXT
  3: 1,      // 图片 -> IMAGE
  34: 2,     // 语音 -> VOICE
  43: 3,     // 视频 -> VIDEO
  49: 7,     // 链接/文件 -> LINK (需要进一步判断)
  47: 5,     // 表情包 -> EMOJI
  48: 8,     // 位置 -> LOCATION
  42: 27,    // 名片 -> CONTACT
  50: 23,    // 通话 -> CALL
  10000: 80, // 系统消息 -> SYSTEM
}

export interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'arkme-json' | 'html' | 'txt' | 'excel' | 'sql'
  dateRange?: { start: number; end: number } | null
  exportMedia?: boolean
  // 是否导出聊天文本；false 时只导出选中的媒体资源
  exportChatText?: boolean
  exportAvatars?: boolean
  exportImages?: boolean
  exportVideos?: boolean
  exportEmojis?: boolean
  exportVoices?: boolean
  // 仅导出图片资源（不生成聊天文本文件）
  imageOnlyMode?: boolean
  // 仅导出视频资源（不生成聊天文本文件）
  videoOnlyMode?: boolean
  // 仅导出表情包资源（不生成聊天文本文件）
  emojiOnlyMode?: boolean
  // 仅导出语音资源（不生成聊天文本文件）
  voiceOnlyMode?: boolean
  // 视频文件去重（多个消息可引用同一文件）；默认开启以节省空间
  dedupeVideoFiles?: boolean
  // 媒体路径映射表：消息实例键 -> 相对路径（避免仅用 createTime 发生同秒覆盖）
  mediaPathMap?: Map<string, string>
  // Arkme 媒体索引：mediaKey -> 媒体条目（用于文本导出与媒体导出解耦）
  arkmeMediaIndexMap?: Map<string, ArkmeMediaIndexEntry>
  // 全局媒体索引文件（相对 outputPath 所在目录）
  arkmeMediaMapFilePath?: string
  // 导出前跳过检查（renderer 传入 hint，主要用于聊天文本批量导出）
  skipIfUnchanged?: boolean
  currentMessageCountHint?: number
  // Unix 秒级时间戳（会话最新消息时间）
  latestMessageTimestampHint?: number
  currentEmojiCountHint?: number
  currentImageCountHint?: number
  currentVideoCountHint?: number
  currentVoiceCountHint?: number
  // 同一批媒体导出任务的唯一标识（用于控制索引快照只在批次末尾生成）
  mediaExportBatchId?: string
  // 当且仅当本次调用是该批次最后一次导出时置为 true
  mediaExportBatchIsFinal?: boolean
}

export interface ContactExportOptions {
  format: 'json' | 'csv' | 'vcf'
  exportAvatars: boolean
  contactTypes: {
    friends: boolean
    groups: boolean
    officials: boolean
  }
  selectedUsernames?: string[]
}

export interface ExportProgress {
  current: number
  total: number
  currentSession: string
  phase: 'preparing' | 'exporting' | 'writing' | 'complete'
  detail?: string
  // 会话级进度（批量导出时）
  sessionCurrent?: number
  sessionTotal?: number
  // 当前阶段进度（媒体处理/写文件等）
  stepCurrent?: number
  stepTotal?: number
  stepUnit?: string
}

export interface ExportSessionOutputTarget {
  sessionId: string
  outputPath: string
  openTargetPath: string
  openTargetType: 'file' | 'directory'
  skipped?: boolean
  skipReason?: string
}

interface ExportMediaProgress {
  detail: string
  current?: number
  total?: number
  unit?: string
}

type ArkmeMediaKind = 'image' | 'video' | 'emoji' | 'voice'

interface ArkmeMediaRef {
  kind: ArkmeMediaKind
  mediaKey: string
  exported: boolean
  relativePath?: string | null
  fileName?: string | null
  sourceMd5?: string | null
  fileMd5?: string | null
  source?: Record<string, unknown>
}

interface ArkmeMediaIndexEntry extends ArkmeMediaRef {
  createTime: number
  sessionId: string
  platformMessageId?: string
  localMessageId?: string
}

type MediaDedupState = Record<ArkmeMediaKind, Map<string, string>>

const createMediaDedupState = (): MediaDedupState => ({
  image: new Map<string, string>(),
  video: new Map<string, string>(),
  emoji: new Map<string, string>(),
  voice: new Map<string, string>()
})

interface ResolvedContactInfo {
  displayName: string
  avatarUrl?: string
  wechatId: string
  wechatAlias?: string
  remark?: string
  nickName?: string
}

class ExportService {
  private configService: ConfigService
  private dbDir: string | null = null
  private contactDb: Database.Database | null = null
  private headImageDb: Database.Database | null = null
  private messageDbCache: Map<string, Database.Database> = new Map()
  private contactColumnsCache: { hasBigHeadUrl: boolean; hasSmallHeadUrl: boolean; selectCols: string[] } | null = null

  constructor() {
    this.configService = new ConfigService()
  }

  private dirHasAnyFile(targetDir: string): boolean {
    try {
      if (!fs.existsSync(targetDir)) return false
      const entries = fs.readdirSync(targetDir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(targetDir, entry.name)
        if (entry.isFile()) return true
        if (entry.isDirectory() && this.dirHasAnyFile(fullPath)) return true
      }
      return false
    } catch {
      return false
    }
  }

  private async yieldMainThread(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve))
  }

  private async yieldMainThreadEvery(counter: number, interval = 200): Promise<void> {
    if (counter > 0 && counter % interval === 0) {
      await this.yieldMainThread()
    }
  }

  private getChatTextFilePrefix(sessionId: string): string {
    if (sessionId.includes('@chatroom')) return '群聊_'
    if (this.isPrivateSessionForExportPrefix(sessionId)) return '私聊_'
    return ''
  }

  private resolveExportRootDir(outputDir: string): string {
    const normalized = path.resolve(outputDir)
    const base = path.basename(normalized).toLowerCase()
    const knownSubdirs = new Set(['chat-text', 'chat-txt', 'images', 'videos', 'emojis', 'voices'])
    if (knownSubdirs.has(base)) {
      return path.dirname(normalized)
    }
    return normalized
  }

  private buildMediaMapSnapshotFileName(now = new Date()): string {
    const yyyy = now.getFullYear()
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const dd = String(now.getDate()).padStart(2, '0')
    const hh = String(now.getHours()).padStart(2, '0')
    const mi = String(now.getMinutes()).padStart(2, '0')
    const ss = String(now.getSeconds()).padStart(2, '0')
    return `arkme-media-map-${yyyy}${mm}${dd}-${hh}${mi}${ss}.json`
  }

  private isPrivateSessionForExportPrefix(sessionId: string): boolean {
    const username = String(sessionId || '').trim().toLowerCase()
    if (!username) return false
    if (username.includes('@chatroom')) return false
    if (username.startsWith('gh_')) return false
    if (username.includes('@kefu.openim') || username.includes('@openim')) return false
    if (username.includes('service_')) return false

    const systemAccounts = [
      'weixin',
      'qqmail',
      'fmessage',
      'medianote',
      'floatbottle',
      'newsapp',
      'brandsessionholder',
      'brandservicesessionholder',
      'notifymessage',
      'opencustomerservicemsg',
      'notification_messages',
      'userexperience_alarm',
      'filehelper',
      'qmessage',
      'tmessage'
    ]
    if (systemAccounts.includes(username)) return false

    return username.startsWith('wxid_') || !username.includes('@')
  }

  private cleanAccountDirName(dirName: string): string {
    const trimmed = dirName.trim()
    if (!trimmed) return trimmed

    // wxid_ 开头的标准格式: wxid_xxx_yyyy -> wxid_xxx
    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[a-zA-Z0-9]+)/i)
      if (match) return match[1]
      return trimmed
    }

    // 自定义微信号格式: xxx_yyyy (4位后缀) -> xxx
    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    if (suffixMatch) return suffixMatch[1]

    return trimmed
  }

  /**
   * 查找账号对应的实际目录名
   * 支持多种匹配方式以兼容不同版本的目录命名
   */
  private findAccountDir(baseDir: string, wxid: string): string | null {
    if (!fs.existsSync(baseDir)) return null

    const cleanedWxid = this.cleanAccountDirName(wxid)

    // 1. 直接匹配原始 wxid
    const directPath = path.join(baseDir, wxid)
    if (fs.existsSync(directPath)) {
      return wxid
    }

    // 2. 直接匹配清理后的 wxid
    if (cleanedWxid !== wxid) {
      const cleanedPath = path.join(baseDir, cleanedWxid)
      if (fs.existsSync(cleanedPath)) {
        return cleanedWxid
      }
    }

    // 3. 扫描目录查找匹配
    try {
      const entries = fs.readdirSync(baseDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        const dirName = entry.name
        const dirNameLower = dirName.toLowerCase()
        const wxidLower = wxid.toLowerCase()
        const cleanedWxidLower = cleanedWxid.toLowerCase()

        if (dirNameLower === wxidLower || dirNameLower === cleanedWxidLower) return dirName
        if (dirNameLower.startsWith(wxidLower + '_') || dirNameLower.startsWith(cleanedWxidLower + '_')) return dirName
        if (wxidLower.startsWith(dirNameLower + '_') || cleanedWxidLower.startsWith(dirNameLower + '_')) return dirName

        const cleanedDirName = this.cleanAccountDirName(dirName)
        if (cleanedDirName.toLowerCase() === wxidLower || cleanedDirName.toLowerCase() === cleanedWxidLower) return dirName
      }
    } catch (e) {
      console.error('查找账号目录失败:', e)
    }

    return null
  }

  private getDecryptedDbDir(): string {
    const cachePath = this.configService.get('cachePath')
    if (cachePath) return cachePath

    // 开发环境使用文档目录
    if (process.env.VITE_DEV_SERVER_URL) {
      const documentsPath = app.getPath('documents')
      return path.join(documentsPath, 'VXdaochuData')
    }

    // 生产环境
    const exePath = app.getPath('exe')
    const installDir = path.dirname(exePath)

    // 检查是否安装在 C 盘
    const isOnCDrive = /^[cC]:/i.test(installDir) || installDir.startsWith('\\')

    if (isOnCDrive) {
      const documentsPath = app.getPath('documents')
      return path.join(documentsPath, 'VXdaochuData')
    }

    return path.join(installDir, 'VXdaochuData')
  }

  async connect(): Promise<{ success: boolean; error?: string }> {
    try {
      const wxid = this.configService.get('myWxid')
      if (!wxid) {
        return { success: false, error: '请先在设置页面配置微信ID' }
      }

      const baseDir = this.getDecryptedDbDir()
      const accountDir = this.findAccountDir(baseDir, wxid)

      if (!accountDir) {
        return { success: false, error: `未找到账号 ${wxid} 的数据库目录，请先解密数据库` }
      }

      const dbDir = path.join(baseDir, accountDir)
      this.dbDir = dbDir

      const contactDbPath = path.join(dbDir, 'contact.db')
      if (fs.existsSync(contactDbPath)) {
        this.contactDb = new Database(contactDbPath, { readonly: true })
      }

      const headImageDbPath = path.join(dbDir, 'head_image.db')
      if (fs.existsSync(headImageDbPath)) {
        this.headImageDb = new Database(headImageDbPath, { readonly: true })
      }

      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  close(): void {
    try {
      this.contactDb?.close()
      this.messageDbCache.forEach(db => {
        try { db.close() } catch { }
      })
    } catch { }
    this.contactDb = null
    this.messageDbCache.clear()
    this.contactColumnsCache = null
    this.dbDir = null
  }

  private getMessageDb(dbPath: string): Database.Database | null {
    if (this.messageDbCache.has(dbPath)) {
      return this.messageDbCache.get(dbPath)!
    }
    try {
      const db = new Database(dbPath, { readonly: true })
      this.messageDbCache.set(dbPath, db)
      return db
    } catch {
      return null
    }
  }

  private findMessageDbs(): string[] {
    if (!this.dbDir) return []
    const dbs: string[] = []
    try {
      const files = fs.readdirSync(this.dbDir)
      for (const file of files) {
        const lower = file.toLowerCase()
        if ((lower.startsWith('message') || lower.startsWith('msg')) && lower.endsWith('.db')) {
          dbs.push(path.join(this.dbDir, file))
        }
      }
    } catch { }
    return dbs
  }

  private getTableNameHash(sessionId: string): string {
    const crypto = require('crypto')
    return crypto.createHash('md5').update(sessionId).digest('hex')
  }

  private findMessageTable(db: Database.Database, sessionId: string): string | null {
    try {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
      ).all() as any[]
      const hash = this.getTableNameHash(sessionId)
      for (const table of tables) {
        if ((table.name as string).includes(hash)) {
          return table.name
        }
      }
    } catch { }
    return null
  }

  private findSessionTables(sessionId: string): { db: Database.Database; tableName: string; dbPath: string }[] {
    const dbs = this.findMessageDbs()
    const result: { db: Database.Database; tableName: string; dbPath: string }[] = []

    for (const dbPath of dbs) {
      const db = this.getMessageDb(dbPath)
      if (!db) continue
      const tableName = this.findMessageTable(db, sessionId)
      if (tableName) {
        result.push({ db, tableName, dbPath })
      }
    }
    return result
  }

  /**
   * 获取联系人信息
   */
  private async getContactInfo(username: string): Promise<ResolvedContactInfo> {
    const input = String(username || '').trim()
    if (!this.contactDb) {
      const fallback = this.normalizeWechatIdentity(input)
      return {
        displayName: input,
        wechatId: fallback.wechatId || input,
        ...(fallback.wechatAlias ? { wechatAlias: fallback.wechatAlias } : {})
      }
    }

    try {
      if (!this.contactColumnsCache) {
        const columns = this.contactDb.prepare("PRAGMA table_info(contact)").all() as any[]
        const columnNames = columns.map((c: any) => c.name)
        const hasBigHeadUrl = columnNames.includes('big_head_url')
        const hasSmallHeadUrl = columnNames.includes('small_head_url')
        const selectCols = ['username', 'remark', 'nick_name', 'alias']
        if (hasBigHeadUrl) selectCols.push('big_head_url')
        if (hasSmallHeadUrl) selectCols.push('small_head_url')
        this.contactColumnsCache = { hasBigHeadUrl, hasSmallHeadUrl, selectCols }
      }

      const { hasBigHeadUrl, hasSmallHeadUrl, selectCols } = this.contactColumnsCache
      let contact = this.contactDb.prepare(`
        SELECT ${selectCols.join(', ')} FROM contact WHERE username = ?
      `).get(input) as any

      if (!contact && input && !input.startsWith('wxid_') && !input.includes('@')) {
        const prefixedInput = `wxid_${input}`
        contact = this.contactDb.prepare(`
          SELECT ${selectCols.join(', ')} FROM contact WHERE username = ? LIMIT 1
        `).get(prefixedInput) as any
      }

      if (!contact && input) {
        contact = this.contactDb.prepare(`
          SELECT ${selectCols.join(', ')} FROM contact WHERE alias = ? LIMIT 1
        `).get(input) as any
      }

      if (contact) {
        const resolvedWechatId = String(contact.username || input)
        const resolvedWechatAlias = contact.alias ? String(contact.alias) : undefined
        const displayName = contact.remark || contact.nick_name || resolvedWechatAlias || resolvedWechatId
        let avatarUrl: string | undefined

        // 优先使用 URL 头像
        if (hasBigHeadUrl && contact.big_head_url) {
          avatarUrl = contact.big_head_url
        } else if (hasSmallHeadUrl && contact.small_head_url) {
          avatarUrl = contact.small_head_url
        }

        // 如果没有 URL 头像，尝试从 head_image.db 获取 base64
        if (!avatarUrl) {
          avatarUrl = await this.getAvatarFromHeadImageDb(resolvedWechatId)
        }

        return {
          displayName,
          avatarUrl,
          wechatId: resolvedWechatId,
          ...(resolvedWechatAlias ? { wechatAlias: resolvedWechatAlias } : {}),
          ...(contact.remark ? { remark: String(contact.remark) } : {}),
          ...(contact.nick_name ? { nickName: String(contact.nick_name) } : {})
        }
      }
    } catch { }
    const fallback = this.normalizeWechatIdentity(input)
    return {
      displayName: input,
      wechatId: fallback.wechatId || input,
      ...(fallback.wechatAlias ? { wechatAlias: fallback.wechatAlias } : {})
    }
  }

  private async resolveSessionWechatIdentity(sessionId: string): Promise<{ wxid: string; alias: string | null }> {
    const raw = String(sessionId || '').trim()
    if (!raw) return { wxid: '', alias: null }

    if (!this.contactDb) {
      if (raw.startsWith('wxid_') || raw.includes('@')) return { wxid: raw, alias: null }
      return { wxid: '', alias: raw || null }
    }

    try {
      const byUsername = this.contactDb.prepare(`
        SELECT username, alias FROM contact WHERE username = ? LIMIT 1
      `)
      const byAlias = this.contactDb.prepare(`
        SELECT username, alias FROM contact WHERE alias = ? LIMIT 1
      `)

      let row = byUsername.get(raw) as { username?: string; alias?: string } | undefined
      if (!row && raw && !raw.startsWith('wxid_') && !raw.includes('@')) {
        row = byUsername.get(`wxid_${raw}`) as { username?: string; alias?: string } | undefined
      }
      if (!row) {
        row = byAlias.get(raw) as { username?: string; alias?: string } | undefined
      }

      if (row?.username) {
        return {
          wxid: String(row.username),
          alias: row.alias ? String(row.alias) : null
        }
      }
    } catch { }

    if (raw.startsWith('wxid_') || raw.includes('@')) return { wxid: raw, alias: null }
    return { wxid: '', alias: raw || null }
  }

  private resolveContactNameFields(rawContact: any): { remark: string; nickname: string; alias: string } {
    return {
      remark: String(rawContact?.remark || ''),
      nickname: String(rawContact?.nick_name || ''),
      alias: String(rawContact?.alias || '')
    }
  }

  private getDisplayNameByNameFields(params: {
    fallback: string
    remark: string
    nickname: string
    alias: string
  }): string {
    return String(params.remark || params.nickname || params.alias || params.fallback || '')
  }

  private async resolveSessionNameFields(sessionId: string): Promise<{ remark: string; nickname: string; alias: string }> {
    const input = String(sessionId || '').trim()
    if (!input || !this.contactDb) return { remark: '', nickname: '', alias: '' }

    try {
      const fetchByUsername = this.contactDb.prepare(`
        SELECT username, remark, nick_name, alias
        FROM contact
        WHERE username = ?
        LIMIT 1
      `)
      const fetchByAlias = this.contactDb.prepare(`
        SELECT username, remark, nick_name, alias
        FROM contact
        WHERE alias = ?
        LIMIT 1
      `)

      let row = fetchByUsername.get(input) as any
      if (!row && input && !input.startsWith('wxid_') && !input.includes('@')) {
        row = fetchByUsername.get(`wxid_${input}`) as any
      }
      if (!row) {
        row = fetchByAlias.get(input) as any
      }
      if (!row) return { remark: '', nickname: '', alias: '' }
      return this.resolveContactNameFields(row)
    } catch {
      return { remark: '', nickname: '', alias: '' }
    }
  }

  private normalizeWechatIdentity(
    rawValue: string,
    resolved?: Partial<Pick<ResolvedContactInfo, 'wechatId' | 'wechatAlias'>>
  ): { wechatId: string | null; wechatAlias: string | null } {
    const raw = String(rawValue || '').trim()
    let wechatId = String(resolved?.wechatId || '').trim()
    let wechatAlias = String(resolved?.wechatAlias || '').trim()

    if (!wechatId && raw && (raw.startsWith('wxid_') || raw.includes('@'))) {
      wechatId = raw
    }

    if (!wechatAlias && raw && !raw.startsWith('wxid_') && !raw.includes('@')) {
      wechatAlias = raw
    }

    if (!wechatId && raw) {
      wechatId = raw
    }

    return {
      wechatId: wechatId || null,
      wechatAlias: wechatAlias || null
    }
  }

  private quoteIdentifier(identifier: string): string {
    return `"${String(identifier || '').replace(/"/g, '""')}"`
  }

  private getName2IdTableName(db: Database.Database): string | null {
    try {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('Name2Id','name2id') LIMIT 1"
      ).get() as { name?: string } | undefined
      return row?.name || null
    } catch {
      return null
    }
  }

  private getName2IdUserColumn(db: Database.Database, name2IdTable: string): 'user_name' | 'username' {
    try {
      const cols = db.prepare(`PRAGMA table_info(${this.quoteIdentifier(name2IdTable)})`).all() as any[]
      const colNames = new Set(cols.map((c: any) => String(c.name || '')))
      if (colNames.has('user_name')) return 'user_name'
      if (colNames.has('username')) return 'username'
    } catch { }
    return 'user_name'
  }

  private sanitizeArkmeContactValue(value: unknown): unknown {
    if (value === null || value === undefined) return undefined
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
    if (Buffer.isBuffer(value)) return value.toString('base64')
    if (value instanceof Date) return value.toISOString()
    try {
      return String(value)
    } catch {
      return undefined
    }
  }

  private buildArkmeContactRaw(row: any, contactCols: string[]): Record<string, unknown> {
    const raw: Record<string, unknown> = {}
    for (const col of contactCols) {
      const key = `contact_${col}`
      const value = this.sanitizeArkmeContactValue(row?.[key])
      if (value !== undefined && value !== '') {
        raw[col] = value
      }
    }
    return raw
  }

  private async getGroupMembersForArkme(
    chatroomId: string,
    myWxidRaw: string,
    myWxidClean: string
  ): Promise<Array<Record<string, unknown>>> {
    if (!this.contactDb) return []

    try {
      const name2IdTable = this.getName2IdTableName(this.contactDb)
      if (!name2IdTable) return []
      const userCol = this.getName2IdUserColumn(this.contactDb, name2IdTable)
      const tableQ = this.quoteIdentifier(name2IdTable)
      const userColQ = this.quoteIdentifier(userCol)

      const contactCols = this.contactDb.prepare('PRAGMA table_info(contact)').all() as any[]
      const contactColNames = contactCols.map((col: any) => String(col.name || ''))
      const hasLocalType = contactColNames.includes('local_type')
      const contactSelect = contactColNames.length > 0
        ? ', ' + contactColNames
          .map(col => `c.${this.quoteIdentifier(col)} AS ${this.quoteIdentifier(`contact_${col}`)}`)
          .join(', ')
        : ''

      const rows = this.contactDb.prepare(`
        SELECT n.${userColQ} as username${contactSelect}
        FROM chatroom_member m
        JOIN ${tableQ} n ON m.member_id = n.rowid
        LEFT JOIN contact c ON n.${userColQ} = c.username
        WHERE m.room_id = (
          SELECT rowid FROM ${tableQ} WHERE ${userColQ} = ? LIMIT 1
        )
      `).all(chatroomId) as any[]

      const memberMap = new Map<string, Record<string, unknown>>()
      const selfIdSet = new Set([myWxidRaw, myWxidClean].filter(Boolean))

      for (const row of rows) {
        const username = String(row?.username || '').trim()
        if (!username) continue

        const contactRaw = this.buildArkmeContactRaw(row, contactColNames)
        const nameFields = this.resolveContactNameFields(contactRaw)
        const identity = this.normalizeWechatIdentity(username, {
          wechatId: String(contactRaw.username || username),
          wechatAlias: contactRaw.alias ? String(contactRaw.alias) : undefined
        })
        const displayName = this.getDisplayNameByNameFields({
          fallback: username,
          remark: nameFields.remark,
          nickname: nameFields.nickname,
          alias: nameFields.alias
        })
        const localType = Number(contactRaw.local_type ?? NaN)
        const isFriend = hasLocalType
          ? Number.isFinite(localType) && localType === 1
          : Boolean(contactRaw.username)
        const isSelf = selfIdSet.has(username) ||
          (identity.wechatId ? selfIdSet.has(identity.wechatId) : false) ||
          (identity.wechatAlias ? selfIdSet.has(identity.wechatAlias) : false)
        const avatarUrl = String(contactRaw.big_head_url || contactRaw.small_head_url || '')

        const currentMember: Record<string, unknown> = {
          username: identity.wechatId || username,
          wechatId: identity.wechatId,
          wechatAlias: identity.wechatAlias,
          displayName,
          isFriend,
          isSelf,
          ...(isSelf ? { selfRemark: '用户自己' } : {}),
          ...(avatarUrl && { avatarUrl }),
          remark: nameFields.remark,
          nickname: nameFields.nickname,
          nickName: nameFields.nickname,
          alias: nameFields.alias,
          ...(Number.isFinite(localType) ? { localType } : {}),
          contactRaw
        }

        const prevMember = memberMap.get(username)
        if (!prevMember) {
          memberMap.set(username, currentMember)
          continue
        }

        const prevRaw = (prevMember.contactRaw as Record<string, unknown> | undefined) || {}
        memberMap.set(username, {
          ...prevMember,
          ...currentMember,
          isFriend: Boolean(prevMember.isFriend) || Boolean(currentMember.isFriend),
          isSelf: Boolean(prevMember.isSelf) || Boolean(currentMember.isSelf),
          avatarUrl: prevMember.avatarUrl || currentMember.avatarUrl,
          displayName: String(prevMember.displayName || currentMember.displayName || username),
          contactRaw: { ...prevRaw, ...(contactRaw || {}) }
        })
      }

      const members = Array.from(memberMap.values())
      for (const member of members) {
        if (member.avatarUrl) continue
        const username = String(member.username || '')
        if (!username) continue
        const avatarUrl = await this.getAvatarFromHeadImageDb(username)
        if (avatarUrl) member.avatarUrl = avatarUrl
      }

      members.sort((a, b) =>
        String(a.displayName || a.username || '').localeCompare(
          String(b.displayName || b.username || ''),
          'zh-Hans-CN'
        )
      )

      return members
    } catch (e) {
      console.error('读取群成员全量信息失败:', e)
      return []
    }
  }

  private async getCommonGroupsForArkme(
    friendUsername: string,
    myWxidRaw: string,
    myWxidClean: string
  ): Promise<Array<Record<string, unknown>>> {
    if (!this.contactDb) return []

    try {
      const name2IdTable = this.getName2IdTableName(this.contactDb)
      if (!name2IdTable) return []
      const userCol = this.getName2IdUserColumn(this.contactDb, name2IdTable)
      const tableQ = this.quoteIdentifier(name2IdTable)
      const userColQ = this.quoteIdentifier(userCol)

      const resolveRowId = (candidates: string[]): number | null => {
        for (const candidate of candidates) {
          const target = String(candidate || '').trim()
          if (!target) continue
          try {
            const row = this.contactDb!.prepare(
              `SELECT rowid FROM ${tableQ} WHERE ${userColQ} = ? LIMIT 1`
            ).get(target) as { rowid?: number } | undefined
            if (row?.rowid != null) return Number(row.rowid)
          } catch { }
        }
        return null
      }

      const myRowId = resolveRowId([myWxidRaw, myWxidClean])
      const peerRowId = resolveRowId([friendUsername, this.cleanAccountDirName(friendUsername)])
      if (myRowId == null || peerRowId == null) return []

      const rows = this.contactDb.prepare(`
        SELECT DISTINCT room.${userColQ} as username
          , c.remark as remark
          , c.nick_name as nick_name
          , c.alias as alias
          , c.big_head_url as big_head_url
          , c.small_head_url as small_head_url
        FROM chatroom_member m1
        JOIN chatroom_member m2 ON m1.room_id = m2.room_id
        JOIN ${tableQ} room ON room.rowid = m1.room_id
        LEFT JOIN contact c ON c.username = room.${userColQ}
        WHERE m1.member_id = ?
          AND m2.member_id = ?
          AND room.${userColQ} LIKE '%@chatroom'
      `).all(myRowId, peerRowId) as Array<{
        username?: string
        remark?: string | null
        nick_name?: string | null
        alias?: string | null
        big_head_url?: string | null
        small_head_url?: string | null
      }>

      const groups: Array<Record<string, unknown>> = []
      for (const row of rows) {
        const groupId = String(row.username || '').trim()
        if (!groupId) continue
        const nameFields = this.resolveContactNameFields(row)
        const groupName = this.getDisplayNameByNameFields({
          fallback: groupId,
          remark: nameFields.remark,
          nickname: nameFields.nickname,
          alias: nameFields.alias
        })
        let avatarUrl = String(row.big_head_url || row.small_head_url || '')
        if (!avatarUrl) {
          avatarUrl = (await this.getContactInfo(groupId)).avatarUrl || ''
        }

        groups.push({
          groupId,
          wechatId: groupId,
          wechatAlias: nameFields.alias || null,
          groupName,
          remark: nameFields.remark,
          nickname: nameFields.nickname,
          nickName: nameFields.nickname,
          alias: nameFields.alias,
          ...(avatarUrl ? { avatarUrl } : {})
        })
      }

      groups.sort((a, b) =>
        String(a.groupName || a.groupId || '').localeCompare(
          String(b.groupName || b.groupId || ''),
          'zh-Hans-CN'
        )
      )

      return groups
    } catch (e) {
      console.error('读取共同群聊信息失败:', e)
      return []
    }
  }

  private normalizeIdentityCandidate(value: unknown): string {
    return String(value || '').trim().toLowerCase()
  }

  private buildIdentityCandidateSet(values: Array<unknown>): Set<string> {
    const result = new Set<string>()
    for (const value of values) {
      const normalized = this.normalizeIdentityCandidate(value)
      if (normalized) result.add(normalized)
    }
    return result
  }

  private async enrichCommonGroupsMessageCounts(
    commonGroups: Array<Record<string, unknown>>,
    recordOwnerCandidates: Array<unknown>,
    contactCandidates: Array<unknown>
  ): Promise<Array<Record<string, unknown>>> {
    if (!Array.isArray(commonGroups) || commonGroups.length === 0) return commonGroups
    const recordOwnerCandidateSet = this.buildIdentityCandidateSet(recordOwnerCandidates)
    const contactCandidateSet = this.buildIdentityCandidateSet(contactCandidates)

    if (recordOwnerCandidateSet.size === 0 && contactCandidateSet.size === 0) {
      return commonGroups.map(group => ({
        ...group,
        recordOwnerMessageCount: 0,
        contactMessageCount: 0
      }))
    }

    const enrichedGroups: Array<Record<string, unknown>> = []
    for (const group of commonGroups) {
      const groupId = String(group.groupId || group.wechatId || '').trim()
      let recordOwnerMessageCount = 0
      let contactMessageCount = 0

      if (groupId) {
        const dbTablePairs = this.findSessionTables(groupId)
        for (const { db, tableName } of dbTablePairs) {
          try {
            const hasName2Id = db.prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='Name2Id'"
            ).get()

            const baseWhere = 'COALESCE(m.local_type, 0) NOT IN (10000, 266287972401)'
            const sql = hasName2Id
              ? `SELECT m.is_send as is_send, n.user_name as sender_username, COUNT(*) as c
                 FROM ${tableName} m
                 LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                 WHERE ${baseWhere}
                 GROUP BY m.is_send, n.user_name`
              : `SELECT is_send as is_send, '' as sender_username, COUNT(*) as c
                 FROM ${tableName}
                 WHERE COALESCE(local_type, 0) NOT IN (10000, 266287972401)
                 GROUP BY is_send`

            const rows = db.prepare(sql).all() as Array<{ is_send?: number; sender_username?: string; c?: number }>
            for (const row of rows) {
              const count = Number(row?.c || 0)
              if (!Number.isFinite(count) || count <= 0) continue
              const isSend = Number(row?.is_send || 0) === 1
              const sender = this.normalizeIdentityCandidate(row?.sender_username)

              if (isSend || (sender && recordOwnerCandidateSet.has(sender))) {
                recordOwnerMessageCount += count
                continue
              }
              if (sender && contactCandidateSet.has(sender)) {
                contactMessageCount += count
              }
            }
          } catch {
            // 单表统计失败时继续下一个表，避免中断整个导出
          }
        }
      }

      enrichedGroups.push({
        ...group,
        recordOwnerMessageCount,
        contactMessageCount
      })
    }

    return enrichedGroups
  }

  private extractChatroomOwnerUsernameForArkme(chatroomId: string): string | undefined {
    if (!this.contactDb || !chatroomId) return undefined

    try {
      const quoteIdent = (name: string) => `"${String(name).replace(/"/g, '""')}"`
      const normalizeKey = (name: string) => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '')
      const getRowValueByAliases = (row: any, aliases: string[]) => {
        if (!row || typeof row !== 'object') return undefined
        const aliasSet = new Set(aliases.map(normalizeKey))
        for (const key of Object.keys(row)) {
          if (aliasSet.has(normalizeKey(key))) return row[key]
        }
        return undefined
      }
      const normalizeOwnerCandidate = (value: unknown): string | undefined => {
        if (value == null) return undefined
        let s = String(value).replace(/\0/g, '').trim()
        if (!s) return undefined
        s = s.replace(/^<!\[CDATA\[/i, '').replace(/\]\]>$/i, '').trim()
        if (!s) return undefined
        if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
          s = s.slice(1, -1).trim()
        }
        if (!s) return undefined
        if (/\s/.test(s)) return undefined
        if (s.length < 2 || s.length > 128) return undefined
        if (/^[0-9]+$/.test(s)) return undefined
        if (/[<>{}\\]/.test(s)) return undefined
        if (!/^[A-Za-z0-9_@.\-+]+$/.test(s)) return undefined
        return s
      }
      const extractOwnerFromText = (text: string): string | undefined => {
        if (!text) return undefined
        const patterns = [
          /<roomowner>\s*(?:<!\[CDATA\[)?([^<\]\s]+)(?:\]\]>)?\s*<\/roomowner>/i,
          /<ownerusername>\s*(?:<!\[CDATA\[)?([^<\]\s]+)(?:\]\]>)?\s*<\/ownerusername>/i,
          /<chatroomowner>\s*(?:<!\[CDATA\[)?([^<\]\s]+)(?:\]\]>)?\s*<\/chatroomowner>/i,
          /<room_owner>\s*(?:<!\[CDATA\[)?([^<\]\s]+)(?:\]\]>)?\s*<\/room_owner>/i,
          /"(?:roomowner|room_owner|ownerusername|owner_user_name|chatroomowner|m_nsRoomOwner)"\s*:\s*"([^"]+)"/i,
          /'(?:roomowner|room_owner|ownerusername|owner_user_name|chatroomowner|m_nsRoomOwner)'\s*:\s*'([^']+)'/i,
          /\b(?:roomowner|room_owner|ownerusername|owner_user_name|chatroomowner|m_nsRoomOwner)\b\s*[=:]\s*["']?([A-Za-z0-9_@.\-+]{2,128})["']?/i
        ]
        for (const pattern of patterns) {
          const match = pattern.exec(text)
          const normalized = normalizeOwnerCandidate(match?.[1])
          if (normalized) return normalized
        }
        return undefined
      }
      const decodeFieldToText = (raw: unknown): string => {
        if (raw == null) return ''
        if (typeof raw === 'string') return raw
        return this.decodeMaybeCompressed(raw)
      }
      const scanRowForOwnerUsername = (row: any): string | undefined => {
        const explicitOwner = getRowValueByAliases(row, [
          'roomowner',
          'room_owner',
          'ownerusername',
          'owner_user_name',
          'chatroomowner',
          'owner',
          'm_nsRoomOwner'
        ])
        const explicitOwnerUsername = normalizeOwnerCandidate(explicitOwner)
        if (explicitOwnerUsername) return explicitOwnerUsername

        const preferredPayloadFields = [
          'room_data',
          'roomdata',
          'ext_buffer',
          'extbuffer',
          'member_list',
          'memberlist',
          'chatroom_data',
          'chatroomdata',
          'room_info',
          'roominfo'
        ]
        for (const fieldAlias of preferredPayloadFields) {
          const value = getRowValueByAliases(row, [fieldAlias])
          const owner = extractOwnerFromText(decodeFieldToText(value))
          if (owner) return owner
        }

        for (const [rawKey, rawValue] of Object.entries(row || {})) {
          if (rawValue == null) continue
          const key = normalizeKey(rawKey)
          if (!/(room|member|owner|data|buffer|xml|json)/.test(key)) continue
          const owner = extractOwnerFromText(decodeFieldToText(rawValue))
          if (owner) return owner
        }
        return undefined
      }

      const getRowsForChatroomTable = (tableName: string): any[] => {
        try {
          const columnRows = this.contactDb!.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all() as any[]
          const columnNames = columnRows.map((c: any) => String(c.name))
          const selectorCols = columnNames.filter((col) => {
            const key = normalizeKey(col)
            return [
              'chatroomname',
              'chatroom_name',
              'username',
              'user_name',
              'strusrname',
              'usrname',
              'talker'
            ].includes(key)
          })
          if (selectorCols.length === 0) return []
          const where = selectorCols.map(col => `${quoteIdent(col)} = ?`).join(' OR ')
          const params = selectorCols.map(() => chatroomId)
          return this.contactDb!.prepare(`SELECT * FROM ${quoteIdent(tableName)} WHERE ${where}`).all(...params) as any[]
        } catch {
          return []
        }
      }

      const tables = this.contactDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%chatroom%'"
      ).all() as any[]

      for (const t of tables) {
        const rows = getRowsForChatroomTable(String(t.name))
        for (const row of rows) {
          const owner = scanRowForOwnerUsername(row)
          if (owner) return owner
        }
      }

      try {
        const contactRow = this.contactDb.prepare(
          `SELECT * FROM ${quoteIdent('contact')} WHERE username = ? LIMIT 1`
        ).get(chatroomId) as any
        const owner = scanRowForOwnerUsername(contactRow)
        if (owner) return owner
      } catch { }
    } catch { }

    return undefined
  }

  /**
   * 从 head_image.db 获取头像（转换为 base64 data URL）
   */
  private async getAvatarFromHeadImageDb(username: string): Promise<string | undefined> {
    if (!this.headImageDb || !username) return undefined

    try {
      const row = this.headImageDb.prepare(`
        SELECT image_buffer FROM head_image WHERE username = ?
      `).get(username) as any

      if (!row || !row.image_buffer) return undefined

      const buffer = Buffer.from(row.image_buffer)
      const base64 = buffer.toString('base64')
      return `data:image/jpeg;base64,${base64}`
    } catch {
      return undefined
    }
  }

  /**
   * 从转账消息 XML 中提取并解析 "谁转账给谁" 描述
   */
  private async resolveTransferDesc(
    content: string,
    myWxid: string,
    groupNicknamesMap: Map<string, string>,
    getContactName: (username: string) => Promise<string>
  ): Promise<string | null> {
    const xmlType = this.extractXmlValue(content, 'type')
    if (xmlType !== '2000') return null

    const payerUsername = this.extractXmlValue(content, 'payer_username')
    const receiverUsername = this.extractXmlValue(content, 'receiver_username')
    if (!payerUsername || !receiverUsername) return null

    const cleanedMyWxid = myWxid ? this.cleanAccountDirName(myWxid) : ''

    const resolveName = async (username: string): Promise<string> => {
      if (myWxid && (username === myWxid || username === cleanedMyWxid)) {
        const groupNick = groupNicknamesMap.get(username) || groupNicknamesMap.get(username.toLowerCase())
        if (groupNick) return groupNick
        return '我'
      }
      const groupNick = groupNicknamesMap.get(username) || groupNicknamesMap.get(username.toLowerCase())
      if (groupNick) return groupNick
      return getContactName(username)
    }

    const [payerName, receiverName] = await Promise.all([
      resolveName(payerUsername),
      resolveName(receiverUsername)
    ])

    return `${payerName} 转账给 ${receiverName}`
  }

  /**
   * 转换微信消息类型到 ChatLab 类型
   */
  private convertMessageType(localType: number, content: string): number {
    // 检查 XML 中的 type 标签（支持大 localType 的情况）
    const xmlTypeMatch = /<type>(\d+)<\/type>/i.exec(content)
    const xmlType = xmlTypeMatch ? parseInt(xmlTypeMatch[1]) : null

    // 特殊处理 type 49 或 XML type
    if (localType === 49 || xmlType) {
      const subType = xmlType || 0
      switch (subType) {
        case 6: return 4   // 文件 -> FILE
        case 19: return 7  // 聊天记录 -> LINK (ChatLab 没有专门的聊天记录类型)
        case 33:
        case 36: return 24 // 小程序 -> SHARE
        case 57: return 25 // 引用回复 -> REPLY
        case 2000: return 99 // 转账 -> OTHER (ChatLab 没有转账类型)
        case 5:
        case 49: return 7  // 链接 -> LINK
        default:
          if (xmlType) return 7 // 有 XML type 但未知，默认为链接
      }
    }
    return MESSAGE_TYPE_MAP[localType] ?? 99 // 未知类型 -> OTHER
  }

  /**
   * 解码消息内容
   */
  private decodeMessageContent(messageContent: any, compressContent: any): string {
    let content = this.decodeMaybeCompressed(compressContent)
    if (!content || content.length === 0) {
      content = this.decodeMaybeCompressed(messageContent)
    }
    return content
  }

  private decodeMaybeCompressed(raw: any): string {
    if (!raw) return ''
    if (Buffer.isBuffer(raw)) {
      return this.decodeBinaryContent(raw)
    }
    if (typeof raw === 'string') {
      if (raw.length === 0) return ''
      // 只有当字符串足够长（超过16字符）且看起来像 hex 时才尝试解码
      // 短字符串（如 "123456" 等纯数字）容易被误判为 hex
      if (raw.length > 16 && this.looksLikeHex(raw)) {
        const bytes = Buffer.from(raw, 'hex')
        if (bytes.length > 0) return this.decodeBinaryContent(bytes)
      }
      // 只有当字符串足够长（超过16字符）且看起来像 base64 时才尝试解码
      // 短字符串（如 "test", "home" 等）容易被误判为 base64
      if (raw.length > 16 && this.looksLikeBase64(raw)) {
        try {
          const bytes = Buffer.from(raw, 'base64')
          return this.decodeBinaryContent(bytes)
        } catch { }
      }
      return raw
    }
    return ''
  }

  private decodeBinaryContent(data: Buffer): string {
    if (data.length === 0) return ''
    try {
      if (data.length >= 4) {
        const magic = data.readUInt32LE(0)
        if (magic === 0xFD2FB528) {
          const fzstd = require('fzstd')
          const decompressed = fzstd.decompress(data)
          return Buffer.from(decompressed).toString('utf-8')
        }
      }
      const decoded = data.toString('utf-8')
      const replacementCount = (decoded.match(/\uFFFD/g) || []).length
      if (replacementCount < decoded.length * 0.2) {
        return decoded.replace(/\uFFFD/g, '')
      }
      return data.toString('latin1')
    } catch {
      return ''
    }
  }

  private looksLikeHex(s: string): boolean {
    if (s.length % 2 !== 0) return false
    return /^[0-9a-fA-F]+$/.test(s)
  }

  private looksLikeBase64(s: string): boolean {
    if (s.length % 4 !== 0) return false
    return /^[A-Za-z0-9+/=]+$/.test(s)
  }

  private buildMediaPathMapKey(params: {
    platformMessageId?: string | number | null
    localMessageId?: string | number | null
    createTime?: number | null
    localType?: number | null
    senderUsername?: string | null
    isSend?: boolean | null
  }): string | undefined {
    const platformMessageId = params.platformMessageId !== undefined && params.platformMessageId !== null
      ? String(params.platformMessageId)
      : ''
    if (platformMessageId) return `srv:${platformMessageId}`

    const localMessageId = params.localMessageId !== undefined && params.localMessageId !== null
      ? String(params.localMessageId)
      : ''
    if (localMessageId) return `loc:${localMessageId}`

    const hasFallbackFields = params.createTime !== undefined || params.localType !== undefined || params.senderUsername
    if (!hasFallbackFields) return undefined

    const createTime = Number(params.createTime || 0)
    const localType = Number(params.localType || 0)
    const sender = String(params.senderUsername || '')
    const sendFlag = params.isSend ? 1 : 0
    return `fallback:${createTime}:${localType}:${sendFlag}:${sender}`
  }

  private getMediaPathFromMap(
    mediaPathMap?: Map<string, string>,
    mediaMapKey?: string,
    createTime?: number
  ): string | undefined {
    if (!mediaPathMap) return undefined

    if (mediaMapKey && mediaPathMap.has(mediaMapKey)) {
      return mediaPathMap.get(mediaMapKey)
    }

    // 兼容旧的 createTime 键映射（仅用于历史逻辑兜底）
    if (createTime) {
      const legacyMap = mediaPathMap as unknown as Map<number, string>
      if (legacyMap.has(createTime)) {
        return legacyMap.get(createTime)
      }
    }

    return undefined
  }

  private setMediaPathMapEntry(
    mediaPathMap: Map<string, string>,
    relativePath: string,
    mediaMapKey?: string,
    createTime?: number
  ) {
    if (mediaMapKey) {
      mediaPathMap.set(mediaMapKey, relativePath)
      return
    }
    if (createTime) {
      const legacyMap = mediaPathMap as unknown as Map<number, string>
      legacyMap.set(createTime, relativePath)
    }
  }

  private getArkmeMediaKind(localType: number): ArkmeMediaKind | null {
    if (localType === 3) return 'image'
    if (localType === 43) return 'video'
    if (localType === 47) return 'emoji'
    if (localType === 34) return 'voice'
    return null
  }

  private buildArkmeMediaKey(params: {
    sessionId: string
    platformMessageId?: string | null
    localMessageId?: string | null
    createTime: number
    localType: number
    isSend?: boolean | null
    realSenderId?: string | number | null
    contentHint?: string | null
  }): string {
    const crypto = require('crypto')
    const parts = [
      `sid:${String(params.sessionId || '')}`,
      `srv:${String(params.platformMessageId || '')}`,
      `loc:${String(params.localMessageId || '')}`,
      `ts:${Number(params.createTime || 0)}`,
      `lt:${Number(params.localType || 0)}`,
      `sd:${params.isSend ? 1 : 0}`,
      `rs:${params.realSenderId !== undefined && params.realSenderId !== null ? String(params.realSenderId) : ''}`
    ]

    if (!params.platformMessageId && !params.localMessageId && params.contentHint) {
      const contentHash = crypto.createHash('sha1').update(String(params.contentHint)).digest('hex').slice(0, 16)
      parts.push(`ch:${contentHash}`)
    }

    const digest = crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 24)
    return `m_${digest}`
  }

  private parseArkmeEmojiSource(content: string): {
    emojiMd5?: string
    cdnUrl?: string
    encryptUrl?: string
    aesKey?: string
  } {
    const cdnUrlMatch = /cdnurl\s*=\s*['"]([^'"]+)['"]/i.exec(content)
    const thumbUrlMatch = /thumburl\s*=\s*['"]([^'"]+)['"]/i.exec(content)
    const md5Match = /(?:emoticon)?md5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content) ||
      /<md5>([^<]+)<\/md5>/i.exec(content)
    const encryptUrlMatch = /encrypturl\s*=\s*['"]([^'"]+)['"]/i.exec(content)
    const aesKeyMatch = /aeskey\s*=\s*['"]([a-zA-Z0-9]+)['"]/i.exec(content)

    const cdnUrl = (cdnUrlMatch?.[1] || thumbUrlMatch?.[1] || '').replace(/&amp;/g, '&')
    const encryptUrl = (encryptUrlMatch?.[1] || '').replace(/&amp;/g, '&')
    const emojiMd5 = this.normalizeMd5(md5Match?.[1]) || ''
    const aesKey = aesKeyMatch?.[1] || ''

    return {
      ...(emojiMd5 ? { emojiMd5 } : {}),
      ...(cdnUrl ? { cdnUrl } : {}),
      ...(encryptUrl ? { encryptUrl } : {}),
      ...(aesKey ? { aesKey } : {})
    }
  }

  private normalizeMd5(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const normalized = value.trim().toLowerCase()
    if (!normalized) return null
    if (!/^[a-f0-9]{16,64}$/.test(normalized)) return null
    return normalized
  }

  private extractArkmeSourceMd5(source?: Record<string, unknown>): string | null {
    if (!source) return null
    return this.normalizeMd5(source.imageMd5) ||
      this.normalizeMd5(source.videoMd5) ||
      this.normalizeMd5(source.emojiMd5) ||
      null
  }

  private async computeFileMd5(filePath: string): Promise<string | null> {
    if (!filePath || !fs.existsSync(filePath)) return null
    const crypto = require('crypto')
    const hash = crypto.createHash('md5')
    try {
      await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(filePath)
        stream.on('data', (chunk: Buffer) => hash.update(chunk))
        stream.on('error', reject)
        stream.on('end', () => resolve())
      })
      return hash.digest('hex')
    } catch {
      return null
    }
  }

  private buildArkmeMediaSource(localType: number, content: string, row: Record<string, any>, createTime: number): Record<string, unknown> | undefined {
    if (localType === 3) {
      const imageMd5 = this.normalizeMd5(this.extractXmlValue(content, 'md5') ||
        (/\<img[^>]*\smd5\s*=\s*['"]([^'"]+)['"]/i.exec(content))?.[1] ||
        undefined) || undefined
      const imageDatName = this.parseImageDatName(row)
      if (!imageMd5 && !imageDatName) return undefined
      return {
        ...(imageMd5 ? { imageMd5 } : {}),
        ...(imageDatName ? { imageDatName } : {})
      }
    }

    if (localType === 43) {
      const videoMd5 = this.normalizeMd5(videoService.parseVideoMd5(content)) || undefined
      if (!videoMd5) return undefined
      return { videoMd5 }
    }

    if (localType === 47) {
      const emojiSource = this.parseArkmeEmojiSource(content)
      if (Object.keys(emojiSource).length === 0) return undefined
      return emojiSource
    }

    if (localType === 34) {
      return { voiceCreateTime: createTime }
    }

    return undefined
  }

  private buildArkmeMediaRef(params: {
    sessionId: string
    localType: number
    createTime: number
    platformMessageId?: string
    localMessageId?: string
    isSend?: boolean
    realSenderId?: string | number
    contentHint?: string
    source?: Record<string, unknown>
    arkmeMediaIndexMap?: Map<string, ArkmeMediaIndexEntry>
  }): ArkmeMediaRef | undefined {
    const kind = this.getArkmeMediaKind(params.localType)
    if (!kind) return undefined

    const mediaKey = this.buildArkmeMediaKey({
      sessionId: params.sessionId,
      platformMessageId: params.platformMessageId,
      localMessageId: params.localMessageId,
      createTime: params.createTime,
      localType: params.localType,
      isSend: params.isSend,
      realSenderId: params.realSenderId,
      contentHint: params.contentHint
    })

    const indexed = params.arkmeMediaIndexMap?.get(mediaKey)
    const relativePath = indexed?.relativePath || null
    const mergedSource = {
      ...((indexed?.source as Record<string, unknown> | undefined) || {}),
      ...((params.source as Record<string, unknown> | undefined) || {})
    }
    const source = Object.keys(mergedSource).length > 0 ? mergedSource : undefined
    const sourceMd5 = indexed?.sourceMd5 || this.extractArkmeSourceMd5(source) || null

    return {
      kind,
      mediaKey,
      exported: Boolean(indexed?.exported && relativePath),
      relativePath,
      fileName: relativePath ? path.basename(relativePath) : null,
      sourceMd5,
      fileMd5: indexed?.fileMd5 || null,
      ...(source ? { source } : {})
    }
  }

  private upsertArkmeMediaIndexEntry(
    arkmeMediaIndexMap: Map<string, ArkmeMediaIndexEntry>,
    entry: ArkmeMediaIndexEntry
  ): void {
    const prev = arkmeMediaIndexMap.get(entry.mediaKey)
    const normalizedSourceMd5 = entry.sourceMd5 || this.extractArkmeSourceMd5(entry.source) || null
    const normalizedFileMd5 = this.normalizeMd5(entry.fileMd5) || null
    if (!prev) {
      arkmeMediaIndexMap.set(entry.mediaKey, {
        ...entry,
        sourceMd5: normalizedSourceMd5,
        fileMd5: normalizedFileMd5
      })
      return
    }

    const mergedSource = {
      ...((prev.source as Record<string, unknown> | undefined) || {}),
      ...((entry.source as Record<string, unknown> | undefined) || {})
    }
    const mergedSourceMd5 = prev.sourceMd5 ||
      normalizedSourceMd5 ||
      this.extractArkmeSourceMd5(mergedSource) ||
      null
    const mergedFileMd5 = prev.fileMd5 || normalizedFileMd5 || null
    arkmeMediaIndexMap.set(entry.mediaKey, {
      ...prev,
      ...entry,
      exported: Boolean(prev.exported || entry.exported),
      relativePath: prev.relativePath || entry.relativePath || null,
      fileName: prev.fileName || entry.fileName || null,
      sourceMd5: mergedSourceMd5,
      fileMd5: mergedFileMd5,
      source: Object.keys(mergedSource).length > 0 ? mergedSource : undefined
    })
  }

  private writeArkmeMediaMapFile(
    outputDir: string,
    arkmeMediaIndexMap: Map<string, ArkmeMediaIndexEntry>,
    fileName = 'arkme-media-map.json'
  ): void {
    if (!outputDir) return
    const mapPath = path.join(outputDir, fileName)
    const sortedItems = Array.from(arkmeMediaIndexMap.values())
      .sort((a, b) => a.createTime - b.createTime || a.mediaKey.localeCompare(b.mediaKey))
      .map(item => ({
        mediaKey: item.mediaKey,
        kind: item.kind,
        exported: item.exported,
        relativePath: item.relativePath || null,
        fileName: item.fileName || null,
        sourceMd5: item.sourceMd5 || null,
        fileMd5: item.fileMd5 || null,
        createTime: item.createTime,
        sessionId: item.sessionId,
        platformMessageId: item.platformMessageId || null,
        localMessageId: item.localMessageId || null,
        ...(item.source ? { source: item.source } : {})
      }))

    const bySourceMd5: Record<string, any[]> = {}
    const byFileMd5: Record<string, any[]> = {}
    for (const item of sortedItems) {
      const brief = {
        mediaKey: item.mediaKey,
        kind: item.kind,
        exported: item.exported,
        relativePath: item.relativePath,
        fileName: item.fileName,
        createTime: item.createTime
      }
      if (item.sourceMd5) {
        if (!bySourceMd5[item.sourceMd5]) bySourceMd5[item.sourceMd5] = []
        bySourceMd5[item.sourceMd5].push(brief)
      }
      if (item.fileMd5) {
        if (!byFileMd5[item.fileMd5]) byFileMd5[item.fileMd5] = []
        byFileMd5[item.fileMd5].push(brief)
      }
    }

    const payload = {
      version: '1.0.0',
      schema: 'arkme.chat.media.map.v1',
      generatedAt: Math.floor(Date.now() / 1000),
      count: sortedItems.length,
      sourceMd5Count: Object.keys(bySourceMd5).length,
      fileMd5Count: Object.keys(byFileMd5).length,
      items: sortedItems,
      bySourceMd5,
      byFileMd5
    }
    fs.writeFileSync(mapPath, JSON.stringify(payload, null, 2), 'utf-8')
  }

  /**
   * 解析消息内容为可读文本
   */
  private parseMessageContent(
    content: string,
    localType: number,
    sessionId?: string,
    createTime?: number,
    mediaPathMap?: Map<string, string>,
    mediaMapKey?: string
  ): string | null {
    if (!content) return null

    // 检查 XML 中的 type 标签（支持大 localType 的情况）
    const xmlTypeMatch = /<type>(\d+)<\/type>/i.exec(content)
    const xmlType = xmlTypeMatch ? xmlTypeMatch[1] : null

    switch (localType) {
      case 1: // 文本
        return this.stripSenderPrefix(content)
      case 3: {
        // 图片消息：如果有媒体映射表，返回相对路径
        const mediaPath = this.getMediaPathFromMap(mediaPathMap, mediaMapKey, createTime)
        if (mediaPath) {
          return `[图片] ${mediaPath}`
        }
        return '[图片]'
      }
      case 34: {
        // 语音消息
        const transcript = (sessionId && createTime) ? voiceTranscribeService.getCachedTranscript(sessionId, createTime) : null
        const mediaPath = this.getMediaPathFromMap(mediaPathMap, mediaMapKey, createTime)
        if (mediaPath) {
          return `[语音消息] ${mediaPath}${transcript ? ' ' + transcript : ''}`
        }
        if (transcript) {
          return `[语音消息] ${transcript}`
        }
        return '[语音消息]'
      }
      case 42: return '[名片]'
      case 43: {
        const mediaPath = this.getMediaPathFromMap(mediaPathMap, mediaMapKey, createTime)
        if (mediaPath) {
          return `[视频] ${mediaPath}`
        }
        return '[视频]'
      }
      case 47: {
        const mediaPath = this.getMediaPathFromMap(mediaPathMap, mediaMapKey, createTime)
        if (mediaPath) {
          return `[动画表情] ${mediaPath}`
        }
        return '[动画表情]'
      }
      case 48: return '[位置]'
      case 49: {
        const title = this.extractXmlValue(content, 'title')
        const type = this.extractXmlValue(content, 'type')

        // 群公告消息（type 87）
        if (type === '87') {
          const textAnnouncement = this.extractXmlValue(content, 'textannouncement')
          if (textAnnouncement) {
            return `[群公告] ${textAnnouncement}`
          }
          return '[群公告]'
        }

        // 转账消息特殊处理
        if (type === '2000') {
          const feedesc = this.extractXmlValue(content, 'feedesc')
          const payMemo = this.extractXmlValue(content, 'pay_memo')
          if (feedesc) {
            return payMemo ? `[转账] ${feedesc} ${payMemo}` : `[转账] ${feedesc}`
          }
          return '[转账]'
        }

        if (type === '6') return title ? `[文件] ${title}` : '[文件]'
        if (type === '19') return title ? `[聊天记录] ${title}` : '[聊天记录]'
        if (type === '33' || type === '36') return title ? `[小程序] ${title}` : '[小程序]'
        if (type === '57') return title || '[引用消息]'
        if (type === '5' || type === '49') return title ? `[链接] ${title}` : '[链接]'
        return title ? `[链接] ${title}` : '[链接]'
      }
      case 50: return '[通话]'
      case 10000: return this.cleanSystemMessage(content)
      case 244813135921: {
        // 引用消息
        const title = this.extractXmlValue(content, 'title')
        return title || '[引用消息]'
      }
      default:
        // 对于未知的 localType，检查 XML type 来判断消息类型
        if (xmlType) {
          const title = this.extractXmlValue(content, 'title')

          // 群公告消息（type 87）
          if (xmlType === '87') {
            const textAnnouncement = this.extractXmlValue(content, 'textannouncement')
            if (textAnnouncement) {
              return `[群公告] ${textAnnouncement}`
            }
            return '[群公告]'
          }

          // 转账消息
          if (xmlType === '2000') {
            const feedesc = this.extractXmlValue(content, 'feedesc')
            const payMemo = this.extractXmlValue(content, 'pay_memo')
            if (feedesc) {
              return payMemo ? `[转账] ${feedesc} ${payMemo}` : `[转账] ${feedesc}`
            }
            return '[转账]'
          }

          // 其他类型
          if (xmlType === '6') return title ? `[文件] ${title}` : '[文件]'
          if (xmlType === '19') return title ? `[聊天记录] ${title}` : '[聊天记录]'
          if (xmlType === '33' || xmlType === '36') return title ? `[小程序] ${title}` : '[小程序]'
          if (xmlType === '57') return title || '[引用消息]'
          if (xmlType === '5' || xmlType === '49') return title ? `[链接] ${title}` : '[链接]'

          // 有 title 就返回 title
          if (title) return title
        }

        // 最后尝试提取文本内容
        return this.stripSenderPrefix(content) || null
    }
  }

  private stripSenderPrefix(content: string): string {
    return content.replace(/^[\s]*([a-zA-Z0-9_-]+):(?!\/\/)\s*/, '')
  }

  /**
   * 从撤回消息内容中提取撤回者的 wxid
   * @returns { isRevoke: true, isSelfRevoke: true } - 是自己撤回的消息
   * @returns { isRevoke: true, revokerWxid: string } - 是别人撤回的消息，提取到撤回者
   * @returns { isRevoke: false } - 不是撤回消息
   */
  private extractRevokerInfo(content: string): { isRevoke: boolean; isSelfRevoke?: boolean; revokerWxid?: string } {
    if (!content) return { isRevoke: false }

    // 检查是否是撤回消息
    if (!content.includes('revokemsg') && !content.includes('撤回')) {
      return { isRevoke: false }
    }

    // 检查是否是 "你撤回了" - 自己撤回
    if (content.includes('你撤回')) {
      return { isRevoke: true, isSelfRevoke: true }
    }

    // 尝试从 <session> 标签提取（格式: wxid_xxx）
    const sessionMatch = /<session>([^<]+)<\/session>/i.exec(content)
    if (sessionMatch) {
      const session = sessionMatch[1].trim()
      // 如果 session 是 wxid 格式，返回它
      if (session.startsWith('wxid_') || /^[a-zA-Z][a-zA-Z0-9_-]+$/.test(session)) {
        return { isRevoke: true, revokerWxid: session }
      }
    }

    // 尝试从 <fromusername> 提取
    const fromUserMatch = /<fromusername>([^<]+)<\/fromusername>/i.exec(content)
    if (fromUserMatch) {
      return { isRevoke: true, revokerWxid: fromUserMatch[1].trim() }
    }

    // 是撤回消息但无法提取撤回者
    return { isRevoke: true }
  }

  private extractXmlValue(xml: string, tagName: string): string {
    const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i')
    const match = regex.exec(xml)
    if (match) {
      return match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
    }
    return ''
  }

  private cleanSystemMessage(content: string): string {
    // 移除 XML 声明
    let cleaned = content.replace(/<\?xml[^?]*\?>/gi, '')
    // 移除所有 XML/HTML 标签
    cleaned = cleaned.replace(/<[^>]+>/g, '')
    // 移除尾部的数字（如撤回消息后的时间戳）
    cleaned = cleaned.replace(/\d+\s*$/, '')
    // 清理多余空白
    cleaned = cleaned.replace(/\s+/g, ' ').trim()
    return cleaned || '[系统消息]'
  }

  /**
   * 导出单个会话为 ChatLab 格式
   */
  async exportSessionToChatLab(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.dbDir) {
        const connectResult = await this.connect()
        if (!connectResult.success) return connectResult
      }

      const myWxid = this.configService.get('myWxid') || ''
      const cleanedMyWxid = this.cleanAccountDirName(myWxid)
      const isGroup = sessionId.includes('@chatroom')

      // 获取会话信息
      const sessionInfo = await this.getContactInfo(sessionId)
      const myIdentitySource = cleanedMyWxid || myWxid
      const myInfo = await this.getContactInfo(myIdentitySource)
      const contactInfoCache = new Map<string, ResolvedContactInfo>()
      const getCachedContactInfo = async (username: string): Promise<ResolvedContactInfo> => {
        const key = String(username || '')
        if (contactInfoCache.has(key)) return contactInfoCache.get(key)!
        const info = await this.getContactInfo(key)
        contactInfoCache.set(key, info)
        return info
      }
      contactInfoCache.set(sessionId, sessionInfo)
      if (myIdentitySource) contactInfoCache.set(myIdentitySource, myInfo)

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing',
        detail: '正在准备导出...'
      })

      // 查找消息表
      const dbTablePairs = this.findSessionTables(sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息' }
      }

      // 收集所有消息
      const allMessages: any[] = []
      const memberSet = new Map<string, ChatLabMember>()
      // 群昵称缓存 (platformId -> groupNickname)
      const groupNicknameCache = new Map<string, string>()
      let processedMessageRows = 0

      for (const { db, tableName, dbPath } of dbTablePairs) {
        try {
          // 检查是否有 Name2Id 表
          const hasName2Id = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='Name2Id'"
          ).get()

          let sql: string
          if (hasName2Id) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ORDER BY m.create_time ASC`
          } else {
            sql = `SELECT * FROM ${tableName} ORDER BY create_time ASC`
          }

          const rows = db.prepare(sql).all() as any[]

          for (const row of rows) {
            const createTime = row.create_time || 0

            // 时间范围过滤
            if (options.dateRange) {
              if (createTime < options.dateRange.start || createTime > options.dateRange.end) {
                continue
              }
            }

            const content = this.decodeMessageContent(row.message_content, row.compress_content)
            const localType = row.local_type || row.type || 1
            const senderUsername = row.sender_username || ''

            // 判断是否是自己发送
            const isSend = row.is_send === 1 || senderUsername === cleanedMyWxid

            // 确定实际发送者
            let actualSender: string
            if (localType === 10000 || localType === 266287972401) {
              // 系统消息特殊处理
              const revokeInfo = this.extractRevokerInfo(content)
              if (revokeInfo.isRevoke) {
                // 撤回消息
                if (revokeInfo.isSelfRevoke) {
                  // "你撤回了" - 发送者是当前用户
                  actualSender = cleanedMyWxid
                } else if (revokeInfo.revokerWxid) {
                  // 提取到了撤回者的 wxid
                  actualSender = revokeInfo.revokerWxid
                } else {
                  // 无法确定撤回者，使用 sessionId
                  actualSender = sessionId
                }
              } else {
                // 普通系统消息（如"xxx加入群聊"），发送者是群聊ID
                actualSender = sessionId
              }
            } else {
              actualSender = isSend ? cleanedMyWxid : senderUsername
            }

            // 提取消息ID (local_id 或 server_id)
            const platformMessageId = row.server_id ? String(row.server_id) : (row.local_id ? String(row.local_id) : undefined)
            const localMessageId = row.local_id ? String(row.local_id) : undefined
            const mediaMapKey = this.buildMediaPathMapKey({
              platformMessageId,
              localMessageId,
              createTime,
              localType,
              senderUsername: actualSender,
              isSend
            })

            // 提取引用消息ID (从 type 57 的 XML 中解析)
            let replyToMessageId: string | undefined
            if (localType === 49 && content.includes('<type>57</type>')) {
              const svridMatch = /<svrid>(\d+)<\/svrid>/i.exec(content)
              if (svridMatch) {
                replyToMessageId = svridMatch[1]
              }
            }

            // 提取群昵称 (从消息内容中解析)
            let groupNickname: string | undefined
            if (isGroup && actualSender) {
              // 尝试从缓存获取
              if (groupNicknameCache.has(actualSender)) {
                groupNickname = groupNicknameCache.get(actualSender)
              } else {
                // 尝试从消息内容中提取群昵称
                const nicknameFromContent = this.extractGroupNickname(content, actualSender)
                if (nicknameFromContent) {
                  groupNickname = nicknameFromContent
                  groupNicknameCache.set(actualSender, nicknameFromContent)
                }
              }
            }

            // 检查是否是聊天记录消息（type=19）
            const xmlType = this.extractXmlValue(content, 'type')
            let chatRecordList: any[] | undefined
            if (xmlType === '19' || localType === 49) {
              chatRecordList = this.parseChatHistory(content)
            }

            allMessages.push({
              createTime,
              localType,
              content,
              senderUsername: actualSender,
              isSend,
              platformMessageId,
              localMessageId,
              mediaMapKey,
              replyToMessageId,
              groupNickname,
              chatRecordList
            })

            // 收集成员信息
            if (actualSender && !memberSet.has(actualSender)) {
              const memberInfo = await getCachedContactInfo(actualSender)
              const memberIdentity = this.normalizeWechatIdentity(actualSender, memberInfo)
              memberSet.set(actualSender, {
                platformId: actualSender,
                accountName: memberInfo.displayName,
                wechatId: memberIdentity.wechatId,
                wechatAlias: memberIdentity.wechatAlias,
                ...(groupNickname && { groupNickname }),
                ...(options.exportAvatars && memberInfo.avatarUrl && { avatar: memberInfo.avatarUrl })
              })
            } else if (actualSender && groupNickname && !memberSet.get(actualSender)?.groupNickname) {
              // 更新已有成员的群昵称
              const existing = memberSet.get(actualSender)!
              memberSet.set(actualSender, { ...existing, groupNickname })
            }

            processedMessageRows++
            await this.yieldMainThreadEvery(processedMessageRows)
          }
        } catch (e) {
          console.error('导出消息失败:', e)
        }
      }

      // 按时间排序
      allMessages.sort((a, b) => a.createTime - b.createTime)

      onProgress?.({
        current: 50,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting',
        detail: '正在读取消息...'
      })

      // 构建 ChatLab 格式消息
      const chatLabMessages: ChatLabMessage[] = []

      for (const msg of allMessages) {
        const senderContactInfo = await getCachedContactInfo(msg.senderUsername)
        const senderIdentity = this.normalizeWechatIdentity(msg.senderUsername, senderContactInfo)
        const memberInfo = memberSet.get(msg.senderUsername) || {
          platformId: msg.senderUsername,
          accountName: senderContactInfo.displayName,
          wechatId: senderIdentity.wechatId,
          wechatAlias: senderIdentity.wechatAlias
        }
        let parsedContent = this.parseMessageContent(
          msg.content,
          msg.localType,
          sessionId,
          msg.createTime,
          options.mediaPathMap,
          msg.mediaMapKey
        )

        // 转账消息：追加 "谁转账给谁" 信息
        if (parsedContent && parsedContent.startsWith('[转账]') && msg.content) {
          const transferDesc = await this.resolveTransferDesc(
            msg.content,
            myWxid,
            new Map<string, string>(),
            async (username) => {
              const info = await getCachedContactInfo(username)
              return info.displayName || username
            }
          )
          if (transferDesc) {
            parsedContent = parsedContent.replace('[转账]', `[转账] (${transferDesc})`)
          }
        }

        const message: ChatLabMessage = {
          sender: msg.senderUsername,
          accountName: memberInfo.accountName,
          senderWechatId: senderIdentity.wechatId,
          senderWechatAlias: senderIdentity.wechatAlias,
          timestamp: msg.createTime,
          type: this.convertMessageType(msg.localType, msg.content),
          content: parsedContent
        }

        // 添加可选字段
        if (msg.groupNickname) message.groupNickname = msg.groupNickname
        if (msg.platformMessageId) message.platformMessageId = msg.platformMessageId
        if (msg.replyToMessageId) message.replyToMessageId = msg.replyToMessageId

        // 如果有聊天记录，添加为嵌套字段
        if (msg.chatRecordList && msg.chatRecordList.length > 0) {
          const chatRecords: ChatRecordItem[] = []

          for (const record of msg.chatRecordList) {
            // 解析时间戳 (格式: "YYYY-MM-DD HH:MM:SS")
            let recordTimestamp = msg.createTime
            if (record.sourcetime) {
              try {
                const timeParts = record.sourcetime.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
                if (timeParts) {
                  const date = new Date(
                    parseInt(timeParts[1]),
                    parseInt(timeParts[2]) - 1,
                    parseInt(timeParts[3]),
                    parseInt(timeParts[4]),
                    parseInt(timeParts[5]),
                    parseInt(timeParts[6])
                  )
                  recordTimestamp = Math.floor(date.getTime() / 1000)
                }
              } catch (e) {
                console.error('解析聊天记录时间失败:', e)
              }
            }

            // 转换消息类型
            let recordType = 0 // TEXT
            let recordContent = record.datadesc || record.datatitle || ''

            switch (record.datatype) {
              case 1:
                recordType = 0 // TEXT
                break
              case 3:
                recordType = 1 // IMAGE
                recordContent = '[图片]'
                break
              case 8:
              case 49:
                recordType = 4 // FILE
                recordContent = record.datatitle ? `[文件] ${record.datatitle}` : '[文件]'
                break
              case 34:
                recordType = 2 // VOICE
                recordContent = '[语音消息]'
                break
              case 43:
                recordType = 3 // VIDEO
                recordContent = '[视频]'
                break
              case 47:
                recordType = 5 // EMOJI
                recordContent = '[动画表情]'
                break
              default:
                recordType = 0
                recordContent = record.datadesc || record.datatitle || '[消息]'
            }

            const recordIdentity = this.normalizeWechatIdentity(record.sourcename || '')
            const chatRecord: ChatRecordItem = {
              sender: record.sourcename || 'unknown',
              accountName: record.sourcename || 'unknown',
              senderWechatId: recordIdentity.wechatId,
              senderWechatAlias: recordIdentity.wechatAlias,
              timestamp: recordTimestamp,
              type: recordType,
              content: recordContent
            }

            // 添加头像（如果启用导出头像）
            if (options.exportAvatars && record.sourceheadurl) {
              chatRecord.avatar = record.sourceheadurl
            }

            chatRecords.push(chatRecord)

            // 添加成员信息
            if (record.sourcename && !memberSet.has(record.sourcename)) {
              const recordMemberIdentity = this.normalizeWechatIdentity(record.sourcename)
              memberSet.set(record.sourcename, {
                platformId: record.sourcename,
                accountName: record.sourcename,
                wechatId: recordMemberIdentity.wechatId,
                wechatAlias: recordMemberIdentity.wechatAlias,
                ...(options.exportAvatars && record.sourceheadurl && { avatar: record.sourceheadurl })
              })
            }
          }

          message.chatRecords = chatRecords
        }

        chatLabMessages.push(message)
      }

      // 构建 meta
      const meta: ChatLabMeta = {
        name: sessionInfo.displayName,
        platform: 'wechat',
        type: isGroup ? 'group' : 'private',
        ownerId: cleanedMyWxid,
        ownerWechatId: myInfo.wechatId || cleanedMyWxid || null,
        ownerWechatAlias: myInfo.wechatAlias || null
      }
      if (isGroup) {
        meta.groupId = sessionId
        const groupIdentity = this.normalizeWechatIdentity(sessionId, sessionInfo)
        meta.groupWechatId = groupIdentity.wechatId
        meta.groupWechatAlias = groupIdentity.wechatAlias
        // 添加群头像
        if (options.exportAvatars && sessionInfo.avatarUrl) {
          meta.groupAvatar = sessionInfo.avatarUrl
        }
      }

      const chatLabExport: ChatLabExport = {
        chatlab: {
          version: '0.0.2',
          exportedAt: Math.floor(Date.now() / 1000),
          generator: 'VXdaochu'
        },
        meta,
        members: Array.from(memberSet.values()),
        messages: chatLabMessages
      }

      onProgress?.({
        current: 80,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing',
        detail: '正在写入文件...'
      })

      // 写入文件
      if (options.format === 'chatlab-jsonl') {
        // JSONL 格式
        const lines: string[] = []
        lines.push(JSON.stringify({
          _type: 'header',
          chatlab: chatLabExport.chatlab,
          meta: chatLabExport.meta
        }))
        for (const member of chatLabExport.members) {
          lines.push(JSON.stringify({ _type: 'member', ...member }))
        }
        for (const message of chatLabExport.messages) {
          lines.push(JSON.stringify({ _type: 'message', ...message }))
        }
        fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8')
      } else {
        // JSON 格式
        fs.writeFileSync(outputPath, JSON.stringify(chatLabExport, null, 2), 'utf-8')
      }

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete',
        detail: '导出完成'
      })

      return { success: true }
    } catch (e) {
      console.error('ExportService: 导出失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 从消息内容中提取群昵称
   */
  private extractGroupNickname(content: string, senderUsername: string): string | undefined {
    // 尝试从 msgsource 中提取
    const msgsourceMatch = /<msgsource>[\s\S]*?<\/msgsource>/i.exec(content)
    if (msgsourceMatch) {
      // 提取 <atuserlist> 或其他可能包含昵称的字段
      const displaynameMatch = /<displayname>([^<]+)<\/displayname>/i.exec(msgsourceMatch[0])
      if (displaynameMatch) {
        return displaynameMatch[1]
      }
    }
    return undefined
  }

  /**
   * 解析合并转发的聊天记录 (Type 19)
   */
  private parseChatHistory(content: string): any[] | undefined {
    try {
      const type = this.extractXmlValue(content, 'type')
      if (type !== '19') return undefined

      // 提取 recorditem 中的 CDATA
      const match = /<recorditem>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?<\/recorditem>/.exec(content)
      if (!match) return undefined

      const innerXml = match[1]
      const items: any[] = []
      const itemRegex = /<dataitem\s+(.*?)>([\s\S]*?)<\/dataitem>/g
      let itemMatch

      while ((itemMatch = itemRegex.exec(innerXml)) !== null) {
        const attrs = itemMatch[1]
        const body = itemMatch[2]

        const datatypeMatch = /datatype="(\d+)"/.exec(attrs)
        const datatype = datatypeMatch ? parseInt(datatypeMatch[1]) : 0

        const sourcename = this.extractXmlValue(body, 'sourcename')
        const sourcetime = this.extractXmlValue(body, 'sourcetime')
        const sourceheadurl = this.extractXmlValue(body, 'sourceheadurl')
        const datadesc = this.extractXmlValue(body, 'datadesc')
        const datatitle = this.extractXmlValue(body, 'datatitle')
        const fileext = this.extractXmlValue(body, 'fileext')
        const datasize = parseInt(this.extractXmlValue(body, 'datasize') || '0')

        items.push({
          datatype,
          sourcename,
          sourcetime,
          sourceheadurl,
          datadesc: this.decodeHtmlEntities(datadesc),
          datatitle: this.decodeHtmlEntities(datatitle),
          fileext,
          datasize
        })
      }

      return items.length > 0 ? items : undefined
    } catch (e) {
      console.error('ExportService: 解析聊天记录失败:', e)
      return undefined
    }
  }

  /**
   * 解码 HTML 实体
   */
  private decodeHtmlEntities(text: string): string {
    if (!text) return ''
    return text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
  }

  /**
   * 格式化聊天记录为 JSON 导出格式
   */
  private formatChatRecordsForJson(chatRecordList: any[], options: ExportOptions): any[] {
    return chatRecordList.map(record => {
      // 解析时间戳
      let timestamp = 0
      if (record.sourcetime) {
        try {
          const timeParts = record.sourcetime.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
          if (timeParts) {
            const date = new Date(
              parseInt(timeParts[1]),
              parseInt(timeParts[2]) - 1,
              parseInt(timeParts[3]),
              parseInt(timeParts[4]),
              parseInt(timeParts[5]),
              parseInt(timeParts[6])
            )
            timestamp = Math.floor(date.getTime() / 1000)
          }
        } catch (e) {
          console.error('解析聊天记录时间失败:', e)
        }
      }

      // 转换消息类型名称
      let typeName = '文本消息'
      let content = record.datadesc || record.datatitle || ''

      switch (record.datatype) {
        case 1:
          typeName = '文本消息'
          break
        case 3:
          typeName = '图片消息'
          content = '[图片]'
          break
        case 8:
        case 49:
          typeName = '文件消息'
          content = record.datatitle ? `[文件] ${record.datatitle}` : '[文件]'
          break
        case 34:
          typeName = '语音消息'
          content = '[语音消息]'
          break
        case 43:
          typeName = '视频消息'
          content = '[视频]'
          break
        case 47:
          typeName = '动画表情'
          content = '[动画表情]'
          break
        default:
          typeName = '其他消息'
          content = record.datadesc || record.datatitle || '[消息]'
      }

      const chatRecordIdentity = this.normalizeWechatIdentity(record.sourcename || '')
      const chatRecord: any = {
        sender: record.sourcename || 'unknown',
        senderWechatId: chatRecordIdentity.wechatId,
        senderWechatAlias: chatRecordIdentity.wechatAlias,
        senderDisplayName: record.sourcename || 'unknown',
        timestamp,
        formattedTime: timestamp > 0 ? this.formatTimestamp(timestamp) : record.sourcetime,
        type: typeName,
        datatype: record.datatype,
        content
      }

      // 添加头像
      if (options.exportAvatars && record.sourceheadurl) {
        chatRecord.senderAvatar = record.sourceheadurl
      }

      // 添加文件信息
      if (record.fileext) {
        chatRecord.fileExt = record.fileext
      }
      if (record.datasize > 0) {
        chatRecord.fileSize = record.datasize
      }

      return chatRecord
    })
  }

  /**
   * 从 extra_buffer 中提取手机号
   * 微信的 extra_buffer 是 protobuf 格式的二进制数据
   * 手机号通常存储在特定的 tag 字段中
   */
  private extractPhoneFromExtraBuf(extraBuffer: any): string | undefined {
    if (!extraBuffer) return undefined

    try {
      let data: Buffer
      if (Buffer.isBuffer(extraBuffer)) {
        data = extraBuffer
      } else if (typeof extraBuffer === 'string') {
        // 可能是 hex 或 base64 编码
        if (/^[0-9a-fA-F]+$/.test(extraBuffer)) {
          data = Buffer.from(extraBuffer, 'hex')
        } else {
          data = Buffer.from(extraBuffer, 'base64')
        }
      } else {
        return undefined
      }

      if (data.length === 0) return undefined

      // 方法1: 尝试解析微信的 protobuf-like 格式
      // 微信 extra_buffer 格式: [tag(1byte)][length(1-2bytes)][data]
      // 手机号可能在 tag 0x42 (66) 或其他位置
      const phoneFromProtobuf = this.parseWechatExtraBuffer(data)
      if (phoneFromProtobuf) return phoneFromProtobuf

      // 方法2: 转为字符串尝试匹配
      const str = data.toString('utf-8')

      // 尝试匹配手机号格式（中国大陆手机号）
      const phoneRegex = /1[3-9]\d{9}/g
      const matches = str.match(phoneRegex)
      if (matches && matches.length > 0) {
        return matches[0]
      }

      // 尝试匹配带国际区号的手机号 +86
      const intlRegex = /\+86\s*1[3-9]\d{9}/g
      const intlMatches = str.match(intlRegex)
      if (intlMatches && intlMatches.length > 0) {
        return intlMatches[0].replace(/\s+/g, '')
      }

      // 方法3: 在二进制数据中查找手机号模式
      const hexStr = data.toString('hex')
      // 手机号 ASCII: 31 (1) 后跟 3-9 的数字
      const hexPhoneRegex = /31[33-39][30-39]{9}/gi
      const hexMatches = hexStr.match(hexPhoneRegex)
      if (hexMatches && hexMatches.length > 0) {
        const phone = Buffer.from(hexMatches[0], 'hex').toString('ascii')
        if (/^1[3-9]\d{9}$/.test(phone)) {
          return phone
        }
      }

      // 方法4: 尝试 latin1 编码
      const latin1Str = data.toString('latin1')
      const latin1Matches = latin1Str.match(phoneRegex)
      if (latin1Matches && latin1Matches.length > 0) {
        return latin1Matches[0]
      }
    } catch (e) {
      // 解析失败，忽略
    }

    return undefined
  }

  /**
   * 解析微信 extra_buffer 的 protobuf-like 格式
   * 格式: 连续的 [tag][length][value] 结构
   */
  private parseWechatExtraBuffer(data: Buffer): string | undefined {
    try {
      let offset = 0
      const results: { tag: number; value: string }[] = []

      while (offset < data.length - 2) {
        const tag = data[offset]
        offset++

        // 读取长度 (可能是 1 或 2 字节)
        let length = data[offset]
        offset++

        // 如果长度字节的高位为1，可能是变长编码
        if (length > 127 && offset < data.length) {
          // 简单处理：跳过这个字段
          length = length & 0x7f
        }

        if (length === 0 || offset + length > data.length) {
          // 无效长度，尝试下一个位置
          continue
        }

        // 读取值
        const valueBytes = data.slice(offset, offset + length)
        offset += length

        // 尝试解码为字符串
        const valueStr = valueBytes.toString('utf-8')

        // 检查是否是手机号
        const phoneMatch = valueStr.match(/^1[3-9]\d{9}$/)
        if (phoneMatch) {
          return phoneMatch[0]
        }

        // 检查是否包含手机号
        const containsPhone = valueStr.match(/1[3-9]\d{9}/)
        if (containsPhone) {
          return containsPhone[0]
        }

        results.push({ tag, value: valueStr })
      }

      // 在所有解析出的值中查找手机号
      for (const item of results) {
        const phoneMatch = item.value.match(/1[3-9]\d{9}/)
        if (phoneMatch) {
          return phoneMatch[0]
        }
      }
    } catch (e) {
      // 解析失败
    }

    return undefined
  }

  /**
   * 获取消息类型名称
   */
  private getMessageTypeName(localType: number, content?: string): string {
    // 检查 XML 中的 type 标签（支持大 localType 的情况）
    if (content) {
      const xmlTypeMatch = /<type>(\d+)<\/type>/i.exec(content)
      const xmlType = xmlTypeMatch ? xmlTypeMatch[1] : null

      if (xmlType) {
        switch (xmlType) {
          case '87': return '群公告'
          case '2000': return '转账消息'
          case '5': return '链接消息'
          case '6': return '文件消息'
          case '19': return '聊天记录'
          case '33':
          case '36': return '小程序消息'
          case '57': return '引用消息'
        }
      }
    }

    const typeNames: Record<number, string> = {
      1: '文本消息',
      3: '图片消息',
      34: '语音消息',
      42: '名片消息',
      43: '视频消息',
      47: '动画表情',
      48: '位置消息',
      49: '链接消息',
      50: '通话消息',
      10000: '系统消息'
    }
    return typeNames[localType] || '其他消息'
  }

  /**
   * 格式化时间戳为可读字符串
   */
  private formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp * 1000)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
  }

  /**
   * 导出单个会话为详细 JSON 格式（原项目格式）
   */
  async exportSessionToDetailedJson(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.dbDir) {
        const connectResult = await this.connect()
        if (!connectResult.success) return connectResult
      }

      const myWxid = this.configService.get('myWxid') || ''
      const cleanedMyWxid = this.cleanAccountDirName(myWxid)
      const isGroup = sessionId.includes('@chatroom')

      // 获取会话信息
      const sessionInfo = await this.getContactInfo(sessionId)
      const sessionIdentity = await this.resolveSessionWechatIdentity(sessionId)
      const sessionWxid = sessionIdentity.wxid || ''
      const sessionAlias = sessionIdentity.alias || sessionInfo.wechatAlias || null
      const sessionNameFields = await this.resolveSessionNameFields(sessionId)
      const myIdentitySource = cleanedMyWxid || myWxid
      const myInfo = await this.getContactInfo(myIdentitySource)
      const contactInfoCache = new Map<string, ResolvedContactInfo>()
      const getCachedContactInfo = async (username: string): Promise<ResolvedContactInfo> => {
        const key = String(username || '')
        if (contactInfoCache.has(key)) return contactInfoCache.get(key)!
        const info = await this.getContactInfo(key)
        contactInfoCache.set(key, info)
        return info
      }
      contactInfoCache.set(sessionId, sessionInfo)
      if (myIdentitySource) contactInfoCache.set(myIdentitySource, myInfo)

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing',
        detail: '正在准备导出...'
      })

      // 查找消息表
      const dbTablePairs = this.findSessionTables(sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息' }
      }

      // 收集所有消息
      const allMessages: any[] = []
      let firstMessageTime: number | null = null
      let lastMessageTime: number | null = null
      let processedMessageRows = 0

      for (const { db, tableName } of dbTablePairs) {
        try {
          const hasName2Id = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='Name2Id'"
          ).get()

          let sql: string
          if (hasName2Id) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ORDER BY m.create_time ASC`
          } else {
            sql = `SELECT * FROM ${tableName} ORDER BY create_time ASC`
          }

          const rows = db.prepare(sql).all() as any[]

          for (const row of rows) {
            const createTime = row.create_time || 0

            if (options.dateRange) {
              if (createTime < options.dateRange.start || createTime > options.dateRange.end) {
                continue
              }
            }

            const content = this.decodeMessageContent(row.message_content, row.compress_content)
            const localType = row.local_type || row.type || 1
            const senderUsername = row.sender_username || ''
            const isSend = row.is_send === 1 || senderUsername === cleanedMyWxid

            // 确定实际发送者
            let actualSender: string
            if (localType === 10000 || localType === 266287972401) {
              // 系统消息特殊处理
              const revokeInfo = this.extractRevokerInfo(content)
              if (revokeInfo.isRevoke) {
                if (revokeInfo.isSelfRevoke) {
                  actualSender = cleanedMyWxid
                } else if (revokeInfo.revokerWxid) {
                  actualSender = revokeInfo.revokerWxid
                } else {
                  actualSender = sessionId
                }
              } else {
                actualSender = sessionId
              }
            } else {
              actualSender = isSend ? cleanedMyWxid : (senderUsername || sessionId)
            }
            const senderInfo = await getCachedContactInfo(actualSender)
            const senderIdentity = this.normalizeWechatIdentity(actualSender, senderInfo)

            // 提取 source（msgsource）
            let source = ''
            const msgsourceMatch = /<msgsource>[\s\S]*?<\/msgsource>/i.exec(content)
            if (msgsourceMatch) {
              source = msgsourceMatch[0]
            }

            // 提取消息ID
            const platformMessageId = row.server_id ? String(row.server_id) : (row.local_id ? String(row.local_id) : undefined)
            const localMessageId = row.local_id ? String(row.local_id) : undefined
            const mediaMapKey = this.buildMediaPathMapKey({
              platformMessageId,
              localMessageId,
              createTime,
              localType,
              senderUsername: actualSender,
              isSend
            })

            // 提取引用消息ID
            let replyToMessageId: string | undefined
            if (localType === 49 && content.includes('<type>57</type>')) {
              const svridMatch = /<svrid>(\d+)<\/svrid>/i.exec(content)
              if (svridMatch) {
                replyToMessageId = svridMatch[1]
              }
            }

            // 提取群昵称
            const groupNickname = isGroup ? this.extractGroupNickname(content, actualSender) : undefined

            // 检查是否是聊天记录消息（type=19）
            const xmlType = this.extractXmlValue(content, 'type')
            let chatRecordList: any[] | undefined
            if (xmlType === '19' || localType === 49) {
              chatRecordList = this.parseChatHistory(content)
            }

            allMessages.push({
              localId: row.local_id || allMessages.length + 1,
              platformMessageId,
              createTime,
              formattedTime: this.formatTimestamp(createTime),
              type: this.getMessageTypeName(localType, content),
              localType,
              chatLabType: this.convertMessageType(localType, content),
              content: this.parseMessageContent(content, localType, sessionId, createTime, options.mediaPathMap, mediaMapKey),
              rawContent: content, // 保留原始内容（用于转账描述解析）
              isSend: isSend ? 1 : 0,
              senderUsername: actualSender,
              senderWechatId: senderIdentity.wechatId,
              senderWechatAlias: senderIdentity.wechatAlias,
              senderDisplayName: senderInfo.displayName,
              ...(groupNickname && { groupNickname }),
              ...(replyToMessageId && { replyToMessageId }),
              ...(options.exportAvatars && senderInfo.avatarUrl && { senderAvatar: senderInfo.avatarUrl }),
              ...(chatRecordList && { chatRecords: this.formatChatRecordsForJson(chatRecordList, options) }),
              source
            })

            // 更新时间范围
            if (firstMessageTime === null || createTime < firstMessageTime) {
              firstMessageTime = createTime
            }
            if (lastMessageTime === null || createTime > lastMessageTime) {
              lastMessageTime = createTime
            }

            processedMessageRows++
            await this.yieldMainThreadEvery(processedMessageRows)
          }
        } catch (e) {
          console.error('导出消息失败:', e)
        }
      }

      // 按时间排序
      allMessages.sort((a, b) => a.createTime - b.createTime)

      onProgress?.({
        current: 70,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing',
        detail: '正在写入文件...'
      })

      // 转账消息：追加 "谁转账给谁" 信息
      for (const msg of allMessages) {
        if (msg.content && msg.content.startsWith('[转账]') && msg.rawContent) {
          const transferDesc = await this.resolveTransferDesc(
            msg.rawContent,
            myWxid,
            new Map<string, string>(),
            async (username: string) => {
              const info = await getCachedContactInfo(username)
              return info.displayName || username
            }
          )
          if (transferDesc) {
            msg.content = msg.content.replace('[转账]', `[转账] (${transferDesc})`)
          }
        }
      }

      // 构建详细 JSON 格式（包含 ChatLab 元信息）
      const detailedExport = {
        // ChatLab 兼容的元信息
        exportInfo: {
          version: '0.0.2',
          exportedAt: Math.floor(Date.now() / 1000),
          generator: 'VXdaochu',
          format: 'detailed-json'
        },
        session: {
          wechatId: sessionWxid || null,
          wechatAlias: sessionAlias,
          wxid: sessionWxid,
          nickname: sessionNameFields.nickname,
          nickName: sessionNameFields.nickname,
          remark: sessionNameFields.remark,
          displayName: sessionInfo.displayName,
          type: isGroup ? '群聊' : '私聊',
          platform: 'wechat',
          isGroup,
          ownerId: cleanedMyWxid,
          ownerWechatId: myInfo.wechatId || cleanedMyWxid || null,
          ownerWechatAlias: myInfo.wechatAlias || null,
          ownerDisplayName: myInfo.displayName,
          ...(options.exportAvatars && myInfo.avatarUrl && { ownerAvatar: myInfo.avatarUrl }),
          ...(isGroup && { groupId: sessionId }),
          ...(options.exportAvatars && sessionInfo.avatarUrl && { avatar: sessionInfo.avatarUrl }),
          firstTimestamp: firstMessageTime,
          lastTimestamp: lastMessageTime,
          messageCount: allMessages.length
        },
        messages: allMessages
      }

      fs.writeFileSync(outputPath, JSON.stringify(detailedExport, null, 2), 'utf-8')

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete',
        detail: '导出完成'
      })

      return { success: true }
    } catch (e) {
      console.error('ExportService: 导出失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 导出单个会话为 Arkme JSON 格式（包含会话头部增强信息）
   */
  async exportSessionToArkmeJson(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.dbDir) {
        const connectResult = await this.connect()
        if (!connectResult.success) return connectResult
      }

      const myWxid = this.configService.get('myWxid') || ''
      const cleanedMyWxid = this.cleanAccountDirName(myWxid)
      const isGroup = sessionId.includes('@chatroom')
      const hasMedia = Boolean(options.exportImages || options.exportVideos || options.exportEmojis || options.exportVoices)
      const mediaMapFile = options.arkmeMediaMapFilePath || 'arkme-media-map.json'

      const sessionInfo = await this.getContactInfo(sessionId)
      const sessionIdentity = await this.resolveSessionWechatIdentity(sessionId)
      const sessionWxid = sessionIdentity.wxid || ''
      const sessionAlias = sessionIdentity.alias || sessionInfo.wechatAlias || null
      const sessionNameFields = await this.resolveSessionNameFields(sessionId)
      const myIdentitySource = cleanedMyWxid || myWxid
      const myInfo = await this.getContactInfo(myIdentitySource)
      const contactInfoCache = new Map<string, ResolvedContactInfo>()
      const getCachedContactInfo = async (username: string): Promise<ResolvedContactInfo> => {
        const key = String(username || '')
        if (contactInfoCache.has(key)) return contactInfoCache.get(key)!
        const info = await this.getContactInfo(key)
        contactInfoCache.set(key, info)
        return info
      }
      contactInfoCache.set(sessionId, sessionInfo)
      if (myIdentitySource) contactInfoCache.set(myIdentitySource, myInfo)

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing',
        detail: '正在准备导出...'
      })

      const dbTablePairs = this.findSessionTables(sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息' }
      }

      const allMessages: any[] = []
      let firstMessageTime: number | null = null
      let lastMessageTime: number | null = null
      let processedMessageRows = 0

      for (const { db, tableName } of dbTablePairs) {
        try {
          const hasName2Id = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='Name2Id'"
          ).get()

          let sql: string
          if (hasName2Id) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ORDER BY m.create_time ASC`
          } else {
            sql = `SELECT * FROM ${tableName} ORDER BY create_time ASC`
          }

          const rows = db.prepare(sql).all() as any[]

          for (const row of rows) {
            const createTime = row.create_time || 0
            if (options.dateRange) {
              if (createTime < options.dateRange.start || createTime > options.dateRange.end) continue
            }

            const content = this.decodeMessageContent(row.message_content, row.compress_content)
            const localType = row.local_type || row.type || 1
            const senderUsername = row.sender_username || ''
            const isSend = row.is_send === 1 || senderUsername === cleanedMyWxid

            let actualSender: string
            if (localType === 10000 || localType === 266287972401) {
              const revokeInfo = this.extractRevokerInfo(content)
              if (revokeInfo.isRevoke) {
                if (revokeInfo.isSelfRevoke) {
                  actualSender = cleanedMyWxid
                } else if (revokeInfo.revokerWxid) {
                  actualSender = revokeInfo.revokerWxid
                } else {
                  actualSender = sessionId
                }
              } else {
                actualSender = sessionId
              }
            } else {
              actualSender = isSend ? cleanedMyWxid : (senderUsername || sessionId)
            }

            const senderInfo = await getCachedContactInfo(actualSender)
            const senderIdentity = this.normalizeWechatIdentity(actualSender, senderInfo)
            let source = ''
            const msgsourceMatch = /<msgsource>[\s\S]*?<\/msgsource>/i.exec(content)
            if (msgsourceMatch) {
              source = msgsourceMatch[0]
            }

            const platformMessageId = row.server_id ? String(row.server_id) : (row.local_id ? String(row.local_id) : undefined)
            const localMessageId = row.local_id ? String(row.local_id) : undefined
            const mediaMapKey = this.buildMediaPathMapKey({
              platformMessageId,
              localMessageId,
              createTime,
              localType,
              senderUsername: actualSender,
              isSend
            })

            let replyToMessageId: string | undefined
            if (localType === 49 && content.includes('<type>57</type>')) {
              const svridMatch = /<svrid>(\d+)<\/svrid>/i.exec(content)
              if (svridMatch) replyToMessageId = svridMatch[1]
            }

            const groupNickname = isGroup ? this.extractGroupNickname(content, actualSender) : undefined
            const xmlType = this.extractXmlValue(content, 'type')
            let chatRecordList: any[] | undefined
            if (xmlType === '19' || localType === 49) {
              chatRecordList = this.parseChatHistory(content)
            }
            const mediaSource = this.buildArkmeMediaSource(localType, content, row, createTime)
            const mediaRef = this.buildArkmeMediaRef({
              sessionId,
              localType,
              createTime,
              platformMessageId,
              localMessageId,
              isSend,
              realSenderId: row.real_sender_id,
              contentHint: content,
              source: mediaSource,
              arkmeMediaIndexMap: options.arkmeMediaIndexMap
            })

            allMessages.push({
              localId: row.local_id || allMessages.length + 1,
              platformMessageId,
              createTime,
              formattedTime: this.formatTimestamp(createTime),
              type: this.getMessageTypeName(localType, content),
              localType,
              chatLabType: this.convertMessageType(localType, content),
              content: this.parseMessageContent(content, localType, sessionId, createTime, options.mediaPathMap, mediaMapKey),
              rawContent: content,
              isSend: isSend ? 1 : 0,
              senderUsername: actualSender,
              senderWechatId: senderIdentity.wechatId,
              senderWechatAlias: senderIdentity.wechatAlias,
              senderDisplayName: senderInfo.displayName,
              ...(options.exportAvatars && senderInfo.avatarUrl && { senderAvatar: senderInfo.avatarUrl }),
              ...(groupNickname && { groupNickname }),
              ...(replyToMessageId && { replyToMessageId }),
              ...(mediaRef ? { mediaRef } : {}),
              ...(chatRecordList && { chatRecords: this.formatChatRecordsForJson(chatRecordList, options) }),
              source
            })

            if (firstMessageTime === null || createTime < firstMessageTime) firstMessageTime = createTime
            if (lastMessageTime === null || createTime > lastMessageTime) lastMessageTime = createTime

            processedMessageRows++
            await this.yieldMainThreadEvery(processedMessageRows)
          }
        } catch (e) {
          console.error('导出 Arkme JSON 消息失败:', e)
        }
      }

      allMessages.sort((a, b) => a.createTime - b.createTime)

      onProgress?.({
        current: 70,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing',
        detail: '正在组装 Arkme 头部信息...'
      })

      for (const msg of allMessages) {
        if (msg.content && msg.content.startsWith('[转账]') && msg.rawContent) {
          const transferDesc = await this.resolveTransferDesc(
            msg.rawContent,
            myWxid,
            new Map<string, string>(),
            async (username: string) => {
              const info = await getCachedContactInfo(username)
              return info.displayName || username
            }
          )
          if (transferDesc) {
            msg.content = msg.content.replace('[转账]', `[转账] (${transferDesc})`)
          }
        }
      }

      const normalizeIdentity = (value: unknown): string => String(value || '').trim().toLowerCase()
      const buildIdentityKeys = (payload: {
        senderUsername?: unknown
        senderWechatId?: unknown
        senderWechatAlias?: unknown
      }): string[] => {
        const keys: string[] = []
        const username = normalizeIdentity(payload.senderUsername)
        const wxid = normalizeIdentity(payload.senderWechatId)
        const alias = normalizeIdentity(payload.senderWechatAlias)
        if (username) keys.push(`username:${username}`)
        if (wxid) keys.push(`wxid:${wxid}`)
        if (alias) keys.push(`alias:${alias}`)
        return keys
      }
      const identityToSenderId = new Map<string, string>()
      const findSenderIdByKeys = (keys: string[]): string | undefined => {
        for (const key of keys) {
          const hit = identityToSenderId.get(key)
          if (hit) return hit
        }
        return undefined
      }
      const registerIdentityKeys = (senderId: string, keys: string[]): void => {
        for (const key of keys) identityToSenderId.set(key, senderId)
      }
      let nextSenderOrdinal = 1
      const allocateSenderId = (): string => `m${nextSenderOrdinal++}`

      const toCompactMessage = (msg: any, senderId: string) => ({
        localId: msg.localId,
        platformMessageId: msg.platformMessageId,
        createTime: msg.createTime,
        formattedTime: msg.formattedTime,
        type: msg.type,
        localType: msg.localType,
        chatLabType: msg.chatLabType,
        content: msg.content,
        isSend: msg.isSend,
        senderId,
        ...(msg.groupNickname && { groupNickname: msg.groupNickname }),
        ...(msg.replyToMessageId && { replyToMessageId: msg.replyToMessageId }),
        ...(msg.mediaRef ? { mediaRef: msg.mediaRef } : {}),
        ...(msg.chatRecords && { chatRecords: msg.chatRecords }),
        ...(msg.source ? { source: msg.source } : {})
      })

      let compactMessages: any[] = []
      let membersForExport: Array<Record<string, unknown>> | undefined
      let privateSendSenderId: string | null = null
      let privateRecordOwnerSenderId: string | null = null
      let privateSendInfo: Record<string, unknown> | null = null
      let recordOwnerInfo: Record<string, unknown> | null = null
      let groupOwnerInfo: Record<string, unknown> | null = null

      if (isGroup) {
        const rawGroupMembers = await this.getGroupMembersForArkme(sessionId, myWxid, cleanedMyWxid)
        const memberBySenderId = new Map<string, Record<string, unknown>>()
        let recordOwnerSenderId: string | null = null
        membersForExport = (rawGroupMembers || []).map(member => ({ ...(member as Record<string, unknown>) }))

        for (const member of membersForExport) {
          const senderId = allocateSenderId()
          member.senderId = senderId
          if (!member.status) member.status = 'active'
          if (!member.source) member.source = 'chatroom_member'
          memberBySenderId.set(senderId, member)
          if (Boolean(member.isSelf) && !recordOwnerSenderId) {
            recordOwnerSenderId = senderId
          }
          registerIdentityKeys(senderId, buildIdentityKeys({
            senderUsername: member.username,
            senderWechatId: member.wechatId,
            senderWechatAlias: member.wechatAlias
          }))
        }

        compactMessages = allMessages.map(msg => {
          const identityKeys = buildIdentityKeys({
            senderUsername: msg.senderUsername,
            senderWechatId: msg.senderWechatId,
            senderWechatAlias: msg.senderWechatAlias
          })
          let senderId = findSenderIdByKeys(identityKeys)

          if (!senderId) {
            senderId = allocateSenderId()
            const fallbackMember: Record<string, unknown> = {
              senderId,
              username: String(msg.senderUsername || ''),
              wechatId: msg.senderWechatId || null,
              wechatAlias: msg.senderWechatAlias || null,
              displayName: String(msg.senderDisplayName || msg.senderUsername || ''),
              isFriend: false,
              isSelf: Boolean(msg.isSend),
              status: 'left_or_unknown',
              source: 'message_history_fallback',
              remark: '',
              nickname: '',
              nickName: '',
              alias: String(msg.senderWechatAlias || '')
            }
            if (msg.senderAvatar) fallbackMember.avatarUrl = String(msg.senderAvatar)
            membersForExport!.push(fallbackMember)
            memberBySenderId.set(senderId, fallbackMember)
          } else {
            const member = memberBySenderId.get(senderId)
            if (member) {
              if (!member.username && msg.senderUsername) member.username = String(msg.senderUsername)
              if (!member.wechatId && msg.senderWechatId) member.wechatId = String(msg.senderWechatId)
              if (!member.wechatAlias && msg.senderWechatAlias) member.wechatAlias = String(msg.senderWechatAlias)
              if (!member.displayName && msg.senderDisplayName) member.displayName = String(msg.senderDisplayName)
              if (!member.avatarUrl && msg.senderAvatar) member.avatarUrl = String(msg.senderAvatar)
            }
          }

          registerIdentityKeys(senderId, identityKeys)
          return toCompactMessage(msg, senderId)
        })

        if (!recordOwnerSenderId) {
          const recordOwnerFallbackId = allocateSenderId()
          const recordOwnerIdentity = this.normalizeWechatIdentity(cleanedMyWxid || myWxid || '', myInfo)
          const recordOwnerMember: Record<string, unknown> = {
            senderId: recordOwnerFallbackId,
            username: String(recordOwnerIdentity.wechatId || cleanedMyWxid || myWxid || ''),
            wechatId: recordOwnerIdentity.wechatId,
            wechatAlias: recordOwnerIdentity.wechatAlias,
            displayName: String(myInfo.displayName || '我'),
            isFriend: true,
            isSelf: true,
            status: 'left_or_unknown',
            source: 'record_owner_fallback',
            remark: String(myInfo.remark || ''),
            nickname: String(myInfo.nickName || ''),
            nickName: String(myInfo.nickName || ''),
            alias: String(recordOwnerIdentity.wechatAlias || '')
          }
          if (options.exportAvatars && myInfo.avatarUrl) {
            recordOwnerMember.avatarUrl = String(myInfo.avatarUrl)
          }
          membersForExport.push(recordOwnerMember)
          memberBySenderId.set(recordOwnerFallbackId, recordOwnerMember)
          registerIdentityKeys(recordOwnerFallbackId, buildIdentityKeys({
            senderUsername: recordOwnerMember.username,
            senderWechatId: recordOwnerMember.wechatId,
            senderWechatAlias: recordOwnerMember.wechatAlias
          }))
          recordOwnerSenderId = recordOwnerFallbackId
        }

        const recordOwnerMember = recordOwnerSenderId ? memberBySenderId.get(recordOwnerSenderId) : undefined
        const recordOwnerIdentity = this.normalizeWechatIdentity(
          String(recordOwnerMember?.username || cleanedMyWxid || myWxid || ''),
          {
            wechatId: String(recordOwnerMember?.wechatId || myInfo.wechatId || ''),
            wechatAlias: String(recordOwnerMember?.wechatAlias || myInfo.wechatAlias || '')
          }
        )
        recordOwnerInfo = {
          senderId: recordOwnerSenderId,
          senderUsername: String(recordOwnerMember?.username || recordOwnerIdentity.wechatId || cleanedMyWxid || myWxid || ''),
          wechatId: recordOwnerIdentity.wechatId,
          wechatAlias: recordOwnerIdentity.wechatAlias,
          displayName: String(recordOwnerMember?.displayName || myInfo.displayName || '我'),
          remark: String(recordOwnerMember?.remark || myInfo.remark || ''),
          nickname: String(recordOwnerMember?.nickname || myInfo.nickName || ''),
          nickName: String(recordOwnerMember?.nickName || myInfo.nickName || ''),
          ...(options.exportAvatars && (recordOwnerMember?.avatarUrl || myInfo.avatarUrl)
            ? { avatar: String(recordOwnerMember?.avatarUrl || myInfo.avatarUrl) }
            : {})
        }

        const groupOwnerUsername = this.extractChatroomOwnerUsernameForArkme(sessionId)
        if (!groupOwnerUsername) {
          groupOwnerInfo = {
            senderId: null,
            senderUsername: null,
            wechatId: null,
            wechatAlias: null,
            displayName: '未识别',
            status: 'unresolved',
            reason: 'owner_not_found'
          }
        } else {
          const groupOwnerContactInfo = await getCachedContactInfo(groupOwnerUsername)
          const groupOwnerIdentity = this.normalizeWechatIdentity(groupOwnerUsername, groupOwnerContactInfo)
          const ownerKeys = buildIdentityKeys({
            senderUsername: groupOwnerUsername,
            senderWechatId: groupOwnerIdentity.wechatId,
            senderWechatAlias: groupOwnerIdentity.wechatAlias
          })
          let groupOwnerSenderId = findSenderIdByKeys(ownerKeys)
          if (!groupOwnerSenderId) {
            groupOwnerSenderId = allocateSenderId()
            const ownerFallbackMember: Record<string, unknown> = {
              senderId: groupOwnerSenderId,
              username: groupOwnerIdentity.wechatId || groupOwnerUsername,
              wechatId: groupOwnerIdentity.wechatId,
              wechatAlias: groupOwnerIdentity.wechatAlias,
              displayName: String(groupOwnerContactInfo.displayName || groupOwnerUsername),
              isFriend: false,
              isSelf: false,
              isGroupOwner: true,
              status: 'left_or_unknown',
              source: 'group_owner_fallback',
              remark: String(groupOwnerContactInfo.remark || ''),
              nickname: String(groupOwnerContactInfo.nickName || ''),
              nickName: String(groupOwnerContactInfo.nickName || ''),
              alias: String(groupOwnerIdentity.wechatAlias || '')
            }
            if (options.exportAvatars && groupOwnerContactInfo.avatarUrl) {
              ownerFallbackMember.avatarUrl = String(groupOwnerContactInfo.avatarUrl)
            }
            membersForExport.push(ownerFallbackMember)
            memberBySenderId.set(groupOwnerSenderId, ownerFallbackMember)
          } else {
            const existingMember = memberBySenderId.get(groupOwnerSenderId)
            if (existingMember) {
              existingMember.isGroupOwner = true
            }
          }
          registerIdentityKeys(groupOwnerSenderId, ownerKeys)
          groupOwnerInfo = {
            senderId: groupOwnerSenderId,
            senderUsername: groupOwnerIdentity.wechatId || groupOwnerUsername,
            wechatId: groupOwnerIdentity.wechatId,
            wechatAlias: groupOwnerIdentity.wechatAlias,
            displayName: String(groupOwnerContactInfo.displayName || groupOwnerUsername),
            status: 'resolved',
            ...(options.exportAvatars && groupOwnerContactInfo.avatarUrl
              ? { avatar: String(groupOwnerContactInfo.avatarUrl) }
              : {})
          }
        }
      } else {
        privateSendSenderId = allocateSenderId()
        privateRecordOwnerSenderId = allocateSenderId()

        privateSendInfo = {
          senderId: privateSendSenderId,
          senderUsername: sessionWxid || sessionId,
          wechatId: sessionWxid || sessionInfo.wechatId || null,
          wechatAlias: sessionAlias || sessionInfo.wechatAlias || null,
          nickname: sessionNameFields.nickname,
          nickName: sessionNameFields.nickname,
          remark: sessionNameFields.remark,
          displayName: sessionInfo.displayName,
          ...(options.exportAvatars && sessionInfo.avatarUrl ? { avatar: sessionInfo.avatarUrl } : {})
        }
        const privateRecordOwnerIdentity = this.normalizeWechatIdentity(cleanedMyWxid || myWxid || '', myInfo)
        recordOwnerInfo = {
          senderId: privateRecordOwnerSenderId,
          senderUsername: privateRecordOwnerIdentity.wechatId || cleanedMyWxid || myWxid || '',
          wechatId: privateRecordOwnerIdentity.wechatId,
          wechatAlias: privateRecordOwnerIdentity.wechatAlias,
          remark: String(myInfo.remark || ''),
          nickname: String(myInfo.nickName || ''),
          nickName: String(myInfo.nickName || ''),
          displayName: myInfo.displayName,
          ...(options.exportAvatars && myInfo.avatarUrl ? { avatar: myInfo.avatarUrl } : {})
        }

        registerIdentityKeys(privateSendSenderId, buildIdentityKeys({
          senderUsername: sessionId,
          senderWechatId: sessionWxid || sessionInfo.wechatId || null,
          senderWechatAlias: sessionAlias || sessionInfo.wechatAlias || null
        }))
        registerIdentityKeys(privateRecordOwnerSenderId, buildIdentityKeys({
          senderUsername: cleanedMyWxid || myWxid || myInfo.wechatId || null,
          senderWechatId: myInfo.wechatId || cleanedMyWxid || myWxid || null,
          senderWechatAlias: myInfo.wechatAlias || null
        }))

        compactMessages = allMessages.map(msg => {
          const identityKeys = buildIdentityKeys({
            senderUsername: msg.senderUsername,
            senderWechatId: msg.senderWechatId,
            senderWechatAlias: msg.senderWechatAlias
          })
          let senderId = findSenderIdByKeys(identityKeys)
          if (!senderId) {
            senderId = msg.isSend ? privateRecordOwnerSenderId! : privateSendSenderId!
          }
          registerIdentityKeys(senderId, identityKeys)
          return toCompactMessage(msg, senderId)
        })
      }

      let commonGroups = !isGroup
        ? await this.getCommonGroupsForArkme(sessionId, myWxid, cleanedMyWxid)
        : undefined
      if (!isGroup && Array.isArray(commonGroups) && commonGroups.length > 0) {
        commonGroups = await this.enrichCommonGroupsMessageCounts(
          commonGroups,
          [
            cleanedMyWxid,
            myWxid,
            myInfo.wechatId,
            myInfo.wechatAlias
          ],
          [
            sessionId,
            sessionWxid,
            sessionAlias,
            sessionInfo.wechatId,
            sessionInfo.wechatAlias
          ]
        )
      }

      const arkmeExport = {
        exportInfo: {
          version: '1.0.0',
          exportedAt: Math.floor(Date.now() / 1000),
          generator: 'VXdaochu',
          format: 'arkme-json',
          schema: 'arkme.chat.export.v4'
        },
        session: {
          wechatId: sessionWxid || null,
          wechatAlias: sessionAlias,
          wxid: sessionWxid,
          nickname: sessionNameFields.nickname,
          nickName: sessionNameFields.nickname,
          remark: sessionNameFields.remark,
          displayName: sessionInfo.displayName,
          type: isGroup ? '群聊' : '私聊',
          platform: 'wechat',
          isGroup,
          ...(isGroup
            ? {
              recordOwner: recordOwnerInfo,
              groupOwner: groupOwnerInfo
            }
            : {
              send: privateSendInfo,
              recordOwner: recordOwnerInfo
            }),
          ...(hasMedia ? { mediaIndexFile: mediaMapFile, mediaMapFile } : {}),
          ...(isGroup && { groupId: sessionId }),
          ...(options.exportAvatars && sessionInfo.avatarUrl && { avatar: sessionInfo.avatarUrl }),
          firstTimestamp: firstMessageTime,
          lastTimestamp: lastMessageTime,
          messageCount: compactMessages.length
        },
        ...(isGroup ? { members: membersForExport || [] } : {}),
        ...(!isGroup ? { commonGroups: commonGroups || [] } : {}),
        messages: compactMessages
      }

      fs.writeFileSync(outputPath, JSON.stringify(arkmeExport, null, 2), 'utf-8')

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete',
        detail: '导出完成'
      })

      return { success: true }
    } catch (e) {
      console.error('ExportService: 导出 Arkme JSON 失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 导出单个会话为 Excel 格式
   */
  async exportSessionToExcel(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.dbDir) {
        return { success: false, error: '数据库未连接' }
      }

      const sessionInfo = await this.getContactInfo(sessionId)
      const cleanedMyWxid = (this.configService.get('myWxid') || '').replace(/^wxid_/, '')
      const fullMyWxid = `wxid_${cleanedMyWxid}`
      const contactInfoCache = new Map<string, ResolvedContactInfo>()
      const getCachedContactInfo = async (username: string): Promise<ResolvedContactInfo> => {
        const key = String(username || '')
        if (contactInfoCache.has(key)) return contactInfoCache.get(key)!
        const info = await this.getContactInfo(key)
        contactInfoCache.set(key, info)
        return info
      }
      contactInfoCache.set(sessionId, sessionInfo)

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing',
        detail: '正在准备导出...'
      })

      // 查找消息数据库和表
      const dbTablePairs = this.findSessionTables(sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息' }
      }

      // 收集所有消息
      const allMessages: any[] = []

      for (const { db, tableName } of dbTablePairs) {
        try {
          const hasName2Id = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='Name2Id'"
          ).get()

          let sql: string
          if (hasName2Id) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ORDER BY m.create_time ASC`
          } else {
            sql = `SELECT * FROM ${tableName} ORDER BY create_time ASC`
          }

          const rows = db.prepare(sql).all() as any[]

          for (const row of rows) {
            const createTime = row.create_time || 0

            if (options.dateRange) {
              if (createTime < options.dateRange.start || createTime > options.dateRange.end) {
                continue
              }
            }

            const content = this.decodeMessageContent(row.message_content, row.compress_content)
            const localType = row.local_type || row.type || 1
            const senderUsername = row.sender_username || ''

            // 判断是否是自己发送的消息
            const isSend = row.is_send === 1 ||
              senderUsername === cleanedMyWxid ||
              senderUsername === fullMyWxid

            // 确定实际发送者
            let actualSender: string
            if (localType === 10000 || localType === 266287972401) {
              // 系统消息特殊处理
              const revokeInfo = this.extractRevokerInfo(content)
              if (revokeInfo.isRevoke) {
                if (revokeInfo.isSelfRevoke) {
                  actualSender = cleanedMyWxid
                } else if (revokeInfo.revokerWxid) {
                  actualSender = revokeInfo.revokerWxid
                } else {
                  actualSender = sessionId
                }
              } else {
                actualSender = sessionId
              }
            } else {
              actualSender = isSend ? cleanedMyWxid : (senderUsername || sessionId)
            }
            const senderInfo = await getCachedContactInfo(actualSender)
            const senderIdentity = this.normalizeWechatIdentity(actualSender, senderInfo)
            const platformMessageId = row.server_id ? String(row.server_id) : (row.local_id ? String(row.local_id) : undefined)
            const localMessageId = row.local_id ? String(row.local_id) : undefined
            const mediaMapKey = this.buildMediaPathMapKey({
              platformMessageId,
              localMessageId,
              createTime,
              localType,
              senderUsername: actualSender,
              isSend
            })

            // 检查是否是聊天记录消息（type=19）
            const xmlType = this.extractXmlValue(content, 'type')
            let chatRecordList: any[] | undefined
            if (xmlType === '19' || localType === 49) {
              chatRecordList = this.parseChatHistory(content)
            }

            allMessages.push({
              createTime,
              talker: actualSender,
              talkerWechatId: senderIdentity.wechatId,
              talkerWechatAlias: senderIdentity.wechatAlias,
              type: localType,
              content,
              senderName: senderInfo.displayName,
              senderAvatar: options.exportAvatars ? senderInfo.avatarUrl : undefined,
              isSend,
              platformMessageId,
              localMessageId,
              mediaMapKey,
              chatRecordList
            })
          }
        } catch (e) {
          console.error(`读取消息表 ${tableName} 失败:`, e)
        }
      }

      if (allMessages.length === 0) {
        return { success: false, error: '没有消息可导出' }
      }

      // 按时间排序
      allMessages.sort((a, b) => a.createTime - b.createTime)

      onProgress?.({
        current: 50,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting',
        detail: `正在整理 ${allMessages.length} 条消息...`
      })

      // 准备 Excel 数据
      const excelData: any[] = []

      for (let index = 0; index < allMessages.length; index++) {
        const msg = allMessages[index]
        const msgType = this.getMessageTypeName(msg.type, msg.content)
        const time = new Date(msg.createTime * 1000)

        // 获取消息内容（使用统一的解析方法）
        let messageContent = this.parseMessageContent(
          msg.content,
          msg.type,
          sessionId,
          msg.createTime,
          options.mediaPathMap,
          msg.mediaMapKey
        )

        // 转账消息：追加 "谁转账给谁" 信息
        if (messageContent && messageContent.startsWith('[转账]') && msg.content) {
          const transferDesc = await this.resolveTransferDesc(
            msg.content,
            fullMyWxid,
            new Map<string, string>(),
            async (username: string) => {
              const info = await getCachedContactInfo(username)
              return info.displayName || username
            }
          )
          if (transferDesc) {
            messageContent = messageContent.replace('[转账]', `[转账] (${transferDesc})`)
          }
        }

        const row: any = {
          '序号': index + 1,
          '时间': time.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }),
          '日期': time.toLocaleDateString('zh-CN'),
          '时刻': time.toLocaleTimeString('zh-CN'),
          '星期': ['日', '一', '二', '三', '四', '五', '六'][time.getDay()],
          '发送者': msg.senderName,
          '微信ID': msg.talker,
          '微信号(wxid)': msg.talkerWechatId || '',
          '微信号(自定义)': msg.talkerWechatAlias || '',
          '消息类型': msgType,
          '消息内容': messageContent || '',
          '原始类型代码': msg.type,
          '时间戳': msg.createTime
        }

        // 只有勾选导出头像时才添加头像链接列
        if (options.exportAvatars && msg.senderAvatar) {
          row['头像链接'] = msg.senderAvatar
        }

        // 如果有聊天记录，添加聊天记录详情列
        if (msg.chatRecordList && msg.chatRecordList.length > 0) {
          const recordDetails = msg.chatRecordList.map((record: any, idx: number) => {
            const recordType = this.getChatRecordTypeName(record.datatype)
            const recordContent = this.getChatRecordContent(record)
            return `${idx + 1}. [${record.sourcename}] ${record.sourcetime} ${recordType}: ${recordContent}`
          }).join('\n')
          row['聊天记录详情'] = recordDetails
        }

        excelData.push(row)
      }

      // 创建工作簿
      const wb = XLSX.utils.book_new()
      const ws = XLSX.utils.json_to_sheet(excelData)

      // 设置列宽（根据是否导出头像和聊天记录动态调整）
      const colWidths: any[] = [
        { wch: 6 },   // 序号
        { wch: 20 },  // 时间
        { wch: 12 },  // 日期
        { wch: 10 },  // 时刻
        { wch: 6 },   // 星期
        { wch: 15 },  // 发送者
        { wch: 25 },  // 微信ID
        { wch: 25 },  // 微信号(wxid)
        { wch: 22 },  // 微信号(自定义)
        { wch: 12 },  // 消息类型
        { wch: 50 },  // 消息内容
        { wch: 8 },   // 原始类型代码
        { wch: 12 }   // 时间戳
      ]

      if (options.exportAvatars) {
        colWidths.push({ wch: 50 })  // 头像链接
      }

      // 检查是否有聊天记录消息
      const hasChatRecords = allMessages.some(msg => msg.chatRecordList && msg.chatRecordList.length > 0)
      if (hasChatRecords) {
        colWidths.push({ wch: 80 })  // 聊天记录详情
      }

      ws['!cols'] = colWidths

      // 添加工作表（工作表名称最多31个字符，且不能包含特殊字符）
      const sheetName = sessionInfo.displayName
        .substring(0, 31)
        .replace(/[:\\\/\?\*\[\]]/g, '_')
      XLSX.utils.book_append_sheet(wb, ws, sheetName)

      // 写入文件（使用 buffer 方式，避免 xlsx 直接写文件的问题）
      try {
        onProgress?.({
          current: 85,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'writing',
          detail: '正在写入 Excel 文件...'
        })
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' })
        fs.writeFileSync(outputPath, wbout)
      } catch (writeError) {
        console.error('写入文件失败:', writeError)
        return { success: false, error: `文件写入失败: ${String(writeError)}` }
      }

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete',
        detail: '导出完成'
      })

      return { success: true }
    } catch (e) {
      console.error('ExportService: Excel 导出失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 导出单个会话为 HTML 格式（数据内嵌版本）
   */
  async exportSessionToHtml(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.dbDir) {
        return { success: false, error: '数据库未连接' }
      }

      const sessionInfo = await this.getContactInfo(sessionId)
      const myWxid = this.configService.get('myWxid') || ''
      const cleanedMyWxid = this.cleanAccountDirName(myWxid)
      const isGroup = sessionId.includes('@chatroom')
      const myIdentitySource = cleanedMyWxid || myWxid
      const myInfo = await this.getContactInfo(myIdentitySource)
      const contactInfoCache = new Map<string, ResolvedContactInfo>()
      const getCachedContactInfo = async (username: string): Promise<ResolvedContactInfo> => {
        const key = String(username || '')
        if (contactInfoCache.has(key)) return contactInfoCache.get(key)!
        const info = await this.getContactInfo(key)
        contactInfoCache.set(key, info)
        return info
      }
      contactInfoCache.set(sessionId, sessionInfo)
      if (myIdentitySource) contactInfoCache.set(myIdentitySource, myInfo)

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing',
        detail: '正在准备导出...'
      })

      // 查找消息数据库和表
      const dbTablePairs = this.findSessionTables(sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息' }
      }

      // 收集所有消息
      const allMessages: any[] = []
      const memberSet = new Map<string, any>()

      for (const { db, tableName } of dbTablePairs) {
        try {
          const hasName2Id = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='Name2Id'"
          ).get()

          let sql: string
          if (hasName2Id) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ORDER BY m.create_time ASC`
          } else {
            sql = `SELECT * FROM ${tableName} ORDER BY create_time ASC`
          }

          const rows = db.prepare(sql).all() as any[]

          for (const row of rows) {
            const createTime = row.create_time || 0

            if (options.dateRange) {
              if (createTime < options.dateRange.start || createTime > options.dateRange.end) {
                continue
              }
            }

            const content = this.decodeMessageContent(row.message_content, row.compress_content)
            const localType = row.local_type || row.type || 1
            const senderUsername = row.sender_username || ''
            const isSend = row.is_send === 1 || senderUsername === cleanedMyWxid

            // 确定实际发送者
            let actualSender: string
            if (localType === 10000 || localType === 266287972401) {
              // 系统消息特殊处理
              const revokeInfo = this.extractRevokerInfo(content)
              if (revokeInfo.isRevoke) {
                if (revokeInfo.isSelfRevoke) {
                  actualSender = cleanedMyWxid
                } else if (revokeInfo.revokerWxid) {
                  actualSender = revokeInfo.revokerWxid
                } else {
                  actualSender = sessionId
                }
              } else {
                actualSender = sessionId
              }
            } else {
              actualSender = isSend ? cleanedMyWxid : (senderUsername || sessionId)
            }
            const senderInfo = await getCachedContactInfo(actualSender)
            const senderIdentity = this.normalizeWechatIdentity(actualSender, senderInfo)
            const platformMessageId = row.server_id ? String(row.server_id) : (row.local_id ? String(row.local_id) : undefined)
            const localMessageId = row.local_id ? String(row.local_id) : undefined
            const mediaMapKey = this.buildMediaPathMapKey({
              platformMessageId,
              localMessageId,
              createTime,
              localType,
              senderUsername: actualSender,
              isSend
            })

            // 检查是否是聊天记录消息
            const xmlType = this.extractXmlValue(content, 'type')
            let chatRecordList: any[] | undefined
            if (xmlType === '19' || localType === 49) {
              chatRecordList = this.parseChatHistory(content)
            }

            allMessages.push({
              timestamp: createTime,
              sender: actualSender,
              senderWechatId: senderIdentity.wechatId,
              senderWechatAlias: senderIdentity.wechatAlias,
              senderName: senderInfo.displayName,
              type: localType,
              content: this.parseMessageContent(content, localType, sessionId, createTime, options.mediaPathMap, mediaMapKey),
              rawContent: content,
              isSend,
              platformMessageId,
              localMessageId,
              mediaMapKey,
              chatRecords: chatRecordList ? this.formatChatRecordsForJson(chatRecordList, options) : undefined
            })

            // 收集成员信息
            if (!memberSet.has(actualSender)) {
              memberSet.set(actualSender, {
                id: actualSender,
                wechatId: senderIdentity.wechatId,
                wechatAlias: senderIdentity.wechatAlias,
                name: senderInfo.displayName,
                avatar: options.exportAvatars ? senderInfo.avatarUrl : undefined
              })
            }

            // 收集聊天记录中的成员
            if (chatRecordList) {
              for (const record of chatRecordList) {
                if (record.sourcename && !memberSet.has(record.sourcename)) {
                  const recordIdentity = this.normalizeWechatIdentity(record.sourcename)
                  memberSet.set(record.sourcename, {
                    id: record.sourcename,
                    wechatId: recordIdentity.wechatId,
                    wechatAlias: recordIdentity.wechatAlias,
                    name: record.sourcename,
                    avatar: options.exportAvatars ? record.sourceheadurl : undefined
                  })
                }
              }
            }
          }
        } catch (e) {
          console.error(`读取消息表 ${tableName} 失败:`, e)
        }
      }

      if (allMessages.length === 0) {
        return { success: false, error: '没有消息可导出' }
      }

      // 按时间排序
      allMessages.sort((a, b) => a.timestamp - b.timestamp)

      onProgress?.({
        current: 55,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting',
        detail: `正在整理 ${allMessages.length} 条消息...`
      })

      // 准备导出数据
      const exportData = {
        meta: {
          sessionId,
          sessionWechatId: sessionInfo.wechatId || sessionId,
          sessionWechatAlias: sessionInfo.wechatAlias || null,
          sessionName: sessionInfo.displayName,
          isGroup,
          ownerWechatId: myInfo.wechatId || cleanedMyWxid || null,
          ownerWechatAlias: myInfo.wechatAlias || null,
          exportTime: Date.now(),
          messageCount: allMessages.length,
          dateRange: options.dateRange ? {
            start: options.dateRange.start,
            end: options.dateRange.end
          } : null
        },
        members: Array.from(memberSet.values()),
        messages: allMessages
      }

      // 直接写入单文件 HTML（CSS/JS/数据全部内联）
      const outputDir = path.dirname(outputPath)
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
      }

      onProgress?.({
        current: 85,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing',
        detail: '正在写入 HTML 文件...'
      })
      fs.writeFileSync(outputPath, HtmlExportGenerator.generateHtmlWithData(exportData), 'utf-8')

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete',
        detail: '导出完成'
      })

      return { success: true }
    } catch (e) {
      console.error('ExportService: HTML 导出失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取聊天记录消息的类型名称
   */
  private getChatRecordTypeName(datatype: number): string {
    const typeNames: Record<number, string> = {
      1: '文本',
      3: '图片',
      8: '文件',
      34: '语音',
      43: '视频',
      47: '表情',
      49: '文件'
    }
    return typeNames[datatype] || '其他'
  }

  /**
   * 获取聊天记录消息的内容
   */
  private getChatRecordContent(record: any): string {
    switch (record.datatype) {
      case 1:
        return record.datadesc || record.datatitle || ''
      case 3:
        return '[图片]'
      case 8:
      case 49:
        return record.datatitle ? `[文件] ${record.datatitle}` : '[文件]'
      case 34:
        return '[语音消息]'
      case 43:
        return '[视频]'
      case 47:
        return '[动画表情]'
      default:
        return record.datadesc || record.datatitle || '[消息]'
    }
  }

  /**
   * 批量导出多个会话
   */
  async exportSessions(
    sessionIds: string[],
    outputDir: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{
    success: boolean
    successCount: number
    failCount: number
    sessionOutputs?: ExportSessionOutputTarget[]
    error?: string
  }> {
    let successCount = 0
    let failCount = 0
    const sessionOutputs: ExportSessionOutputTarget[] = []
    const globalArkmeMediaIndexMap = new Map<string, ArkmeMediaIndexEntry>()
    const hasAnyMediaExport = Boolean(options.exportImages || options.exportVideos || options.exportEmojis || options.exportVoices)
    const exportRootDir = this.resolveExportRootDir(outputDir)
    const globalMapPath = path.join(exportRootDir, 'arkme-media-map.json')
    const globalMediaDedupState = createMediaDedupState()
    const sessionWithExistingMedia = new Set<string>()

    try {
      if (!this.dbDir) {
        const connectResult = await this.connect()
        if (!connectResult.success) {
          return { success: false, successCount: 0, failCount: sessionIds.length, error: connectResult.error }
        }
      }

      // 确保输出目录存在
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
      }
      if (!fs.existsSync(exportRootDir)) {
        fs.mkdirSync(exportRootDir, { recursive: true })
      }

      if (hasAnyMediaExport && fs.existsSync(globalMapPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(globalMapPath, 'utf-8')) as { items?: Array<Record<string, unknown>> }
          for (const item of parsed.items || []) {
            const kind = String(item?.kind || '') as ArkmeMediaKind
            if (!['image', 'video', 'emoji', 'voice'].includes(kind)) continue
            const mediaKey = String(item?.mediaKey || '').trim()
            const sessionId = String(item?.sessionId || '').trim()
            if (!mediaKey || !sessionId) continue

            const relativePathRaw = item?.relativePath
            const relativePath = typeof relativePathRaw === 'string' && relativePathRaw.trim()
              ? relativePathRaw.trim()
              : null
            const sourceRaw = item?.source
            const source = sourceRaw && typeof sourceRaw === 'object' && !Array.isArray(sourceRaw)
              ? sourceRaw as Record<string, unknown>
              : undefined
            const sourceMd5 = this.normalizeMd5(String(item?.sourceMd5 || '')) ||
              this.extractArkmeSourceMd5(source) ||
              null
            const fileMd5 = this.normalizeMd5(String(item?.fileMd5 || '')) || null
            const createTimeRaw = Number(item?.createTime)
            const createTime = Number.isFinite(createTimeRaw) && createTimeRaw > 0 ? createTimeRaw : 0
            const platformMessageIdRaw = String(item?.platformMessageId || '').trim()
            const localMessageIdRaw = String(item?.localMessageId || '').trim()
            const exported = Boolean(item?.exported && relativePath)

            this.upsertArkmeMediaIndexEntry(globalArkmeMediaIndexMap, {
              mediaKey,
              kind,
              exported,
              relativePath,
              fileName: relativePath ? path.basename(relativePath) : null,
              sourceMd5,
              fileMd5,
              createTime,
              sessionId,
              ...(platformMessageIdRaw ? { platformMessageId: platformMessageIdRaw } : {}),
              ...(localMessageIdRaw ? { localMessageId: localMessageIdRaw } : {}),
              ...(source ? { source } : {})
            })

            if (exported) {
              sessionWithExistingMedia.add(sessionId)
            }
          }
        } catch {
          // 忽略历史索引解析失败，继续按目录判断
        }
      }

      for (let i = 0; i < sessionIds.length; i++) {
        const sessionId = sessionIds[i]
        const sessionInfo = await this.getContactInfo(sessionId)
        const sessionCurrent = i + 1
        const sessionTotal = sessionIds.length
        const emitProgress = (progress: ExportProgress) => {
          onProgress?.({
            ...progress,
            sessionCurrent,
            sessionTotal,
            // 对任务中心保留“当前阶段进度”口径，避免单会话时 1/1 误导
            stepCurrent: progress.stepCurrent ?? progress.current,
            stepTotal: progress.stepTotal ?? progress.total,
            stepUnit: progress.stepUnit ?? (progress.total === 100 ? '%' : undefined),
            currentSession: progress.currentSession || sessionInfo.displayName
          })
        }

        // 生成文件名（清理非法字符）
        const safeName = sessionInfo.displayName.replace(/[<>:"\/\\|?*]/g, '_')
        const filePrefix = this.getChatTextFilePrefix(sessionId)
        const safeFileName = `${filePrefix}${safeName}`
        let ext = '.json'
        if (options.format === 'chatlab-jsonl') ext = '.jsonl'
        else if (options.format === 'excel') ext = '.xlsx'
        else if (options.format === 'html') ext = '.html'

        // 当导出媒体时，创建会话子文件夹，把文件和媒体都放进去
        const emojiOnlyMode = Boolean(
          options.emojiOnlyMode &&
          options.exportEmojis &&
          !options.exportImages &&
          !options.exportVideos &&
          !options.exportVoices
        )
        const voiceOnlyMode = Boolean(
          options.voiceOnlyMode &&
          options.exportVoices &&
          !options.exportImages &&
          !options.exportVideos &&
          !options.exportEmojis
        )
        const imageOnlyMode = Boolean(
          options.imageOnlyMode &&
          options.exportImages &&
          !options.exportVideos &&
          !options.exportEmojis &&
          !options.exportVoices
        )
        const videoOnlyMode = Boolean(
          options.videoOnlyMode &&
          options.exportVideos &&
          !options.exportImages &&
          !options.exportEmojis &&
          !options.exportVoices
        )
        const mediaOnlyMode = imageOnlyMode || videoOnlyMode || emojiOnlyMode || voiceOnlyMode
        const shouldExportChatText = options.exportChatText !== false
        const hasMedia = Boolean(options.exportImages || options.exportVideos || options.exportEmojis || options.exportVoices)
        const chatTextDisabledMediaOnlyMode = !shouldExportChatText && hasMedia
        const effectiveMediaOnlyMode = mediaOnlyMode || chatTextDisabledMediaOnlyMode
        const selectedMediaSubdirs: string[] = []
        if (options.exportImages) selectedMediaSubdirs.push('images')
        if (options.exportVideos) selectedMediaSubdirs.push('videos')
        if (options.exportEmojis) selectedMediaSubdirs.push('emojis')
        if (options.exportVoices) selectedMediaSubdirs.push('voices')
        const mediaOnlyOutputDir = selectedMediaSubdirs.length === 1
          ? path.join(exportRootDir, selectedMediaSubdirs[0])
          : exportRootDir
        const sessionOutputDir = hasMedia && !effectiveMediaOnlyMode ? path.join(outputDir, safeName) : outputDir
        if (hasMedia && !effectiveMediaOnlyMode && !fs.existsSync(sessionOutputDir)) {
          fs.mkdirSync(sessionOutputDir, { recursive: true })
        }
        if (effectiveMediaOnlyMode && !fs.existsSync(mediaOnlyOutputDir)) {
          fs.mkdirSync(mediaOnlyOutputDir, { recursive: true })
        }

        const outputPath = path.join(sessionOutputDir, `${safeFileName}${ext}`)

        const canTrySkipTextUnchanged = Boolean(
          shouldExportChatText &&
          options.skipIfUnchanged &&
          !effectiveMediaOnlyMode &&
          !hasMedia &&
          Number.isFinite(options.currentMessageCountHint) &&
          Number.isFinite(options.latestMessageTimestampHint) &&
          Number(options.currentMessageCountHint) >= 0 &&
          Number(options.latestMessageTimestampHint) > 0
        )
        if (canTrySkipTextUnchanged) {
          const latestRecord = exportRecordService.getLatestRecord(sessionId, options.format)
          const currentMessageCount = Number(options.currentMessageCountHint ?? -1)
          const latestMessageTimestampMs = Math.floor(Number(options.latestMessageTimestampHint || 0) * 1000)
          const exportFileExists = fs.existsSync(outputPath)
          const hasNoDataChange = Boolean(
            latestRecord &&
            latestRecord.messageCount === currentMessageCount &&
            latestRecord.exportTime >= latestMessageTimestampMs
          )

          if (hasNoDataChange && exportFileExists) {
            emitProgress({
              current: 100,
              total: 100,
              currentSession: sessionInfo.displayName,
              phase: 'complete',
              detail: '已导出（无变化，已跳过）'
            })
            successCount++
            sessionOutputs.push({
              sessionId,
              outputPath,
              openTargetPath: outputPath,
              openTargetType: 'file',
              skipped: true,
              skipReason: 'unchanged-existing-file'
            })
            await new Promise(resolve => setImmediate(resolve))
            continue
          }
        }

        const canTrySkipEmojiUnchanged = Boolean(
          options.skipIfUnchanged &&
          emojiOnlyMode &&
          Number.isFinite(options.currentEmojiCountHint) &&
          Number.isFinite(options.latestMessageTimestampHint) &&
          Number(options.currentEmojiCountHint) >= 0 &&
          Number(options.latestMessageTimestampHint) > 0
        )
        if (canTrySkipEmojiUnchanged) {
          const latestEmojiRecord = exportRecordService.getLatestRecord(sessionId, 'emoji-assets')
          const currentEmojiCount = Number(options.currentEmojiCountHint ?? -1)
          const currentLatestMessageTimestamp = Number(options.latestMessageTimestampHint || 0)
          const sessionFolderHasFiles = this.dirHasAnyFile(sessionOutputDir) || sessionWithExistingMedia.has(sessionId)
          const hasNoEmojiDataChange = Boolean(
            latestEmojiRecord &&
            latestEmojiRecord.emojiItemCount === currentEmojiCount &&
            Number(latestEmojiRecord.sourceLatestMessageTimestamp || 0) >= currentLatestMessageTimestamp
          )

          if (hasNoEmojiDataChange && sessionFolderHasFiles) {
            emitProgress({
              current: 100,
              total: 100,
              currentSession: sessionInfo.displayName,
              phase: 'complete',
              detail: '已导出（无新增，已跳过）'
            })
            successCount++
            sessionOutputs.push({
              sessionId,
              outputPath: mediaOnlyOutputDir,
              openTargetPath: mediaOnlyOutputDir,
              openTargetType: 'directory',
              skipped: true,
              skipReason: 'emoji-unchanged-existing-folder'
            })
            await new Promise(resolve => setImmediate(resolve))
            continue
          }
        }

        const canTrySkipImageUnchanged = Boolean(
          options.skipIfUnchanged &&
          imageOnlyMode &&
          Number.isFinite(options.currentImageCountHint) &&
          Number.isFinite(options.latestMessageTimestampHint) &&
          Number(options.currentImageCountHint) >= 0 &&
          Number(options.latestMessageTimestampHint) > 0
        )
        if (canTrySkipImageUnchanged) {
          const latestImageRecord = exportRecordService.getLatestRecord(sessionId, 'image-assets')
          const currentImageCount = Number(options.currentImageCountHint ?? -1)
          const currentLatestMessageTimestamp = Number(options.latestMessageTimestampHint || 0)
          const sessionFolderHasFiles = this.dirHasAnyFile(sessionOutputDir) || sessionWithExistingMedia.has(sessionId)
          const hasNoImageDataChange = Boolean(
            latestImageRecord &&
            latestImageRecord.messageCount === currentImageCount &&
            Number(latestImageRecord.sourceLatestMessageTimestamp || 0) >= currentLatestMessageTimestamp
          )

          if (hasNoImageDataChange && sessionFolderHasFiles) {
            emitProgress({
              current: 100,
              total: 100,
              currentSession: sessionInfo.displayName,
              phase: 'complete',
              detail: '已导出（无新增，已跳过）'
            })
            successCount++
            sessionOutputs.push({
              sessionId,
              outputPath: mediaOnlyOutputDir,
              openTargetPath: mediaOnlyOutputDir,
              openTargetType: 'directory',
              skipped: true,
              skipReason: 'image-unchanged-existing-folder'
            })
            await new Promise(resolve => setImmediate(resolve))
            continue
          }
        }

        const canTrySkipVideoUnchanged = Boolean(
          options.skipIfUnchanged &&
          videoOnlyMode &&
          Number.isFinite(options.currentVideoCountHint) &&
          Number.isFinite(options.latestMessageTimestampHint) &&
          Number(options.currentVideoCountHint) >= 0 &&
          Number(options.latestMessageTimestampHint) > 0
        )
        if (canTrySkipVideoUnchanged) {
          const latestVideoRecord = exportRecordService.getLatestRecord(sessionId, 'video-assets')
          const currentVideoCount = Number(options.currentVideoCountHint ?? -1)
          const currentLatestMessageTimestamp = Number(options.latestMessageTimestampHint || 0)
          const sessionFolderHasFiles = this.dirHasAnyFile(sessionOutputDir) || sessionWithExistingMedia.has(sessionId)
          const hasNoVideoDataChange = Boolean(
            latestVideoRecord &&
            latestVideoRecord.messageCount === currentVideoCount &&
            Number(latestVideoRecord.sourceLatestMessageTimestamp || 0) >= currentLatestMessageTimestamp
          )

          if (hasNoVideoDataChange && sessionFolderHasFiles) {
            emitProgress({
              current: 100,
              total: 100,
              currentSession: sessionInfo.displayName,
              phase: 'complete',
              detail: '已导出（无新增，已跳过）'
            })
            successCount++
            sessionOutputs.push({
              sessionId,
              outputPath: mediaOnlyOutputDir,
              openTargetPath: mediaOnlyOutputDir,
              openTargetType: 'directory',
              skipped: true,
              skipReason: 'video-unchanged-existing-folder'
            })
            await new Promise(resolve => setImmediate(resolve))
            continue
          }
        }

        if (
          imageOnlyMode &&
          Number.isFinite(options.currentImageCountHint) &&
          Number(options.currentImageCountHint) === 0
        ) {
          emitProgress({
            current: 100,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'complete',
            detail: '无图片，已跳过'
          })
          successCount++
          sessionOutputs.push({
            sessionId,
            outputPath: mediaOnlyOutputDir,
            openTargetPath: mediaOnlyOutputDir,
            openTargetType: 'directory',
            skipped: true,
            skipReason: 'image-empty-session'
          })
          await new Promise(resolve => setImmediate(resolve))
          continue
        }

        if (
          videoOnlyMode &&
          Number.isFinite(options.currentVideoCountHint) &&
          Number(options.currentVideoCountHint) === 0
        ) {
          emitProgress({
            current: 100,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'complete',
            detail: '无视频，已跳过'
          })
          successCount++
          sessionOutputs.push({
            sessionId,
            outputPath: mediaOnlyOutputDir,
            openTargetPath: mediaOnlyOutputDir,
            openTargetType: 'directory',
            skipped: true,
            skipReason: 'video-empty-session'
          })
          await new Promise(resolve => setImmediate(resolve))
          continue
        }

        if (
          voiceOnlyMode &&
          Number.isFinite(options.currentVoiceCountHint) &&
          Number(options.currentVoiceCountHint) === 0
        ) {
          emitProgress({
            current: 100,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'complete',
            detail: '无语音，已跳过'
          })
          successCount++
          sessionOutputs.push({
            sessionId,
            outputPath: mediaOnlyOutputDir,
            openTargetPath: mediaOnlyOutputDir,
            openTargetType: 'directory',
            skipped: true,
            skipReason: 'voice-empty-session'
          })
          await new Promise(resolve => setImmediate(resolve))
          continue
        }

        emitProgress({
          current: 5,
          total: 100,
          currentSession: sessionInfo.displayName,
          phase: 'exporting',
          detail: '正在读取消息...'
        })

        // 先导出媒体文件，收集路径映射表
        let mediaPathMap: Map<string, string> | undefined
        let arkmeMediaIndexMap: Map<string, ArkmeMediaIndexEntry> | undefined
        let sessionHasExportedMedia = false
        if (hasMedia) {
          try {
            const mediaExportResult = await this.exportMediaFiles(
              sessionId,
              exportRootDir,
              effectiveMediaOnlyMode ? exportRootDir : sessionOutputDir,
              options,
              (mediaProgress) => {
              emitProgress({
                current: mediaProgress.current ?? 0,
                total: mediaProgress.total ?? 0,
                currentSession: sessionInfo.displayName,
                phase: 'writing',
                detail: mediaProgress.detail,
                stepCurrent: mediaProgress.current,
                stepTotal: mediaProgress.total,
                stepUnit: mediaProgress.unit
              })
              },
              globalMediaDedupState
            )
            mediaPathMap = mediaExportResult.mediaPathMap
            arkmeMediaIndexMap = mediaExportResult.arkmeMediaIndexMap
            if (arkmeMediaIndexMap.size > 0) {
              sessionHasExportedMedia = Array.from(arkmeMediaIndexMap.values()).some(item => Boolean(item.exported && item.relativePath))
              for (const item of arkmeMediaIndexMap.values()) {
                this.upsertArkmeMediaIndexEntry(globalArkmeMediaIndexMap, item)
              }
              if (sessionHasExportedMedia) {
                sessionWithExistingMedia.add(sessionId)
              }
            }
          } catch (e) {
            console.error(`导出 ${sessionId} 媒体文件失败:`, e)
          }
        }

        // 将媒体路径映射表附加到 options 上
        const exportOpts = {
          ...options,
          ...(mediaPathMap ? { mediaPathMap } : {}),
          ...(arkmeMediaIndexMap ? { arkmeMediaIndexMap } : {}),
          ...(hasMedia && shouldExportChatText
            ? {
              arkmeMediaMapFilePath: path
                .relative(path.dirname(outputPath), globalMapPath)
                .replace(/\\/g, '/')
            }
            : {})
        }

        let result: { success: boolean; error?: string }
        const mediaOnlyEmptyDetail = imageOnlyMode
          ? '无图片，已跳过'
          : (videoOnlyMode
              ? '无视频，已跳过'
              : (emojiOnlyMode
                  ? '无表情包，已跳过'
                  : (voiceOnlyMode ? '无语音，已跳过' : '无可导出的媒体，已跳过')))
        const mediaOnlyDoneDetail = imageOnlyMode
          ? '图片导出完成'
          : (videoOnlyMode
              ? '视频导出完成'
              : (emojiOnlyMode
                  ? '表情包导出完成'
                  : (voiceOnlyMode ? '语音导出完成' : '媒体导出完成')))
        const mediaOnlySkipReason = imageOnlyMode
          ? 'image-empty-session'
          : (videoOnlyMode
              ? 'video-empty-session'
              : (emojiOnlyMode ? 'emoji-empty-session' : (voiceOnlyMode ? 'voice-empty-session' : 'media-empty-session')))
        if (effectiveMediaOnlyMode) {
          if (!sessionHasExportedMedia) {
            try {
              if (fs.existsSync(sessionOutputDir)) {
                const entries = fs.readdirSync(sessionOutputDir)
                if (entries.length === 0) {
                  fs.rmdirSync(sessionOutputDir)
                }
              }
            } catch {
              // 忽略清理空目录失败，不影响导出结果
            }
            emitProgress({
              current: 100,
              total: 100,
              currentSession: sessionInfo.displayName,
              phase: 'complete',
              detail: mediaOnlyEmptyDetail
            })
            successCount++
            sessionOutputs.push({
              sessionId,
              outputPath: mediaOnlyOutputDir,
              openTargetPath: mediaOnlyOutputDir,
              openTargetType: 'directory',
              skipped: true,
              skipReason: mediaOnlySkipReason
            })
            await new Promise(resolve => setImmediate(resolve))
            continue
          }
          emitProgress({
            current: 100,
            total: 100,
            currentSession: sessionInfo.displayName,
            phase: 'complete',
            detail: mediaOnlyDoneDetail
          })
          result = { success: true }
        } else if (!shouldExportChatText) {
          result = { success: false, error: '未选择聊天文本导出且未选择媒体导出' }
        } else if (options.format === 'json') {
          // 根据格式选择导出方法
          result = await this.exportSessionToDetailedJson(sessionId, outputPath, exportOpts, emitProgress)
        } else if (options.format === 'arkme-json') {
          result = await this.exportSessionToArkmeJson(sessionId, outputPath, exportOpts, emitProgress)
        } else if (options.format === 'chatlab' || options.format === 'chatlab-jsonl') {
          result = await this.exportSessionToChatLab(sessionId, outputPath, exportOpts, emitProgress)
        } else if (options.format === 'excel') {
          result = await this.exportSessionToExcel(sessionId, outputPath, exportOpts, emitProgress)
        } else if (options.format === 'html') {
          result = await this.exportSessionToHtml(sessionId, outputPath, exportOpts, emitProgress)
        } else {
          result = { success: false, error: `不支持的格式: ${options.format}` }
        }

        if (result.success) {
          successCount++
          sessionOutputs.push({
            sessionId,
            outputPath: effectiveMediaOnlyMode ? mediaOnlyOutputDir : outputPath,
            openTargetPath: hasMedia ? (effectiveMediaOnlyMode ? mediaOnlyOutputDir : sessionOutputDir) : outputPath,
            openTargetType: hasMedia ? 'directory' : 'file'
          })
        } else {
          failCount++
          console.error(`导出 ${sessionId} 失败:`, result.error)
        }

        // 让出事件循环，避免阻塞主进程
        await new Promise(resolve => setImmediate(resolve))
      }

      if (hasAnyMediaExport) {
        const shouldWriteMainMap = globalArkmeMediaIndexMap.size > 0 || !fs.existsSync(globalMapPath)
        if (shouldWriteMainMap) {
          this.writeArkmeMediaMapFile(exportRootDir, globalArkmeMediaIndexMap)
        }
        const shouldWriteSnapshot = options.mediaExportBatchId
          ? Boolean(options.mediaExportBatchIsFinal)
          : true
        if (shouldWriteSnapshot) {
          this.writeArkmeMediaMapFile(
            exportRootDir,
            globalArkmeMediaIndexMap,
            this.buildMediaMapSnapshotFileName()
          )
        }
      }

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: '',
        phase: 'complete',
        detail: '导出完成',
        sessionCurrent: sessionIds.length,
        sessionTotal: sessionIds.length,
        stepCurrent: 100,
        stepTotal: 100,
        stepUnit: '%'
      })

      return { success: true, successCount, failCount, sessionOutputs }
    } catch (e) {
      return { success: false, successCount, failCount, sessionOutputs, error: String(e) }
    }
  }

  /**
   * 导出会话媒体文件并生成 Arkme 媒体索引
   */
  private async exportMediaFiles(
    sessionId: string,
    mediaRootDir: string,
    mediaPathBaseDir: string,
    options: ExportOptions,
    onDetail?: (progress: ExportMediaProgress) => void,
    globalMediaDedupState?: MediaDedupState
  ): Promise<{ mediaPathMap: Map<string, string>; arkmeMediaIndexMap: Map<string, ArkmeMediaIndexEntry> }> {
    // 返回 消息实例键 -> 相对路径 的映射表（兼容历史 createTime 键）
    const mediaPathMap = new Map<string, string>()
    const arkmeMediaIndexMap = new Map<string, ArkmeMediaIndexEntry>()

    const dbTablePairs = this.findSessionTables(sessionId)
    if (dbTablePairs.length === 0) {
      return { mediaPathMap, arkmeMediaIndexMap }
    }

    // 媒体统一写入导出根目录下固定子目录（images/videos/emojis/voices）
    const imageOutDir = options.exportImages ? path.join(mediaRootDir, 'images') : ''
    const videoOutDir = options.exportVideos ? path.join(mediaRootDir, 'videos') : ''
    const emojiOutDir = options.exportEmojis ? path.join(mediaRootDir, 'emojis') : ''
    const voiceOutDir = options.exportVoices ? path.join(mediaRootDir, 'voices') : ''

    if (!fs.existsSync(mediaRootDir)) {
      fs.mkdirSync(mediaRootDir, { recursive: true })
    }
    if (options.exportImages && !fs.existsSync(imageOutDir)) {
      fs.mkdirSync(imageOutDir, { recursive: true })
    }
    if (options.exportVideos && !fs.existsSync(videoOutDir)) {
      fs.mkdirSync(videoOutDir, { recursive: true })
    }
    if (options.exportEmojis && !fs.existsSync(emojiOutDir)) {
      fs.mkdirSync(emojiOutDir, { recursive: true })
    }
    if (options.exportVoices && !fs.existsSync(voiceOutDir)) {
      fs.mkdirSync(voiceOutDir, { recursive: true })
    }

    let imageCount = 0
    let videoCount = 0
    let emojiCount = 0
    let imageTotal = 0
    let videoTotal = 0
    let emojiTotal = 0
    let imageProcessed = 0
    let videoProcessed = 0
    let emojiProcessed = 0
    let imageFailCount = 0
    let videoFailCount = 0
    let emojiFailCount = 0
    let voiceFailCount = 0
    const imageFailReasons: Record<string, number> = {
      no_identifier: 0,
      decrypt_failed: 0,
      source_missing: 0,
      copy_failed: 0,
      unknown: 0
    }
    const videoFailReasons: Record<string, number> = {
      no_md5: 0,
      source_missing: 0,
      copy_failed: 0,
      unknown: 0
    }
    const emojiFailReasons: Record<string, number> = {
      no_identifier: 0,
      local_cache_miss: 0,
      cdn_download_failed: 0,
      encrypt_download_failed: 0,
      source_missing: 0,
      copy_failed: 0,
      unknown: 0
    }
    const voiceFailReasons: Record<string, number> = {
      media_db_missing: 0,
      decoder_missing: 0,
      source_missing: 0,
      decode_timeout: 0,
      decode_error: 0,
      write_failed: 0,
      unknown: 0
    }
    const shouldDedupeVideoFiles = options.dedupeVideoFiles !== false || Boolean(globalMediaDedupState)
    const sessionMediaDedupState = createMediaDedupState()
    const effectiveGlobalMediaDedupState = globalMediaDedupState || createMediaDedupState()
    const exportedFileMd5ByRelativePath = new Map<string, string | null>()
    const emojiSourceResolutionCache = new Map<string, { sourceFile: string | null; failReason?: keyof typeof emojiFailReasons }>()
    const toSessionRelativePath = (absolutePath: string): string => path.relative(mediaPathBaseDir, absolutePath).replace(/\\/g, '/')
    const dedupeKeyToFileStem = (key: string, fallback: string): string => {
      const candidate = key.includes(':') ? key.split(':').slice(1).join(':') : key
      const cleaned = candidate.replace(/[^a-zA-Z0-9._-]/g, '_')
      return cleaned || fallback
    }
    const findDedupAbsPath = (kind: ArkmeMediaKind, dedupKeys: string[]): string | null => {
      for (const key of dedupKeys) {
        const hit = sessionMediaDedupState[kind].get(key)
        if (hit && fs.existsSync(hit)) return hit
      }
      for (const key of dedupKeys) {
        const hit = effectiveGlobalMediaDedupState[kind].get(key)
        if (hit && fs.existsSync(hit)) return hit
      }
      return null
    }
    const registerDedupAbsPath = (kind: ArkmeMediaKind, dedupKeys: string[], absolutePath: string): void => {
      for (const key of dedupKeys) {
        if (!key) continue
        sessionMediaDedupState[kind].set(key, absolutePath)
        effectiveGlobalMediaDedupState[kind].set(key, absolutePath)
      }
    }
    const resolveExportedFileMd5 = async (absolutePath: string, relativePath: string): Promise<string | null> => {
      if (!absolutePath || !relativePath) return null
      if (exportedFileMd5ByRelativePath.has(relativePath)) {
        return exportedFileMd5ByRelativePath.get(relativePath) || null
      }
      const md5 = await this.computeFileMd5(absolutePath)
      const normalizedMd5 = this.normalizeMd5(md5) || null
      exportedFileMd5ByRelativePath.set(relativePath, normalizedMd5)
      return normalizedMd5
    }
    const shouldReportStep = (processed: number, total: number) => (
      processed <= 3 || processed === total || processed % 10 === 0
    )
    let lastMediaProgress: ExportMediaProgress | null = null
    let lastMediaProgressAt = 0
    const emitMediaProgress = (detail: string, current?: number, total?: number, unit?: string) => {
      const payload = { detail, current, total, unit }
      lastMediaProgress = payload
      lastMediaProgressAt = Date.now()
      onDetail?.(payload)
    }
    const heartbeatTimer = onDetail ? setInterval(() => {
      if (!lastMediaProgress || !lastMediaProgressAt) return
      const elapsedMs = Date.now() - lastMediaProgressAt
      if (elapsedMs < 4000) return
      const elapsedSec = Math.floor(elapsedMs / 1000)
      onDetail?.({
        ...lastMediaProgress,
        detail: `${lastMediaProgress.detail} · 处理中 ${elapsedSec}s`
      })
    }, 2000) : null
    if (heartbeatTimer && typeof (heartbeatTimer as any).unref === 'function') {
      ; (heartbeatTimer as any).unref()
    }
    try {
    const bumpReason = (stats: Record<string, number>, key: string) => {
      if (Object.prototype.hasOwnProperty.call(stats, key)) {
        stats[key] += 1
      } else {
        stats.unknown = (stats.unknown || 0) + 1
      }
    }
    const summarizeReasons = (stats: Record<string, number>, labels: Record<string, string>) => {
      return Object.entries(stats)
        .filter(([, count]) => count > 0)
        .map(([key, count]) => `${labels[key] || key} ${count}`)
        .join('、')
    }
    const resolveEmojiSource = async (
      cacheKey: string,
      cdnUrl: string,
      encryptUrl: string,
      aesKey: string
    ): Promise<{ sourceFile: string | null; failReason?: keyof typeof emojiFailReasons }> => {
      const cached = emojiSourceResolutionCache.get(cacheKey)
      if (cached) return cached

      let sourceFile = this.findLocalEmoji(cacheKey)
      if (sourceFile) {
        const result = { sourceFile }
        emojiSourceResolutionCache.set(cacheKey, result)
        return result
      }

      if (!cdnUrl && !(encryptUrl && aesKey)) {
        const result = { sourceFile: null, failReason: 'no_identifier' as const }
        emojiSourceResolutionCache.set(cacheKey, result)
        return result
      }

      let hadCdnAttempt = false
      let hadEncryptAttempt = false
      let hadLocalCacheMiss = true

      if (cdnUrl) {
        hadCdnAttempt = true
        sourceFile = await this.downloadEmojiFile(cdnUrl, cacheKey)
        if (sourceFile && fs.existsSync(sourceFile)) {
          const result = { sourceFile }
          emojiSourceResolutionCache.set(cacheKey, result)
          return result
        }
      }

      if (encryptUrl && aesKey) {
        hadEncryptAttempt = true
        sourceFile = await this.downloadAndDecryptEmoji(encryptUrl, aesKey, cacheKey)
        if (sourceFile && fs.existsSync(sourceFile)) {
          const result = { sourceFile }
          emojiSourceResolutionCache.set(cacheKey, result)
          return result
        }
      }

      const failReason: keyof typeof emojiFailReasons =
        hadEncryptAttempt ? 'encrypt_download_failed'
          : hadCdnAttempt ? 'cdn_download_failed'
            : hadLocalCacheMiss ? 'local_cache_miss'
              : 'source_missing'
      const result = { sourceFile: null, failReason }
      emojiSourceResolutionCache.set(cacheKey, result)
      return result
    }
    const imageExportConcurrency = 6
    const pendingImageExportJobs: Array<{
      createTime: number
      platformMessageId?: string
      localMessageId?: string
      imageMd5?: string
      imageDatName?: string
      mediaMapKey?: string
      mediaKey: string
    }> = []
    const processPendingImageExportJob = async (job: {
      createTime: number
      platformMessageId?: string
      localMessageId?: string
      imageMd5?: string
      imageDatName?: string
      mediaMapKey?: string
      mediaKey: string
    }) => {
      try {
        let imageHandled = false
        const { createTime, platformMessageId, localMessageId, imageMd5, imageDatName, mediaMapKey, mediaKey } = job
        const normalizedImageMd5 = this.normalizeMd5(imageMd5) || undefined

        if (normalizedImageMd5 || imageDatName) {
          const cacheResult = await imageDecryptService.decryptImage({
            sessionId,
            imageMd5: normalizedImageMd5,
            imageDatName
          })

          if (cacheResult.success && cacheResult.localPath) {
            let filePath = cacheResult.localPath
              .replace(/\?v=\d+$/, '')
              .replace(/^file:\/\/\//i, '')
            filePath = decodeURIComponent(filePath)

            if (fs.existsSync(filePath)) {
              const ext = path.extname(filePath) || '.jpg'
              try {
                const sourceFileMd5 = this.normalizeMd5(await this.computeFileMd5(filePath)) || null
                const dedupKeys: string[] = []
                if (normalizedImageMd5) dedupKeys.push(`image-md5:${normalizedImageMd5}`)
                if (sourceFileMd5) dedupKeys.push(`image-file-md5:${sourceFileMd5}`)

                let exportedAbsPath = findDedupAbsPath('image', dedupKeys)
                if (!exportedAbsPath) {
                  const fileStem = dedupKeys.length > 0
                    ? dedupeKeyToFileStem(dedupKeys[0], mediaKey)
                    : mediaKey
                  const fileName = `${fileStem}${ext}`
                  const destPath = path.join(imageOutDir, fileName)
                  if (!fs.existsSync(destPath)) {
                    fs.copyFileSync(filePath, destPath)
                    imageCount++
                  }
                  exportedAbsPath = destPath
                }

                registerDedupAbsPath('image', dedupKeys, exportedAbsPath)
                const relativePath = toSessionRelativePath(exportedAbsPath)
                const fileMd5 = await resolveExportedFileMd5(exportedAbsPath, relativePath)
                this.setMediaPathMapEntry(mediaPathMap, relativePath, mediaMapKey, createTime)
                this.upsertArkmeMediaIndexEntry(arkmeMediaIndexMap, {
                  mediaKey,
                  kind: 'image',
                  exported: true,
                  relativePath,
                  fileName: path.basename(exportedAbsPath),
                  sourceMd5: normalizedImageMd5 || null,
                  fileMd5,
                  createTime,
                  sessionId,
                  ...(platformMessageId ? { platformMessageId } : {}),
                  ...(localMessageId ? { localMessageId } : {}),
                  source: {
                    ...(normalizedImageMd5 ? { imageMd5: normalizedImageMd5 } : {}),
                    ...(imageDatName ? { imageDatName } : {})
                  }
                })
                imageHandled = true
              } catch {
                bumpReason(imageFailReasons, 'copy_failed')
              }
            } else {
              bumpReason(imageFailReasons, 'source_missing')
            }
          } else {
            bumpReason(imageFailReasons, 'decrypt_failed')
          }
        }
        if (!normalizedImageMd5 && !imageDatName) {
          bumpReason(imageFailReasons, 'no_identifier')
        }
        if (!imageHandled) {
          this.upsertArkmeMediaIndexEntry(arkmeMediaIndexMap, {
            mediaKey,
            kind: 'image',
            exported: false,
            relativePath: null,
            fileName: null,
            sourceMd5: normalizedImageMd5 || null,
            fileMd5: null,
            createTime,
            sessionId,
            ...(platformMessageId ? { platformMessageId } : {}),
            ...(localMessageId ? { localMessageId } : {}),
            source: {
              ...(normalizedImageMd5 ? { imageMd5: normalizedImageMd5 } : {}),
              ...(imageDatName ? { imageDatName } : {})
            }
          })
          imageFailCount++
        }
      } catch {
        imageFailCount++
        bumpReason(imageFailReasons, 'unknown')
        // 跳过单张图片的错误
      } finally {
        imageProcessed++
        if (imageTotal > 0 && shouldReportStep(imageProcessed, imageTotal)) {
          emitMediaProgress(`图片处理: ${imageProcessed}/${imageTotal}（已导出 ${imageCount}）`, imageProcessed, imageTotal, '条')
        }
      }
    }

    // 构建查询条件：只查需要的消息类型
    const typeConditions: string[] = []
    if (options.exportImages) typeConditions.push('3')
    if (options.exportVideos) typeConditions.push('43')
    if (options.exportEmojis) typeConditions.push('47')

    // 图片/视频/表情循环（语音在后面独立处理）
    if (typeConditions.length > 0) {
      // 预先统计表情总数
      if (options.exportImages || options.exportVideos || options.exportEmojis) {
        for (const { db, tableName } of dbTablePairs) {
          try {
            const whereParts: string[] = []
            if (options.exportImages) whereParts.push('local_type = 3')
            if (options.exportVideos) whereParts.push('local_type = 43')
            if (options.exportEmojis) whereParts.push('local_type = 47')
            if (whereParts.length === 0) continue
            let countSql = `SELECT local_type, COUNT(*) as c FROM ${tableName} WHERE (${whereParts.join(' OR ')})`
            if (options.dateRange) {
              countSql += ` AND create_time >= ${options.dateRange.start} AND create_time <= ${options.dateRange.end}`
            }
            countSql += ' GROUP BY local_type'
            const rows = db.prepare(countSql).all() as any[]
            for (const countRow of rows) {
              const localType = Number(countRow?.local_type || 0)
              const count = Number(countRow?.c || 0)
              if (localType === 3) imageTotal += count
              if (localType === 43) videoTotal += count
              if (localType === 47) emojiTotal += count
            }
          } catch { }
        }
        if (imageTotal > 0) emitMediaProgress(`正在处理图片消息（共 ${imageTotal} 条）...`, 0, imageTotal, '条')
        if (videoTotal > 0) emitMediaProgress(`正在处理视频消息（共 ${videoTotal} 条）...`, 0, videoTotal, '条')
        if (emojiTotal > 0) emitMediaProgress(`正在处理表情消息（共 ${emojiTotal} 条）...`, 0, emojiTotal, '条')
      }

      for (const { db, tableName } of dbTablePairs) {
        try {
          const hasName2Id = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='Name2Id'"
          ).get()

          const typeFilter = typeConditions.map(t => `local_type = ${t}`).join(' OR ')

          // 用 SELECT * 获取完整行，包含 packed_info_data
          let sql: string
          if (hasName2Id) {
            sql = `SELECT m.* FROM ${tableName} m WHERE (${typeFilter}) ORDER BY m.create_time ASC`
          } else {
            sql = `SELECT * FROM ${tableName} WHERE (${typeFilter}) ORDER BY create_time ASC`
          }

          const rows = db.prepare(sql).all() as any[]

          for (const row of rows) {
            const createTime = row.create_time || 0

            // 时间范围过滤
            if (options.dateRange) {
              if (createTime < options.dateRange.start || createTime > options.dateRange.end) {
                continue
              }
            }

            const localType = row.local_type || row.type || 1
            const content = this.decodeMessageContent(row.message_content, row.compress_content)
            const platformMessageId = row.server_id ? String(row.server_id) : (row.local_id ? String(row.local_id) : undefined)
            const localMessageId = row.local_id ? String(row.local_id) : undefined
            const mediaMapKey = this.buildMediaPathMapKey({
              platformMessageId,
              localMessageId,
              createTime,
              localType,
              senderUsername: row.sender_username || '',
              isSend: row.is_send === 1
            })
            const mediaKey = this.buildArkmeMediaKey({
              sessionId,
              platformMessageId,
              localMessageId,
              createTime,
              localType,
              isSend: row.is_send === 1,
              realSenderId: row.real_sender_id,
              contentHint: content
            })

            // 导出图片
            if (options.exportImages && localType === 3) {
              const imageMd5 = this.normalizeMd5(this.extractXmlValue(content, 'md5') ||
                (/\<img[^>]*\smd5\s*=\s*['"]([^'"]+)['"]/i.exec(content))?.[1] ||
                undefined) || undefined
              const imageDatName = this.parseImageDatName(row)
              this.upsertArkmeMediaIndexEntry(arkmeMediaIndexMap, {
                mediaKey,
                kind: 'image',
                exported: false,
                relativePath: null,
                fileName: null,
                sourceMd5: imageMd5 || null,
                fileMd5: null,
                createTime,
                sessionId,
                ...(platformMessageId ? { platformMessageId } : {}),
                ...(localMessageId ? { localMessageId } : {}),
                source: {
                  ...(imageMd5 ? { imageMd5 } : {}),
                  ...(imageDatName ? { imageDatName } : {})
                }
              })
              pendingImageExportJobs.push({
                createTime,
                platformMessageId,
                localMessageId,
                imageMd5,
                imageDatName,
                mediaMapKey,
                mediaKey
              })
              continue
            }

            // 导出视频
            if (options.exportVideos && localType === 43) {
              videoProcessed++
              if (videoTotal > 0 && shouldReportStep(videoProcessed, videoTotal)) {
                emitMediaProgress(`视频处理: ${videoProcessed}/${videoTotal}（已导出 ${videoCount}）`, videoProcessed, videoTotal, '条')
              }
              try {
                let videoHandled = false
                const videoMd5 = this.normalizeMd5(videoService.parseVideoMd5(content)) || undefined
                this.upsertArkmeMediaIndexEntry(arkmeMediaIndexMap, {
                  mediaKey,
                  kind: 'video',
                  exported: false,
                  relativePath: null,
                  fileName: null,
                  sourceMd5: videoMd5 || null,
                  fileMd5: null,
                  createTime,
                  sessionId,
                  ...(platformMessageId ? { platformMessageId } : {}),
                  ...(localMessageId ? { localMessageId } : {}),
                  source: videoMd5 ? { videoMd5 } : undefined
                })
                if (videoMd5) {
                  if (shouldDedupeVideoFiles) {
                    const cachedExportAbsPath = findDedupAbsPath('video', [`video-md5:${videoMd5}`])
                    if (cachedExportAbsPath) {
                      const relativePath = toSessionRelativePath(cachedExportAbsPath)
                      const fileMd5 = await resolveExportedFileMd5(cachedExportAbsPath, relativePath)
                      this.setMediaPathMapEntry(mediaPathMap, relativePath, mediaMapKey, createTime)
                      this.upsertArkmeMediaIndexEntry(arkmeMediaIndexMap, {
                        mediaKey,
                        kind: 'video',
                        exported: true,
                        relativePath,
                        fileName: path.basename(cachedExportAbsPath),
                        sourceMd5: videoMd5,
                        fileMd5,
                        createTime,
                        sessionId,
                        ...(platformMessageId ? { platformMessageId } : {}),
                        ...(localMessageId ? { localMessageId } : {}),
                        source: { videoMd5 }
                      })
                      videoHandled = true
                      continue
                    }
                  }

                  const videoInfo = videoService.getVideoInfo(videoMd5)
                  if (videoInfo.exists && videoInfo.videoUrl) {
                    const videoPath = videoInfo.videoUrl.replace(/^file:\/\/\//i, '').replace(/\//g, path.sep)
                    if (fs.existsSync(videoPath)) {
                      const fileName = `${videoMd5}.mp4`
                      const destPath = path.join(videoOutDir, fileName)
                      const relativePath = toSessionRelativePath(destPath)
                      try {
                        if (!fs.existsSync(destPath)) {
                          fs.copyFileSync(videoPath, destPath)
                          videoCount++
                        }
                      } catch {
                        bumpReason(videoFailReasons, 'copy_failed')
                        throw new Error('video_copy_failed')
                      }
                      if (shouldDedupeVideoFiles) {
                        registerDedupAbsPath('video', [`video-md5:${videoMd5}`], destPath)
                      }
                      const fileMd5 = await resolveExportedFileMd5(destPath, relativePath)
                      this.setMediaPathMapEntry(mediaPathMap, relativePath, mediaMapKey, createTime)
                      this.upsertArkmeMediaIndexEntry(arkmeMediaIndexMap, {
                        mediaKey,
                        kind: 'video',
                        exported: true,
                        relativePath,
                        fileName,
                        sourceMd5: videoMd5,
                        fileMd5,
                        createTime,
                        sessionId,
                        ...(platformMessageId ? { platformMessageId } : {}),
                        ...(localMessageId ? { localMessageId } : {}),
                        source: { videoMd5 }
                      })
                      videoHandled = true
                    } else {
                      bumpReason(videoFailReasons, 'source_missing')
                    }
                  } else {
                    bumpReason(videoFailReasons, 'source_missing')
                  }
                }
                if (!videoMd5) {
                  bumpReason(videoFailReasons, 'no_md5')
                }
                if (!videoHandled) {
                  videoFailCount++
                }
              } catch (e) {
                videoFailCount++
                const errMsg = e instanceof Error ? e.message : String(e)
                if (errMsg !== 'video_copy_failed') {
                  bumpReason(videoFailReasons, 'unknown')
                }
                // 跳过单个视频的错误
              }
            }

            // 导出表情包
            if (options.exportEmojis && localType === 47) {
              emojiProcessed++
              if (emojiTotal > 0 && shouldReportStep(emojiProcessed, emojiTotal)) {
                emitMediaProgress(`表情处理: ${emojiProcessed}/${emojiTotal}（已导出 ${emojiCount}）`, emojiProcessed, emojiTotal, '条')
              }
              try {
                let emojiHandled = false
                const emojiSource = this.parseArkmeEmojiSource(content)
                const cdnUrl = String(emojiSource.cdnUrl || '')
                const emojiMd5 = this.normalizeMd5(emojiSource.emojiMd5) || ''
                const encryptUrl = String(emojiSource.encryptUrl || '')
                const aesKey = String(emojiSource.aesKey || '')
                this.upsertArkmeMediaIndexEntry(arkmeMediaIndexMap, {
                  mediaKey,
                  kind: 'emoji',
                  exported: false,
                  relativePath: null,
                  fileName: null,
                  sourceMd5: emojiMd5 || null,
                  fileMd5: null,
                  createTime,
                  sessionId,
                  ...(platformMessageId ? { platformMessageId } : {}),
                  ...(localMessageId ? { localMessageId } : {}),
                  source: Object.keys(emojiSource).length > 0
                    ? { ...emojiSource, ...(emojiMd5 ? { emojiMd5 } : {}) }
                    : undefined
                })

                if (emojiMd5 || cdnUrl) {
                  const cacheKey = emojiMd5 || this.hashString(cdnUrl)
                  const dedupKeys: string[] = []
                  if (emojiMd5) dedupKeys.push(`emoji-md5:${emojiMd5}`)
                  if (cacheKey) dedupKeys.push(`emoji-cache:${cacheKey}`)
                  // 确定文件扩展名
                  const ext = cdnUrl.includes('.gif') || content.includes('type="2"') ? '.gif' : '.png'
                  let exportedAbsPath = findDedupAbsPath('emoji', dedupKeys)

                  if (!exportedAbsPath) {
                    const { sourceFile, failReason } = await resolveEmojiSource(cacheKey, cdnUrl, encryptUrl, aesKey)
                    if (sourceFile && fs.existsSync(sourceFile)) {
                      try {
                        const sourceFileMd5 = this.normalizeMd5(await this.computeFileMd5(sourceFile)) || null
                        if (sourceFileMd5) {
                          dedupKeys.push(`emoji-file-md5:${sourceFileMd5}`)
                          exportedAbsPath = findDedupAbsPath('emoji', dedupKeys)
                        }
                        if (!exportedAbsPath) {
                          const fileStem = dedupKeys.length > 0
                            ? dedupeKeyToFileStem(dedupKeys[0], mediaKey)
                            : mediaKey
                          const fileName = `${fileStem}${ext}`
                          const destPath = path.join(emojiOutDir, fileName)
                          if (!fs.existsSync(destPath)) {
                            fs.copyFileSync(sourceFile, destPath)
                            emojiCount++
                          }
                          exportedAbsPath = destPath
                        }
                      } catch {
                        bumpReason(emojiFailReasons, 'copy_failed')
                      }
                    } else if (failReason) {
                      bumpReason(emojiFailReasons, failReason)
                    } else {
                      bumpReason(emojiFailReasons, 'source_missing')
                    }
                  }

                  if (exportedAbsPath) {
                    registerDedupAbsPath('emoji', dedupKeys, exportedAbsPath)
                    const relativePath = toSessionRelativePath(exportedAbsPath)
                    const fileMd5 = await resolveExportedFileMd5(exportedAbsPath, relativePath)
                    this.setMediaPathMapEntry(mediaPathMap, relativePath, mediaMapKey, createTime)
                    this.upsertArkmeMediaIndexEntry(arkmeMediaIndexMap, {
                      mediaKey,
                      kind: 'emoji',
                      exported: true,
                      relativePath,
                      fileName: path.basename(exportedAbsPath),
                      sourceMd5: emojiMd5 || null,
                      fileMd5,
                      createTime,
                      sessionId,
                      ...(platformMessageId ? { platformMessageId } : {}),
                      ...(localMessageId ? { localMessageId } : {}),
                      source: Object.keys(emojiSource).length > 0
                        ? { ...emojiSource, ...(emojiMd5 ? { emojiMd5 } : {}) }
                        : undefined
                    })
                    emojiHandled = true
                  }
                }
                if (!emojiMd5 && !cdnUrl) {
                  bumpReason(emojiFailReasons, 'no_identifier')
                }
                if (!emojiHandled) {
                  emojiFailCount++
                }
              } catch (e) {
                emojiFailCount++
                bumpReason(emojiFailReasons, 'unknown')
                // 跳过单个表情的错误
              }
            }
          }
        } catch (e) {
          console.error(`[Export] 读取媒体消息失败:`, e)
        }
      }

      if (pendingImageExportJobs.length > 0) {
        let nextImageJobIndex = 0
        const workerCount = Math.min(imageExportConcurrency, pendingImageExportJobs.length)
        // 图片解密/复制走限流并发，避免串行拖慢导出，但不把磁盘打满
        await Promise.all(Array.from({ length: workerCount }, async () => {
          while (true) {
            const jobIndex = nextImageJobIndex++
            if (jobIndex >= pendingImageExportJobs.length) return
            await processPendingImageExportJob(pendingImageExportJobs[jobIndex])
          }
        }))
      }
    } // 结束 typeConditions > 0

    // === 语音导出（独立流程：需要从 MediaDb 读取） ===
    let voiceCount = 0
    if (options.exportVoices) {
      emitMediaProgress('正在处理语音消息...', 0, 0, '条')

      // 1. 收集语音消息并提前生成稳定 mediaKey
      const voiceMessages: Array<{
        createTime: number
        platformMessageId?: string
        localMessageId?: string
        mediaMapKey?: string
        mediaKey: string
      }> = []
      for (const { db, tableName } of dbTablePairs) {
        try {
          let sql = `SELECT create_time, server_id, local_id, is_send, real_sender_id, message_content, compress_content FROM ${tableName} WHERE local_type = 34`
          if (options.dateRange) {
            sql += ` AND create_time >= ${options.dateRange.start} AND create_time <= ${options.dateRange.end}`
          }
          sql += ` ORDER BY create_time`
          const rows = db.prepare(sql).all() as any[]
          for (const row of rows) {
            const createTime = Number(row.create_time || 0)
            if (!createTime) continue
            const content = this.decodeMessageContent(row.message_content, row.compress_content)
            const platformMessageId = row.server_id ? String(row.server_id) : (row.local_id ? String(row.local_id) : undefined)
            const localMessageId = row.local_id ? String(row.local_id) : undefined
            const mediaMapKey = this.buildMediaPathMapKey({
              platformMessageId,
              localMessageId,
              createTime,
              localType: 34,
              senderUsername: row.sender_username || '',
              isSend: row.is_send === 1
            })
            const mediaKey = this.buildArkmeMediaKey({
              sessionId,
              platformMessageId,
              localMessageId,
              createTime,
              localType: 34,
              isSend: row.is_send === 1,
              realSenderId: row.real_sender_id,
              contentHint: content
            })

            voiceMessages.push({
              createTime,
              platformMessageId,
              localMessageId,
              mediaMapKey,
              mediaKey
            })
            this.upsertArkmeMediaIndexEntry(arkmeMediaIndexMap, {
              mediaKey,
              kind: 'voice',
              exported: false,
              relativePath: null,
              fileName: null,
              sourceMd5: null,
              fileMd5: null,
              createTime,
              sessionId,
              ...(platformMessageId ? { platformMessageId } : {}),
              ...(localMessageId ? { localMessageId } : {}),
              source: { voiceCreateTime: createTime }
            })
          }
        } catch { }
      }

      if (voiceMessages.length > 0) {
        // 2. 查找 MediaDb
        const mediaDbs = this.findMediaDbs()

        if (mediaDbs.length > 0) {
          // 3. 只初始化一次 silk-wasm
          let silkWasm: any = null
          try {
            silkWasm = require('silk-wasm')
          } catch (e) {
            console.error('[Export] silk-wasm 加载失败:', e)
          }

          if (silkWasm) {
            // 4. 打开所有 MediaDb，预先建立 VoiceInfo 查询
            interface VoiceDbInfo {
              db: InstanceType<typeof Database>
              voiceTable: string
              dataColumn: string
              timeColumn: string
              chatNameIdColumn: string | null
              name2IdTable: string | null
            }
            const voiceDbs: VoiceDbInfo[] = []

            for (const dbPath of mediaDbs) {
              try {
                const mediaDb = new Database(dbPath, { readonly: true })
                const tables = mediaDb.prepare(
                  "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'VoiceInfo%'"
                ).all() as any[]
                if (tables.length === 0) { mediaDb.close(); continue }

                const voiceTable = tables[0].name
                const columns = mediaDb.prepare(`PRAGMA table_info('${voiceTable}')`).all() as any[]
                const colNames = columns.map((c: any) => c.name.toLowerCase())

                const dataColumn = colNames.find((c: string) => ['voice_data', 'buf', 'voicebuf', 'data'].includes(c))
                const timeColumn = colNames.find((c: string) => ['create_time', 'createtime', 'time'].includes(c))
                if (!dataColumn || !timeColumn) { mediaDb.close(); continue }

                const chatNameIdColumn = colNames.find((c: string) => ['chat_name_id', 'chatnameid', 'chat_nameid'].includes(c)) || null
                const n2iTables = mediaDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Name2Id%'").all() as any[]
                const name2IdTable = n2iTables.length > 0 ? n2iTables[0].name : null

                voiceDbs.push({ db: mediaDb, voiceTable, dataColumn, timeColumn, chatNameIdColumn, name2IdTable })
              } catch { }
            }

            // 5. 串行处理语音（避免内存溢出）
            const myWxid = this.configService.get('myWxid')
            const candidates = [sessionId]
            if (myWxid && myWxid !== sessionId) candidates.push(myWxid)

            const total = voiceMessages.length
            const shouldReportVoiceStep = (processed: number) => (
              processed % 5 === 0 || processed === total || processed <= 3
            )
            for (let idx = 0; idx < total; idx++) {
              const voiceMessage = voiceMessages[idx]
              const createTime = voiceMessage.createTime
              const createTimeDedupeKey = `voice-time:${sessionId}:${createTime}`

              const bindVoiceExported = async (bindAbsPath: string, sourceMd5?: string | null) => {
                const bindPath = toSessionRelativePath(bindAbsPath)
                const fileMd5 = await resolveExportedFileMd5(bindAbsPath, bindPath)
                this.setMediaPathMapEntry(mediaPathMap, bindPath, voiceMessage.mediaMapKey, createTime)
                this.upsertArkmeMediaIndexEntry(arkmeMediaIndexMap, {
                  mediaKey: voiceMessage.mediaKey,
                  kind: 'voice',
                  exported: true,
                  relativePath: bindPath,
                  fileName: path.basename(bindPath),
                  sourceMd5: sourceMd5 || null,
                  fileMd5,
                  createTime,
                  sessionId,
                  ...(voiceMessage.platformMessageId ? { platformMessageId: voiceMessage.platformMessageId } : {}),
                  ...(voiceMessage.localMessageId ? { localMessageId: voiceMessage.localMessageId } : {}),
                  source: {
                    voiceCreateTime: createTime,
                    ...(sourceMd5 ? { voiceMd5: sourceMd5 } : {})
                  }
                })
              }

              const cachedVoiceAbsPath = findDedupAbsPath('voice', [createTimeDedupeKey])
              if (cachedVoiceAbsPath) {
                await bindVoiceExported(cachedVoiceAbsPath)
                if (shouldReportVoiceStep(idx + 1)) {
                  emitMediaProgress(`语音处理: ${idx + 1}/${total}（已导出 ${voiceCount}）`, idx + 1, total, '条')
                }
                continue
              }

              // 在 MediaDb 中查找 SILK 数据
              let silkData: Buffer | null = null
              for (const vdb of voiceDbs) {
                try {
                  // 策略1: chatNameId + createTime
                  if (vdb.chatNameIdColumn && vdb.name2IdTable) {
                    for (const cand of candidates) {
                      const n2i = vdb.db.prepare(`SELECT rowid FROM ${vdb.name2IdTable} WHERE user_name = ?`).get(cand) as any
                      if (n2i?.rowid) {
                        const row = vdb.db.prepare(`SELECT ${vdb.dataColumn} AS data FROM ${vdb.voiceTable} WHERE ${vdb.chatNameIdColumn} = ? AND ${vdb.timeColumn} = ? LIMIT 1`).get(n2i.rowid, createTime) as any
                        if (row?.data) {
                          silkData = this.decodeVoiceBlob(row.data)
                          if (silkData) break
                        }
                      }
                    }
                  }
                  // 策略2: 仅 createTime
                  if (!silkData) {
                    const row = vdb.db.prepare(`SELECT ${vdb.dataColumn} AS data FROM ${vdb.voiceTable} WHERE ${vdb.timeColumn} = ? LIMIT 1`).get(createTime) as any
                    if (row?.data) {
                      silkData = this.decodeVoiceBlob(row.data)
                    }
                  }
                  if (silkData) break
                } catch { }
              }

              if (!silkData) {
                voiceFailCount++
                bumpReason(voiceFailReasons, 'source_missing')
                if (shouldReportVoiceStep(idx + 1)) {
                  emitMediaProgress(`语音处理: ${idx + 1}/${total}（已导出 ${voiceCount}，未成功 ${voiceFailCount}）`, idx + 1, total, '条')
                }
                continue
              }

              try {
                // SILK → PCM → WAV（串行，立即释放）
                const result = await this.withTimeout(
                  Promise.resolve(silkWasm.decode(silkData, 24000)),
                  10000,
                  '语音解码'
                )
                silkData = null // 释放 SILK 数据
                if (!result?.data) {
                  voiceFailCount++
                  bumpReason(voiceFailReasons, 'decode_error')
                  if (shouldReportVoiceStep(idx + 1)) {
                    emitMediaProgress(`语音处理: ${idx + 1}/${total}（已导出 ${voiceCount}，未成功 ${voiceFailCount}）`, idx + 1, total, '条')
                  }
                  continue
                }
                const pcmData = Buffer.from(result.data)
                const wavData = this.createWavBuffer(pcmData, 24000)
                try {
                  const wavMd5 = this.normalizeMd5(createHash('md5').update(wavData).digest('hex')) || null
                  const voiceDedupKeys = [createTimeDedupeKey]
                  if (wavMd5) {
                    voiceDedupKeys.unshift(`voice-md5:${wavMd5}`)
                  }

                  let exportedAbsPath = findDedupAbsPath('voice', voiceDedupKeys)
                  if (!exportedAbsPath) {
                    const fileName = `${wavMd5 || voiceMessage.mediaKey}.wav`
                    const destPath = path.join(voiceOutDir, fileName)
                    if (!fs.existsSync(destPath)) {
                      fs.writeFileSync(destPath, wavData)
                      voiceCount++
                    }
                    exportedAbsPath = destPath
                  }

                  registerDedupAbsPath('voice', voiceDedupKeys, exportedAbsPath)
                  await bindVoiceExported(exportedAbsPath, wavMd5)
                } catch {
                  voiceFailCount++
                  bumpReason(voiceFailReasons, 'write_failed')
                  if (shouldReportVoiceStep(idx + 1)) {
                    emitMediaProgress(`语音处理: ${idx + 1}/${total}（已导出 ${voiceCount}，未成功 ${voiceFailCount}）`, idx + 1, total, '条')
                  }
                  continue
                }
              } catch (e) {
                voiceFailCount++
                const errMsg = e instanceof Error ? e.message : String(e)
                if (errMsg.includes('语音解码 超时')) {
                  bumpReason(voiceFailReasons, 'decode_timeout')
                  console.warn(`[Export] 语音解码超时: session=${sessionId}, createTime=${createTime}`)
                } else {
                  bumpReason(voiceFailReasons, 'decode_error')
                }
              }

              // 进度日志
              if (shouldReportVoiceStep(idx + 1)) {
                const failSuffix = voiceFailCount > 0 ? `，未成功 ${voiceFailCount}` : ''
                emitMediaProgress(`语音处理: ${idx + 1}/${total}（已导出 ${voiceCount}${failSuffix}）`, idx + 1, total, '条')
              }
            }

            // 6. 关闭所有 MediaDb
            for (const vdb of voiceDbs) {
              try { vdb.db.close() } catch { }
            }
          } else {
            voiceFailCount += voiceMessages.length
            voiceFailReasons.decoder_missing += voiceMessages.length
            emitMediaProgress(`语音处理失败：无法加载语音解码器（待处理 ${voiceMessages.length} 条）`, 0, voiceMessages.length, '条')
          }
        } else {
          voiceFailCount += voiceMessages.length
          voiceFailReasons.media_db_missing += voiceMessages.length
          emitMediaProgress(`语音处理失败：未找到 MediaDb（待处理 ${voiceMessages.length} 条）`, 0, voiceMessages.length, '条')
        }
      }
    }

    const parts: string[] = []
    if (imageCount > 0) parts.push(`${imageCount} 张图片`)
    if (videoCount > 0) parts.push(`${videoCount} 个视频`)
    if (emojiCount > 0) parts.push(`${emojiCount} 个表情`)
    if (voiceCount > 0) parts.push(`${voiceCount} 条语音`)
    const failParts: string[] = []
    if (imageFailCount > 0) failParts.push(`图片 ${imageFailCount}`)
    if (videoFailCount > 0) failParts.push(`视频 ${videoFailCount}`)
    if (emojiFailCount > 0) failParts.push(`表情 ${emojiFailCount}`)
    if (voiceFailCount > 0) failParts.push(`语音 ${voiceFailCount}`)
    const summaryBase = parts.length > 0 ? `媒体导出完成: ${parts.join(', ')}` : '无媒体文件'
    const reasonBreakdowns: string[] = []
    const imageReasonText = summarizeReasons(imageFailReasons, {
      no_identifier: '无图片标识',
      decrypt_failed: '图片解密失败',
      source_missing: '图片源文件缺失',
      copy_failed: '图片复制失败',
      unknown: '图片未知错误'
    })
    if (imageReasonText) reasonBreakdowns.push(`图片(${imageReasonText})`)
    const videoReasonText = summarizeReasons(videoFailReasons, {
      no_md5: '无视频MD5',
      source_missing: '视频源文件缺失',
      copy_failed: '视频复制失败',
      unknown: '视频未知错误'
    })
    if (videoReasonText) reasonBreakdowns.push(`视频(${videoReasonText})`)
    const emojiReasonText = summarizeReasons(emojiFailReasons, {
      no_identifier: '无表情标识',
      local_cache_miss: '本地缓存缺失',
      cdn_download_failed: 'CDN下载失败',
      encrypt_download_failed: '加密URL下载失败',
      source_missing: '表情源文件缺失',
      copy_failed: '表情复制失败',
      unknown: '表情未知错误'
    })
    if (emojiReasonText) reasonBreakdowns.push(`表情(${emojiReasonText})`)
    const voiceReasonText = summarizeReasons(voiceFailReasons, {
      media_db_missing: '未找到MediaDb',
      decoder_missing: '缺少语音解码器',
      source_missing: '语音源数据缺失',
      decode_timeout: '语音解码超时',
      decode_error: '语音解码失败',
      write_failed: '语音写文件失败',
      unknown: '语音未知错误'
    })
    if (voiceReasonText) reasonBreakdowns.push(`语音(${voiceReasonText})`)

    let summary = failParts.length > 0 ? `${summaryBase}；未成功处理 ${failParts.join('、')}` : summaryBase
    if (reasonBreakdowns.length > 0) {
      summary += `；失败明细 ${reasonBreakdowns.join('；')}`
    }
    emitMediaProgress(summary)
    console.log(`[Export] ${sessionId} ${summary}`)
    return { mediaPathMap, arkmeMediaIndexMap }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
    }
  }

  /**
   * 从数据库行的 packed_info_data 中解析图片 dat 文件名
   * 复制自 chatService.parseImageDatNameFromRow 逻辑
   */
  private parseImageDatName(row: Record<string, any>): string | undefined {
    // 尝试多种可能的字段名
    const fieldNames = [
      'packed_info_data', 'packed_info', 'packedInfoData', 'packedInfo',
      'PackedInfoData', 'PackedInfo',
      'WCDB_CT_packed_info_data', 'WCDB_CT_packed_info',
      'WCDB_CT_PackedInfoData', 'WCDB_CT_PackedInfo'
    ]
    let packed: any = undefined
    for (const name of fieldNames) {
      if (row[name] !== undefined && row[name] !== null) {
        packed = row[name]
        break
      }
    }

    // 解码为 Buffer
    let buffer: Buffer | null = null
    if (!packed) return undefined
    if (Buffer.isBuffer(packed)) {
      buffer = packed
    } else if (packed instanceof Uint8Array) {
      buffer = Buffer.from(packed)
    } else if (Array.isArray(packed)) {
      buffer = Buffer.from(packed)
    } else if (typeof packed === 'string') {
      const trimmed = packed.trim()
      if (/^[a-fA-F0-9]+$/.test(trimmed) && trimmed.length % 2 === 0) {
        try { buffer = Buffer.from(trimmed, 'hex') } catch { }
      }
      if (!buffer) {
        try { buffer = Buffer.from(trimmed, 'base64') } catch { }
      }
    } else if (typeof packed === 'object' && Array.isArray(packed.data)) {
      buffer = Buffer.from(packed.data)
    }

    if (!buffer || buffer.length === 0) return undefined

    // 提取可打印字符
    const printable: number[] = []
    for (let i = 0; i < buffer.length; i++) {
      const byte = buffer[i]
      if (byte >= 0x20 && byte <= 0x7e) {
        printable.push(byte)
      } else {
        printable.push(0x20)
      }
    }
    const text = Buffer.from(printable).toString('utf-8')

    // 匹配 dat 文件名
    const match = /([0-9a-fA-F]{8,})(?:\.t)?\.dat/.exec(text)
    if (match?.[1]) return match[1].toLowerCase()
    const hexMatch = /([0-9a-fA-F]{16,})/.exec(text)
    return hexMatch?.[1]?.toLowerCase()
  }

  /**
   * 简单字符串哈希（用于无 md5 时生成缓存 key）
   */
  private hashString(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const chr = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + chr
      hash |= 0
    }
    return Math.abs(hash).toString(16)
  }

  /**
   * 查找本地缓存的表情包文件
   */
  private findLocalEmoji(cacheKey: string): string | null {
    try {
      const cachePath = this.configService.get('cachePath')
      if (!cachePath) return null

      const emojiCacheDir = path.join(cachePath, 'Emojis')
      if (!fs.existsSync(emojiCacheDir)) return null

      // 检查各种扩展名
      const extensions = ['.gif', '.png', '.webp', '.jpg', '.jpeg', '']
      for (const ext of extensions) {
        const filePath = path.join(emojiCacheDir, `${cacheKey}${ext}`)
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath)
          if (stat.isFile() && stat.size > 0) return filePath
        }
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * 从 CDN 下载表情包文件并缓存（使用微信 UA + 重定向 + SSL bypass）
   */
  private downloadEmojiFile(cdnUrl: string, cacheKey: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const cachePath = this.configService.get('cachePath')
        if (!cachePath) { resolve(null); return }

        const emojiCacheDir = path.join(cachePath, 'Emojis')
        if (!fs.existsSync(emojiCacheDir)) fs.mkdirSync(emojiCacheDir, { recursive: true })

        let url = cdnUrl
        if (url.startsWith('http://') && (url.includes('qq.com') || url.includes('wechat.com'))) {
          url = url.replace('http://', 'https://')
        }

        this.doDownloadBuffer(url, (buffer) => {
          if (!buffer) { resolve(null); return }
          const ext = this.detectEmojiExt(buffer)
          const filePath = path.join(emojiCacheDir, `${cacheKey}${ext}`)
          fs.writeFileSync(filePath, buffer)
          resolve(filePath)
        })
      } catch { resolve(null) }
    })
  }

  /**
   * 下载加密表情并用 AES 解密
   */
  private async downloadAndDecryptEmoji(encryptUrl: string, aesKey: string, cacheKey: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const cachePath = this.configService.get('cachePath')
        if (!cachePath) { resolve(null); return }

        const emojiCacheDir = path.join(cachePath, 'Emojis')
        if (!fs.existsSync(emojiCacheDir)) fs.mkdirSync(emojiCacheDir, { recursive: true })

        let url = encryptUrl.replace(/&amp;/g, '&')
        if (url.startsWith('http://') && (url.includes('qq.com') || url.includes('wechat.com'))) {
          url = url.replace('http://', 'https://')
        }

        this.doDownloadBuffer(url, (buffer) => {
          if (!buffer) { resolve(null); return }
          try {
            const crypto = require('crypto')
            const keyBuf = Buffer.from(crypto.createHash('md5').update(aesKey).digest('hex').slice(0, 16), 'utf8')
            const decipher = crypto.createDecipheriv('aes-128-ecb', keyBuf, null)
            decipher.setAutoPadding(true)
            const decrypted = Buffer.concat([decipher.update(buffer), decipher.final()])
            const ext = this.detectEmojiExt(decrypted)
            const filePath = path.join(emojiCacheDir, `${cacheKey}${ext}`)
            fs.writeFileSync(filePath, decrypted)
            resolve(filePath)
          } catch { resolve(null) }
        })
      } catch { resolve(null) }
    })
  }

  private doDownloadBuffer(url: string, callback: (buf: Buffer | null) => void, redirectCount = 0): void {
    if (redirectCount > 5) { callback(null); return }
    const protocol = url.startsWith('https') ? https : http
    const req = protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x67001431) NetType/WIFI WindowsWechat/3.9.11.17(0x63090b11)',
        'Accept': '*/*',
      },
      rejectUnauthorized: false,
      timeout: 15000
    }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
        const loc = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href
        this.doDownloadBuffer(loc, callback, redirectCount + 1)
        return
      }
      if (res.statusCode !== 200) { callback(null); return }
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        callback(buf.length > 0 ? buf : null)
      })
      res.on('error', () => callback(null))
    })
    req.on('error', () => callback(null))
    req.setTimeout(15000, () => { req.destroy(); callback(null) })
  }

  private async withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        work,
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`${label} 超时(${timeoutMs}ms)`)), timeoutMs)
        })
      ])
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }

  private detectEmojiExt(buf: Buffer): string {
    if (buf[0] === 0x89 && buf[1] === 0x50) return '.png'
    if (buf[0] === 0xFF && buf[1] === 0xD8) return '.jpg'
    if (buf[0] === 0x52 && buf[1] === 0x49) return '.webp'
    return '.gif'
  }

  /**
   * 查找 media 数据库文件
   */
  private findMediaDbs(): string[] {
    if (!this.dbDir) return []
    const result: string[] = []
    try {
      const files = fs.readdirSync(this.dbDir)
      for (const file of files) {
        const lower = file.toLowerCase()
        if (lower.startsWith('media') && lower.endsWith('.db')) {
          result.push(path.join(this.dbDir, file))
        }
      }
    } catch { }
    return result
  }

  /**
   * 解码语音 Blob 数据为 Buffer
   */
  private decodeVoiceBlob(raw: any): Buffer | null {
    if (!raw) return null
    if (Buffer.isBuffer(raw)) return raw
    if (raw instanceof Uint8Array) return Buffer.from(raw)
    if (Array.isArray(raw)) return Buffer.from(raw)
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (/^[a-fA-F0-9]+$/.test(trimmed) && trimmed.length % 2 === 0) {
        try { return Buffer.from(trimmed, 'hex') } catch { }
      }
      try { return Buffer.from(trimmed, 'base64') } catch { }
    }
    if (typeof raw === 'object' && Array.isArray(raw.data)) {
      return Buffer.from(raw.data)
    }
    return null
  }

  /**
   * PCM 数据生成 WAV 文件 Buffer
   */
  private createWavBuffer(pcmData: Buffer, sampleRate: number = 24000, channels: number = 1): Buffer {
    const pcmLength = pcmData.length
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + pcmLength, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(channels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(sampleRate * channels * 2, 28)
    header.writeUInt16LE(channels * 2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(pcmLength, 40)
    return Buffer.concat([header, pcmData])
  }

  /**
   * 导出通讯录
   */
  async exportContacts(
    outputDir: string,
    options: ContactExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; successCount?: number; error?: string }> {
    try {
      if (!this.dbDir) {
        const connectResult = await this.connect()
        if (!connectResult.success) {
          return { success: false, error: connectResult.error }
        }
      }

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: '通讯录',
        phase: 'preparing',
        detail: '正在连接数据库...'
      })

      if (!this.contactDb) {
        return { success: false, error: '联系人数据库未连接' }
      }

      // 确保输出目录存在
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
      }

      // 获取表结构
      const columns = this.contactDb.prepare("PRAGMA table_info(contact)").all() as any[]
      const columnNames = columns.map((c: any) => c.name)

      // 打印所有列名用于调试
      console.log('Contact table columns:', columnNames)

      const hasBigHeadUrl = columnNames.includes('big_head_url')
      const hasSmallHeadUrl = columnNames.includes('small_head_url')
      const hasLocalType = columnNames.includes('local_type')
      // 微信数据库中手机号可能的字段名
      const hasMobile = columnNames.includes('mobile')
      const hasPhone = columnNames.includes('phone')
      const hasPhoneNumber = columnNames.includes('phone_number')
      const hasTel = columnNames.includes('tel')
      const hasExtraBuffer = columnNames.includes('extra_buffer')
      const hasDescription = columnNames.includes('description')

      const selectCols = ['username', 'remark', 'nick_name', 'alias']
      if (hasBigHeadUrl) selectCols.push('big_head_url')
      if (hasSmallHeadUrl) selectCols.push('small_head_url')
      if (hasLocalType) selectCols.push('local_type')
      if (hasMobile) selectCols.push('mobile')
      if (hasPhone) selectCols.push('phone')
      if (hasPhoneNumber) selectCols.push('phone_number')
      if (hasTel) selectCols.push('tel')
      if (hasExtraBuffer) selectCols.push('extra_buffer')
      if (hasDescription) selectCols.push('description')

      onProgress?.({
        current: 20,
        total: 100,
        currentSession: '通讯录',
        phase: 'exporting',
        detail: '正在读取联系人数据...'
      })

      const rows = this.contactDb.prepare(`
        SELECT ${selectCols.join(', ')} FROM contact
      `).all() as any[]

      // 过滤和转换联系人
      const contacts: any[] = []
      for (const row of rows) {
        const username = row.username || ''

        // 过滤系统账号
        if (!username || username === 'filehelper' || username === 'fmessage' ||
          username === 'floatbottle' || username === 'medianote' ||
          username === 'newsapp' || username.startsWith('fake_')) {
          continue
        }

        // 如果指定了选中列表且不为空，则只导出选中的
        if (options.selectedUsernames && options.selectedUsernames.length > 0) {
          if (!options.selectedUsernames.includes(username)) {
            continue
          }
        }

        // 判断类型
        let type: 'friend' | 'group' | 'official' | 'other' = 'friend'
        if (username.includes('@chatroom')) {
          type = 'group'
        } else if (username.startsWith('gh_')) {
          type = 'official'
        } else if (hasLocalType) {
          const localType = row.local_type || 0
          if (localType === 3) type = 'official'
        }

        // 仅当没有指定选中列表时，才应用类型过滤
        if (!options.selectedUsernames || options.selectedUsernames.length === 0) {
          if (type === 'friend' && !options.contactTypes.friends) continue
          if (type === 'group' && !options.contactTypes.groups) continue
          if (type === 'official' && !options.contactTypes.officials) continue
        }

        const displayName = row.remark || row.nick_name || row.alias || username
        let avatarUrl: string | undefined
        if (options.exportAvatars) {
          if (hasBigHeadUrl && row.big_head_url) {
            avatarUrl = row.big_head_url
          } else if (hasSmallHeadUrl && row.small_head_url) {
            avatarUrl = row.small_head_url
          }
        }

        // 获取手机号 - 尝试多个可能的字段
        let mobile = row.mobile || row.phone || row.phone_number || row.tel || ''

        // 如果有 extra_buffer，尝试从中解析手机号
        if (!mobile && row.extra_buffer) {
          const phoneMatch = this.extractPhoneFromExtraBuf(row.extra_buffer)
          if (phoneMatch) mobile = phoneMatch
        }

        contacts.push({
          username,
          displayName,
          remark: row.remark || '',
          nickname: row.nick_name || '',
          alias: row.alias || '',
          mobile,
          type,
          avatarUrl
        })
      }

      onProgress?.({
        current: 60,
        total: 100,
        currentSession: '通讯录',
        phase: 'writing',
        detail: `正在处理 ${contacts.length} 个联系人...`
      })

      // 按类型和名称排序
      contacts.sort((a, b) => {
        const typeOrder: Record<string, number> = { friend: 0, group: 1, official: 2, other: 3 }
        if (typeOrder[a.type] !== typeOrder[b.type]) {
          return typeOrder[a.type] - typeOrder[b.type]
        }
        return a.displayName.localeCompare(b.displayName, 'zh-CN')
      })

      // 根据格式导出
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      let outputPath: string

      if (options.format === 'json') {
        outputPath = path.join(outputDir, `contacts_${timestamp}.json`)
        const exportData = {
          exportInfo: {
            version: '1.0.0',
            exportedAt: Math.floor(Date.now() / 1000),
            generator: 'VXdaochu',
            platform: 'wechat'
          },
          statistics: {
            total: contacts.length,
            friends: contacts.filter(c => c.type === 'friend').length,
            groups: contacts.filter(c => c.type === 'group').length,
            officials: contacts.filter(c => c.type === 'official').length
          },
          contacts
        }
        fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2), 'utf-8')
      } else if (options.format === 'csv') {
        outputPath = path.join(outputDir, `contacts_${timestamp}.csv`)
        const headers = ['用户名', '显示名称', '备注', '昵称', '手机号', '类型', '头像URL']
        const csvLines = [headers.join(',')]
        for (const c of contacts) {
          const row = [
            `"${c.username}"`,
            `"${c.displayName.replace(/"/g, '""')}"`,
            `"${(c.remark || '').replace(/"/g, '""')}"`,
            `"${(c.nickname || '').replace(/"/g, '""')}"`,
            `"${c.mobile || ''}"`,
            `"${c.type}"`,
            `"${c.avatarUrl || ''}"`
          ]
          csvLines.push(row.join(','))
        }
        // 添加 BOM 以支持 Excel 正确识别 UTF-8
        fs.writeFileSync(outputPath, '\ufeff' + csvLines.join('\n'), 'utf-8')
      } else if (options.format === 'vcf') {
        outputPath = path.join(outputDir, `contacts_${timestamp}.vcf`)
        const vcfLines: string[] = []
        for (const c of contacts) {
          if (c.type === 'group') continue // vCard 不支持群组
          vcfLines.push('BEGIN:VCARD')
          vcfLines.push('VERSION:3.0')
          // 如果有备注，显示名称用备注，原昵称放到 ORG 或 NOTE
          if (c.remark && c.remark !== c.nickname) {
            vcfLines.push(`FN:${c.remark}`)
            // N 字段：姓;名;中间名;前缀;后缀
            vcfLines.push(`N:${c.remark};;;;`)
            if (c.nickname) vcfLines.push(`NICKNAME:${c.nickname}`)
            vcfLines.push(`NOTE:微信昵称: ${c.nickname || c.username}`)
          } else {
            vcfLines.push(`FN:${c.displayName}`)
            vcfLines.push(`N:${c.displayName};;;;`)
            if (c.nickname && c.nickname !== c.displayName) {
              vcfLines.push(`NICKNAME:${c.nickname}`)
            }
          }
          if (c.mobile) vcfLines.push(`TEL;TYPE=CELL:${c.mobile}`)
          vcfLines.push(`X-WECHAT-ID:${c.username}`)
          if (c.avatarUrl) vcfLines.push(`PHOTO;VALUE=URI:${c.avatarUrl}`)
          vcfLines.push('END:VCARD')
          vcfLines.push('')
        }
        fs.writeFileSync(outputPath, vcfLines.join('\n'), 'utf-8')
      } else {
        return { success: false, error: `不支持的格式: ${options.format}` }
      }

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: '通讯录',
        phase: 'complete',
        detail: '导出完成'
      })

      return { success: true, successCount: contacts.length }
    } catch (e) {
      console.error('ExportService: 导出通讯录失败:', e)
      return { success: false, error: String(e) }
    }
  }
}

export const exportService = new ExportService()
