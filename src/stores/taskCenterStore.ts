import { create } from 'zustand'

export type GlobalTaskStatus = 'pending' | 'running' | 'success' | 'error'
export type GlobalTaskKind = 'chat-export' | 'image-decrypt'

export interface GlobalTaskRecord {
  id: string
  kind: GlobalTaskKind
  typeLabel: string
  sessionId?: string
  sessionName: string
  status: GlobalTaskStatus
  progressCurrent: number
  progressTotal: number
  successCount?: number
  failCount?: number
  unitLabel?: string
  phase?: string
  detail?: string
  currentName?: string
  format?: string
  outputDir?: string
  error?: string
  createdAt: number
  updatedAt: number
}

type TaskPatch = Partial<Omit<GlobalTaskRecord, 'id' | 'createdAt'>> & {
  updatedAt?: number
}

interface ExportProgressPayload {
  current?: number
  total?: number
  currentSession?: string
  phase?: string
  detail?: string
}

interface TaskCenterState {
  tasks: GlobalTaskRecord[]
  activeExportTaskId: string | null
  upsertTask: (task: GlobalTaskRecord) => void
  patchTask: (taskId: string, patch: TaskPatch) => void
  removeTask: (taskId: string) => void
  clearFinishedTasks: () => void
  setActiveExportTaskId: (taskId: string | null) => void
  updateActiveExportProgress: (progress: ExportProgressPayload) => void
}

const EXPORT_PHASE_LABEL_MAP: Record<string, string> = {
  preparing: '正在准备...',
  exporting: '正在导出消息...',
  writing: '正在写入文件...',
  complete: '导出完成'
}

const touchTask = (task: GlobalTaskRecord, patch: TaskPatch): GlobalTaskRecord => ({
  ...task,
  ...patch,
  updatedAt: patch.updatedAt ?? Date.now()
})

export const useTaskCenterStore = create<TaskCenterState>((set, get) => ({
  tasks: [],
  activeExportTaskId: null,

  upsertTask: (task) => set(state => {
    const nextTask = {
      ...task,
      createdAt: task.createdAt || Date.now(),
      updatedAt: task.updatedAt || Date.now()
    }
    const index = state.tasks.findIndex(t => t.id === task.id)
    if (index < 0) {
      return { tasks: [nextTask, ...state.tasks] }
    }
    const tasks = state.tasks.slice()
    tasks[index] = {
      ...tasks[index],
      ...nextTask,
      createdAt: tasks[index].createdAt || nextTask.createdAt,
      updatedAt: nextTask.updatedAt
    }
    return { tasks }
  }),

  patchTask: (taskId, patch) => set(state => {
    const index = state.tasks.findIndex(t => t.id === taskId)
    if (index < 0) return state
    const tasks = state.tasks.slice()
    tasks[index] = touchTask(tasks[index], patch)
    return { tasks }
  }),

  removeTask: (taskId) => set(state => ({
    tasks: state.tasks.filter(task => task.id !== taskId),
    activeExportTaskId: state.activeExportTaskId === taskId ? null : state.activeExportTaskId
  })),

  clearFinishedTasks: () => set(state => ({
    tasks: state.tasks.filter(task => task.status === 'pending' || task.status === 'running')
  })),

  setActiveExportTaskId: (taskId) => set({ activeExportTaskId: taskId }),

  updateActiveExportProgress: (progress) => {
    const state = get()
    const fallbackTask = state.tasks
      .filter(task => task.kind === 'chat-export' && task.status === 'running')
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const targetTaskId = state.activeExportTaskId || fallbackTask?.id
    if (!targetTaskId) return

    const phase = progress.phase ? (EXPORT_PHASE_LABEL_MAP[progress.phase] || progress.phase) : undefined
    get().patchTask(targetTaskId, {
      progressCurrent: Number(progress.current || 0),
      progressTotal: Number(progress.total || 0),
      currentName: progress.currentSession || '',
      phase,
      detail: progress.detail || ''
    })
  }
}))

