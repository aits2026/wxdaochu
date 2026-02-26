import { create } from 'zustand'

export type GlobalTaskStatus = 'pending' | 'running' | 'success' | 'error'
export type GlobalTaskKind = 'chat-export' | 'chat-export-batch' | 'image-decrypt'

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
  outputTargetType?: 'file' | 'directory'
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
  sessionCurrent?: number
  sessionTotal?: number
  stepCurrent?: number
  stepTotal?: number
  stepUnit?: string
}

interface TaskCenterState {
  tasks: GlobalTaskRecord[]
  activeExportTaskId: string | null
  isTaskCenterOpen: boolean
  highlightedTaskId: string | null
  upsertTask: (task: GlobalTaskRecord) => void
  patchTask: (taskId: string, patch: TaskPatch) => void
  removeTask: (taskId: string) => void
  clearFinishedTasks: () => void
  setActiveExportTaskId: (taskId: string | null) => void
  setTaskCenterOpen: (open: boolean) => void
  openTaskCenter: () => void
  closeTaskCenter: () => void
  highlightTask: (taskId: string) => void
  clearTaskHighlight: (taskId?: string) => void
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
  isTaskCenterOpen: false,
  highlightedTaskId: null,

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
    activeExportTaskId: state.activeExportTaskId === taskId ? null : state.activeExportTaskId,
    highlightedTaskId: state.highlightedTaskId === taskId ? null : state.highlightedTaskId
  })),

  clearFinishedTasks: () => set(state => {
    const tasks = state.tasks.filter(task => task.status === 'pending' || task.status === 'running')
    const highlightedStillExists = tasks.some(task => task.id === state.highlightedTaskId)
    return {
      tasks,
      highlightedTaskId: highlightedStillExists ? state.highlightedTaskId : null
    }
  }),

  setActiveExportTaskId: (taskId) => set({ activeExportTaskId: taskId }),
  setTaskCenterOpen: (open) => set({ isTaskCenterOpen: open }),
  openTaskCenter: () => set({ isTaskCenterOpen: true }),
  closeTaskCenter: () => set({ isTaskCenterOpen: false }),
  highlightTask: (taskId) => set({ highlightedTaskId: taskId }),
  clearTaskHighlight: (taskId) => set(state => ({
    highlightedTaskId: taskId && state.highlightedTaskId !== taskId ? state.highlightedTaskId : null
  })),

  updateActiveExportProgress: (progress) => {
    const state = get()
    let targetTaskId = state.activeExportTaskId
    let targetTask = targetTaskId ? state.tasks.find(task => task.id === targetTaskId) : undefined

    // 批量聊天文本导出使用聚合任务自行更新，不消费高频 export.onProgress。
    if (targetTask && targetTask.kind !== 'chat-export') {
      return
    }

    if (!targetTaskId) {
      let fallbackTask: GlobalTaskRecord | undefined
      for (const task of state.tasks) {
        if (task.kind !== 'chat-export' || task.status !== 'running') continue
        if (!fallbackTask || task.updatedAt > fallbackTask.updatedAt) {
          fallbackTask = task
        }
      }
      targetTaskId = fallbackTask?.id || null
      targetTask = fallbackTask
    }

    if (!targetTaskId) return

    const phase = progress.phase ? (EXPORT_PHASE_LABEL_MAP[progress.phase] || progress.phase) : undefined
    const hasProgressNumbers = (
      progress.stepCurrent !== undefined ||
      progress.stepTotal !== undefined ||
      progress.current !== undefined ||
      progress.total !== undefined
    )
    const progressCurrent = hasProgressNumbers
      ? Number(progress.stepCurrent ?? progress.current ?? 0)
      : (targetTask?.progressCurrent ?? 0)
    const progressTotal = hasProgressNumbers
      ? Number(progress.stepTotal ?? progress.total ?? 0)
      : (targetTask?.progressTotal ?? 0)
    get().patchTask(targetTaskId, {
      progressCurrent,
      progressTotal,
      unitLabel: progress.stepUnit || (hasProgressNumbers ? (progressTotal === 100 ? '%' : undefined) : targetTask?.unitLabel),
      currentName: progress.currentSession || '',
      phase,
      detail: progress.detail || ''
    })
  }
}))
