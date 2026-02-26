import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { DEFAULT_PROFILE_ID, ensureProfileRegistry, getActiveProfileId, getProfileConfigDbPath } from './profileStorage'

interface ConfigSchema {
  // 数据库相关
  dbPath: string
  decryptKey: string
  myWxid: string

  // 图片解密相关
  imageXorKey: string
  imageAesKey: string

  // 缓存相关
  cachePath: string
  lastOpenedDb: string
  lastSession: string

  // 导出相关
  exportPath: string

  // 界面相关
  theme: string
  themeMode: string
  appIcon: string
  language: string

  // 协议相关
  agreementVersion: number

  // 激活相关
  activationData: string

  // STT 相关
  sttLanguages: string[]
  sttModelType: 'int8' | 'float32'
  sttMode: 'cpu' | 'gpu'  // STT 模式：CPU (SenseVoice) 或 GPU (Whisper)
  whisperModelType: 'tiny' | 'base' | 'small' | 'medium'  // Whisper 模型类型

  // 日志相关
  logLevel: string

  // 数据管理相关
  skipIntegrityCheck: boolean
  autoUpdateDatabase: boolean  // 是否自动更新数据库
  // 自动同步高级参数
  autoUpdateCheckInterval: number     // 检查间隔（秒）
  autoUpdateMinInterval: number       // 最小更新间隔（毫秒）
  autoUpdateDebounceTime: number      // 防抖时间（毫秒）

  // AI 相关
  aiCurrentProvider: string  // 当前选中的提供商
  aiProviderConfigs: {  // 每个提供商的独立配置
    [providerId: string]: {
      apiKey: string
      model: string
    }
  }
  aiDefaultTimeRange: number
  aiSummaryDetail: 'simple' | 'normal' | 'detailed'
  aiEnableCache: boolean
  aiEnableThinking: boolean  // 是否显示思考过程
  aiMessageLimit: number     // 摘要提取的消息条数限制
}

const defaults: ConfigSchema = {
  dbPath: '',
  decryptKey: '',
  myWxid: '',
  imageXorKey: '',
  imageAesKey: '',
  cachePath: '',
  lastOpenedDb: '',
  lastSession: '',
  exportPath: '',
  theme: 'cloud-dancer',
  themeMode: 'light',
  appIcon: 'default',
  language: 'zh-CN',
  sttLanguages: ['zh'],
  sttModelType: 'int8',
  sttMode: 'cpu',  // 默认使用 CPU 模式
  whisperModelType: 'small',  // 默认使用 small 模型
  agreementVersion: 0,
  activationData: '',
  logLevel: 'WARN', // 默认只记录警告和错误
  skipIntegrityCheck: false, // 默认进行完整性检查
  autoUpdateDatabase: true,  // 默认开启自动更新
  autoUpdateCheckInterval: 60,     // 默认 60 秒检查一次
  autoUpdateMinInterval: 1000,     // 默认最小更新间隔 1 秒
  autoUpdateDebounceTime: 500,     // 默认防抖时间 0.5 秒
  // AI 默认配置
  aiCurrentProvider: 'zhipu',
  aiProviderConfigs: {},  // 空对象，用户配置后填充
  aiDefaultTimeRange: 7, // 默认7天
  aiSummaryDetail: 'normal',
  aiEnableCache: true,
  aiEnableThinking: true,  // 默认显示思考过程
  aiMessageLimit: 3000     // 默认3000条，用户可调至5000
}

type SensitiveConfigKey = 'decryptKey' | 'imageXorKey' | 'imageAesKey' | 'aiProviderConfigs'

const SENSITIVE_CONFIG_KEYS: SensitiveConfigKey[] = [
  'decryptKey',
  'imageXorKey',
  'imageAesKey',
  'aiProviderConfigs'
]

const SECURE_SECRETS_ENVELOPE_KEY = '__secureSecretsEnvelope'
const SECURE_SECRETS_VERSION = 1
const SHARED_MACHINE_CONFIG_FILENAME = 'vxdaochu-machine-config.json'
const SHARED_MACHINE_CONFIG_VERSION = 1

interface SharedMachineConfig {
  version: number
  cachePath?: string
}

interface SecureSecretsEnvelope {
  version: number
  alg: 'aes-256-gcm'
  kdf: 'scrypt'
  salt: string
  iv: string
  authTag: string
  ciphertext: string
  nonEmptyKeys: SensitiveConfigKey[]
  updatedAt: number
}

interface UnlockedSecureSecretsCache {
  derivedKey: Buffer
  secrets: Partial<Record<SensitiveConfigKey, ConfigSchema[SensitiveConfigKey]>>
  envelopeSalt: string
}

function isSensitiveConfigKey(key: string): key is SensitiveConfigKey {
  return (SENSITIVE_CONFIG_KEYS as string[]).includes(key)
}

function isNonEmptySensitiveValue(key: SensitiveConfigKey, value: unknown): boolean {
  if (key === 'aiProviderConfigs') {
    return !!value && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length > 0
  }
  return typeof value === 'string' ? value.trim().length > 0 : !!value
}

export class ConfigService {
  private static unlockedSecureSecrets = new Map<string, UnlockedSecureSecretsCache>()
  private db: Database.Database | null = null
  private dbPath: string
  private profileId: string

  constructor(profileId?: string) {
    ensureProfileRegistry()
    this.profileId = profileId || getActiveProfileId()
    this.dbPath = getProfileConfigDbPath(this.profileId)
    this.initDatabase()
  }

  private static getSharedMachineConfigPath(): string {
    return path.join(app.getPath('userData'), SHARED_MACHINE_CONFIG_FILENAME)
  }

  private static readSharedMachineConfig(): SharedMachineConfig {
    const filePath = ConfigService.getSharedMachineConfigPath()
    if (!fs.existsSync(filePath)) {
      return { version: SHARED_MACHINE_CONFIG_VERSION }
    }
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<SharedMachineConfig>
      const next: SharedMachineConfig = {
        version: SHARED_MACHINE_CONFIG_VERSION
      }
      if (typeof parsed?.cachePath === 'string') {
        next.cachePath = parsed.cachePath
      }
      return next
    } catch {
      return { version: SHARED_MACHINE_CONFIG_VERSION }
    }
  }

  private static writeSharedMachineConfig(config: SharedMachineConfig): void {
    try {
      const filePath = ConfigService.getSharedMachineConfigPath()
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      const payload: SharedMachineConfig = {
        version: SHARED_MACHINE_CONFIG_VERSION
      }
      if (typeof config.cachePath === 'string') {
        payload.cachePath = config.cachePath
      }
      fs.writeFileSync(filePath, JSON.stringify(payload), 'utf-8')
    } catch (e) {
      console.error('[Config] 写入本机共享配置失败:', e)
    }
  }

  private static hasSharedCachePath(): boolean {
    const config = ConfigService.readSharedMachineConfig()
    return Object.prototype.hasOwnProperty.call(config, 'cachePath')
  }

  private static getSharedCachePathValue(): string | undefined {
    const config = ConfigService.readSharedMachineConfig()
    if (!Object.prototype.hasOwnProperty.call(config, 'cachePath')) {
      return undefined
    }
    return typeof config.cachePath === 'string' ? config.cachePath : ''
  }

  private static setSharedCachePathValue(nextPath: string): void {
    const config = ConfigService.readSharedMachineConfig()
    config.cachePath = typeof nextPath === 'string' ? nextPath : ''
    ConfigService.writeSharedMachineConfig(config)
  }

  getProfileId(): string {
    return this.profileId
  }

  private getUnlockedSecureSecrets(): UnlockedSecureSecretsCache | null {
    return ConfigService.unlockedSecureSecrets.get(this.profileId) || null
  }

  private setUnlockedSecureSecrets(cache: UnlockedSecureSecretsCache | null): void {
    if (!cache) {
      ConfigService.unlockedSecureSecrets.delete(this.profileId)
      return
    }
    ConfigService.unlockedSecureSecrets.set(this.profileId, cache)
  }

  private readConfigRowValue(key: string): string | null {
    if (!this.db) return null
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  private writeConfigRowValue(key: string, jsonValue: string): void {
    if (!this.db) return
    this.db.prepare(`
      INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)
    `).run(key, jsonValue)
  }

  private deleteConfigRow(key: string): void {
    if (!this.db) return
    this.db.prepare('DELETE FROM config WHERE key = ?').run(key)
  }

  private getRawConfigValue<T = unknown>(key: string): T | undefined {
    const raw = this.readConfigRowValue(key)
    if (raw === null) return undefined
    return JSON.parse(raw) as T
  }

  private setRawConfigValue(key: string, value: unknown): void {
    this.writeConfigRowValue(key, JSON.stringify(value))
  }

  private getSecureSecretsEnvelope(): SecureSecretsEnvelope | null {
    try {
      const env = this.getRawConfigValue<SecureSecretsEnvelope>(SECURE_SECRETS_ENVELOPE_KEY)
      if (!env || typeof env !== 'object') return null
      if (env.version !== SECURE_SECRETS_VERSION) return null
      if (!env.salt || !env.iv || !env.authTag || !env.ciphertext) return null
      return {
        ...env,
        nonEmptyKeys: Array.isArray(env.nonEmptyKeys)
          ? env.nonEmptyKeys.filter((key): key is SensitiveConfigKey => isSensitiveConfigKey(String(key)))
          : []
      }
    } catch {
      return null
    }
  }

  private setSecureSecretsEnvelope(envelope: SecureSecretsEnvelope | null): void {
    if (!this.db) return
    if (!envelope) {
      this.deleteConfigRow(SECURE_SECRETS_ENVELOPE_KEY)
      return
    }
    this.setRawConfigValue(SECURE_SECRETS_ENVELOPE_KEY, envelope)
  }

  private deriveSecureSecretsKey(password: string, saltHex: string): Buffer {
    return crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32)
  }

  private encryptSecureSecretsPayload(
    password: string,
    secrets: Partial<Record<SensitiveConfigKey, ConfigSchema[SensitiveConfigKey]>>
  ): { envelope: SecureSecretsEnvelope; cache: UnlockedSecureSecretsCache } {
    const salt = crypto.randomBytes(16).toString('hex')
    const key = this.deriveSecureSecretsKey(password, salt)
    return this.encryptSecureSecretsPayloadWithDerivedKey(key, salt, secrets)
  }

  private encryptSecureSecretsPayloadWithDerivedKey(
    derivedKey: Buffer,
    saltHex: string,
    secrets: Partial<Record<SensitiveConfigKey, ConfigSchema[SensitiveConfigKey]>>
  ): { envelope: SecureSecretsEnvelope; cache: UnlockedSecureSecretsCache } {
    const iv = crypto.randomBytes(12)
    const plainPayload = JSON.stringify(secrets)
    const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv)
    const ciphertext = Buffer.concat([cipher.update(plainPayload, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()

    const nonEmptyKeys = SENSITIVE_CONFIG_KEYS.filter((key) => isNonEmptySensitiveValue(key, secrets[key]))
    const envelope: SecureSecretsEnvelope = {
      version: SECURE_SECRETS_VERSION,
      alg: 'aes-256-gcm',
      kdf: 'scrypt',
      salt: saltHex,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      ciphertext: ciphertext.toString('hex'),
      nonEmptyKeys,
      updatedAt: Date.now()
    }

    return {
      envelope,
      cache: {
        derivedKey,
        secrets,
        envelopeSalt: saltHex
      }
    }
  }

  private decryptSecureSecretsPayload(
    envelope: SecureSecretsEnvelope,
    password: string
  ): UnlockedSecureSecretsCache {
    const derivedKey = this.deriveSecureSecretsKey(password, envelope.salt)
    const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, Buffer.from(envelope.iv, 'hex'))
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'hex'))
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'hex')),
      decipher.final()
    ]).toString('utf8')
    const parsed = JSON.parse(plain) as Partial<Record<SensitiveConfigKey, ConfigSchema[SensitiveConfigKey]>>

    const secrets: Partial<Record<SensitiveConfigKey, ConfigSchema[SensitiveConfigKey]>> = {}
    for (const key of SENSITIVE_CONFIG_KEYS) {
      if (Object.prototype.hasOwnProperty.call(parsed, key)) {
        secrets[key] = parsed[key] as ConfigSchema[typeof key]
      }
    }

    return {
      derivedKey,
      secrets,
      envelopeSalt: envelope.salt
    }
  }

  private readSensitiveSecretsFromPlaintextRows(): Partial<Record<SensitiveConfigKey, ConfigSchema[SensitiveConfigKey]>> {
    const result: Partial<Record<SensitiveConfigKey, ConfigSchema[SensitiveConfigKey]>> = {}
    for (const key of SENSITIVE_CONFIG_KEYS) {
      const raw = this.readConfigRowValue(key)
      if (raw === null) {
        result[key] = defaults[key]
        continue
      }
      try {
        result[key] = JSON.parse(raw)
      } catch {
        result[key] = defaults[key]
      }
    }
    return result
  }

  private clearSensitivePlaintextRows(): void {
    for (const key of SENSITIVE_CONFIG_KEYS) {
      this.setRawConfigValue(key, defaults[key])
    }
  }

  private persistUnlockedSensitiveSecrets(): void {
    const cache = this.getUnlockedSecureSecrets()
    if (!cache) return
    const { envelope } = this.encryptSecureSecretsPayloadWithDerivedKey(cache.derivedKey, cache.envelopeSalt, cache.secrets)
    this.setSecureSecretsEnvelope(envelope)
    this.clearSensitivePlaintextRows()
  }

  static getSuggestedCacheBasePath(profileId?: string): string {
    void profileId
    return path.join(app.getPath('documents'), 'VXdaochu')
  }

  private readLegacyCachePathFromConfigDb(configDbPath: string): string | null {
    if (!fs.existsSync(configDbPath)) return null
    let db: Database.Database | null = null
    try {
      db = new Database(configDbPath, { readonly: true })
      const row = db.prepare("SELECT value FROM config WHERE key = 'cachePath'").get() as { value: string } | undefined
      if (!row) return null
      const parsed = JSON.parse(row.value)
      if (typeof parsed !== 'string') return null
      return parsed
    } catch {
      return null
    } finally {
      db?.close()
    }
  }

  private ensureSharedCachePathInitialized(): void {
    if (ConfigService.hasSharedCachePath()) return

    const currentProfileCachePath = this.readLegacyCachePathFromConfigDb(this.dbPath)
    if (typeof currentProfileCachePath === 'string' && currentProfileCachePath.trim().length > 0) {
      ConfigService.setSharedCachePathValue(currentProfileCachePath)
      return
    }

    if (this.profileId !== DEFAULT_PROFILE_ID) {
      const defaultProfileCachePath = this.readLegacyCachePathFromConfigDb(getProfileConfigDbPath(DEFAULT_PROFILE_ID))
      if (typeof defaultProfileCachePath === 'string' && defaultProfileCachePath.trim().length > 0) {
        ConfigService.setSharedCachePathValue(defaultProfileCachePath)
      }
    }
  }

  private initDatabase(): void {
    try {
      // 确保目录存在
      const dir = path.dirname(this.dbPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      this.db = new Database(this.dbPath)

      // 创建配置表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `)

      // 创建 TLD 缓存表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tld_cache (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          tlds TEXT,
          updated_at INTEGER
        )
      `)



      // 初始化默认值
      const insertStmt = this.db.prepare(`
        INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)
      `)

      for (const [key, value] of Object.entries(defaults)) {
        insertStmt.run(key, JSON.stringify(value))
      }

      // 兼容迁移：将旧版本账号级 cachePath 提升为本机共享配置（仅迁移一次）
      try {
        this.ensureSharedCachePathInitialized()
      } catch (e) {
        console.error('迁移本机共享缓存目录配置失败:', e)
      }

      // 迁移：修复旧版本产生的空 STT 语言配置，默认为中文
      try {
        const sttRow = this.db.prepare("SELECT value FROM config WHERE key = 'sttLanguages'").get() as { value: string } | undefined
        if (sttRow) {
          const langs = JSON.parse(sttRow.value)
          if (Array.isArray(langs) && langs.length === 0) {
            this.db.prepare("UPDATE config SET value = ? WHERE key = 'sttLanguages'").run(JSON.stringify(['zh']))
          }
        }
      } catch (e) {
        console.error('迁移 STT 配置失败:', e)
      }

      // 迁移：将旧的 AI 配置迁移到新结构（支持多提供商）
      try {
        const oldProviderRow = this.db.prepare("SELECT value FROM config WHERE key = 'aiProvider'").get() as { value: string } | undefined
        const oldApiKeyRow = this.db.prepare("SELECT value FROM config WHERE key = 'aiApiKey'").get() as { value: string } | undefined
        const oldModelRow = this.db.prepare("SELECT value FROM config WHERE key = 'aiModel'").get() as { value: string } | undefined

        if (oldProviderRow && oldApiKeyRow) {
          const oldProvider = JSON.parse(oldProviderRow.value)
          const oldApiKey = JSON.parse(oldApiKeyRow.value)
          const oldModel = oldModelRow ? JSON.parse(oldModelRow.value) : ''

          // 如果有旧配置且 API Key 不为空，迁移到新结构
          if (oldApiKey) {
            const newConfigs: any = {}
            newConfigs[oldProvider] = {
              apiKey: oldApiKey,
              model: oldModel
            }

            this.db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run('aiCurrentProvider', JSON.stringify(oldProvider))
            this.db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run('aiProviderConfigs', JSON.stringify(newConfigs))

            // 删除旧配置
            this.db.prepare("DELETE FROM config WHERE key IN ('aiProvider', 'aiApiKey', 'aiModel')").run()

            console.log('[Config] AI 配置已迁移到新结构')
          }
        }
      } catch (e) {
        console.error('迁移 AI 配置失败:', e)
      }
    } catch (e) {
      console.error('初始化配置数据库失败:', e)
    }
  }

  get<K extends keyof ConfigSchema>(key: K): ConfigSchema[K] {
    try {
      if (String(key) === 'cachePath') {
        const sharedCachePath = ConfigService.getSharedCachePathValue()
        if (sharedCachePath !== undefined) {
          return sharedCachePath as ConfigSchema[K]
        }

        const legacyCachePath = this.readLegacyCachePathFromConfigDb(this.dbPath)
        if (typeof legacyCachePath === 'string' && legacyCachePath.trim().length > 0) {
          ConfigService.setSharedCachePathValue(legacyCachePath)
          return legacyCachePath as ConfigSchema[K]
        }

        return defaults[key]
      }

      if (!this.db) {
        return defaults[key]
      }

      if (isSensitiveConfigKey(String(key))) {
        const envelope = this.getSecureSecretsEnvelope()
        if (envelope) {
          const unlocked = this.getUnlockedSecureSecrets()
          if (!unlocked) {
            return defaults[key]
          }
          if (Object.prototype.hasOwnProperty.call(unlocked.secrets, key)) {
            return (unlocked.secrets[key as SensitiveConfigKey] as ConfigSchema[K]) ?? defaults[key]
          }
          return defaults[key]
        }
      }

      const raw = this.readConfigRowValue(String(key))
      if (raw !== null) {
        return JSON.parse(raw)
      }
      return defaults[key]
    } catch (e) {
      console.error(`获取配置 ${key} 失败:`, e)
      return defaults[key]
    }
  }

  set<K extends keyof ConfigSchema>(key: K, value: ConfigSchema[K]): void {
    try {
      if (String(key) === 'cachePath') {
        ConfigService.setSharedCachePathValue(typeof value === 'string' ? value : '')
        return
      }

      if (!this.db) return

      if (isSensitiveConfigKey(String(key)) && this.getSecureSecretsEnvelope()) {
        const unlocked = this.getUnlockedSecureSecrets()
        if (!unlocked) {
          console.warn(`[Config] profile ${this.profileId} 的敏感配置 ${String(key)} 已加密且当前未解锁，忽略写入`)
          return
        }
        unlocked.secrets[key as SensitiveConfigKey] = value as ConfigSchema[SensitiveConfigKey]
        this.setUnlockedSecureSecrets(unlocked)
        this.persistUnlockedSensitiveSecrets()
        return
      }

      this.writeConfigRowValue(String(key), JSON.stringify(value))
    } catch (e) {
      console.error(`设置配置 ${key} 失败:`, e)
    }
  }

  getAll(): ConfigSchema {
    try {
      if (!this.db) {
        return {
          ...defaults,
          cachePath: this.get('cachePath')
        }
      }
      const rows = this.db.prepare('SELECT key, value FROM config').all() as { key: string; value: string }[]
      const result = { ...defaults }
      for (const row of rows) {
        if (row.key in defaults) {
          (result as any)[row.key] = JSON.parse(row.value)
        }
      }
      result.cachePath = this.get('cachePath')
      const envelope = this.getSecureSecretsEnvelope()
      if (envelope) {
        const unlocked = this.getUnlockedSecureSecrets()
        for (const key of SENSITIVE_CONFIG_KEYS) {
          if (unlocked && Object.prototype.hasOwnProperty.call(unlocked.secrets, key)) {
            ;(result as any)[key] = unlocked.secrets[key]
          } else {
            ;(result as any)[key] = defaults[key]
          }
        }
      }
      return result
    } catch (e) {
      console.error('获取所有配置失败:', e)
      return { ...defaults }
    }
  }

  clear(): void {
    try {
      if (!this.db) return
      this.db.exec('DELETE FROM config')
      this.setUnlockedSecureSecrets(null)
      // 重新插入默认值
      const insertStmt = this.db.prepare(`
        INSERT INTO config (key, value) VALUES (?, ?)
      `)
      for (const [key, value] of Object.entries(defaults)) {
        insertStmt.run(key, JSON.stringify(value))
      }
    } catch (e) {
      console.error('清除配置失败:', e)
    }
  }

  enableSensitiveSecretsProtection(password: string): { success: boolean; error?: string } {
    try {
      if (!this.db) return { success: false, error: '配置数据库未初始化' }
      if (!password) return { success: false, error: '密码不能为空' }

      const existingEnvelope = this.getSecureSecretsEnvelope()
      let secrets: Partial<Record<SensitiveConfigKey, ConfigSchema[SensitiveConfigKey]>>

      if (existingEnvelope) {
        const unlocked = this.getUnlockedSecureSecrets()
        if (unlocked) {
          secrets = unlocked.secrets
        } else {
          secrets = this.decryptSecureSecretsPayload(existingEnvelope, password).secrets
        }
      } else {
        secrets = this.readSensitiveSecretsFromPlaintextRows()
      }

      const { envelope, cache } = this.encryptSecureSecretsPayload(password, secrets)
      this.setSecureSecretsEnvelope(envelope)
      this.clearSensitivePlaintextRows()
      this.setUnlockedSecureSecrets(cache)
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  unlockSensitiveSecrets(password: string): { success: boolean; error?: string } {
    try {
      if (!this.db) return { success: false, error: '配置数据库未初始化' }
      const envelope = this.getSecureSecretsEnvelope()
      if (!envelope) {
        return { success: true }
      }
      const cache = this.decryptSecureSecretsPayload(envelope, password)
      this.setUnlockedSecureSecrets(cache)
      return { success: true }
    } catch (e) {
      return { success: false, error: '敏感配置解锁失败，密码可能错误' }
    }
  }

  lockSensitiveSecrets(): void {
    this.setUnlockedSecureSecrets(null)
  }

  disableSensitiveSecretsProtection(): { success: boolean; error?: string } {
    try {
      if (!this.db) return { success: false, error: '配置数据库未初始化' }
      const envelope = this.getSecureSecretsEnvelope()
      if (!envelope) {
        this.setUnlockedSecureSecrets(null)
        return { success: true }
      }

      const unlocked = this.getUnlockedSecureSecrets()
      if (!unlocked) {
        return { success: false, error: '当前未解锁，无法恢复明文敏感配置' }
      }

      for (const key of SENSITIVE_CONFIG_KEYS) {
        const nextValue = Object.prototype.hasOwnProperty.call(unlocked.secrets, key)
          ? unlocked.secrets[key]
          : defaults[key]
        this.setRawConfigValue(key, nextValue)
      }
      this.setSecureSecretsEnvelope(null)
      this.setUnlockedSecureSecrets(null)
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  hasConfiguredSensitiveValue(key: SensitiveConfigKey): boolean {
    try {
      const raw = this.getRawConfigValue<ConfigSchema[SensitiveConfigKey]>(key)
      if (isNonEmptySensitiveValue(key, raw)) return true
      const envelope = this.getSecureSecretsEnvelope()
      if (!envelope) return false
      return envelope.nonEmptyKeys.includes(key)
    } catch {
      return false
    }
  }

  hasConfiguredDatabaseConnection(): boolean {
    const wxid = this.getRawConfigValue<string>('myWxid') || ''
    const dbPath = this.getRawConfigValue<string>('dbPath') || ''
    const hasDecryptKey = this.hasConfiguredSensitiveValue('decryptKey')
    return !!wxid && !!dbPath && hasDecryptKey
  }

  shouldDeferAutoConnectUntilUnlock(): boolean {
    try {
      const authEnabled = !!this.getRawConfigValue<boolean>('authEnabled')
      if (!authEnabled) return false
      const passwordHash = this.getRawConfigValue<string>('authPasswordHash') || ''
      if (!passwordHash) return false
      const envelope = this.getSecureSecretsEnvelope()
      if (!envelope) return false
      const unlocked = this.getUnlockedSecureSecrets()
      return !unlocked
    } catch {
      return false
    }
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  // TLD 缓存相关方法
  getTldCache(): { tlds: string[]; updatedAt: number } | null {
    try {
      if (!this.db) return null
      const row = this.db.prepare('SELECT tlds, updated_at FROM tld_cache WHERE id = 1').get() as { tlds: string; updated_at: number } | undefined
      if (row) {
        return {
          tlds: JSON.parse(row.tlds),
          updatedAt: row.updated_at
        }
      }
      return null
    } catch (e) {
      console.error('获取 TLD 缓存失败:', e)
      return null
    }
  }

  setTldCache(tlds: string[]): void {
    try {
      if (!this.db) return
      const now = Date.now()
      this.db.prepare(`
        INSERT OR REPLACE INTO tld_cache (id, tlds, updated_at) VALUES (1, ?, ?)
      `).run(JSON.stringify(tlds), now)
    } catch (e) {
      console.error('设置 TLD 缓存失败:', e)
    }
  }

  // AI 配置便捷方法
  getAICurrentProvider(): string {
    return this.get('aiCurrentProvider')
  }

  setAICurrentProvider(provider: string): void {
    this.set('aiCurrentProvider', provider)
  }

  getAIProviderConfig(providerId: string): { apiKey: string; model: string; baseURL?: string } | null {
    const configs = this.get('aiProviderConfigs')
    return configs[providerId] || null
  }

  setAIProviderConfig(providerId: string, config: { apiKey: string; model: string; baseURL?: string }): void {
    const configs = this.get('aiProviderConfigs')
    configs[providerId] = config
    this.set('aiProviderConfigs', configs)
  }

  getAllAIProviderConfigs(): { [providerId: string]: { apiKey: string; model: string; baseURL?: string } } {
    return this.get('aiProviderConfigs')
  }

  getAIMessageLimit(): number {
    return this.get('aiMessageLimit')
  }

  setAIMessageLimit(limit: number): void {
    this.set('aiMessageLimit', limit)
  }

  getCacheBasePath(): string {
    const configured = this.get('cachePath')
    if (configured && configured.trim().length > 0) {
      return configured
    }
    return ConfigService.getSuggestedCacheBasePath()
  }
}
