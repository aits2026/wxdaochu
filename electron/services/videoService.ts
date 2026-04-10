import { basename, dirname, join } from 'path'
import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import { ConfigService } from './config'
import Database from 'better-sqlite3'
import { app } from 'electron'

export interface VideoInfo {
  videoUrl?: string       // 视频文件路径（用�?readFile�?
  coverUrl?: string       // 封面 data URL
  thumbUrl?: string       // 缩略�?data URL
  exists: boolean
}

class VideoService {
  private configService: ConfigService

  constructor() {
    this.configService = new ConfigService()
  }

  /**
   * 获取数据库根目录
   */
  private getDbPath(): string {
    return this.configService.get('dbPath') || ''
  }

  /**
   * 获取当前用户的wxid
   */
  private getMyWxid(): string {
    return this.configService.get('myWxid') || ''
  }

  /**
   * 获取缓存目录（解密后的数据库存放位置�?   */
  private getCachePath(): string {
    const cachePath = this.configService.get('cachePath')
    if (cachePath) return cachePath
    return this.getDefaultCachePath()
  }

  private getDefaultCachePath(): string {
    if (process.env.VITE_DEV_SERVER_URL) {
      const documentsPath = app.getPath('documents')
      return join(documentsPath, 'VXdaochuData')
    }

    const exePath = app.getPath('exe')
    const installDir = dirname(exePath)

    const isOnCDrive = /^[cC]:/i.test(installDir) || installDir.startsWith('\\')
    if (isOnCDrive) {
      const documentsPath = app.getPath('documents')
      return join(documentsPath, 'VXdaochuData')
    }

    return join(installDir, 'VXdaochuData')
  }

  /**
   * 清理 wxid 目录名（去掉后缀�?
   */
  private cleanWxid(wxid: string): string {
    const trimmed = wxid.trim()
    if (!trimmed) return trimmed

    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[^_]+)/i)
      if (match) return match[1]
      return trimmed
    }

    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    if (suffixMatch) return suffixMatch[1]

    return trimmed
  }

  private isDirectory(dirPath: string): boolean {
    try {
      return statSync(dirPath).isDirectory()
    } catch {
      return false
    }
  }

  private isAccountDir(dirPath: string): boolean {
    return (
      existsSync(join(dirPath, 'msg', 'video')) ||
      existsSync(join(dirPath, 'hardlink.db')) ||
      existsSync(join(dirPath, 'db_storage')) ||
      existsSync(join(dirPath, 'msg'))
    )
  }

  private resolveAccountDir(basePath: string, wxid: string): string | undefined {
    const normalized = basePath.replace(/[\\/]+$/, '')
    const cleanedWxid = this.cleanWxid(wxid)

    if (this.isAccountDir(normalized)) {
      return normalized
    }

    const searchBases = new Set<string>([normalized])
    const weChatFilesDir = join(normalized, 'WeChat Files')
    if (this.isDirectory(weChatFilesDir)) {
      searchBases.add(weChatFilesDir)
    }

    for (const baseDir of searchBases) {
      for (const candidate of [wxid, cleanedWxid]) {
        if (!candidate) continue
        const direct = join(baseDir, candidate)
        if (this.isAccountDir(direct)) {
          return direct
        }
      }

      try {
        const entries = readdirSync(baseDir)
        const lowerWxid = wxid.toLowerCase()
        const lowerCleanedWxid = cleanedWxid.toLowerCase()

        for (const entry of entries) {
          const entryPath = join(baseDir, entry)
          if (!this.isDirectory(entryPath)) continue

          const lowerEntry = entry.toLowerCase()
          const cleanedEntry = this.cleanWxid(entry).toLowerCase()
          const matched =
            lowerEntry === lowerWxid ||
            lowerEntry === lowerCleanedWxid ||
            lowerEntry.startsWith(`${lowerWxid}_`) ||
            lowerEntry.startsWith(`${lowerCleanedWxid}_`) ||
            cleanedEntry === lowerWxid ||
            cleanedEntry === lowerCleanedWxid

          if (matched && this.isAccountDir(entryPath)) {
            return entryPath
          }
        }
      } catch {
        // 忽略目录扫描失败
      }
    }

    return undefined
  }

  private collectHardlinkDbCandidates(): string[] {
    const cachePath = this.getCachePath()
    const wxid = this.getMyWxid()
    const cleanedWxid = this.cleanWxid(wxid)
    const dbPath = this.getDbPath()
    const candidates = new Set<string>()

    const addCandidate = (candidatePath?: string) => {
      if (candidatePath) {
        candidates.add(candidatePath)
      }
    }

    const addAccountDirCandidates = (accountDir?: string) => {
      if (!accountDir) return
      addCandidate(join(accountDir, 'hardlink.db'))
      addCandidate(join(accountDir, 'msg', 'hardlink.db'))
      addCandidate(join(accountDir, 'db_storage', 'hardlink', 'hardlink.db'))
    }

    addCandidate(join(cachePath, cleanedWxid, 'hardlink.db'))
    addCandidate(join(cachePath, wxid, 'hardlink.db'))
    addCandidate(join(cachePath, 'hardlink.db'))
    addCandidate(join(cachePath, cleanedWxid, 'db_storage', 'hardlink', 'hardlink.db'))
    addCandidate(join(cachePath, wxid, 'db_storage', 'hardlink', 'hardlink.db'))
    addCandidate(join(cachePath, 'databases', cleanedWxid, 'hardlink.db'))
    addCandidate(join(cachePath, 'databases', wxid, 'hardlink.db'))

    if (dbPath) {
      addAccountDirCandidates(this.resolveAccountDir(dbPath, wxid))
    }
    if (cachePath) {
      addAccountDirCandidates(this.resolveAccountDir(cachePath, wxid))
    }

    return Array.from(candidates).filter(candidatePath => existsSync(candidatePath))
  }

  /**
   * �?video_hardlink_info_v4 表查询视频文件名
   */
  private queryVideoFileName(md5: string): string | undefined {
    if (!md5) return undefined

    const hardlinkDbPaths = this.collectHardlinkDbCandidates()
    if (hardlinkDbPaths.length === 0) return undefined

    for (const hardlinkDbPath of hardlinkDbPaths) {
      try {
        const db = new Database(hardlinkDbPath, { readonly: true })

        try {
          const tableRows = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'video_hardlink_info%' ORDER BY name DESC"
          ).all() as Array<{ name: string }>

          const tableNames = tableRows.length > 0
            ? tableRows.map(row => row.name)
            : ['video_hardlink_info_v4', 'video_hardlink_info_v3', 'video_hardlink_info']

          for (const tableName of tableNames) {
            const columns = db.prepare(`PRAGMA table_info('${tableName}')`).all() as Array<{ name: string }>
            if (columns.length === 0) continue

            const columnMap = new Map<string, string>()
            for (const column of columns) {
              if (column.name) {
                columnMap.set(column.name.toLowerCase(), column.name)
              }
            }

            const md5ColumnLower = ['md5', 'file_md5', 'video_md5'].find(name => columnMap.has(name))
            const fileNameColumnLower = ['file_name', 'filename', 'target_name', 'hardlink_name', 'path'].find(name => columnMap.has(name))

            if (!md5ColumnLower || !fileNameColumnLower) continue

            const md5Column = columnMap.get(md5ColumnLower)!
            const fileNameColumn = columnMap.get(fileNameColumnLower)!
            const row = db.prepare(
              `SELECT ${fileNameColumn} AS fileName FROM ${tableName} WHERE ${md5Column} = ? LIMIT 1`
            ).get(md5) as { fileName?: string } | undefined

            if (row?.fileName) {
              return basename(String(row.fileName)).replace(/\.[^.]+$/, '')
            }
          }
        } finally {
          db.close()
        }
      } catch {
        // 忽略单个 hardlink.db 解析失败
      }
    }

    return undefined
  }

  /**
   * 将文件转换为 data URL
   */
  private fileToDataUrl(filePath: string, mimeType: string): string | undefined {
    try {
      if (!existsSync(filePath)) return undefined
      const buffer = readFileSync(filePath)
      return `data:${mimeType};base64,${buffer.toString('base64')}`
    } catch {
      return undefined
    }
  }

  /**
   * 根据视频MD5获取视频文件信息
   * 视频存放�? {数据库根目录}/{用户wxid}/msg/video/{年月}/
   * 文件命名: {md5}.mp4, {md5}.jpg, {md5}_thumb.jpg
   */
  getVideoInfo(videoMd5: string): VideoInfo {
    const dbPath = this.getDbPath()
    const wxid = this.getMyWxid()

    if (!dbPath || !wxid || !videoMd5) {
      return { exists: false }
    }

    // 先尝试从数据库查询真正的视频文件�?
    const realVideoMd5 = this.queryVideoFileName(videoMd5) || videoMd5
    const accountDir = this.resolveAccountDir(dbPath, wxid)
    if (!accountDir) {
      return { exists: false }
    }

    const videoBaseDirs = [
      join(accountDir, 'msg', 'video'),
      join(accountDir, 'FileStorage', 'Video')
    ].filter(videoBaseDir => existsSync(videoBaseDir))

    if (videoBaseDirs.length === 0) {
      return { exists: false }
    }

    // 遍历年月目录查找视频文件
    try {
      let previewFallback: { coverUrl?: string; thumbUrl?: string } | null = null
      const possibleVideoNames = Array.from(new Set([realVideoMd5, videoMd5].filter(Boolean)))
      const possibleVideoExts = ['.mp4', '.mov', '.m4v']

      for (const videoBaseDir of videoBaseDirs) {
        const allEntries = readdirSync(videoBaseDir)

        const subDirs = allEntries
          .filter(entry => this.isDirectory(join(videoBaseDir, entry)))
          .sort((a, b) => b.localeCompare(a))

        const searchDirs = subDirs.length > 0
          ? subDirs.map(subDir => join(videoBaseDir, subDir))
          : [videoBaseDir]

        for (const dirPath of searchDirs) {
          for (const candidateName of possibleVideoNames) {
            const coverPath = join(dirPath, `${candidateName}.jpg`)
            const thumbPath = join(dirPath, `${candidateName}_thumb.jpg`)
            const coverUrl = this.fileToDataUrl(coverPath, 'image/jpeg')
            const thumbUrl = this.fileToDataUrl(thumbPath, 'image/jpeg')

            for (const ext of possibleVideoExts) {
              const videoPath = join(dirPath, `${candidateName}${ext}`)
              if (existsSync(videoPath)) {
                return {
                  videoUrl: `file:///${videoPath.replace(/\\/g, '/')}`,
                  coverUrl,
                  thumbUrl,
                  exists: true
                }
              }
            }

            if (!previewFallback && (coverUrl || thumbUrl)) {
              previewFallback = { coverUrl, thumbUrl }
            }
          }
        }
      }

      if (previewFallback) {
        return {
          exists: false,
          coverUrl: previewFallback.coverUrl,
          thumbUrl: previewFallback.thumbUrl
        }
      }
    } catch {
      // 忽略错误
    }

    return { exists: false }
  }

  /**
   * 根据消息内容解析视频MD5
   */
  parseVideoMd5(content: string): string | undefined {
    if (!content) return undefined

    try {
      // 尝试从XML中提取md5
      // 格式可能�? <md5>xxx</md5> �?md5="xxx"
      const md5Match = /<md5>([a-fA-F0-9]+)<\/md5>/i.exec(content)
      if (md5Match) {
        return md5Match[1].toLowerCase()
      }

      const attrMatch = /md5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content)
      if (attrMatch) {
        return attrMatch[1].toLowerCase()
      }

      // 尝试从videomsg标签中提�?
      const videoMsgMatch = /<videomsg[^>]*md5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content)
      if (videoMsgMatch) {
        return videoMsgMatch[1].toLowerCase()
      }
    } catch (e) {
      console.error('解析视频MD5失败:', e)
    }

    return undefined
  }
}

export const videoService = new VideoService()
