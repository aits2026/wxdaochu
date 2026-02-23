import { create } from 'zustand'
import { ReactNode } from 'react'

interface TitleBarState {
  rightContent: ReactNode | null
  setRightContent: (content: ReactNode | null) => void
}

export const useTitleBarStore = create<TitleBarState>((set) => ({
  rightContent: null,
  setRightContent: (content) => set({ rightContent: content })
}))
