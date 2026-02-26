import fs from 'fs'
import Database from 'better-sqlite3'
import { ConfigService } from './config'
import {
  createProfileId,
  ensureProfileRegistry,
  getActiveProfileId,
  getProfileConfigDbPath,
  getProfileDir,
  queueProfileReset,
  setActiveProfileId,
  upsertProfileRegistryItem,
  type ProfileRegistryItem
} from './profileStorage'

export interface ProfileSummary {
  id: string
  wxid: string
  nickName: string
  alias: string
  avatarUrl: string
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  isCurrent: boolean
  isProtected: boolean
  authMode: 'none' | 'password' | 'biometric'
  isConfigured: boolean
}

export interface CurrentProfileIdentity {
  wxid?: string
  nickName?: string
  alias?: string
  avatarUrl?: string
}

type ConfigRow = { value: string }

class ProfileService {
  constructor() {
    // 确保注册表在应用启动阶段可用
    ensureProfileRegistry()
  }

  getCurrentProfileId(): string {
    return getActiveProfileId()
  }

  touchCurrentProfile(): void {
    const currentId = this.getCurrentProfileId()
    upsertProfileRegistryItem({ id: currentId, lastUsedAt: Date.now() })
  }

  listProfiles(): ProfileSummary[] {
    const registry = ensureProfileRegistry()
    const currentId = registry.activeProfileId

    const items = registry.profiles.map(item => this.toSummary(item, currentId))
    items.sort((a, b) => {
      if (a.isCurrent && !b.isCurrent) return -1
      if (!a.isCurrent && b.isCurrent) return 1
      return (b.lastUsedAt || 0) - (a.lastUsedAt || 0)
    })
    return items
  }

  getCurrentProfile(): ProfileSummary | null {
    const currentId = this.getCurrentProfileId()
    const current = this.listProfiles().find(item => item.id === currentId)
    return current || null
  }

  createProfile(): ProfileSummary {
    const profileId = createProfileId()
    const now = Date.now()
    ensureProfileRegistry()
    upsertProfileRegistryItem({
      id: profileId,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now
    })

    // 初始化配置库（cachePath 已改为本机共享配置，不在 profile 级别写入）
    const cfg = new ConfigService(profileId)
    cfg.close()

    return this.getProfileById(profileId) || this.toSummary({
      id: profileId,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now
    }, this.getCurrentProfileId())
  }

  switchProfile(profileId: string): { success: boolean; error?: string } {
    const registry = ensureProfileRegistry()
    if (!registry.profiles.some(item => item.id === profileId)) {
      return { success: false, error: '账号不存在' }
    }
    setActiveProfileId(profileId)
    return { success: true }
  }

  updateCurrentProfileIdentity(identity: CurrentProfileIdentity): void {
    const currentId = this.getCurrentProfileId()
    if (!currentId) return

    const payload: Partial<ProfileRegistryItem> & { id: string } = {
      id: currentId,
      lastUsedAt: Date.now()
    }
    if (identity.wxid !== undefined) payload.wxid = identity.wxid || ''
    if (identity.nickName !== undefined) payload.nickName = identity.nickName || ''
    if (identity.alias !== undefined) payload.alias = identity.alias || ''
    if (identity.avatarUrl !== undefined) payload.avatarUrl = identity.avatarUrl || ''
    upsertProfileRegistryItem(payload)
  }

  resetProfileLocalData(profileId: string): { success: boolean; error?: string } {
    if (profileId === this.getCurrentProfileId()) {
      return { success: false, error: '请先切换到其他账号后再重置该账号' }
    }

    try {
      const dir = getProfileDir(profileId)
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
      // 仅保留注册表项，等待用户重新登录后复用该 profile 身份信息
      fs.mkdirSync(dir, { recursive: true })
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  queueResetCurrentProfile(): { success: boolean; profileId?: string; error?: string } {
    try {
      const profileId = this.getCurrentProfileId()
      if (!profileId) {
        return { success: false, error: '当前账号不存在' }
      }
      queueProfileReset(profileId)
      return { success: true, profileId }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  private getProfileById(profileId: string): ProfileSummary | null {
    const registry = ensureProfileRegistry()
    const item = registry.profiles.find(profile => profile.id === profileId)
    if (!item) return null
    return this.toSummary(item, registry.activeProfileId)
  }

  private toSummary(item: ProfileRegistryItem, currentProfileId: string): ProfileSummary {
    const authInfo = this.readAuthInfo(item.id)
    const myWxid = this.readConfigValue(item.id, 'myWxid')

    return {
      id: item.id,
      wxid: String(item.wxid || myWxid || ''),
      nickName: String(item.nickName || ''),
      alias: String(item.alias || ''),
      avatarUrl: String(item.avatarUrl || ''),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      lastUsedAt: item.lastUsedAt,
      isCurrent: item.id === currentProfileId,
      isProtected: authInfo.mode !== 'none',
      authMode: authInfo.mode,
      isConfigured: !!myWxid
    }
  }

  private readAuthInfo(profileId: string): { mode: 'none' | 'password' | 'biometric' } {
    const authEnabled = !!this.readConfigValue(profileId, 'authEnabled')
    if (!authEnabled) return { mode: 'none' }

    const passwordHash = this.readConfigValue(profileId, 'authPasswordHash')
    if (typeof passwordHash === 'string' && passwordHash.trim().length > 0) {
      return { mode: 'password' }
    }

    const credentialId = this.readConfigValue(profileId, 'authCredentialId')
    if (typeof credentialId === 'string' && credentialId.trim().length > 0) {
      return { mode: 'biometric' }
    }

    return { mode: 'none' }
  }

  private readConfigValue(profileId: string, key: string): unknown {
    const dbPath = getProfileConfigDbPath(profileId)
    if (!fs.existsSync(dbPath)) return undefined

    let db: Database.Database | null = null
    try {
      db = new Database(dbPath, { readonly: true })
      const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as ConfigRow | undefined
      if (!row) return undefined
      return JSON.parse(row.value)
    } catch {
      return undefined
    } finally {
      db?.close()
    }
  }
}

export const profileService = new ProfileService()
