import { useMemo, useState } from 'react'
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
        {task.progressTotal > 0 && (
          <span>{task.progressCurrent} / {task.progressTotal} {unitLabel}</span>
        )}
        {(task.successCount !== undefined || task.failCount !== undefined) && (
          <span>成功 {task.successCount || 0} · 失败 {task.failCount || 0}</span>
        )}
        {isFinished && <span>{formatTaskTime(task.updatedAt)}</span>}
      </div>

      {(task.phase || task.currentName || task.detail) && (
        <div className="global-task-center-detail">
          {task.phase && <div>{task.phase}</div>}
          {task.currentName && <div className="muted">当前: {task.currentName}</div>}
          {task.detail && <div className="muted">{task.detail}</div>}
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

function GlobalTaskCenter() {
  const [open, setOpen] = useState(false)
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

  return (
    <div className="global-task-center-wrap">
      <button
        type="button"
        className={`global-task-center-trigger ${open ? 'active' : ''}`}
        onClick={() => setOpen(v => !v)}
        title="任务中心"
      >
        <ListTodo size={15} />
        {activeCount > 0 && (
          <span className="task-badge">{activeCount}</span>
        )}
      </button>

      {open && (
        <>
          <div className="global-task-center-overlay" onClick={() => setOpen(false)} />
          <div className="global-task-center-popover">
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

