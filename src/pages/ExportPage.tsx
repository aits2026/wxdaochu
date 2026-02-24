import { useState, useEffect, useCallback, useDeferredValue, useMemo, useRef, startTransition } from 'react'
import { Search, Download, FolderOpen, RefreshCw, Check, FileJson, FileText, Table, Loader2, X, FileSpreadsheet, Database, FileCode, CheckCircle, XCircle, ExternalLink, MessageSquare, Users, User, Filter, Image, Video, CircleUserRound, Smile, Mic, Newspaper, ChevronDown, MoreHorizontal, ArrowLeft, Eye, Aperture, CircleHelp, ListTodo } from 'lucide-react'
import { List, RowComponentProps } from 'react-window'
import DateRangePicker from '../components/DateRangePicker'
import { useTitleBarStore } from '../stores/titleBarStore'
import { useAppStore } from '../stores/appStore'
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
type ImageDecryptTaskStatus = 'running' | 'success' | 'error'
type TaskCenterTaskStatus = 'pending' | 'running' | 'success' | 'error'

interface SessionImageDecryptOverview {
  total: number
  decryptedCount: number
  undecryptedCount: number
  status: 'idle' | 'checking' | 'complete' | 'partial' | 'error'
  checkedAt?: number
}

interface SessionImageAssetItem {
  imageMd5?: string
  imageDatName?: string
  createTime?: number
  localPath?: string
  localUrl?: string
  decrypted: boolean
}

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
  const isDbConnected = useAppStore(state => state.isDbConnected)
  const preloadedUserInfo = useAppStore(state => state.userInfo)
  const userInfoLoaded = useAppStore(state => state.userInfoLoaded)
  const [exportAccountInfo, setExportAccountInfo] = useState<{
    connected: boolean
    wxid: string
    nickName: string
    alias: string
    avatarUrl: string
  }>({
    connected: false,
    wxid: '',
    nickName: '',
    alias: '',
    avatarUrl: ''
  })

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
  const [isSessionImageDecrypting, setIsSessionImageDecrypting] = useState(false)
  const [showSessionImageDecryptConfirm, setShowSessionImageDecryptConfirm] = useState(false)
  const [showSessionImageDecryptProgress, setShowSessionImageDecryptProgress] = useState(false)
  const [sessionImageDecryptTaskExpanded, setSessionImageDecryptTaskExpanded] = useState(true)
  const [sessionImageDecryptTaskStatus, setSessionImageDecryptTaskStatus] = useState<ImageDecryptTaskStatus>('running')
  const [sessionImageDecryptTaskStats, setSessionImageDecryptTaskStats] = useState({ success: 0, fail: 0 })
  const [sessionImageDecryptTaskSessionId, setSessionImageDecryptTaskSessionId] = useState<string | null>(null)
  const [sessionImageDecryptTaskSessionName, setSessionImageDecryptTaskSessionName] = useState('')
  const [sessionImageDecryptTaskError, setSessionImageDecryptTaskError] = useState<string | null>(null)
  const [sessionImageOverviews, setSessionImageOverviews] = useState<Record<string, SessionImageDecryptOverview>>({})
  const [showSessionImageAssetsModal, setShowSessionImageAssetsModal] = useState(false)
  const [sessionImageAssetsLoading, setSessionImageAssetsLoading] = useState(false)
  const [sessionImageAssetsError, setSessionImageAssetsError] = useState<string | null>(null)
  const [sessionImageAssetsSessionId, setSessionImageAssetsSessionId] = useState<string | null>(null)
  const [sessionImageAssetsSessionName, setSessionImageAssetsSessionName] = useState('')
  const [sessionImageAssets, setSessionImageAssets] = useState<SessionImageAssetItem[]>([])
  const [sessionImageMessages, setSessionImageMessages] = useState<{ imageMd5?: string; imageDatName?: string; createTime?: number }[] | null>(null)
  const [sessionImageDates, setSessionImageDates] = useState<string[]>([])
  const [sessionImageSelectedDates, setSessionImageSelectedDates] = useState<Set<string>>(new Set())
  const [sessionImageDecryptProgress, setSessionImageDecryptProgress] = useState({ current: 0, total: 0 })

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
    messageTables: { dbName: string; tableName: string; count: number }[]
    groupInfo?: {
      ownerUsername?: string
      ownerDisplayName?: string
      memberCount?: number
      friendMemberCount?: number
      friendMembers?: Array<{ username: string; displayName: string }>
      selfMessageCount?: number
    }
  } | null>(null)
  const [showGroupFriendsPopup, setShowGroupFriendsPopup] = useState(false)
  const [groupFriendMessageCounts, setGroupFriendMessageCounts] = useState<Record<string, number>>({})
  const [groupFriendMessageCountsStatus, setGroupFriendMessageCountsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [groupFriendMessageCountsSessionId, setGroupFriendMessageCountsSessionId] = useState<string | null>(null)
  const [groupFriendsSortOrder, setGroupFriendsSortOrder] = useState<'desc' | 'asc'>('desc')
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)
  const [isLoadingGroupInfo, setIsLoadingGroupInfo] = useState(false)
  const [exportRecords, setExportRecords] = useState<{ exportTime: number; format: string; messageCount: number }[]>([])
  const [showExportSettings, setShowExportSettings] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [showUsageTipsPopover, setShowUsageTipsPopover] = useState(false)
  const [showTaskCenterPopover, setShowTaskCenterPopover] = useState(false)
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
  const sessionDetailRequestIdRef = useRef(0)
  const groupFriendMessageCountsRequestIdRef = useRef(0)
  const sessionImageOverviewRequestIdRef = useRef(0)
  const sessionImageAssetsRequestIdRef = useRef(0)
  const sessionTypeFilterRef = useRef<SessionTypeFilter>('private')

  useEffect(() => {
    sessionTypeFilterRef.current = sessionTypeFilter
  }, [sessionTypeFilter])

  const loadExportAccountInfo = useCallback(async () => {
    try {
      const result = await window.electronAPI.chat.getMyUserInfo()
      if (result.success && result.userInfo) {
        setExportAccountInfo({
          connected: true,
          wxid: result.userInfo.wxid,
          nickName: result.userInfo.nickName,
          alias: result.userInfo.alias,
          avatarUrl: result.userInfo.avatarUrl
        })
        return
      }
    } catch (e) {
      console.error('导出页加载当前账号信息失败:', e)
    }

    setExportAccountInfo(prev => ({
      ...prev,
      connected: true
    }))
  }, [])

  useEffect(() => {
    if (!isDbConnected) {
      setExportAccountInfo({
        connected: false,
        wxid: '',
        nickName: '',
        alias: '',
        avatarUrl: ''
      })
      return
    }

    if (userInfoLoaded && preloadedUserInfo) {
      setExportAccountInfo({
        connected: true,
        wxid: preloadedUserInfo.wxid,
        nickName: preloadedUserInfo.nickName,
        alias: preloadedUserInfo.alias,
        avatarUrl: preloadedUserInfo.avatarUrl
      })
      return
    }

    if (!userInfoLoaded || (userInfoLoaded && !preloadedUserInfo)) {
      loadExportAccountInfo()
    }
  }, [isDbConnected, userInfoLoaded, preloadedUserInfo, loadExportAccountInfo])

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

  const isSessionTypeCountsPending = isLoading && sessions.length === 0
  const formatSessionTypeCount = (count: number) => (
    isSessionTypeCountsPending ? '计算中' : count.toLocaleString()
  )

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

  const renderFieldLoading = () => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: 0.65, fontSize: 12 }}>
      <Loader2 size={12} style={{ animation: 'exportSpin 1s linear infinite' }} />
      <span>加载中...</span>
    </span>
  )

  const toLocalFileUrl = (localPath?: string) => {
    if (!localPath) return undefined
    if (localPath.startsWith('file:')) return localPath
    return `file://${localPath.replace(/\\/g, '/')}`
  }

  const getSessionDisplayName = useCallback((sessionId: string) => {
    return (
      sessionDetail?.remark ||
      sessionDetail?.nickName ||
      sessionByUsername.get(sessionId)?.displayName ||
      sessionId
    )
  }, [sessionByUsername, sessionDetail?.nickName, sessionDetail?.remark])

  const inspectSessionImageAssets = useCallback(async (sessionId: string) => {
    const listResult = await window.electronAPI.chat.getAllImageMessages(sessionId)
    if (!listResult.success || !listResult.images) {
      throw new Error(listResult.error || '读取会话图片失败')
    }

    const assets: SessionImageAssetItem[] = []
    let decryptedCount = 0
    let undecryptedCount = 0

    for (let i = 0; i < listResult.images.length; i++) {
      const img = listResult.images[i]
      let localPath: string | undefined

      try {
        const cacheResult = await window.electronAPI.image.resolveCache({
          sessionId,
          imageMd5: img.imageMd5,
          imageDatName: img.imageDatName,
        })
        if (cacheResult.success && cacheResult.localPath) {
          localPath = cacheResult.localPath
        }
      } catch {
        // 忽略单张图片检测错误，按未解密处理
      }

      const decrypted = Boolean(localPath)
      if (decrypted) decryptedCount++
      else undecryptedCount++

      assets.push({
        ...img,
        decrypted,
        localPath,
        localUrl: toLocalFileUrl(localPath)
      })

      if (i % 25 === 0) {
        await new Promise(r => setTimeout(r, 0))
      }
    }

    return {
      total: listResult.images.length,
      decryptedCount,
      undecryptedCount,
      assets
    }
  }, [])

  const refreshSessionImageOverview = useCallback(async (sessionId: string) => {
    const requestId = ++sessionImageOverviewRequestIdRef.current

    setSessionImageOverviews(prev => ({
      ...prev,
      [sessionId]: {
        total: prev[sessionId]?.total || 0,
        decryptedCount: prev[sessionId]?.decryptedCount || 0,
        undecryptedCount: prev[sessionId]?.undecryptedCount || 0,
        status: 'checking',
        checkedAt: prev[sessionId]?.checkedAt,
      }
    }))

    try {
      const result = await inspectSessionImageAssets(sessionId)
      if (requestId !== sessionImageOverviewRequestIdRef.current) return

      setSessionImageOverviews(prev => ({
        ...prev,
        [sessionId]: {
          total: result.total,
          decryptedCount: result.decryptedCount,
          undecryptedCount: result.undecryptedCount,
          status: result.total > 0 && result.undecryptedCount === 0 ? 'complete' : 'partial',
          checkedAt: Date.now(),
        }
      }))
    } catch {
      if (requestId !== sessionImageOverviewRequestIdRef.current) return
      setSessionImageOverviews(prev => ({
        ...prev,
        [sessionId]: {
          total: prev[sessionId]?.total || 0,
          decryptedCount: prev[sessionId]?.decryptedCount || 0,
          undecryptedCount: prev[sessionId]?.undecryptedCount || 0,
          status: 'error',
          checkedAt: Date.now(),
        }
      }))
    }
  }, [inspectSessionImageAssets])

  const openSessionImageAssetsModal = useCallback(async () => {
    if (!selectedSession) return

    const sessionId = selectedSession
    const requestId = ++sessionImageAssetsRequestIdRef.current
    setShowSessionImageAssetsModal(true)
    setSessionImageAssetsLoading(true)
    setSessionImageAssetsError(null)
    setSessionImageAssetsSessionId(sessionId)
    setSessionImageAssetsSessionName(getSessionDisplayName(sessionId))

    try {
      const result = await inspectSessionImageAssets(sessionId)
      if (requestId !== sessionImageAssetsRequestIdRef.current) return

      setSessionImageAssets(result.assets)
      setSessionImageOverviews(prev => ({
        ...prev,
        [sessionId]: {
          total: result.total,
          decryptedCount: result.decryptedCount,
          undecryptedCount: result.undecryptedCount,
          status: result.total > 0 && result.undecryptedCount === 0 ? 'complete' : 'partial',
          checkedAt: Date.now(),
        }
      }))
    } catch (e) {
      if (requestId !== sessionImageAssetsRequestIdRef.current) return
      setSessionImageAssets([])
      setSessionImageAssetsError(String(e))
    } finally {
      if (requestId === sessionImageAssetsRequestIdRef.current) {
        setSessionImageAssetsLoading(false)
      }
    }
  }, [getSessionDisplayName, inspectSessionImageAssets, selectedSession])

  const formatImageDecryptDateLabel = useCallback((dateStr: string) => {
    const [y, m, d] = dateStr.split('-').map(Number)
    return `${y}年${m}月${d}日`
  }, [])

  const toggleSessionImageDate = useCallback((date: string) => {
    setSessionImageSelectedDates(prev => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }, [])

  const selectAllSessionImageDates = useCallback(() => {
    setSessionImageSelectedDates(new Set(sessionImageDates))
  }, [sessionImageDates])

  const clearAllSessionImageDates = useCallback(() => {
    setSessionImageSelectedDates(new Set())
  }, [])

  const sessionImageCountByDate = useMemo(() => {
    const map = new Map<string, number>()
    if (!sessionImageMessages) return map
    sessionImageMessages.forEach(img => {
      if (img.createTime) {
        const d = new Date(img.createTime * 1000).toISOString().slice(0, 10)
        map.set(d, (map.get(d) ?? 0) + 1)
      }
    })
    return map
  }, [sessionImageMessages])

  const selectedSessionImageCount = useMemo(() => {
    if (!sessionImageMessages) return 0
    return sessionImageMessages.filter(img =>
      img.createTime && sessionImageSelectedDates.has(new Date(img.createTime * 1000).toISOString().slice(0, 10))
    ).length
  }, [sessionImageMessages, sessionImageSelectedDates])

  const currentSessionImageOverview = selectedSession ? sessionImageOverviews[selectedSession] : undefined
  const isCurrentSessionImageTaskRunning = Boolean(
    isSessionImageDecrypting && selectedSession && sessionImageDecryptTaskSessionId === selectedSession
  )
  const currentSessionImageDecryptedCount = currentSessionImageOverview?.decryptedCount || 0
  const currentSessionImageUndecryptedCount = currentSessionImageOverview?.undecryptedCount || 0
  const currentSessionAllImagesDecrypted = Boolean(
    sessionDetail &&
    sessionDetail.imageCount > 0 &&
    currentSessionImageOverview &&
    currentSessionImageOverview.total === sessionDetail.imageCount &&
    currentSessionImageOverview.undecryptedCount === 0 &&
    currentSessionImageOverview.status === 'complete'
  )
  const hasCurrentSessionDecryptedImages = currentSessionImageDecryptedCount > 0
  const decryptedImageAssets = useMemo(
    () => sessionImageAssets.filter(item => item.decrypted && item.localUrl),
    [sessionImageAssets]
  )
  const sessionImageAssetsOverview = useMemo(() => {
    if (!sessionImageAssetsSessionId) return undefined
    return sessionImageOverviews[sessionImageAssetsSessionId]
  }, [sessionImageAssetsSessionId, sessionImageOverviews])
  const sessionImageAssetsTotalCount = sessionImageAssetsOverview?.total ?? sessionImageAssets.length
  const sessionImageAssetsDecryptedCount = sessionImageAssetsOverview?.decryptedCount ?? decryptedImageAssets.length
  const sessionImageAssetsUndecryptedCount = sessionImageAssetsOverview?.undecryptedCount ?? Math.max(0, sessionImageAssetsTotalCount - sessionImageAssetsDecryptedCount)
  const imageDecryptTaskExists = Boolean(sessionImageDecryptTaskSessionId && sessionImageDecryptProgress.total > 0)
  const imageDecryptTaskRecord = imageDecryptTaskExists ? {
    id: `image-decrypt:${sessionImageDecryptTaskSessionId}`,
    typeLabel: '图片解密',
    sessionId: sessionImageDecryptTaskSessionId!,
    sessionName: sessionImageDecryptTaskSessionName || sessionByUsername.get(sessionImageDecryptTaskSessionId!)?.displayName || sessionImageDecryptTaskSessionId!,
    status: (isSessionImageDecrypting ? 'running' : sessionImageDecryptTaskStatus) as TaskCenterTaskStatus,
    progressCurrent: sessionImageDecryptProgress.current,
    progressTotal: sessionImageDecryptProgress.total,
    successCount: sessionImageDecryptTaskStats.success,
    failCount: sessionImageDecryptTaskStats.fail,
    error: sessionImageDecryptTaskError,
  } : null
  const taskCenterTasks = useMemo(() => (
    imageDecryptTaskRecord ? [imageDecryptTaskRecord] : []
  ), [imageDecryptTaskRecord])
  const taskCenterPendingTasks = taskCenterTasks.filter(task => task.status === 'pending')
  const taskCenterRunningTasks = taskCenterTasks.filter(task => task.status === 'running')
  const taskCenterFinishedTasks = taskCenterTasks.filter(task => task.status === 'success' || task.status === 'error')
  const taskCenterActiveCount = taskCenterPendingTasks.length + taskCenterRunningTasks.length
  const groupFriendMembersForPopup = useMemo(() => {
    const friendMembers = sessionDetail?.groupInfo?.friendMembers || []
    if (friendMembers.length <= 1) return friendMembers

    const countsReadyForCurrentSession =
      groupFriendMessageCountsSessionId === selectedSession &&
      groupFriendMessageCountsStatus === 'ready'

    if (!countsReadyForCurrentSession) return friendMembers

    return friendMembers
      .map((friend, originalIndex) => ({
        friend,
        originalIndex,
        count: Number(groupFriendMessageCounts[friend.username] || 0)
      }))
      .sort((a, b) => {
        const diff = groupFriendsSortOrder === 'desc'
          ? b.count - a.count
          : a.count - b.count
        if (diff !== 0) return diff
        return a.originalIndex - b.originalIndex
      })
      .map(item => item.friend)
  }, [
    sessionDetail?.groupInfo?.friendMembers,
    groupFriendMessageCounts,
    groupFriendMessageCountsSessionId,
    groupFriendMessageCountsStatus,
    groupFriendsSortOrder,
    selectedSession
  ])

  useEffect(() => {
    if (!selectedSession || !sessionDetail || sessionDetail.imageCount <= 0) return

    if (isCurrentSessionImageTaskRunning) return

    const overview = sessionImageOverviews[selectedSession]
    if (overview?.status === 'checking') return
    const isFreshEnough = overview &&
      overview.total === sessionDetail.imageCount &&
      (overview.status === 'complete' || overview.status === 'partial')

    if (isFreshEnough) return

    if (overview?.status === 'error' && overview.total === sessionDetail.imageCount) return

    void refreshSessionImageOverview(selectedSession)
  }, [
    selectedSession,
    sessionDetail?.imageCount,
    isCurrentSessionImageTaskRunning,
    refreshSessionImageOverview,
    sessionImageOverviews
  ])

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

  useEffect(() => {
    const friendMembers = sessionDetail?.groupInfo?.friendMembers || []
    if (!showGroupFriendsPopup || !selectedSession || !selectedSession.includes('@chatroom')) return
    if (friendMembers.length === 0) return

    const alreadyHandledCurrentSession = groupFriendMessageCountsSessionId === selectedSession &&
      (groupFriendMessageCountsStatus === 'loading' || groupFriendMessageCountsStatus === 'ready' || groupFriendMessageCountsStatus === 'error')
    if (alreadyHandledCurrentSession) return

    const requestId = ++groupFriendMessageCountsRequestIdRef.current
    setGroupFriendMessageCounts({})
    setGroupFriendMessageCountsSessionId(selectedSession)
    setGroupFriendMessageCountsStatus('loading')

    void (async () => {
      try {
        const result = await window.electronAPI.groupAnalytics.getGroupMessageRanking(selectedSession, 100000)
        if (requestId !== groupFriendMessageCountsRequestIdRef.current) return

        if (result.success && result.data) {
          const counts: Record<string, number> = {}
          for (const item of result.data) {
            const username = item?.member?.username
            if (!username) continue
            counts[username] = Number(item.messageCount || 0)
          }
          setGroupFriendMessageCounts(counts)
          setGroupFriendMessageCountsStatus('ready')
        } else {
          setGroupFriendMessageCounts({})
          setGroupFriendMessageCountsStatus('error')
        }
      } catch {
        if (requestId !== groupFriendMessageCountsRequestIdRef.current) return
        setGroupFriendMessageCounts({})
        setGroupFriendMessageCountsStatus('error')
      }
    })()
  }, [
    showGroupFriendsPopup,
    selectedSession,
    sessionDetail?.groupInfo?.friendMembers,
    groupFriendMessageCountsSessionId,
    groupFriendMessageCountsStatus
  ])

  const selectSession = async (username: string) => {
    const requestId = ++sessionDetailRequestIdRef.current
    groupFriendMessageCountsRequestIdRef.current++
    sessionImageAssetsRequestIdRef.current++
    setSelectedSession(username)
    setShowExportSettings(false)
    setShowGroupFriendsPopup(false)
    setGroupFriendMessageCounts({})
    setGroupFriendMessageCountsStatus('idle')
    setGroupFriendMessageCountsSessionId(null)
    setGroupFriendsSortOrder('desc')
    setShowSessionImageAssetsModal(false)
    setSessionImageAssets([])
    setSessionImageAssetsError(null)
    setSessionImageAssetsLoading(false)
    setSessionImageAssetsSessionId(null)
    setSessionImageAssetsSessionName('')
    setSessionDetail(null)
    setShowSessionImageDecryptConfirm(false)
    setSessionImageMessages(null)
    setSessionImageDates([])
    setSessionImageSelectedDates(new Set())
    if (!isSessionImageDecrypting) {
      setSessionImageDecryptTaskExpanded(true)
    }
    setExportRecords([])
    setIsLoadingDetail(true)
    setIsLoadingGroupInfo(false)

    void (async () => {
      try {
        const records = await window.electronAPI.export.getExportRecords(username)
        if (requestId !== sessionDetailRequestIdRef.current) return
        setExportRecords(records)
      } catch { }
    })()

    try {
      const detailResult = await window.electronAPI.chat.getSessionDetail(username, { includeGroupInfo: false })
      if (requestId !== sessionDetailRequestIdRef.current) return

      if (detailResult.success && detailResult.detail) {
        const isGroupChat = username.includes('@chatroom')
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
          messageTables: detailResult.detail.messageTables || [],
          groupInfo: isGroupChat ? {} : detailResult.detail.groupInfo,
        })

        if (isGroupChat) {
          setIsLoadingGroupInfo(true)
          void (async () => {
            try {
              const groupResult = await window.electronAPI.chat.getSessionGroupInfo(username)
              if (requestId !== sessionDetailRequestIdRef.current) return
              if (groupResult.success) {
                setSessionDetail(prev => {
                  if (!prev || prev.wxid !== username) return prev
                  return {
                    ...prev,
                    groupInfo: groupResult.groupInfo || {}
                  }
                })
              }
            } catch { }
            finally {
              if (requestId === sessionDetailRequestIdRef.current) {
                setIsLoadingGroupInfo(false)
              }
            }
          })()
        }
      }
    } catch { }
    finally {
      if (requestId === sessionDetailRequestIdRef.current) {
        setIsLoadingDetail(false)
      }
    }
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

  const openSessionImageDecrypt = async () => {
    if (!selectedSession || isSessionImageDecrypting) return

    try {
      const result = await window.electronAPI.chat.getAllImageMessages(selectedSession)
      if (!result.success || !result.images || result.images.length === 0) {
        alert(result.error || '当前会话没有图片消息')
        return
      }

      const dateSet = new Set<string>()
      result.images.forEach(img => {
        if (img.createTime) dateSet.add(new Date(img.createTime * 1000).toISOString().slice(0, 10))
      })
      const sortedDates = Array.from(dateSet).sort((a, b) => b.localeCompare(a))

      setSessionImageMessages(result.images)
      setSessionImageDates(sortedDates)
      setSessionImageSelectedDates(new Set(sortedDates))
      setShowSessionImageDecryptConfirm(true)
    } catch (e) {
      console.error('加载会话图片失败:', e)
      alert('加载会话图片失败')
    }
  }

  const confirmSessionImageDecrypt = async () => {
    if (!selectedSession || !sessionImageMessages) return
    if (sessionImageSelectedDates.size === 0) {
      alert('请至少选择一个日期')
      return
    }

    const images = sessionImageMessages.filter(img =>
      img.createTime && sessionImageSelectedDates.has(new Date(img.createTime * 1000).toISOString().slice(0, 10))
    )
    if (images.length === 0) {
      alert('所选日期下没有图片')
      return
    }

    setShowSessionImageDecryptConfirm(false)
    setSessionImageMessages(null)
    setSessionImageDates([])
    setSessionImageSelectedDates(new Set())

    setIsSessionImageDecrypting(true)
    setShowSessionImageDecryptProgress(true)
    setShowTaskCenterPopover(true)
    setSessionImageDecryptTaskExpanded(true)
    setSessionImageDecryptTaskStatus('running')
    setSessionImageDecryptTaskStats({ success: 0, fail: 0 })
    setSessionImageDecryptTaskSessionId(selectedSession)
    setSessionImageDecryptTaskError(null)
    setSessionImageDecryptTaskSessionName(
      sessionDetail?.remark || sessionDetail?.nickName || (selectedSession ? sessionByUsername.get(selectedSession)?.displayName : undefined) || selectedSession || ''
    )
    setSessionImageDecryptProgress({ current: 0, total: images.length })

    let success = 0
    let fail = 0
    try {
      for (let i = 0; i < images.length; i++) {
        try {
          const r = await window.electronAPI.image.decrypt({
            sessionId: selectedSession,
            imageMd5: images[i].imageMd5,
            imageDatName: images[i].imageDatName,
            force: false
          })
          if (r?.success) success++
          else fail++
        } catch {
          fail++
        }
        if (i % 5 === 0) await new Promise(r => setTimeout(r, 0))
        setSessionImageDecryptProgress({ current: i + 1, total: images.length })
        setSessionImageDecryptTaskStats({ success, fail })
      }
      setSessionImageDecryptTaskStatus('success')
    } catch (e) {
      console.error('批量解密图片失败:', e)
      setSessionImageDecryptTaskStatus('error')
      setSessionImageDecryptTaskError(String(e))
    }

    setIsSessionImageDecrypting(false)
    setSessionImageDecryptTaskStats({ success, fail })
    setSessionImageDecryptTaskExpanded(false)

    void refreshSessionImageOverview(selectedSession)
    if (showSessionImageAssetsModal && sessionImageAssetsSessionId === selectedSession) {
      void openSessionImageAssetsModal()
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
            <div className="session-account-header">
              <div className="session-account-avatar">
                {exportAccountInfo.avatarUrl ? (
                  <img src={exportAccountInfo.avatarUrl} alt="" />
                ) : (
                  <User size={18} />
                )}
              </div>
              <div className="session-account-main">
                <div className="session-account-name-row">
                  <div className="session-account-name">
                    {exportAccountInfo.connected
                      ? (exportAccountInfo.nickName || exportAccountInfo.wxid || '当前账号')
                      : '未连接数据库'}
                  </div>
                  {exportAccountInfo.connected && (
                    <span className="session-account-badge">当前导出账号</span>
                  )}
                </div>
                <div className="session-account-id">
                  {exportAccountInfo.connected
                    ? (exportAccountInfo.alias
                      ? `微信号: ${exportAccountInfo.alias}${exportAccountInfo.wxid ? ` · wxid: ${exportAccountInfo.wxid}` : ''}`
                      : (exportAccountInfo.wxid ? `wxid: ${exportAccountInfo.wxid}` : '未识别账号信息'))
                    : '请先配置并连接数据源'}
                </div>
                <div className="session-account-status-row">
                  <div className={`session-account-status ${exportAccountInfo.connected ? 'connected' : 'disconnected'}`}>
                    <span className="status-dot" />
                    <span>{exportAccountInfo.connected ? '已连接数据库' : '未连接'}</span>
                  </div>
                  <div className="session-account-status-actions">
                    <div className="session-account-tips-wrap">
                      <button
                        type="button"
                        className={`session-account-tips-btn ${showUsageTipsPopover ? 'active' : ''}`}
                        title="使用提示"
                        onClick={() => {
                          setShowUsageTipsPopover(v => {
                            const next = !v
                            if (next) {
                              setShowMoreMenu(false)
                              setShowTaskCenterPopover(false)
                            }
                            return next
                          })
                        }}
                      >
                        <CircleHelp size={14} />
                      </button>
                      {showUsageTipsPopover && (
                        <>
                          <div className="more-menu-overlay" onClick={() => setShowUsageTipsPopover(false)} />
                          <div className="session-account-tips-popover">
                            <div className="session-account-tips-title">使用提示</div>
                            <ul className="session-account-tips-list">
                              <li>联网功能仅用来支持在线更新！</li>
                              <li>记得到「数据管理」界面解密数据库哦！</li>
                              <li>除使用 AI 功能外，所有数据仅在本地处理，不会上传到任何服务器！</li>
                            </ul>
                          </div>
                        </>
                      )}
                    </div>
                    <div className="session-account-task-wrap">
                      <button
                        type="button"
                        className={`session-account-task-btn ${showTaskCenterPopover ? 'active' : ''}`}
                        title="任务中心"
                        onClick={() => {
                          setShowTaskCenterPopover(v => {
                            const next = !v
                            if (next) {
                              setShowUsageTipsPopover(false)
                              setShowMoreMenu(false)
                            }
                            return next
                          })
                        }}
                      >
                        <ListTodo size={14} />
                        {taskCenterActiveCount > 0 && (
                          <span className="task-badge">{taskCenterActiveCount}</span>
                        )}
                      </button>
                      {showTaskCenterPopover && (
                        <>
                          <div className="more-menu-overlay" onClick={() => setShowTaskCenterPopover(false)} />
                          <div className="session-task-center-popover">
                            <div className="session-task-center-header">
                              <div className="title">任务中心</div>
                              <button type="button" onClick={() => setShowTaskCenterPopover(false)}>收起</button>
                            </div>
                            {taskCenterTasks.length === 0 ? (
                              <div className="session-task-center-empty">暂无任务</div>
                            ) : (
                              <div className="session-task-center-sections">
                                {taskCenterPendingTasks.length > 0 && (
                                  <div className="task-section">
                                    <div className="task-section-title">待开始（{taskCenterPendingTasks.length}）</div>
                                    {taskCenterPendingTasks.map(task => (
                                      <div key={task.id} className="task-card">
                                        <div className="task-card-top">
                                          <div className="task-main">
                                            <span className="task-type">{task.typeLabel}</span>
                                            <span className="task-name">{task.sessionName}</span>
                                          </div>
                                          <span className="task-state pending">待开始</span>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {taskCenterRunningTasks.length > 0 && (
                                  <div className="task-section">
                                    <div className="task-section-title">进行中（{taskCenterRunningTasks.length}）</div>
                                    {taskCenterRunningTasks.map(task => (
                                      <div key={task.id} className="task-card">
                                        <div className="task-card-top">
                                          <div className="task-main">
                                            <span className="task-type">{task.typeLabel}</span>
                                            <span className="task-name">{task.sessionName}</span>
                                          </div>
                                          <span className="task-state running">
                                            <Loader2 size={11} className="spin" />
                                            <span>进行中</span>
                                          </span>
                                        </div>
                                        <div className="task-progress-meta">
                                          <span>{task.progressCurrent} / {task.progressTotal} 张</span>
                                          <span>成功 {task.successCount} · 失败 {task.failCount}</span>
                                        </div>
                                        <div className="task-progress-bar">
                                          <div
                                            className="task-progress-fill"
                                            style={{ width: `${task.progressTotal > 0 ? (task.progressCurrent / task.progressTotal) * 100 : 0}%` }}
                                          />
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {taskCenterFinishedTasks.length > 0 && (
                                  <div className="task-section">
                                    <div className="task-section-title">已完成（{taskCenterFinishedTasks.length}）</div>
                                    {taskCenterFinishedTasks.map(task => (
                                      <div key={task.id} className="task-card">
                                        <div className="task-card-top">
                                          <div className="task-main">
                                            <span className="task-type">{task.typeLabel}</span>
                                            <span className="task-name">{task.sessionName}</span>
                                          </div>
                                          <span className={`task-state ${task.status}`}>
                                            {task.status === 'success' ? (
                                              <>
                                                <CheckCircle size={11} />
                                                <span>已完成</span>
                                              </>
                                            ) : (
                                              <>
                                                <XCircle size={11} />
                                                <span>失败</span>
                                              </>
                                            )}
                                          </span>
                                        </div>
                                        <div className="task-progress-meta">
                                          <span>{task.progressCurrent} / {task.progressTotal} 张</span>
                                          <span>成功 {task.successCount} · 失败 {task.failCount}</span>
                                        </div>
                                        {task.status === 'error' && task.error && (
                                          <div className="task-error-text">{task.error}</div>
                                        )}
                                        <div className="task-card-actions">
                                          {task.status === 'success' && task.sessionId && (
                                            <button
                                              type="button"
                                              onClick={async () => {
                                                await selectSession(task.sessionId)
                                                setShowTaskCenterPopover(false)
                                                setTimeout(() => { void openSessionImageAssetsModal() }, 0)
                                              }}
                                            >
                                              查看图片
                                            </button>
                                          )}
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setShowSessionImageDecryptProgress(false)
                                              setSessionImageDecryptTaskSessionId(null)
                                              setSessionImageDecryptTaskSessionName('')
                                              setSessionImageDecryptTaskStatus('running')
                                              setSessionImageDecryptTaskStats({ success: 0, fail: 0 })
                                              setSessionImageDecryptTaskError(null)
                                              setSessionImageDecryptProgress({ current: 0, total: 0 })
                                            }}
                                          >
                                            关闭
                                          </button>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              <div className="session-more-wrap">
                <button
                  className="session-more-btn"
                  onClick={() => {
                    setShowMoreMenu(v => {
                      const next = !v
                      if (next) {
                        setShowUsageTipsPopover(false)
                        setShowTaskCenterPopover(false)
                      }
                      return next
                    })
                  }}
                  title="更多操作"
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
                        onClick={async () => {
                          try {
                            await window.electronAPI.window.openMomentsWindow({ preset: 'self' })
                          } catch (e) {
                            console.error('打开我的朋友圈失败:', e)
                          } finally {
                            setShowMoreMenu(false)
                          }
                        }}
                      >
                        <Aperture size={14} />
                        <span>我的朋友圈</span>
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
                className={`type-filter-btn ${sessionTypeFilter === 'private' ? 'active' : ''}`}
                onClick={() => setSessionTypeFilter('private')}
              >
                <div className="type-filter-label">
                  <User size={13} />
                  <span>私聊</span>
                </div>
                <div className="type-filter-count">
                  {formatSessionTypeCount(sessionTypeCounts.private)}
                </div>
              </button>
              <button
                className={`type-filter-btn ${sessionTypeFilter === 'group' ? 'active' : ''}`}
                onClick={() => setSessionTypeFilter('group')}
              >
                <div className="type-filter-label">
                  <Users size={13} />
                  <span>群聊</span>
                </div>
                <div className="type-filter-count">
                  {formatSessionTypeCount(sessionTypeCounts.group)}
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
                  {formatSessionTypeCount(sessionTypeCounts.official)}
                </div>
              </button>
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
                        {isLoadingDetail && !sessionDetail ? (
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
                            {session?.username.includes('@chatroom') && sessionDetail.groupInfo && (
                              <>
                                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color, #e0e0e0)' }}>
                                  <span style={{ opacity: 0.6 }}>群主</span>
                                  {isLoadingGroupInfo && sessionDetail.groupInfo.ownerUsername === undefined && sessionDetail.groupInfo.ownerDisplayName === undefined ? (
                                    renderFieldLoading()
                                  ) : (
                                    <span title={sessionDetail.groupInfo.ownerUsername || ''}>
                                      {sessionDetail.groupInfo.ownerDisplayName || sessionDetail.groupInfo.ownerUsername || '未知'}
                                    </span>
                                  )}
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color, #e0e0e0)' }}>
                                  <span style={{ opacity: 0.6 }}>群总人数</span>
                                  {isLoadingGroupInfo && sessionDetail.groupInfo.memberCount === undefined
                                    ? renderFieldLoading()
                                    : <span>{sessionDetail.groupInfo.memberCount !== undefined ? `${sessionDetail.groupInfo.memberCount.toLocaleString()} 人` : '--'}</span>}
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color, #e0e0e0)' }}>
                                  <span style={{ opacity: 0.6 }}>群内好友数</span>
                                  {isLoadingGroupInfo && sessionDetail.groupInfo.friendMemberCount === undefined ? (
                                    renderFieldLoading()
                                  ) : sessionDetail.groupInfo.friendMemberCount !== undefined ? (
                                    (sessionDetail.groupInfo.friendMembers?.length || 0) > 0 ? (
                                      <button
                                        type="button"
                                        className="group-friend-count-btn"
                                        onClick={() => {
                                          setGroupFriendMessageCounts({})
                                          setGroupFriendMessageCountsStatus('idle')
                                          setGroupFriendMessageCountsSessionId(null)
                                          setGroupFriendsSortOrder('desc')
                                          setShowGroupFriendsPopup(true)
                                        }}
                                      >
                                        <span>{sessionDetail.groupInfo.friendMemberCount.toLocaleString()} 人</span>
                                        <Eye size={13} />
                                      </button>
                                    ) : (
                                      <span>{sessionDetail.groupInfo.friendMemberCount.toLocaleString()} 人</span>
                                    )
                                  ) : (
                                    <span>--</span>
                                  )}
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color, #e0e0e0)' }}>
                                  <span style={{ opacity: 0.6 }}>我发的消息</span>
                                  {isLoadingGroupInfo && sessionDetail.groupInfo.selfMessageCount === undefined
                                    ? renderFieldLoading()
                                    : <span>{sessionDetail.groupInfo.selfMessageCount !== undefined ? `${sessionDetail.groupInfo.selfMessageCount.toLocaleString()} 条` : '--'}</span>}
                                </div>
                              </>
                            )}
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
                                  { icon: <Image size={13} />, label: '图片', count: sessionDetail.imageCount, action: 'decrypt' as const },
                                  { icon: <Smile size={13} />, label: '表情', count: sessionDetail.emojiCount },
                                  { icon: <Video size={13} />, label: '视频', count: sessionDetail.videoCount },
                                  { icon: <Mic size={13} />, label: '语音', count: sessionDetail.voiceCount },
                                ] as const).filter(item => item.count > 0).map(item => (
                                  <div key={item.label} style={{
                                    flex: 1,
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'stretch',
                                    gap: 4,
                                    padding: '8px 4px',
                                    background: 'var(--bg-secondary)',
                                    borderRadius: 8,
                                  }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)', fontSize: 12 }}>
                                        {item.icon}
                                        <span>{item.label}</span>
                                      </div>
                                      {item.action === 'decrypt' && (
                                        <div className="session-media-image-actions">
                                          {isCurrentSessionImageTaskRunning ? (
                                            <span className="session-media-status-pill running">
                                              <Loader2 size={11} className="spin" />
                                              <span>解密中</span>
                                            </span>
                                          ) : currentSessionImageOverview?.status === 'checking' ? (
                                            <span className="session-media-status-pill checking">
                                              <Loader2 size={11} className="spin" />
                                              <span>检查中</span>
                                            </span>
                                          ) : hasCurrentSessionDecryptedImages ? (
                                            <>
                                              <button
                                                type="button"
                                                className="session-media-action-btn"
                                                onClick={openSessionImageAssetsModal}
                                                disabled={!selectedSession}
                                                title="查看已解密图片"
                                              >
                                                <span>查看图片</span>
                                              </button>
                                              {currentSessionAllImagesDecrypted ? (
                                                <span className="session-media-status-pill success">
                                                  <CheckCircle size={11} />
                                                  <span>已解密</span>
                                                </span>
                                              ) : (
                                                <span className="session-media-status-pill warning">
                                                  <span>未解密 {currentSessionImageUndecryptedCount}</span>
                                                </span>
                                              )}
                                            </>
                                          ) : (
                                            <button
                                              type="button"
                                              className="session-media-action-btn"
                                              onClick={openSessionImageDecrypt}
                                              disabled={isSessionImageDecrypting || !selectedSession}
                                              title="批量解密该会话图片"
                                            >
                                              <span>解密</span>
                                            </button>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                    <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', textAlign: 'center' }}>{item.count.toLocaleString()}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            <div style={{ marginTop: 8 }}>
                              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6 }}>数据库分布</div>
                              {sessionDetail.messageTables.length === 0 ? (
                                <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '4px 0' }}>暂无数据库分布信息</div>
                              ) : (
                                sessionDetail.messageTables.map((t, i) => (
                                  <div key={`${t.dbName}:${t.tableName}:${i}`} style={{
                                    padding: '8px 10px',
                                    marginBottom: 6,
                                    background: 'var(--bg-secondary)',
                                    borderRadius: 8,
                                    fontSize: 12,
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    gap: 8,
                                  }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>{t.dbName}</span>
                                    <span style={{ color: 'var(--primary)', fontWeight: 500 }}>{t.count.toLocaleString()} 条</span>
                                  </div>
                                ))
                              )}
                            </div>
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

      {/* 群内好友明细弹窗 */}
      {showGroupFriendsPopup && sessionDetail?.groupInfo && (
        <div className="export-overlay" onClick={() => setShowGroupFriendsPopup(false)}>
          <div className="group-friends-modal" onClick={(e) => e.stopPropagation()}>
            <div className="group-friends-modal-header">
              <div>
                <h3>群内好友</h3>
                <p>
                  {(sessionDetail.groupInfo.friendMembers?.length || sessionDetail.groupInfo.friendMemberCount || 0).toLocaleString()} 人
                </p>
              </div>
              <button
                type="button"
                className="group-friends-close-btn"
                onClick={() => setShowGroupFriendsPopup(false)}
                aria-label="关闭群内好友列表"
              >
                <X size={16} />
              </button>
            </div>
            <div className="group-friends-modal-subtitle">
              <div className="group-friends-modal-subtitle-text">
                {sessionDetail.remark || sessionDetail.nickName || (selectedSession ? sessionByUsername.get(selectedSession)?.displayName : undefined) || selectedSession}
              </div>
              {(sessionDetail.groupInfo.friendMembers || []).length > 0 && (
                <div className="group-friends-sort-switch" role="group" aria-label="发言条数排序">
                  <button
                    type="button"
                    className={`group-friends-sort-btn ${groupFriendsSortOrder === 'desc' ? 'active' : ''}`}
                    onClick={() => setGroupFriendsSortOrder('desc')}
                  >
                    降序
                  </button>
                  <button
                    type="button"
                    className={`group-friends-sort-btn ${groupFriendsSortOrder === 'asc' ? 'active' : ''}`}
                    onClick={() => setGroupFriendsSortOrder('asc')}
                  >
                    升序
                  </button>
                </div>
              )}
            </div>
            <div className="group-friends-list">
              {groupFriendMembersForPopup.length === 0 ? (
                <div className="group-friends-empty">暂无可展示好友</div>
              ) : (
                groupFriendMembersForPopup.map((friend, index) => (
                  <div key={friend.username} className="group-friends-item">
                    <div className="group-friends-index">{index + 1}</div>
                    <div className="group-friends-meta">
                      <div className="group-friends-name">{friend.displayName}</div>
                      <div className="group-friends-username">{friend.username}</div>
                    </div>
                    <div className={`group-friends-message-count ${groupFriendMessageCountsStatus === 'loading' ? 'is-loading' : ''} ${groupFriendMessageCountsStatus === 'error' ? 'is-error' : ''}`}>
                      {groupFriendMessageCountsSessionId === selectedSession && groupFriendMessageCountsStatus === 'ready'
                        ? `${(groupFriendMessageCounts[friend.username] || 0).toLocaleString()}条`
                        : groupFriendMessageCountsSessionId === selectedSession && groupFriendMessageCountsStatus === 'loading'
                          ? '统计中...'
                          : '--'}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* 会话图片批量解密 - 日期选择弹窗 */}
      {showSessionImageDecryptConfirm && (
        <div className="export-overlay" onClick={() => setShowSessionImageDecryptConfirm(false)}>
          <div className="image-decrypt-modal" onClick={(e) => e.stopPropagation()}>
            <div className="image-decrypt-modal-header">
              <div>
                <h3>批量解密图片</h3>
                <p>选择需要解密的日期范围（仅展示有图片的日期）</p>
              </div>
              <button
                type="button"
                className="group-friends-close-btn"
                onClick={() => setShowSessionImageDecryptConfirm(false)}
                aria-label="关闭图片解密弹窗"
              >
                <X size={16} />
              </button>
            </div>
            <div className="image-decrypt-modal-subtitle">
              {sessionDetail?.remark || sessionDetail?.nickName || (selectedSession ? sessionByUsername.get(selectedSession)?.displayName : undefined) || selectedSession}
            </div>
            <div className="image-decrypt-date-toolbar">
              <button type="button" onClick={selectAllSessionImageDates}>全选</button>
              <button type="button" onClick={clearAllSessionImageDates}>清空</button>
            </div>
            <div className="image-decrypt-date-grid">
              {sessionImageDates.length === 0 ? (
                <div className="group-friends-empty">暂无可选日期</div>
              ) : (
                sessionImageDates.map(dateStr => {
                  const count = sessionImageCountByDate.get(dateStr) ?? 0
                  const checked = sessionImageSelectedDates.has(dateStr)
                  return (
                    <button
                      key={dateStr}
                      type="button"
                      className={`image-decrypt-date-btn ${checked ? 'selected' : ''}`}
                      onClick={() => toggleSessionImageDate(dateStr)}
                    >
                      <span className="date-label">{formatImageDecryptDateLabel(dateStr)}</span>
                      <span className="date-count">{count} 张</span>
                    </button>
                  )
                })
              )}
            </div>
            <div className="image-decrypt-summary">
              已选择 {sessionImageSelectedDates.size} 天，共 {selectedSessionImageCount} 张图片
            </div>
            <div className="image-decrypt-modal-actions">
              <button type="button" className="cancel-btn" onClick={() => setShowSessionImageDecryptConfirm(false)}>
                取消
              </button>
              <button
                type="button"
                className="confirm-btn"
                onClick={confirmSessionImageDecrypt}
                disabled={isSessionImageDecrypting || selectedSessionImageCount === 0}
              >
                开始解密
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 会话图片资产查看弹窗（已解密预览 + 继续解密） */}
      {showSessionImageAssetsModal && (
        <div
          className="export-overlay"
          onClick={() => setShowSessionImageAssetsModal(false)}
        >
          <div className="session-image-assets-modal" onClick={(e) => e.stopPropagation()}>
            <div className="session-image-assets-header">
              <div>
                <h3>会话图片</h3>
                <p>查看已解密图片，并继续处理未解密图片</p>
              </div>
              <button
                type="button"
                className="group-friends-close-btn"
                onClick={() => setShowSessionImageAssetsModal(false)}
                aria-label="关闭会话图片弹窗"
              >
                <X size={16} />
              </button>
            </div>

            <div className="session-image-assets-subtitle">
              {sessionImageAssetsSessionName || sessionImageAssetsSessionId || selectedSession}
            </div>

            <div className="session-image-assets-toolbar">
              <div className="session-image-assets-stats">
                <div className="session-image-assets-stat">
                  <span className="label">总数</span>
                  <strong>{sessionImageAssetsTotalCount.toLocaleString()}</strong>
                </div>
                <div className="session-image-assets-stat success">
                  <span className="label">已解密</span>
                  <strong>{sessionImageAssetsDecryptedCount.toLocaleString()}</strong>
                </div>
                <div className="session-image-assets-stat warning">
                  <span className="label">未解密</span>
                  <strong>{sessionImageAssetsUndecryptedCount.toLocaleString()}</strong>
                </div>
              </div>
              <div className="session-image-assets-actions">
                {sessionImageAssetsLoading ? (
                  <span className="session-media-status-pill checking">
                    <Loader2 size={11} className="spin" />
                    <span>扫描中</span>
                  </span>
                ) : sessionImageAssetsSessionId && isSessionImageDecrypting && sessionImageDecryptTaskSessionId === sessionImageAssetsSessionId ? (
                  <span className="session-media-status-pill running">
                    <Loader2 size={11} className="spin" />
                    <span>解密中</span>
                  </span>
                ) : (sessionImageAssetsUndecryptedCount > 0) ? (
                  <button
                    type="button"
                    className="session-media-action-btn"
                    onClick={async () => {
                      setShowSessionImageAssetsModal(false)
                      await openSessionImageDecrypt()
                    }}
                    disabled={isSessionImageDecrypting}
                  >
                    <span>继续解密</span>
                  </button>
                ) : (
                  <span className="session-media-status-pill success">
                    <CheckCircle size={11} />
                    <span>已全部解密</span>
                  </span>
                )}
              </div>
            </div>

            <div className="session-image-assets-content">
              {sessionImageAssetsLoading ? (
                <div className="session-image-assets-loading">
                  <Loader2 size={14} className="spin" />
                  <span>正在扫描已解密图片...</span>
                </div>
              ) : sessionImageAssetsError ? (
                <div className="session-image-assets-empty">
                  <span>加载失败：{sessionImageAssetsError}</span>
                </div>
              ) : decryptedImageAssets.length === 0 ? (
                <div className="session-image-assets-empty">
                  <span>暂无已解密图片</span>
                  <small>你可以先点击上方“继续解密”处理当前会话图片。</small>
                </div>
              ) : (
                <div className="session-image-assets-grid">
                  {decryptedImageAssets
                    .slice()
                    .sort((a, b) => (b.createTime || 0) - (a.createTime || 0))
                    .map((item, index) => (
                      <button
                        key={`${item.imageMd5 || 'img'}:${item.imageDatName || index}:${item.createTime || 0}`}
                        type="button"
                        className="session-image-assets-item"
                        onClick={() => item.localPath && window.electronAPI.shell.openPath(item.localPath)}
                        title="打开图片文件"
                      >
                        {item.localUrl ? (
                          <img
                            src={item.localUrl}
                            alt=""
                            loading="lazy"
                          />
                        ) : (
                          <div className="session-image-assets-placeholder">
                            <Image size={18} />
                          </div>
                        )}
                        <div className="session-image-assets-item-footer">
                          <span>
                            {item.createTime
                              ? new Date(item.createTime * 1000).toLocaleDateString('zh-CN')
                              : '未知时间'}
                          </span>
                          <ExternalLink size={12} />
                        </div>
                      </button>
                    ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 会话图片批量解密 - 非阻塞任务卡片 */}
      {showSessionImageDecryptProgress && (
        <div className={`floating-task-card ${sessionImageDecryptTaskExpanded ? 'expanded' : 'collapsed'} ${sessionImageDecryptTaskStatus}`}>
          <div className="floating-task-header">
            <div className="floating-task-title-wrap">
              <div className="floating-task-title">图片解密任务</div>
              <div className={`floating-task-status ${isSessionImageDecrypting ? 'running' : sessionImageDecryptTaskStatus}`}>
                {isSessionImageDecrypting ? '进行中' : sessionImageDecryptTaskStatus === 'success' ? '已完成' : '失败'}
              </div>
            </div>
            <div className="floating-task-actions">
              <button
                type="button"
                onClick={() => setSessionImageDecryptTaskExpanded(v => !v)}
                title={sessionImageDecryptTaskExpanded ? '收起任务卡片' : '展开任务卡片'}
              >
                {sessionImageDecryptTaskExpanded ? '收起' : '展开'}
              </button>
              {!isSessionImageDecrypting && (
                <button
                  type="button"
                  onClick={() => setShowSessionImageDecryptProgress(false)}
                  title="关闭任务卡片"
                >
                  关闭
                </button>
              )}
            </div>
          </div>

          <div className="floating-task-session">
            {sessionImageDecryptTaskSessionName || sessionDetail?.remark || sessionDetail?.nickName || (selectedSession ? sessionByUsername.get(selectedSession)?.displayName : undefined) || selectedSession}
          </div>

          <div className="floating-task-progress-bar">
            <div
              className="floating-task-progress-fill"
              style={{
                width: `${sessionImageDecryptProgress.total > 0 ? (sessionImageDecryptProgress.current / sessionImageDecryptProgress.total) * 100 : 0}%`
              }}
            />
          </div>

          {sessionImageDecryptTaskExpanded ? (
            <div className="floating-task-body">
              <div className="floating-task-counts">
                <span>{sessionImageDecryptProgress.current} / {sessionImageDecryptProgress.total} 张</span>
                <span>成功 {sessionImageDecryptTaskStats.success}</span>
                <span>失败 {sessionImageDecryptTaskStats.fail}</span>
              </div>
              {isSessionImageDecrypting && (
                <div className="floating-task-running">
                  <Loader2 size={12} className="spin" />
                  <span>后台解密中，你可以继续操作页面</span>
                </div>
              )}
              {!isSessionImageDecrypting && sessionImageDecryptTaskStatus === 'success' && (
                <div className="floating-task-finish success">
                  <CheckCircle size={12} />
                  <span>解密完成</span>
                </div>
              )}
              {!isSessionImageDecrypting && sessionImageDecryptTaskStatus === 'error' && (
                <div className="floating-task-finish error">
                  <XCircle size={12} />
                  <span>{sessionImageDecryptTaskError || '解密任务失败'}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="floating-task-mini">
              <span>{sessionImageDecryptProgress.current} / {sessionImageDecryptProgress.total} 张</span>
              {!isSessionImageDecrypting && (
                <span className={`mini-result ${sessionImageDecryptTaskStatus}`}>
                  {sessionImageDecryptTaskStatus === 'success' ? `成功 ${sessionImageDecryptTaskStats.success}` : '失败'}
                </span>
              )}
            </div>
          )}
        </div>
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
