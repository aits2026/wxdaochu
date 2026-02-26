import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { getActiveProfileId, getProfileDir } from './profileStorage'

export interface ExportRecord {
  exportTime: number   // Unix ms
  format: string
  messageCount: number // 导出时的消息总数
  outputDir?: string   // 导出位置（兼容旧数据；新数据可能为文件或目录路径）
  outputTargetType?: 'file' | 'directory'
  exportImagesIncluded?: boolean
  exportVideosIncluded?: boolean
  exportEmojisIncluded?: boolean
  exportVoicesIncluded?: boolean
  exportKind?: 'chat' | 'image-assets' | 'video-assets' | 'emoji-assets' | 'voice-assets'
  sourceLatestMessageTimestamp?: number // Unix 秒
  emojiItemCount?: number
}

type RecordStore = { [sessionUsername: string]: ExportRecord[] }

export class ExportRecordService {
  private filePath: string
  private store: RecordStore = {}

  constructor() {
    const profileDir = getProfileDir(getActiveProfileId())
    fs.mkdirSync(profileDir, { recursive: true })
    this.filePath = path.join(profileDir, 'export-records.json')
    const legacyPath = path.join(app.getPath('userData'), 'export-records.json')
    if (!fs.existsSync(this.filePath) && fs.existsSync(legacyPath)) {
      try {
        fs.copyFileSync(legacyPath, this.filePath)
      } catch (e) {
        console.warn('[ExportRecord] 迁移旧导出记录失败:', e)
      }
    }
    this.load()
  }

  private load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        this.store = JSON.parse(raw)
      }
    } catch {
      this.store = {}
    }
  }

  private save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.store), 'utf-8')
    } catch { }
  }

  getRecords(sessionUsername: string): ExportRecord[] {
    return (this.store[sessionUsername] || []).slice().reverse() // 最新在前
  }

  getLatestRecordTimes(sessionUsernames: string[]): Record<string, number> {
    const result: Record<string, number> = {}
    for (const sessionUsername of sessionUsernames) {
      const records = this.store[sessionUsername]
      if (!records || records.length === 0) continue
      const latest = records[records.length - 1]
      if (latest?.exportTime) {
        result[sessionUsername] = latest.exportTime
      }
    }
    return result
  }

  getEmojiExportFlags(sessionUsernames: string[]): Record<string, boolean> {
    const result: Record<string, boolean> = {}
    for (const sessionUsername of sessionUsernames) {
      const records = this.store[sessionUsername]
      if (!records || records.length === 0) continue
      if (records.some(record => record?.exportEmojisIncluded === true)) {
        result[sessionUsername] = true
      }
    }
    return result
  }

  getLatestEmojiExportTimes(sessionUsernames: string[]): Record<string, number> {
    const result: Record<string, number> = {}
    for (const sessionUsername of sessionUsernames) {
      const records = this.store[sessionUsername]
      if (!records || records.length === 0) continue
      for (let i = records.length - 1; i >= 0; i--) {
        const record = records[i]
        if (!record) continue
        if (record.exportEmojisIncluded === true || record.exportKind === 'emoji-assets') {
          if (record.exportTime) result[sessionUsername] = record.exportTime
          break
        }
      }
    }
    return result
  }

  getLatestImageExportTimes(sessionUsernames: string[]): Record<string, number> {
    const result: Record<string, number> = {}
    for (const sessionUsername of sessionUsernames) {
      const records = this.store[sessionUsername]
      if (!records || records.length === 0) continue
      for (let i = records.length - 1; i >= 0; i--) {
        const record = records[i]
        if (!record) continue
        if (record.exportImagesIncluded === true || record.exportKind === 'image-assets') {
          if (record.exportTime) result[sessionUsername] = record.exportTime
          break
        }
      }
    }
    return result
  }

  getLatestVideoExportTimes(sessionUsernames: string[]): Record<string, number> {
    const result: Record<string, number> = {}
    for (const sessionUsername of sessionUsernames) {
      const records = this.store[sessionUsername]
      if (!records || records.length === 0) continue
      for (let i = records.length - 1; i >= 0; i--) {
        const record = records[i]
        if (!record) continue
        if (record.exportVideosIncluded === true || record.exportKind === 'video-assets') {
          if (record.exportTime) result[sessionUsername] = record.exportTime
          break
        }
      }
    }
    return result
  }

  getLatestVoiceExportTimes(sessionUsernames: string[]): Record<string, number> {
    const result: Record<string, number> = {}
    for (const sessionUsername of sessionUsernames) {
      const records = this.store[sessionUsername]
      if (!records || records.length === 0) continue
      for (let i = records.length - 1; i >= 0; i--) {
        const record = records[i]
        if (!record) continue
        if (record.exportVoicesIncluded === true || record.exportKind === 'voice-assets') {
          if (record.exportTime) result[sessionUsername] = record.exportTime
          break
        }
      }
    }
    return result
  }

  getLatestRecord(sessionUsername: string, format?: string): ExportRecord | null {
    const records = this.store[sessionUsername]
    if (!records || records.length === 0) return null

    if (!format) {
      return records[records.length - 1] || null
    }

    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i]
      if (record?.format === format) return record
    }
    return null
  }

  saveRecord(
    sessionUsername: string,
    format: string,
    messageCount: number,
    outputDir?: string,
    outputTargetType?: 'file' | 'directory',
    exportEmojisIncluded?: boolean,
    extra?: {
      exportKind?: 'chat' | 'image-assets' | 'video-assets' | 'emoji-assets' | 'voice-assets'
      exportImagesIncluded?: boolean
      exportVideosIncluded?: boolean
      exportVoicesIncluded?: boolean
      sourceLatestMessageTimestamp?: number
      emojiItemCount?: number
    }
  ) {
    if (!this.store[sessionUsername]) {
      this.store[sessionUsername] = []
    }
    this.store[sessionUsername].push({
      exportTime: Date.now(),
      format,
      messageCount,
      outputDir,
      outputTargetType,
      exportImagesIncluded: extra?.exportImagesIncluded,
      exportVideosIncluded: extra?.exportVideosIncluded,
      exportEmojisIncluded,
      exportVoicesIncluded: extra?.exportVoicesIncluded,
      exportKind: extra?.exportKind,
      sourceLatestMessageTimestamp: extra?.sourceLatestMessageTimestamp,
      emojiItemCount: extra?.emojiItemCount
    })
    this.save()
  }
}

export const exportRecordService = new ExportRecordService()
