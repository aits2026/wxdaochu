export interface LocalProfileSummary {
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

export async function listProfiles(): Promise<LocalProfileSummary[]> {
  return window.electronAPI.profile.list()
}

export async function createAndSwitchProfile(): Promise<{ success: boolean; error?: string; profile?: LocalProfileSummary }> {
  return window.electronAPI.profile.createAndSwitch()
}

export async function switchProfile(profileId: string): Promise<{ success: boolean; error?: string }> {
  return window.electronAPI.profile.switch(profileId)
}

export async function resetCurrentProfileAndRelaunch(): Promise<{ success: boolean; error?: string; profileId?: string }> {
  return window.electronAPI.profile.resetCurrentAndRelaunch()
}

export async function discardCurrentProfileAndRelaunch(targetProfileId?: string): Promise<{ success: boolean; error?: string; removedProfileId?: string; targetProfileId?: string }> {
  return window.electronAPI.profile.discardCurrentAndRelaunch(targetProfileId)
}
