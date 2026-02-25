import { create } from 'zustand'

export type ExportPageSessionTypeFilter = 'group' | 'private' | 'official'

export interface ExportPageChatSessionCacheItem {
  username: string
  displayName?: string
  avatarUrl?: string
  summary: string
  lastTimestamp: number
  accountType?: 'friend' | 'group' | 'official'
}

export interface ExportPageChatCacheSnapshot {
  cacheKey: string
  sessions: ExportPageChatSessionCacheItem[]
  sessionMessageCounts: Record<string, number>
  loadedSessionCountUsernames: string[]
  selectedSession: string | null
  searchKeyword: string
  sessionTypeFilter: ExportPageSessionTypeFilter
  dataLoadedAt: number
  dirty: boolean
}

interface ExportPageCacheState {
  chatCache: ExportPageChatCacheSnapshot | null
  setChatCache: (snapshot: ExportPageChatCacheSnapshot) => void
  markChatCacheDirty: () => void
  clearChatCache: () => void
}

export const useExportPageCacheStore = create<ExportPageCacheState>((set) => ({
  chatCache: null,
  setChatCache: (snapshot) => set({ chatCache: snapshot }),
  markChatCacheDirty: () => set((state) => ({
    chatCache: state.chatCache ? { ...state.chatCache, dirty: true } : null
  })),
  clearChatCache: () => set({ chatCache: null })
}))

