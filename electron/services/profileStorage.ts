import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'

export interface ProfileRegistryItem {
  id: string
  wxid?: string
  nickName?: string
  alias?: string
  avatarUrl?: string
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}

export interface ProfileRegistry {
  version: 1
  activeProfileId: string
  profiles: ProfileRegistryItem[]
}

const PROFILE_REGISTRY_FILENAME = 'profiles-registry.json'
const PROFILE_PENDING_RESETS_FILENAME = 'profiles-pending-resets.json'
const PROFILES_DIRNAME = 'profiles'
const PROFILE_CONFIG_FILENAME = 'vxdaochu-config.db'
const DEFAULT_PROFILE_ID = 'default'

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

export function getUserDataPath(): string {
  return app.getPath('userData')
}

export function getProfilesRootPath(): string {
  return path.join(getUserDataPath(), PROFILES_DIRNAME)
}

export function getProfileDir(profileId: string): string {
  return path.join(getProfilesRootPath(), profileId)
}

export function getProfileConfigDbPath(profileId: string): string {
  return path.join(getProfileDir(profileId), PROFILE_CONFIG_FILENAME)
}

export function getLegacyConfigDbPath(): string {
  return path.join(getUserDataPath(), PROFILE_CONFIG_FILENAME)
}

export function getProfileRegistryPath(): string {
  return path.join(getUserDataPath(), PROFILE_REGISTRY_FILENAME)
}

function getProfilePendingResetsPath(): string {
  return path.join(getUserDataPath(), PROFILE_PENDING_RESETS_FILENAME)
}

function defaultRegistry(): ProfileRegistry {
  const now = Date.now()
  return {
    version: 1,
    activeProfileId: DEFAULT_PROFILE_ID,
    profiles: [
      {
        id: DEFAULT_PROFILE_ID,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: now
      }
    ]
  }
}

function normalizeRegistry(input: Partial<ProfileRegistry> | null | undefined): ProfileRegistry {
  const fallback = defaultRegistry()
  const profiles = Array.isArray(input?.profiles)
    ? input!.profiles
        .filter((item): item is ProfileRegistryItem => !!item && typeof item.id === 'string' && item.id.trim().length > 0)
        .map(item => ({
          id: item.id,
          wxid: item.wxid || '',
          nickName: item.nickName || '',
          alias: item.alias || '',
          avatarUrl: item.avatarUrl || '',
          createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
          updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
          lastUsedAt: typeof item.lastUsedAt === 'number' ? item.lastUsedAt : undefined
        }))
    : fallback.profiles

  const deduped = new Map<string, ProfileRegistryItem>()
  for (const item of profiles) {
    deduped.set(item.id, item)
  }

  if (!deduped.size) {
    deduped.set(fallback.profiles[0].id, fallback.profiles[0])
  }

  let activeProfileId = typeof input?.activeProfileId === 'string' ? input.activeProfileId : fallback.activeProfileId
  if (!deduped.has(activeProfileId)) {
    activeProfileId = Array.from(deduped.keys())[0]
  }

  return {
    version: 1,
    activeProfileId,
    profiles: Array.from(deduped.values())
  }
}

function migrateLegacyConfigIfNeeded(registry: ProfileRegistry): void {
  const legacyConfigPath = getLegacyConfigDbPath()
  if (!fs.existsSync(legacyConfigPath)) return

  const targetPath = getProfileConfigDbPath(DEFAULT_PROFILE_ID)
  ensureDir(path.dirname(targetPath))

  if (fs.existsSync(targetPath)) {
    return
  }

  try {
    fs.renameSync(legacyConfigPath, targetPath)
    return
  } catch (e) {
    try {
      fs.copyFileSync(legacyConfigPath, targetPath)
      fs.unlinkSync(legacyConfigPath)
      return
    } catch (copyErr) {
      console.error('[ProfileStorage] 迁移旧配置文件失败:', copyErr)
    }
  }
}

function getSuggestedCacheBasePath(profileId: string): string {
  if (profileId === DEFAULT_PROFILE_ID) {
    return path.join(app.getPath('documents'), 'VXdaochu')
  }
  return path.join(app.getPath('documents'), 'VXdaochuProfiles', profileId)
}

function readProfileCachePath(profileId: string): string | null {
  const dbPath = getProfileConfigDbPath(profileId)
  if (!fs.existsSync(dbPath)) return null

  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const row = db.prepare("SELECT value FROM config WHERE key = 'cachePath'").get() as { value: string } | undefined
    if (!row) return null
    const parsed = JSON.parse(row.value)
    return typeof parsed === 'string' && parsed.trim().length > 0 ? parsed : null
  } catch {
    return null
  } finally {
    db?.close()
  }
}

function readPendingProfileResets(): string[] {
  const filePath = getProfilePendingResetsPath()
  if (!fs.existsSync(filePath)) return []
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
  } catch {
    return []
  }
}

function writePendingProfileResets(ids: string[]): void {
  const filePath = getProfilePendingResetsPath()
  const normalized = Array.from(new Set(ids.filter(Boolean)))
  if (normalized.length === 0) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    } catch {}
    return
  }
  ensureDir(getUserDataPath())
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), 'utf-8')
}

function safeRemovePath(targetPath: string | null | undefined, kind: 'generic' | 'cachePath' = 'generic'): void {
  if (!targetPath) return
  const normalized = String(targetPath).trim()
  if (!normalized) return
  try {
    const resolved = path.resolve(normalized)
    const root = path.parse(resolved).root
    if (resolved === root) {
      console.error('[ProfileStorage] 拒绝删除根目录:', resolved)
      return
    }
    if (kind === 'cachePath') {
      const protectedPaths = new Set([
        path.resolve(app.getPath('home')),
        path.resolve(app.getPath('documents')),
        path.resolve(app.getPath('downloads')),
        path.resolve(app.getPath('desktop')),
        path.resolve(app.getPath('appData')),
        path.resolve(app.getPath('userData'))
      ])
      if (protectedPaths.has(resolved)) {
        console.error('[ProfileStorage] cachePath 过于宽泛，拒绝整目录删除:', resolved)
        return
      }
    }
    if (fs.existsSync(resolved)) {
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  } catch (e) {
    console.error('[ProfileStorage] 删除路径失败:', normalized, e)
  }
}

function applyPendingProfileResets(registry: ProfileRegistry): ProfileRegistry {
  const pendingIds = readPendingProfileResets()
  if (pendingIds.length === 0) return registry

  const dedupedIds = Array.from(new Set(pendingIds))
  const deletedPaths = new Set<string>()
  const now = Date.now()

  for (const profileId of dedupedIds) {
    const profileDir = getProfileDir(profileId)

    const targets = [profileDir]
    if (profileId === DEFAULT_PROFILE_ID) {
      targets.push(getLegacyConfigDbPath())
    }

    for (const target of targets) {
      if (!target) continue
      const resolved = path.resolve(target)
      if (deletedPaths.has(resolved)) continue
      safeRemovePath(resolved, 'generic')
      deletedPaths.add(resolved)
    }

    ensureDir(profileDir)

    registry.profiles = registry.profiles.map(item =>
      item.id === profileId
        ? {
            ...item,
            updatedAt: now,
            lastUsedAt: item.lastUsedAt ?? now
          }
        : item
    )
  }

  writePendingProfileResets([])
  return registry
}

export function saveProfileRegistry(registry: ProfileRegistry): void {
  const normalized = normalizeRegistry(registry)
  ensureDir(getUserDataPath())
  ensureDir(getProfilesRootPath())
  for (const item of normalized.profiles) {
    ensureDir(getProfileDir(item.id))
  }
  fs.writeFileSync(getProfileRegistryPath(), JSON.stringify(normalized, null, 2), 'utf-8')
}

export function loadProfileRegistry(): ProfileRegistry {
  ensureDir(getUserDataPath())
  ensureDir(getProfilesRootPath())

  let registry = defaultRegistry()
  const registryPath = getProfileRegistryPath()

  if (fs.existsSync(registryPath)) {
    try {
      const raw = fs.readFileSync(registryPath, 'utf-8')
      registry = normalizeRegistry(JSON.parse(raw))
    } catch (e) {
      console.error('[ProfileStorage] 读取 profile 注册表失败，使用默认配置:', e)
      registry = defaultRegistry()
    }
  }

  registry = applyPendingProfileResets(registry)
  migrateLegacyConfigIfNeeded(registry)

  for (const item of registry.profiles) {
    ensureDir(getProfileDir(item.id))
  }

  saveProfileRegistry(registry)
  return registry
}

export function ensureProfileRegistry(): ProfileRegistry {
  return loadProfileRegistry()
}

export function getActiveProfileId(): string {
  return ensureProfileRegistry().activeProfileId
}

export function setActiveProfileId(profileId: string): ProfileRegistry {
  const registry = ensureProfileRegistry()
  if (!registry.profiles.some(item => item.id === profileId)) {
    throw new Error(`Profile 不存在: ${profileId}`)
  }
  registry.activeProfileId = profileId
  const now = Date.now()
  registry.profiles = registry.profiles.map(item =>
    item.id === profileId
      ? { ...item, lastUsedAt: now, updatedAt: now }
      : item
  )
  saveProfileRegistry(registry)
  return registry
}

export function createProfileId(): string {
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function upsertProfileRegistryItem(partial: Partial<ProfileRegistryItem> & { id: string }): ProfileRegistry {
  const registry = ensureProfileRegistry()
  const now = Date.now()
  const idx = registry.profiles.findIndex(item => item.id === partial.id)
  if (idx >= 0) {
    const prev = registry.profiles[idx]
    registry.profiles[idx] = {
      ...prev,
      ...partial,
      id: prev.id,
      updatedAt: now,
      lastUsedAt: partial.lastUsedAt ?? prev.lastUsedAt
    }
  } else {
    registry.profiles.push({
      id: partial.id,
      wxid: partial.wxid || '',
      nickName: partial.nickName || '',
      alias: partial.alias || '',
      avatarUrl: partial.avatarUrl || '',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: partial.lastUsedAt ?? now
    })
  }
  saveProfileRegistry(registry)
  return registry
}

export function deleteProfileRegistryItem(profileId: string): ProfileRegistry {
  const registry = ensureProfileRegistry()
  registry.profiles = registry.profiles.filter(item => item.id !== profileId)
  if (!registry.profiles.length) {
    registry.profiles.push(defaultRegistry().profiles[0])
  }
  if (!registry.profiles.some(item => item.id === registry.activeProfileId)) {
    registry.activeProfileId = registry.profiles[0].id
  }
  saveProfileRegistry(registry)
  return registry
}

export function queueProfileReset(profileId: string): void {
  const existing = readPendingProfileResets()
  writePendingProfileResets([...existing, profileId])
}

export { DEFAULT_PROFILE_ID }
