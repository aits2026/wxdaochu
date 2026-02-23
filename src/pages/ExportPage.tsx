import { useState, useEffect, useCallback, useDeferredValue, useMemo, useRef, startTransition } from 'react'
import { Search, Download, FolderOpen, RefreshCw, Check, FileJson, FileText, Table, Loader2, X, FileSpreadsheet, Database, FileCode, CheckCircle, XCircle, ExternalLink, MessageSquare, Users, User, Filter, Image, Video, CircleUserRound, Smile, Mic, Newspaper, ChevronDown, MoreHorizontal, ArrowLeft, Eye } from 'lucide-react'
import { List, RowComponentProps } from 'react-window'
import DateRangePicker from '../components/DateRangePicker'
import { useTitleBarStore } from '../stores/titleBarStore'
import * as configService from '../services/config'
import './ExportPage.scss'

type ExportTab = 'chat' | 'contacts'

interface ChatSession {
  username: string
  displayName?: string
  avatarUrl?: string
  summary: string
  lastTimestamp: number
  accountType?: 'friend' | 'group' | 'official'
}

interface Contact {
  username: string
  displayName: string
  remark?: string
  nickname?: string
  avatarUrl?: string
  type: 'friend' | 'group' | 'official' | 'other'
}

interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'html' | 'txt' | 'excel' | 'sql'
  startDate: string
  endDate: string
  exportAvatars: boolean
  exportImages: boolean
  exportVideos: boolean
  exportEmojis: boolean
  exportVoices: boolean
}

interface ContactExportOptions {
  format: 'json' | 'csv' | 'vcf'
  exportAvatars: boolean
  contactTypes: {
    friends: boolean
    groups: boolean
    officials: boolean
  }
  selectedUsernames?: string[]
}

interface ExportResult {
  success: boolean
  successCount?: number
  failCount?: number
  error?: string
}

type SessionMessageCountMap = Record<string, number>

// 会话类型筛选
type SessionTypeFilter = 'group' | 'private' | 'official'

interface ExportSessionRowData {
  sessions: ChatSession[]
  selectedSession: string | null
  sessionMessageCounts: SessionMessageCountMap
  onSelect: (username: string) => void
}

const getAvatarLetter = (name: string) => {
  if (!name) return '?'
  return [...name][0] || '?'
}

const matchesSessionTypeFilter = (session: ChatSession, filter: SessionTypeFilter) => {
  if (filter === 'group') return session.accountType === 'group'
  if (filter === 'private') return session.accountType === 'friend'
  return session.accountType === 'official'
}

const ExportSessionRow = (props: RowComponentProps<ExportSessionRowData>) => {
  const { index, style, sessions, selectedSession, sessionMessageCounts, onSelect } = props
  const session = sessions[index]
  const messageCount = sessionMessageCounts[session.username]
  const isGroup = session.username.includes('@chatroom')

  return (
    <div style={style}>
      <div
        className={`export-session-item ${selectedSession === session.username ? 'selected' : ''}`}
        onClick={() => onSelect(session.username)}
      >
        <div className="export-avatar">
          {session.avatarUrl ? (
            <img src={session.avatarUrl} alt="" loading="lazy" />
          ) : (
            <span className={isGroup ? 'group-placeholder' : ''}>
              {isGroup ? '群' : getAvatarLetter(session.displayName || session.username)}
            </span>
          )}
        </div>
        <div className="export-session-info">
          <div className="export-session-name">{session.displayName || session.username}</div>
          <div className="export-session-summary">{session.summary || '暂无消息'}</div>
        </div>
        {messageCount !== undefined && (
          <div className="export-session-count">
            {messageCount.toLocaleString()}
          </div>
        )}
      </div>
    </div>
  )
}

function ExportPage() {
  const [activeTab, setActiveTab] = useState<ExportTab>('chat')
  const setTitleBarContent = useTitleBarStore(state => state.setRightContent)

  // 聊天导出状态
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [sessionMessageCounts, setSessionMessageCounts] = useState<SessionMessageCountMap>({})
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingSessionCounts, setIsLoadingSessionCounts] = useState(false)
  const [loadedSessionCountUsernames, setLoadedSessionCountUsernames] = useState<Set<string>>(new Set())
  const [searchKeyword, setSearchKeyword] = useState('')
  const [sessionTypeFilter, setSessionTypeFilter] = useState<SessionTypeFilter>('private')
  const [exportFolder, setExportFolder] = useState<string>('')
  const [isExporting, setIsExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState({
    current: 0,
    total: 0,
    currentName: '',
    phase: '',
    detail: ''
  })
  const [exportResult, setExportResult] = useState<ExportResult | null>(null)

  const [showFormatPicker, setShowFormatPicker] = useState(false)
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const [sessionDetail, setSessionDetail] = useState<{
    wxid: string
    remark?: string
    nickName?: string
    alias?: string
    messageCount: number
    firstMessageTime?: number
    latestMessageTime?: number
    imageCount: number
    videoCount: number
    voiceCount: number
    emojiCount: number
  } | null>(null)
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)
  const [exportRecords, setExportRecords] = useState<{ exportTime: number; format: string; messageCount: number }[]>([])
  const [showExportSettings, setShowExportSettings] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [options, setOptions] = useState<ExportOptions>({
    format: 'json',
    startDate: '',
    endDate: '',
    exportAvatars: true,
    exportImages: false,
    exportVideos: false,
    exportEmojis: false,
    exportVoices: false
  })

  // 通讯录导出状态
  const [contacts, setContacts] = useState<Contact[]>([])
  const [filteredContacts, setFilteredContacts] = useState<Contact[]>([])
  const [selectedContacts, setSelectedContacts] = useState<Set<string>>(new Set())
  const [contactSearchKeyword, setContactSearchKeyword] = useState('')
  const [isLoadingContacts, setIsLoadingContacts] = useState(false)
  const [contactOptions, setContactOptions] = useState<ContactExportOptions>({
    format: 'json',
    exportAvatars: true,
    contactTypes: {
      friends: true,
      groups: false,
      officials: false
    }
  })

  const deferredSearchKeyword = useDeferredValue(searchKeyword)
  const deferredSessionMessageCounts = useDeferredValue(sessionMessageCounts)
  const sessionCountRequestIdRef = useRef(0)
  const sessionTypeFilterRef = useRef<SessionTypeFilter>('private')

  useEffect(() => {
    sessionTypeFilterRef.current = sessionTypeFilter
  }, [sessionTypeFilter])

  // 加载默认导出配置
  const loadDefaultExportConfig = useCallback(async () => {
    try {
      const defaultDateRange = await configService.getExportDefaultDateRange()
      const defaultAvatars = await configService.getExportDefaultAvatars()

      // 计算日期范围
      let startDate = ''
      let endDate = ''
      if (defaultDateRange > 0) {
        const today = new Date()

        const year = today.getFullYear()
        const month = String(today.getMonth() + 1).padStart(2, '0')
        const day = String(today.getDate()).padStart(2, '0')
        const todayStr = `${year}-${month}-${day}`

        if (defaultDateRange === 1) {
          // 最近1天 = 今天
          startDate = todayStr
          endDate = todayStr
        } else {
          // 其他天数：从 N 天前到今天
          const start = new Date(today)
          start.setDate(today.getDate() - defaultDateRange + 1)

          const startYear = start.getFullYear()
          const startMonth = String(start.getMonth() + 1).padStart(2, '0')
          const startDay = String(start.getDate()).padStart(2, '0')

          startDate = `${startYear}-${startMonth}-${startDay}`
          endDate = todayStr
        }
      }

      setOptions(prev => ({
        ...prev,
        startDate,
        endDate,
        exportAvatars: defaultAvatars
      }))

      setContactOptions(prev => ({
        ...prev,
        exportAvatars: defaultAvatars
      }))
    } catch (e) {
      console.error('加载默认导出配置失败:', e)
      // 即使加载失败也不影响页面显示，使用默认值
    }
  }, [])

  // 监听导出进度
  useEffect(() => {
    const removeListener = window.electronAPI.export.onProgress((data) => {
      // 将 phase 英文映射为中文描述
      const phaseMap: Record<string, string> = {
        'preparing': '正在准备...',
        'exporting': '正在导出消息...',
        'writing': '正在写入文件...',
        'complete': '导出完成'
      }
      setExportProgress({
        current: data.current || 0,
        total: data.total || 0,
        currentName: data.currentSession || '',
        phase: (data.phase ? phaseMap[data.phase] : undefined) || data.phase || '',
        detail: data.detail || ''
      })
    })

    return () => {
      removeListener()
    }
  }, [])

  // 加载聊天会话
  const loadSessions = useCallback(async () => {
    setIsLoading(true)
    try {
      const result = await window.electronAPI.chat.connect()
      if (!result.success) {
        console.error('连接失败:', result.error)
        setIsLoading(false)
        return
      }
      const sessionsResult = await window.electronAPI.chat.getSessions()
      if (sessionsResult.success && sessionsResult.sessions) {
        setSessions(sessionsResult.sessions)
        setSessionMessageCounts({})
        setLoadedSessionCountUsernames(new Set())
        // 批量加载消息数量（异步，不阻塞列表显示）
        const allUsernames = sessionsResult.sessions.map(s => s.username)
        const priorityFilter = sessionTypeFilterRef.current
        const priorityUsernames = sessionsResult.sessions
          .filter(s => matchesSessionTypeFilter(s, priorityFilter))
          .map(s => s.username)
        const priorityUsernameSet = new Set(priorityUsernames)
        const remainingUsernames = allUsernames.filter(username => !priorityUsernameSet.has(username))
        const requestId = ++sessionCountRequestIdRef.current
        setIsLoadingSessionCounts(true)
        const mergeCounts = (counts: SessionMessageCountMap, usernames: string[]) => {
          if (!counts || usernames.length === 0) return
          startTransition(() => {
            setSessionMessageCounts(prev => ({ ...prev, ...counts }))
            setLoadedSessionCountUsernames(prev => {
              const next = new Set(prev)
              usernames.forEach(username => next.add(username))
              return next
            })
          })
        }

        void (async () => {
          try {
            if (priorityUsernames.length > 0) {
              const countsResult = await window.electronAPI.chat.getSessionMessageCounts(priorityUsernames)
              if (requestId !== sessionCountRequestIdRef.current) return
              if (countsResult.success && countsResult.counts) {
                mergeCounts(countsResult.counts, priorityUsernames)
              }
            }

            if (remainingUsernames.length > 0) {
              const countsResult = await window.electronAPI.chat.getSessionMessageCounts(remainingUsernames)
              if (requestId !== sessionCountRequestIdRef.current) return
              if (countsResult.success && countsResult.counts) {
                mergeCounts(countsResult.counts, remainingUsernames)
              }
            }
          } catch (error) {
            if (requestId !== sessionCountRequestIdRef.current) return
            console.error('加载会话消息数量失败:', error)
          } finally {
            if (requestId === sessionCountRequestIdRef.current) {
              setIsLoadingSessionCounts(false)
            }
          }
        })()
      }
    } catch (e) {
      console.error('加载会话失败:', e)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // 加载通讯录
  const loadContacts = useCallback(async () => {
    setIsLoadingContacts(true)
    try {
      const result = await window.electronAPI.chat.connect()
      if (!result.success) {
        console.error('连接失败:', result.error)
        setIsLoadingContacts(false)
        return
      }
      const contactsResult = await window.electronAPI.chat.getContacts()
      if (contactsResult.success && contactsResult.contacts) {
        setContacts(contactsResult.contacts)
        setFilteredContacts(contactsResult.contacts)
      }
    } catch (e) {
      console.error('加载通讯录失败:', e)
    } finally {
      setIsLoadingContacts(false)
    }
  }, [])

  const loadExportPath = useCallback(async () => {
    try {
      const savedPath = await configService.getExportPath()
      if (savedPath) {
        setExportFolder(savedPath)
      } else {
        const downloadsPath = await window.electronAPI.app.getDownloadsPath()
        setExportFolder(downloadsPath)
      }
    } catch (e) {
      console.error('加载导出路径失败:', e)
    }
  }, [])

  useEffect(() => {
    loadSessions()
    loadExportPath()
    loadDefaultExportConfig()
  }, [loadSessions, loadExportPath, loadDefaultExportConfig])

  // 切换到通讯录时加载
  useEffect(() => {
    if (activeTab === 'contacts' && contacts.length === 0) {
      loadContacts()
    }
  }, [activeTab, contacts.length, loadContacts])

  // 离开页面时清除标题栏
  useEffect(() => {
    return () => setTitleBarContent(null)
  }, [setTitleBarContent])

  const sessionTypeCounts = useMemo(() => {
    let group = 0
    let privateCount = 0
    let official = 0

    for (const session of sessions) {
      if (session.accountType === 'group') group++
      else if (session.accountType === 'friend') privateCount++
      else if (session.accountType === 'official') official++
    }

    return { group, private: privateCount, official }
  }, [sessions])

  const filteredSessions = useMemo(() => {
    let filtered = sessions

    if (sessionTypeFilter === 'group') {
      filtered = filtered.filter(s => s.accountType === 'group')
    } else if (sessionTypeFilter === 'private') {
      filtered = filtered.filter(s => s.accountType === 'friend')
    } else {
      filtered = filtered.filter(s => s.accountType === 'official')
    }

    const keyword = deferredSearchKeyword.trim().toLowerCase()
    if (keyword) {
      filtered = filtered.filter(s =>
        s.displayName?.toLowerCase().includes(keyword) ||
        s.username.toLowerCase().includes(keyword)
      )
    }

    const hasCountsForCurrentFiltered = filtered.length > 0 && filtered.every(s => loadedSessionCountUsernames.has(s.username))

    if (sessionTypeFilter !== 'official' && hasCountsForCurrentFiltered) {
      filtered = [...filtered].sort((a, b) => {
        const countDiff = (deferredSessionMessageCounts[b.username] || 0) - (deferredSessionMessageCounts[a.username] || 0)
        if (countDiff !== 0) return countDiff
        return (b.lastTimestamp || 0) - (a.lastTimestamp || 0)
      })
    }

    return filtered
  }, [sessions, sessionTypeFilter, deferredSearchKeyword, deferredSessionMessageCounts, loadedSessionCountUsernames])

  const sessionByUsername = useMemo(() => {
    const map = new Map<string, ChatSession>()
    for (const session of sessions) {
      map.set(session.username, session)
    }
    return map
  }, [sessions])

  // 通讯录搜索过滤
  useEffect(() => {
    let filtered = contacts

    // 类型过滤
    filtered = filtered.filter(c => {
      if (c.type === 'friend' && !contactOptions.contactTypes.friends) return false
      if (c.type === 'group' && !contactOptions.contactTypes.groups) return false
      if (c.type === 'official' && !contactOptions.contactTypes.officials) return false
      return true
    })

    // 关键词过滤
    if (contactSearchKeyword.trim()) {
      const lower = contactSearchKeyword.toLowerCase()
      filtered = filtered.filter(c =>
        c.displayName?.toLowerCase().includes(lower) ||
        c.remark?.toLowerCase().includes(lower) ||
        c.username.toLowerCase().includes(lower)
      )
    }

    setFilteredContacts(filtered)
  }, [contactSearchKeyword, contacts, contactOptions.contactTypes])

  const selectSession = async (username: string) => {
    setSelectedSession(username)
    setShowExportSettings(false)
    setSessionDetail(null)
    setExportRecords([])
    setIsLoadingDetail(true)
    try {
      const [detailResult, records] = await Promise.all([
        window.electronAPI.chat.getSessionDetail(username),
        window.electronAPI.export.getExportRecords(username),
      ])
      if (detailResult.success && detailResult.detail) {
        setSessionDetail({
          wxid: detailResult.detail.wxid,
          remark: detailResult.detail.remark,
          nickName: detailResult.detail.nickName,
          alias: detailResult.detail.alias,
          messageCount: detailResult.detail.messageCount,
          firstMessageTime: detailResult.detail.firstMessageTime,
          latestMessageTime: detailResult.detail.latestMessageTime,
          imageCount: detailResult.detail.imageCount,
          videoCount: detailResult.detail.videoCount,
          voiceCount: detailResult.detail.voiceCount,
          emojiCount: detailResult.detail.emojiCount,
        })
      }
      setExportRecords(records)
    } catch { }
    setIsLoadingDetail(false)
  }

  const toggleContact = (username: string) => {
    const newSet = new Set(selectedContacts)
    if (newSet.has(username)) {
      newSet.delete(username)
    } else {
      newSet.add(username)
    }
    setSelectedContacts(newSet)
  }

  const toggleSelectAllContacts = () => {
    if (selectedContacts.size === filteredContacts.length && filteredContacts.length > 0) {
      setSelectedContacts(new Set())
    } else {
      setSelectedContacts(new Set(filteredContacts.map(c => c.username)))
    }
  }

  const openExportFolder = async () => {
    if (exportFolder) {
      await window.electronAPI.shell.openPath(exportFolder)
    }
  }

  // 选择导出文件夹
  const selectExportFolder = async () => {
    try {
      const result = await window.electronAPI.dialog.openFile({
        properties: ['openDirectory'],
        title: '选择导出位置'
      })
      if (!result.canceled && result.filePaths.length > 0) {
        const newPath = result.filePaths[0]
        setExportFolder(newPath)
        // 保存到配置
        await configService.setExportPath(newPath)
      }
    } catch (e) {
      console.error('选择文件夹失败:', e)
    }
  }

  // 导出聊天记录
  const startExport = async () => {
    if (!selectedSession || !exportFolder) return

    setIsExporting(true)
    setExportProgress({ current: 0, total: 1, currentName: '', phase: '准备导出', detail: '' })
    setExportResult(null)

    try {
      const sessionList = [selectedSession]
      const exportOptions = {
        format: options.format,
        dateRange: (options.startDate && options.endDate) ? {
          start: Math.floor(new Date(options.startDate + 'T00:00:00').getTime() / 1000),
          end: Math.floor(new Date(options.endDate + 'T23:59:59').getTime() / 1000)
        } : null,
        exportAvatars: options.exportAvatars,
        exportImages: options.exportImages,
        exportVideos: options.exportVideos,
        exportEmojis: options.exportEmojis,
        exportVoices: options.exportVoices
      }

      if (options.format === 'chatlab' || options.format === 'chatlab-jsonl' || options.format === 'json' || options.format === 'excel' || options.format === 'html') {
        const result = await window.electronAPI.export.exportSessions(
          sessionList,
          exportFolder,
          exportOptions
        )
        setExportResult(result)
        // 导出成功后保存记录并刷新
        if (result.success && sessionDetail) {
          await window.electronAPI.export.saveExportRecord(selectedSession, options.format, sessionDetail.messageCount)
          const records = await window.electronAPI.export.getExportRecords(selectedSession)
          setExportRecords(records)
        }
      } else {
        setExportResult({ success: false, error: `${options.format.toUpperCase()} 格式导出功能开发中...` })
      }
    } catch (e) {
      console.error('导出失败:', e)
      setExportResult({ success: false, error: String(e) })
    } finally {
      setIsExporting(false)
    }
  }

  // 导出通讯录
  const startContactExport = async () => {
    if (!exportFolder) return

    setIsExporting(true)
    setExportResult(null)

    try {
      const result = await window.electronAPI.export.exportContacts(
        exportFolder,
        {
          format: contactOptions.format,
          exportAvatars: contactOptions.exportAvatars,
          contactTypes: contactOptions.contactTypes,
          selectedUsernames: selectedContacts.size > 0 ? Array.from(selectedContacts) : undefined
        }
      )
      setExportResult(result)
    } catch (e) {
      console.error('导出通讯录失败:', e)
      setExportResult({ success: false, error: String(e) })
    } finally {
      setIsExporting(false)
    }
  }

  const chatFormatOptions = [
    { value: 'chatlab', label: 'ChatLab', icon: FileCode, desc: '标准格式，支持其他软件导入' },
    { value: 'chatlab-jsonl', label: 'ChatLab JSONL', icon: FileCode, desc: '流式格式，适合大量消息' },
    { value: 'json', label: 'JSON', icon: FileJson, desc: '详细格式，包含完整消息信息' },
    { value: 'html', label: 'HTML', icon: FileText, desc: '网页格式，可直接浏览' },
    { value: 'txt', label: 'TXT', icon: Table, desc: '纯文本，通用格式' },
    { value: 'excel', label: 'Excel', icon: FileSpreadsheet, desc: '电子表格，适合统计分析' },
    { value: 'sql', label: 'PostgreSQL', icon: Database, desc: '数据库脚本，便于导入到数据库' }
  ]

  const contactFormatOptions = [
    { value: 'json', label: 'JSON', icon: FileJson, desc: '结构化数据，便于程序处理' },
    { value: 'csv', label: 'CSV', icon: FileSpreadsheet, desc: '表格格式，可用Excel打开' },
    { value: 'vcf', label: 'vCard', icon: User, desc: '通讯录标准格式，可导入手机' }
  ]

  const getContactTypeIcon = (type: string) => {
    switch (type) {
      case 'friend': return <User size={14} />
      case 'group': return <Users size={14} />
      case 'official': return <MessageSquare size={14} />
      default: return <User size={14} />
    }
  }

  const getContactTypeName = (type: string) => {
    switch (type) {
      case 'friend': return '好友'
      case 'group': return '群聊'
      case 'official': return '公众号'
      default: return '其他'
    }
  }

  return (
    <div className="export-page">
      {/* 聊天记录导出 */}
      {activeTab === 'chat' && (
        <>
          <div className="session-panel">
            <div className="panel-header">
              <h2>选择会话</h2>
            </div>

            <div className="search-bar">
              <Search size={16} />
              <input
                type="text"
                placeholder="搜索联系人或群组..."
                value={searchKeyword}
                onChange={e => setSearchKeyword(e.target.value)}
              />
              {searchKeyword && (
                <button className="clear-btn" onClick={() => setSearchKeyword('')}>
                  <X size={14} />
                </button>
              )}
            </div>

            <div className="session-type-filter">
              <button
                className={`type-filter-btn ${sessionTypeFilter === 'group' ? 'active' : ''}`}
                onClick={() => setSessionTypeFilter('group')}
              >
                <div className="type-filter-label">
                  <Users size={13} />
                  <span>群聊</span>
                </div>
                <div className="type-filter-count">
                  {sessionTypeCounts.group}
                </div>
              </button>
              <button
                className={`type-filter-btn ${sessionTypeFilter === 'private' ? 'active' : ''}`}
                onClick={() => setSessionTypeFilter('private')}
              >
                <div className="type-filter-label">
                  <User size={13} />
                  <span>私聊</span>
                </div>
                <div className="type-filter-count">
                  {sessionTypeCounts.private}
                </div>
              </button>
              <button
                className={`type-filter-btn ${sessionTypeFilter === 'official' ? 'active' : ''}`}
                onClick={() => setSessionTypeFilter('official')}
              >
                <div className="type-filter-label">
                  <Newspaper size={13} />
                  <span>公众号</span>
                </div>
                <div className="type-filter-count">
                  {sessionTypeCounts.official}
                </div>
              </button>

              {/* 三点更多菜单 */}
              <div className="session-more-wrap">
                <button
                  className="session-more-btn"
                  onClick={() => setShowMoreMenu(v => !v)}
                >
                  <MoreHorizontal size={16} />
                </button>
                {showMoreMenu && (
                  <>
                    <div className="more-menu-overlay" onClick={() => setShowMoreMenu(false)} />
                    <div className="more-menu-dropdown">
                      <button
                        className="more-menu-item"
                        onClick={() => { loadSessions(); setShowMoreMenu(false) }}
                      >
                        <RefreshCw size={14} className={isLoading ? 'spin' : ''} />
                        <span>刷新</span>
                      </button>
                      <button
                        className="more-menu-item"
                        onClick={() => { setActiveTab('contacts'); setShowMoreMenu(false) }}
                      >
                        <Users size={14} />
                        <span>导出通讯录</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
            {isLoadingSessionCounts && (
              <div className="session-count-loading-hint">
                <Loader2 size={12} className="spin" />
                <span>正在统计消息数量并排序...</span>
              </div>
            )}

            {isLoading ? (
              <div className="loading-state">
                <Loader2 size={24} className="spin" />
                <span>加载中...</span>
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="empty-state">
                <span>暂无会话</span>
              </div>
            ) : (
              <div className="export-session-list">
                {/* @ts-ignore - react-window v2 类型定义与当前 rowProps 推断不一致 */}
                <List
                  style={{ height: '100%', width: '100%' }}
                  rowCount={filteredSessions.length}
                  rowHeight={72}
                  rowProps={{
                    sessions: filteredSessions,
                    selectedSession,
                    sessionMessageCounts,
                    onSelect: selectSession
                  }}
                  rowComponent={ExportSessionRow}
                />
              </div>
            )}
          </div>

          <div className="settings-panel">
            {!selectedSession ? (
              <div className="empty-state" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span>请从左侧选择一个会话</span>
              </div>
            ) : !showExportSettings ? (
              <>
                <div className="panel-header">
                  <h2>会话信息</h2>
                </div>
                <div className="settings-content">
                  {(() => {
                    const session = selectedSession ? sessionByUsername.get(selectedSession) : undefined
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '32px 16px' }}>
                        <div className="export-avatar" style={{ width: 64, height: 64, fontSize: 24 }}>
                          {session?.avatarUrl ? (
                            <img src={session.avatarUrl} alt="" style={{ width: 64, height: 64, borderRadius: 8 }} />
                          ) : (
                            <span style={{ width: 64, height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'var(--bg-secondary, #f0f0f0)' }}>
                              {session?.username.includes('@chatroom') ? '群' : getAvatarLetter(session?.displayName || session?.username || '')}
                            </span>
                          )}
                        </div>
                        <h3 style={{ margin: 0, textAlign: 'center' }}>{session?.displayName || selectedSession}</h3>
                        {isLoadingDetail ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: 0.6 }}>
                            <Loader2 size={16} className="spin" />
                            <span>加载中...</span>
                          </div>
                        ) : sessionDetail ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', padding: '0 16px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color, #e0e0e0)' }}>
                              <span style={{ opacity: 0.6 }}>微信ID</span>
                              <span style={{ fontFamily: 'monospace', fontSize: 13 }}>{sessionDetail.wxid}</span>
                            </div>
                            {sessionDetail.remark && (
                              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color, #e0e0e0)' }}>
                                <span style={{ opacity: 0.6 }}>备注</span>
                                <span>{sessionDetail.remark}</span>
                              </div>
                            )}
                            {sessionDetail.nickName && (
                              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color, #e0e0e0)' }}>
                                <span style={{ opacity: 0.6 }}>昵称</span>
                                <span>{sessionDetail.nickName}</span>
                              </div>
                            )}
                            {sessionDetail.alias && (
                              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color, #e0e0e0)' }}>
                                <span style={{ opacity: 0.6 }}>微信号</span>
                                <span>{sessionDetail.alias}</span>
                              </div>
                            )}
                            <div style={{ height: 8 }} />
                            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color, #e0e0e0)' }}>
                              <span style={{ opacity: 0.6 }}>消息总数</span>
                              <span style={{ fontWeight: 500 }}>{sessionDetail.messageCount.toLocaleString()} 条</span>
                            </div>
                            {sessionDetail.firstMessageTime && (
                              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color, #e0e0e0)' }}>
                                <span style={{ opacity: 0.6 }}>最早消息</span>
                                <span>{new Date(sessionDetail.firstMessageTime * 1000).toLocaleDateString('zh-CN')}</span>
                              </div>
                            )}
                            {sessionDetail.latestMessageTime && (
                              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color, #e0e0e0)' }}>
                                <span style={{ opacity: 0.6 }}>最新消息</span>
                                <span>{new Date(sessionDetail.latestMessageTime * 1000).toLocaleDateString('zh-CN')}</span>
                              </div>
                            )}
                            {(sessionDetail.imageCount > 0 || sessionDetail.emojiCount > 0 || sessionDetail.videoCount > 0 || sessionDetail.voiceCount > 0) && (
                              <div style={{ display: 'flex', gap: 8, padding: '8px 0', flexWrap: 'wrap' }}>
                                {([
                                  { icon: <Image size={13} />, label: '图片', count: sessionDetail.imageCount },
                                  { icon: <Smile size={13} />, label: '表情', count: sessionDetail.emojiCount },
                                  { icon: <Video size={13} />, label: '视频', count: sessionDetail.videoCount },
                                  { icon: <Mic size={13} />, label: '语音', count: sessionDetail.voiceCount },
                                ] as const).filter(item => item.count > 0).map(item => (
                                  <div key={item.label} style={{
                                    flex: 1,
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'center',
                                    gap: 4,
                                    padding: '8px 4px',
                                    background: 'var(--bg-secondary)',
                                    borderRadius: 8,
                                  }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)', fontSize: 12 }}>
                                      {item.icon}
                                      <span>{item.label}</span>
                                    </div>
                                    <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{item.count.toLocaleString()}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {/* 导出记录 */}
                            <div style={{ marginTop: 8 }}>
                              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6 }}>导出记录</div>
                              {exportRecords.length === 0 ? (
                                <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '4px 0' }}>暂无导出记录</div>
                              ) : exportRecords.map((rec, i) => {
                                const diff = sessionDetail ? sessionDetail.messageCount - rec.messageCount : 0
                                const date = new Date(rec.exportTime)
                                const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
                                return (
                                  <div key={i} style={{
                                    padding: '8px 10px',
                                    marginBottom: 6,
                                    background: 'var(--bg-secondary)',
                                    borderRadius: 8,
                                    fontSize: 12,
                                  }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                      <span style={{ color: 'var(--text-secondary)' }}>{dateStr}</span>
                                      <span style={{ color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>{rec.format}</span>
                                    </div>
                                    <div style={{ color: 'var(--text-secondary)' }}>
                                      导出时 {rec.messageCount.toLocaleString()} 条，
                                      {diff > 0
                                        ? <span style={{ color: 'var(--primary)' }}> 现在新增 +{diff.toLocaleString()} 条</span>
                                        : <span style={{ color: 'var(--text-tertiary)' }}> ✓ 暂无新增</span>
                                      }
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    )
                  })()}
                </div>
                <div className="export-action">
                  <div className="export-action-row">
                    <button
                      className="export-btn export-btn-secondary"
                      onClick={() => window.electronAPI.window.openChatWindow(selectedSession!)}
                    >
                      <Eye size={16} />
                      <span>查看会话</span>
                    </button>
                    <button
                      className="export-btn"
                      onClick={() => setShowExportSettings(true)}
                      disabled={!sessionDetail || sessionDetail.messageCount === 0}
                    >
                      <Download size={16} />
                      <span>导出此会话</span>
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="panel-header">
                  <h2 style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }} onClick={() => setShowExportSettings(false)}>
                    ← 导出设置
                  </h2>
                </div>
                <div className="settings-content">
                  <div className="setting-section">
                    {(() => {
                      const currentFmt = chatFormatOptions.find(f => f.value === options.format) || chatFormatOptions[2]
                      return (
                        <div style={{ position: 'relative' }}>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              cursor: 'pointer',
                              padding: '8px 0',
                            }}
                            onClick={() => setShowFormatPicker(!showFormatPicker)}
                          >
                            <h3 style={{ margin: 0 }}>导出格式</h3>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <currentFmt.icon size={16} />
                              <span>{currentFmt.label}</span>
                              <ChevronDown
                                size={16}
                                style={{
                                  transition: 'transform 0.2s',
                                  transform: showFormatPicker ? 'rotate(180deg)' : 'rotate(0deg)',
                                }}
                              />
                            </div>
                          </div>
                          {showFormatPicker && (
                            <>
                              <div
                                style={{ position: 'fixed', inset: 0, zIndex: 99 }}
                                onClick={() => setShowFormatPicker(false)}
                              />
                              <div
                                style={{
                                  position: 'absolute',
                                  right: 0,
                                  top: '100%',
                                  zIndex: 100,
                                  background: 'var(--bg-primary, #fff)',
                                  border: '1px solid var(--border-color, #e0e0e0)',
                                  borderRadius: 8,
                                  boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                                  padding: 4,
                                  minWidth: 260,
                                  maxHeight: 360,
                                  overflowY: 'auto',
                                }}
                              >
                                {chatFormatOptions.map(fmt => (
                                  <div
                                    key={fmt.value}
                                    style={{
                                      display: 'flex',
                                      flexDirection: 'column',
                                      gap: 2,
                                      padding: '10px 12px',
                                      borderRadius: 6,
                                      cursor: 'pointer',
                                      background: options.format === fmt.value ? 'var(--bg-active, #f0f0f0)' : 'transparent',
                                    }}
                                    onMouseEnter={e => {
                                      if (options.format !== fmt.value) e.currentTarget.style.background = 'var(--bg-hover, #f5f5f5)'
                                    }}
                                    onMouseLeave={e => {
                                      if (options.format !== fmt.value) e.currentTarget.style.background = 'transparent'
                                    }}
                                    onClick={() => {
                                      setOptions({ ...options, format: fmt.value as any })
                                      setShowFormatPicker(false)
                                    }}
                                  >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                      <fmt.icon size={16} />
                                      <span style={{ fontWeight: 500 }}>{fmt.label}</span>
                                    </div>
                                    <span style={{ fontSize: 12, opacity: 0.6, paddingLeft: 24 }}>{fmt.desc}</span>
                                  </div>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      )
                    })()}
                  </div>

                  <div className="setting-section">
                    <h3>时间范围</h3>
                    <div className="time-options">
                      <DateRangePicker
                        startDate={options.startDate}
                        endDate={options.endDate}
                        onStartDateChange={(date) => setOptions(prev => ({ ...prev, startDate: date }))}
                        onEndDateChange={(date) => setOptions(prev => ({ ...prev, endDate: date }))}
                      />
                      <p className="time-hint">不选择时间范围则导出全部消息</p>
                    </div>
                  </div>

                  <div className="setting-section">
                    <h3>导出选项</h3>
                    <div className="export-options">
                      <label className="checkbox-item">
                        <input type="checkbox" checked={options.exportAvatars} onChange={e => setOptions(prev => ({ ...prev, exportAvatars: e.target.checked }))} />
                        <div className="custom-checkbox"></div>
                        <CircleUserRound size={16} style={{ color: 'var(--text-tertiary)' }} />
                        <span>导出头像</span>
                      </label>
                      <label className="checkbox-item">
                        <input type="checkbox" checked={options.exportImages} onChange={e => setOptions(prev => ({ ...prev, exportImages: e.target.checked }))} />
                        <div className="custom-checkbox"></div>
                        <Image size={16} style={{ color: 'var(--text-tertiary)' }} />
                        <span>导出图片</span>
                      </label>
                      <label className="checkbox-item">
                        <input type="checkbox" checked={options.exportVideos} onChange={e => setOptions(prev => ({ ...prev, exportVideos: e.target.checked }))} />
                        <div className="custom-checkbox"></div>
                        <Video size={16} style={{ color: 'var(--text-tertiary)' }} />
                        <span>导出视频</span>
                      </label>
                      <label className="checkbox-item">
                        <input type="checkbox" checked={options.exportEmojis} onChange={e => setOptions(prev => ({ ...prev, exportEmojis: e.target.checked }))} />
                        <div className="custom-checkbox"></div>
                        <Smile size={16} style={{ color: 'var(--text-tertiary)' }} />
                        <span>导出表情包</span>
                      </label>
                      <label className="checkbox-item">
                        <input type="checkbox" checked={options.exportVoices} onChange={e => setOptions(prev => ({ ...prev, exportVoices: e.target.checked }))} />
                        <div className="custom-checkbox"></div>
                        <Mic size={16} style={{ color: 'var(--text-tertiary)' }} />
                        <span>导出语音</span>
                      </label>
                    </div>
                  </div>

                  <div className="setting-section">
                    <h3>导出位置</h3>
                    <div className="export-path-select" onClick={selectExportFolder}>
                      <FolderOpen size={16} />
                      <span className="path-text">{exportFolder || '点击选择导出位置'}</span>
                      <span className="change-text">更改</span>
                    </div>
                  </div>
                </div>

                <div className="export-action">
                  <button
                    className="export-btn"
                    onClick={startExport}
                    disabled={!selectedSession || !exportFolder || isExporting}
                  >
                    {isExporting ? (
                      <>
                        <Loader2 size={18} className="spin" />
                        <span>导出中...</span>
                      </>
                    ) : (
                      <>
                        <Download size={18} />
                        <span>开始导出</span>
                      </>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* 通讯录导出 */}
      {activeTab === 'contacts' && (
        <>
          <div className="session-panel contacts-panel">
            <div className="panel-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button className="icon-btn" onClick={() => setActiveTab('chat')}>
                  <ArrowLeft size={18} />
                </button>
                <h2>通讯录预览</h2>
              </div>
              <button className="icon-btn" onClick={loadContacts} disabled={isLoadingContacts}>
                <RefreshCw size={18} className={isLoadingContacts ? 'spin' : ''} />
              </button>
            </div>

            <div className="search-bar">
              <Search size={16} />
              <input
                type="text"
                placeholder="搜索联系人..."
                value={contactSearchKeyword}
                onChange={e => setContactSearchKeyword(e.target.value)}
              />
              {contactSearchKeyword && (
                <button className="clear-btn" onClick={() => setContactSearchKeyword('')}>
                  <X size={14} />
                </button>
              )}
            </div>

            <div className="select-actions">
              <button className="select-all-btn" onClick={toggleSelectAllContacts}>
                {selectedContacts.size === filteredContacts.length && filteredContacts.length > 0 ? '取消全选' : '全选'}
              </button>
              <span className="selected-count">
                {selectedContacts.size > 0 ? `已选 ${selectedContacts.size} 个` : `共 ${filteredContacts.length} 个联系人`}
              </span>
            </div>

            {isLoadingContacts ? (
              <div className="loading-state">
                <Loader2 size={24} className="spin" />
                <span>加载中...</span>
              </div>
            ) : filteredContacts.length === 0 ? (
              <div className="empty-state">
                <span>暂无联系人</span>
              </div>
            ) : (
              <div className="contacts-list selectable">
                {filteredContacts.slice(0, 100).map(contact => (
                  <div
                    key={contact.username}
                    className={`contact-item ${selectedContacts.has(contact.username) ? 'selected' : ''}`}
                    onClick={() => toggleContact(contact.username)}
                  >
                    <div className="check-box">
                      {selectedContacts.has(contact.username) && <Check size={14} />}
                    </div>
                    <div className="contact-avatar">
                      {contact.avatarUrl ? (
                        <img src={contact.avatarUrl} alt="" />
                      ) : (
                        <span>{getAvatarLetter(contact.displayName)}</span>
                      )}
                    </div>
                    <div className="contact-info">
                      <div className="contact-name">{contact.displayName}</div>
                      {contact.remark && contact.remark !== contact.displayName && (
                        <div className="contact-remark">备注: {contact.remark}</div>
                      )}
                    </div>
                    <div className={`contact-type ${contact.type}`}>
                      {getContactTypeIcon(contact.type)}
                      <span>{getContactTypeName(contact.type)}</span>
                    </div>
                  </div>
                ))}
                {filteredContacts.length > 100 && (
                  <div className="contacts-more">
                    还有 {filteredContacts.length - 100} 个联系人...
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="settings-panel">
            <div className="panel-header">
              <h2>导出设置</h2>
            </div>

            <div className="settings-content">
              <div className="setting-section">
                <h3>导出格式</h3>
                <div className="format-options contact-formats">
                  {contactFormatOptions.map(fmt => (
                    <div
                      key={fmt.value}
                      className={`format-card ${contactOptions.format === fmt.value ? 'active' : ''}`}
                      onClick={() => setContactOptions(prev => ({ ...prev, format: fmt.value as any }))}
                    >
                      <fmt.icon size={24} />
                      <span className="format-label">{fmt.label}</span>
                      <span className="format-desc">{fmt.desc}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="setting-section">
                <h3>联系人类型</h3>
                <div className="export-options">
                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={contactOptions.contactTypes.friends}
                      onChange={e => setContactOptions(prev => ({
                        ...prev,
                        contactTypes: { ...prev.contactTypes, friends: e.target.checked }
                      }))}
                    />
                    <div className="custom-checkbox"></div>
                    <User size={16} />
                    <span>好友</span>
                  </label>
                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={contactOptions.contactTypes.groups}
                      onChange={e => setContactOptions(prev => ({
                        ...prev,
                        contactTypes: { ...prev.contactTypes, groups: e.target.checked }
                      }))}
                    />
                    <div className="custom-checkbox"></div>
                    <Users size={16} />
                    <span>群聊</span>
                  </label>
                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={contactOptions.contactTypes.officials}
                      onChange={e => setContactOptions(prev => ({
                        ...prev,
                        contactTypes: { ...prev.contactTypes, officials: e.target.checked }
                      }))}
                    />
                    <div className="custom-checkbox"></div>
                    <MessageSquare size={16} />
                    <span>公众号</span>
                  </label>
                </div>
              </div>

              <div className="setting-section">
                <h3>导出选项</h3>
                <div className="export-options">
                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={contactOptions.exportAvatars}
                      onChange={e => setContactOptions(prev => ({ ...prev, exportAvatars: e.target.checked }))}
                    />
                    <div className="custom-checkbox"></div>
                    <span>导出头像</span>
                  </label>
                </div>
              </div>

              <div className="setting-section">
                <h3>导出位置</h3>
                <div className="export-path-select" onClick={selectExportFolder}>
                  <FolderOpen size={16} />
                  <span className="path-text">{exportFolder || '点击选择导出位置'}</span>
                  <span className="change-text">更改</span>
                </div>
              </div>
            </div>

            <div className="export-action">
              <button
                className="export-btn"
                onClick={startContactExport}
                disabled={!exportFolder || isExporting}
              >
                {isExporting ? (
                  <>
                    <Loader2 size={18} className="spin" />
                    <span>导出中...</span>
                  </>
                ) : (
                  <>
                    <Download size={18} />
                    <span>导出通讯录</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </>
      )}

      {/* 导出进度弹窗 */}
      {isExporting && (
        <div className="export-overlay">
          <div className="export-progress-modal">
            <div className="progress-spinner">
              <Loader2 size={32} className="spin" />
            </div>
            <h3>正在导出</h3>
            {exportProgress.phase && <p className="progress-phase">{exportProgress.phase}</p>}
            {exportProgress.currentName && (
              <p className="progress-text">当前会话: {exportProgress.currentName}</p>
            )}
            {exportProgress.detail && <p className="progress-detail">{exportProgress.detail}</p>}
            {!exportProgress.currentName && !exportProgress.detail && (
              <p className="progress-text">准备中...</p>
            )}
            <div className="progress-export-options">
              <span>格式: {options.format.toUpperCase()}</span>
              {options.exportImages && <span> · 含图片</span>}
              {options.exportVideos && <span> · 含视频</span>}
              {options.exportEmojis && <span> · 含表情</span>}
              {options.exportVoices && <span> · 含语音</span>}
              {options.exportAvatars && <span> · 含头像</span>}
            </div>
            {exportProgress.total > 0 && (
              <>
                <div className="progress-bar">
                  <div
                    className="progress-fill"
                    style={{ width: `${(exportProgress.current / exportProgress.total) * 100}%` }}
                  />
                </div>
                <p className="progress-count">{exportProgress.current} / {exportProgress.total} 个会话</p>
              </>
            )}
          </div>
        </div>
      )}

      {/* 导出结果弹窗 */}
      {exportResult && (
        <div className="export-overlay">
          <div className="export-result-modal">
            <div className={`result-icon ${exportResult.success ? 'success' : 'error'}`}>
              {exportResult.success ? <CheckCircle size={48} /> : <XCircle size={48} />}
            </div>
            <h3>{exportResult.success ? '导出完成' : '导出失败'}</h3>
            {exportResult.success ? (
              <p className="result-text">
                {exportResult.successCount !== undefined
                  ? `成功导出 ${exportResult.successCount} 个${activeTab === 'chat' ? '会话' : '联系人'}`
                  : '导出成功'}
                {exportResult.failCount ? `，${exportResult.failCount} 个失败` : ''}
              </p>
            ) : (
              <p className="result-text error">{exportResult.error}</p>
            )}
            <div className="result-actions">
              {exportResult.success && (
                <button className="open-folder-btn" onClick={openExportFolder}>
                  <ExternalLink size={16} />
                  <span>打开文件夹</span>
                </button>
              )}
              <button className="close-btn" onClick={() => setExportResult(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ExportPage
