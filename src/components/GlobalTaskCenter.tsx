import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle, ExternalLink, ListTodo, Loader2, Trash2, XCircle } from 'lucide-react'
import { GlobalTaskRecord, useTaskCenterStore } from '../stores/taskCenterStore'
import './GlobalTaskCenter.scss'

const formatTaskTime = (timestamp?: number) => {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function TaskCard({
  task,
  onRemove
}: {
  task: GlobalTaskRecord
  onRemove: (taskId: string) => void
}) {
  const isRunning = task.status === 'running'
  const isFinished = task.status === 'success' || task.status === 'error'
  const progressPercent = task.progressTotal > 0
    ? Math.max(0, Math.min(100, (task.progressCurrent / task.progressTotal) * 100))
    : 0
  const unitLabel = task.unitLabel || (task.kind === 'image-decrypt' ? '张' : '项')
  const isSingleSessionChatExport = task.kind === 'chat-export' && Boolean(task.sessionId)
  const hasResultCounts = task.successCount !== undefined || task.failCount !== undefined
  const resultTotal = (task.successCount || 0) + (task.failCount || 0)
  const showProgressMeta = !(isFinished && isSingleSessionChatExport && task.progressCurrent === 1 && task.progressTotal === 1)
  const showResultCounts = hasResultCounts && !(isSingleSessionChatExport && resultTotal <= 1)
  const displayPhase = !isFinished ? (task.phase || '') : ''
  const displayCurrentName = task.currentName && task.currentName !== task.sessionName ? task.currentName : ''

  let displayDetail = task.detail || ''
  if (displayDetail && task.phase) {
    const detailStartsWithPhase = (
      displayDetail === task.phase ||
      displayDetail.startsWith(`${task.phase}，`) ||
      displayDetail.startsWith(`${task.phase},`) ||
      displayDetail.startsWith(`${task.phase} `)
    )
    if (detailStartsWithPhase) {
      displayDetail = ''
    }
  }
  if (task.status === 'error' && (displayDetail === '导出失败' || displayDetail === '解密任务失败')) {
    displayDetail = ''
  }

  return (
    <div className="global-task-center-card">
      <div className="global-task-center-card-top">
        <div className="global-task-center-main">
          <span className="global-task-center-type">{task.typeLabel}</span>
          <span className="global-task-center-name">{task.sessionName}</span>
        </div>
        <span className={`global-task-center-state ${task.status}`}>
          {task.status === 'running' ? (
            <>
              <Loader2 size={11} className="spin" />
              <span>进行中</span>
            </>
          ) : task.status === 'success' ? (
            <>
              <CheckCircle size={11} />
              <span>已完成</span>
            </>
          ) : task.status === 'error' ? (
            <>
              <XCircle size={11} />
              <span>失败</span>
            </>
          ) : (
            <span>待开始</span>
          )}
        </span>
      </div>

      <div className="global-task-center-meta">
        {task.kind === 'chat-export' && task.format && (
          <span>格式 {task.format}</span>
        )}
        {task.progressTotal > 0 && showProgressMeta && (
          <span>{task.progressCurrent} / {task.progressTotal} {unitLabel}</span>
        )}
        {showResultCounts && (
          <span>成功 {task.successCount || 0} · 失败 {task.failCount || 0}</span>
        )}
        {isFinished && <span>{formatTaskTime(task.updatedAt)}</span>}
      </div>

      {(displayPhase || displayCurrentName || displayDetail) && (
        <div className="global-task-center-detail">
          {displayPhase && <div>{displayPhase}</div>}
          {displayCurrentName && <div className="muted">当前: {displayCurrentName}</div>}
          {displayDetail && <div className="muted">{displayDetail}</div>}
        </div>
      )}

      {(isRunning || task.status === 'pending') && task.progressTotal > 0 && (
        <div className="global-task-center-progress">
          <div
            className="global-task-center-progress-fill"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      )}

      {task.status === 'error' && task.error && (
        <div className="global-task-center-error">{task.error}</div>
      )}

      {isFinished && (
        <div className="global-task-center-actions">
          {task.status === 'success' && task.outputDir && (
            <button
              type="button"
              onClick={() => void window.electronAPI.shell.openPath(task.outputDir!)}
            >
              <ExternalLink size={12} />
              <span>打开目录</span>
            </button>
          )}
          <button type="button" onClick={() => onRemove(task.id)}>
            关闭
          </button>
        </div>
      )}
    </div>
  )
}

interface GlobalTaskCenterProps {
  variant?: 'titlebar' | 'sidebar'
  label?: string
}

function GlobalTaskCenter({ variant = 'titlebar', label = '任务中心' }: GlobalTaskCenterProps) {
  const [open, setOpen] = useState(false)
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | undefined>(undefined)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const tasks = useTaskCenterStore(state => state.tasks)
  const removeTask = useTaskCenterStore(state => state.removeTask)
  const clearFinishedTasks = useTaskCenterStore(state => state.clearFinishedTasks)

  const sortedTasks = useMemo(
    () => tasks.slice().sort((a, b) => b.updatedAt - a.updatedAt),
    [tasks]
  )
  const pendingTasks = sortedTasks.filter(task => task.status === 'pending')
  const runningTasks = sortedTasks.filter(task => task.status === 'running')
  const finishedTasks = sortedTasks.filter(task => task.status === 'success' || task.status === 'error')
  const activeCount = pendingTasks.length + runningTasks.length
  const isSidebar = variant === 'sidebar'

  const updatePopoverPosition = useCallback(() => {
    if (!isSidebar) {
      setPopoverStyle(undefined)
      return
    }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const popoverWidth = Math.min(400, window.innerWidth - 24)
    const maxPopoverHeight = Math.min(window.innerHeight * 0.75, 680)
    const left = Math.max(12, Math.min(rect.right + 8, window.innerWidth - popoverWidth - 12))
    const top = Math.max(12, Math.min(rect.top, window.innerHeight - maxPopoverHeight - 12))
    setPopoverStyle({ left, top })
  }, [isSidebar])

  useEffect(() => {
    if (!open) return
    updatePopoverPosition()
    window.addEventListener('resize', updatePopoverPosition)
    return () => {
      window.removeEventListener('resize', updatePopoverPosition)
    }
  }, [open, updatePopoverPosition])

  const toggleOpen = () => {
    setOpen(prev => {
      const next = !prev
      if (next) {
        requestAnimationFrame(() => {
          updatePopoverPosition()
        })
      }
      return next
    })
  }

  return (
    <div className={`global-task-center-wrap ${variant}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`global-task-center-trigger ${isSidebar ? 'sidebar-trigger nav-item' : 'titlebar-trigger'} ${open ? 'active' : ''}`}
        onClick={toggleOpen}
        title={label}
      >
        {isSidebar ? (
          <>
            <span className="nav-icon"><ListTodo size={20} /></span>
            <span className="nav-label">{label}</span>
          </>
        ) : (
          <ListTodo size={15} />
        )}
        {activeCount > 0 && (
          <span className="task-badge">{activeCount}</span>
        )}
      </button>

      {open && (
        <>
          <div className="global-task-center-overlay" onClick={() => setOpen(false)} />
          <div
            className={`global-task-center-popover ${isSidebar ? 'anchor-sidebar' : 'anchor-titlebar'}`}
            style={isSidebar ? popoverStyle : undefined}
          >
            <div className="global-task-center-header">
              <div className="title">任务中心</div>
              <div className="header-actions">
                {finishedTasks.length > 0 && (
                  <button type="button" onClick={clearFinishedTasks} title="清空已完成">
                    <Trash2 size={12} />
                    <span>清空已完成</span>
                  </button>
                )}
                <button type="button" onClick={() => setOpen(false)}>收起</button>
              </div>
            </div>

            {sortedTasks.length === 0 ? (
              <div className="global-task-center-empty">暂无任务</div>
            ) : (
              <div className="global-task-center-sections">
                {pendingTasks.length > 0 && (
                  <div className="global-task-center-section">
                    <div className="section-title">待开始（{pendingTasks.length}）</div>
                    {pendingTasks.map(task => (
                      <TaskCard key={task.id} task={task} onRemove={removeTask} />
                    ))}
                  </div>
                )}

                {runningTasks.length > 0 && (
                  <div className="global-task-center-section">
                    <div className="section-title">进行中（{runningTasks.length}）</div>
                    {runningTasks.map(task => (
                      <TaskCard key={task.id} task={task} onRemove={removeTask} />
                    ))}
                  </div>
                )}

                {finishedTasks.length > 0 && (
                  <div className="global-task-center-section">
                    <div className="section-title">已完成（{finishedTasks.length}）</div>
                    {finishedTasks.map(task => (
                      <TaskCard key={task.id} task={task} onRemove={removeTask} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default GlobalTaskCenter
