import { app } from 'electron'
import path from 'path'
import fs from 'fs'

export interface ExportRecord {
  exportTime: number   // Unix ms
  format: string
  messageCount: number // 导出时的消息总数
}

type RecordStore = { [sessionUsername: string]: ExportRecord[] }

export class ExportRecordService {
  private filePath: string
  private store: RecordStore = {}

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'export-records.json')
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

  saveRecord(sessionUsername: string, format: string, messageCount: number) {
    if (!this.store[sessionUsername]) {
      this.store[sessionUsername] = []
    }
    this.store[sessionUsername].push({
      exportTime: Date.now(),
      format,
      messageCount,
    })
    this.save()
  }
}

export const exportRecordService = new ExportRecordService()
