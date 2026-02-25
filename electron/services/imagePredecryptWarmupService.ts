import { chatService, type ChatSession } from './chatService'
import { ConfigService } from './config'
import { imageDecryptService } from './imageDecryptService'

type TriggerState = {
  reason: string
  delayMs: number
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class ImagePredecryptWarmupService {
  private configService = new ConfigService()
  private started = false
  private timer: NodeJS.Timeout | null = null
  private running = false
  private rerunRequested = false
  private rerunTrigger: TriggerState | null = null
  private exportBusyCount = 0
  private stopSignal = 0
  private sessionScanVersion = new Map<string, number>()
  private imageFailureBackoffUntil = new Map<string, number>()
  private lastFullRescanAt = 0
  private passCounter = 0

  private readonly startupDelayMs = 30_000
  private readonly triggerDelayMs = 8_000
  private readonly retryDelayMs = 60_000
  private readonly idleIntervalMs = 30 * 60_000
  private readonly exportRetryDelayMs = 15_000
  private readonly fullRescanIntervalMs = 6 * 60 * 60_000
  private readonly imageFailureBackoffMs = 3 * 60 * 60_000
  private readonly perImageYieldEvery = 12
  private readonly perImageYieldMs = 8

  start(): void {
    if (this.started) return
    this.started = true
    this.schedule({ reason: 'startup', delayMs: this.startupDelayMs })
  }

  stop(): void {
    this.started = false
    this.stopSignal++
    this.clearTimer()
  }

  notifyChatReady(reason = 'chat-ready'): void {
    this.kick(reason, this.triggerDelayMs)
  }

  notifySessionsUpdated(): void {
    this.kick('sessions-updated', this.triggerDelayMs)
  }

  setExportBusy(busy: boolean): void {
    if (busy) {
      this.exportBusyCount++
      this.stopSignal++
      return
    }

    this.exportBusyCount = Math.max(0, this.exportBusyCount - 1)
    if (this.exportBusyCount === 0) {
      this.kick('export-finished', this.exportRetryDelayMs)
    }
  }

  private kick(reason: string, delayMs = this.triggerDelayMs): void {
    if (!this.started) return

    if (this.running) {
      this.rerunRequested = true
      if (!this.rerunTrigger || delayMs < this.rerunTrigger.delayMs) {
        this.rerunTrigger = { reason, delayMs }
      }
      return
    }

    if (this.exportBusyCount > 0) {
      this.schedule({ reason: 'export-busy-retry', delayMs: Math.min(delayMs, this.exportRetryDelayMs) })
      return
    }

    this.schedule({ reason, delayMs })
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private schedule(trigger: TriggerState): void {
    if (!this.started) return

    if (this.timer) {
      this.clearTimer()
    }

    this.timer = setTimeout(() => {
      this.timer = null
      void this.run(trigger)
    }, Math.max(0, trigger.delayMs))

    if (typeof (this.timer as any).unref === 'function') {
      ; (this.timer as any).unref()
    }
  }

  private shouldStop(runSignal: number): boolean {
    return !this.started || this.exportBusyCount > 0 || runSignal !== this.stopSignal
  }

  private getSessionRevision(session: ChatSession): number {
    return Number(session.lastTimestamp || session.sortTimestamp || 0)
  }

  private getImageKey(sessionId: string, image: { imageMd5?: string; imageDatName?: string }): string | null {
    const key = image.imageMd5 || image.imageDatName
    if (!key) return null
    return `${sessionId}:${key}`
  }

  private shouldBackoffImage(imageKey: string, now: number): boolean {
    const until = this.imageFailureBackoffUntil.get(imageKey)
    if (!until) return false
    if (until <= now) {
      this.imageFailureBackoffUntil.delete(imageKey)
      return false
    }
    return true
  }

  private onImageDecryptResult(imageKey: string, success: boolean, now: number): void {
    if (success) {
      this.imageFailureBackoffUntil.delete(imageKey)
      return
    }
    this.imageFailureBackoffUntil.set(imageKey, now + this.imageFailureBackoffMs)
  }

  private async run(trigger: TriggerState): Promise<void> {
    if (!this.started) return
    if (this.running) {
      this.rerunRequested = true
      if (!this.rerunTrigger || trigger.delayMs < this.rerunTrigger.delayMs) {
        this.rerunTrigger = trigger
      }
      return
    }

    if (this.exportBusyCount > 0) {
      this.schedule({ reason: 'export-busy', delayMs: this.exportRetryDelayMs })
      return
    }

    this.running = true
    this.passCounter += 1
    const passNo = this.passCounter
    const runSignal = this.stopSignal
    const startedAt = Date.now()
    let interrupted = false

    let processedSessions = 0
    let processedImages = 0
    let decryptedSuccess = 0
    let decryptFailed = 0
    let skippedBackoff = 0

    try {
      const wxid = String(this.configService.get('myWxid') || '').trim()
      const dbPath = String(this.configService.get('dbPath') || '').trim()
      const imageXorKey = String(this.configService.get('imageXorKey') || '').trim()
      if (!wxid || !dbPath || !imageXorKey) {
        this.schedule({ reason: 'preconditions-not-ready', delayMs: this.retryDelayMs })
        return
      }

      const sessionsResult = await chatService.getSessions()
      if (!sessionsResult.success || !sessionsResult.sessions) {
        this.schedule({ reason: 'chat-not-ready', delayMs: this.retryDelayMs })
        return
      }

      const sessions = sessionsResult.sessions
      if (sessions.length === 0) {
        this.schedule({ reason: 'no-sessions', delayMs: this.idleIntervalMs })
        return
      }

      const now = Date.now()
      const fullRescan = (now - this.lastFullRescanAt) >= this.fullRescanIntervalMs || this.lastFullRescanAt === 0
      if (fullRescan) {
        this.lastFullRescanAt = now
      }

      for (const session of sessions) {
        if (this.shouldStop(runSignal)) {
          interrupted = true
          break
        }

        const sessionId = session.username
        if (!sessionId) continue

        const sessionRevision = this.getSessionRevision(session)
        const lastScannedRevision = this.sessionScanVersion.get(sessionId)
        if (!fullRescan && lastScannedRevision !== undefined && lastScannedRevision === sessionRevision) {
          continue
        }

        const imagesResult = await chatService.getAllImageMessages(sessionId)
        if (!imagesResult.success || !imagesResult.images) {
          continue
        }

        processedSessions++
        const images = imagesResult.images

        let sessionInterrupted = false
        for (let i = 0; i < images.length; i++) {
          if (this.shouldStop(runSignal)) {
            interrupted = true
            sessionInterrupted = true
            break
          }

          const image = images[i]
          const imageKey = this.getImageKey(sessionId, image)
          if (!imageKey) continue

          const nowTs = Date.now()
          if (this.shouldBackoffImage(imageKey, nowTs)) {
            skippedBackoff++
            continue
          }

          processedImages++
          try {
            const result = await imageDecryptService.decryptImage({
              sessionId,
              imageMd5: image.imageMd5,
              imageDatName: image.imageDatName
            })
            const ok = Boolean(result.success && result.localPath)
            if (ok) {
              decryptedSuccess++
            } else {
              decryptFailed++
            }
            this.onImageDecryptResult(imageKey, ok, nowTs)
          } catch {
            decryptFailed++
            this.onImageDecryptResult(imageKey, false, nowTs)
          }

          if ((i + 1) % this.perImageYieldEvery === 0) {
            await sleep(this.perImageYieldMs)
          }
        }

        if (!sessionInterrupted) {
          this.sessionScanVersion.set(sessionId, sessionRevision)
        }

        if (processedSessions % 5 === 0) {
          await sleep(10)
        }
      }

      const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
      console.log(
        `[ImagePredecrypt] pass #${passNo} (${trigger.reason}) ` +
        `${interrupted ? 'interrupted' : 'done'}; sessions=${processedSessions}, images=${processedImages}, ` +
        `ok=${decryptedSuccess}, fail=${decryptFailed}, backoffSkip=${skippedBackoff}, ${elapsedSec}s`
      )

      if (interrupted) {
        this.schedule({
          reason: this.exportBusyCount > 0 ? 'reschedule-after-interrupt' : 'continue-after-interrupt',
          delayMs: this.exportBusyCount > 0 ? this.exportRetryDelayMs : this.triggerDelayMs
        })
        return
      }

      if (this.rerunRequested) {
        const rerunTrigger = this.rerunTrigger || { reason: 'rerun', delayMs: this.triggerDelayMs }
        this.rerunRequested = false
        this.rerunTrigger = null
        this.schedule(rerunTrigger)
        return
      }

      this.schedule({ reason: 'idle-loop', delayMs: this.idleIntervalMs })
    } finally {
      this.running = false
    }
  }
}

export const imagePredecryptWarmupService = new ImagePredecryptWarmupService()
