import { useState, useEffect, useCallback, useDeferredValue, useMemo, useRef, startTransition } from 'react'
import { Search, Download, FolderOpen, RefreshCw, Check, FileJson, FileText, Table, Loader2, X, FileSpreadsheet, Database, FileCode, CheckCircle, XCircle, ExternalLink, MessageSquare, Users, User, Filter, Image, Video, CircleUserRound, Smile, Mic, Newspaper, ChevronDown, MoreHorizontal, ArrowLeft, Eye, Aperture, CircleHelp, Copy } from 'lucide-react'
import { List, RowComponentProps } from 'react-window'
import DateRangePicker from '../components/DateRangePicker'
import { useTitleBarStore } from '../stores/titleBarStore'
import { useAppStore } from '../stores/appStore'
import { useExportPageCacheStore } from '../stores/exportPageCacheStore'
import { useTaskCenterStore } from '../stores/taskCenterStore'
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
type LoadSessionsOptions = {
  silent?: boolean
  preserveCounts?: boolean
}
type SelectSessionOptions = {
  source?: 'select' | 'refresh'
  forceReconnect?: boolean
}

const EXPORT_CHAT_CACHE_TTL_MS = 60 * 1000
const OVERVIEW_CHECKING_TIMEOUT_MS = 20 * 1000
const IMAGE_CACHE_RESOLVE_TIMEOUT_MS = 3000

interface SessionImageDecryptOverview {
  total: number
  decryptedCount: number
  undecryptedCount: number
  status: 'idle' | 'checking' | 'complete' | 'partial' | 'error'
  checkedAt?: number
  checkingStartedAt?: number
}

interface SessionImageAssetItem {
  imageMd5?: string
  imageDatName?: string
  createTime?: number
  localPath?: string
  localUrl?: string
  decrypted: boolean
}

interface SessionVideoAvailabilityOverview {
  total: number
  readyCount: number
  thumbOnlyCount: number
  missingCount: number
  rawMessageCount?: number
  parsedMessageCount?: number
  duplicateMessageCount?: number
  parseFailedCount?: number
  status: 'idle' | 'checking' | 'ready' | 'partial' | 'error'
  checkedAt?: number
  checkingStartedAt?: number
}

interface SessionVideoAssetItem {
  videoMd5?: string
  createTime?: number
  videoDuration?: number
  exists: boolean
  hasPreview: boolean
  videoUrl?: string
  coverUrl?: string
  thumbUrl?: string
}

// 会话类型筛选
type SessionTypeFilter = 'group' | 'private' | 'official'

type SessionDetailDiagStepKey = 'init' | 'reconnect' | 'exportRecords' | 'sessionDetail' | 'groupInfo' | 'finish'
type SessionDetailDiagStepStatus = 'pending' | 'loading' | 'success' | 'error' | 'skipped'

interface SessionDetailDiagStep {
  status: SessionDetailDiagStepStatus
  message?: string
  payloadSummary?: string
  startedAt?: number
  durationMs?: number
  updatedAt?: number
}

interface SessionDetailDiagEvent {
  ts: number
  level: 'info' | 'warn' | 'error'
  message: string
  data?: string
}

interface SessionDetailLoadDiagnostics {
  runId: number
  requestId: number
  source: 'select' | 'refresh'
  sessionId: string
  status: 'idle' | 'running' | 'success' | 'error'
  startedAt: number
  finishedAt?: number
  error?: string
  context?: {
    forceReconnect: boolean
    selectedSessionBefore?: string | null
    sessionAccountType?: string
  }
  steps: Record<SessionDetailDiagStepKey, SessionDetailDiagStep>
  events: SessionDetailDiagEvent[]
}

interface ExportSessionRowData {
  sessions: ChatSession[]
  selectedSession: string | null
  sessionTypeFilter: SessionTypeFilter
  sessionMessageCounts: SessionMessageCountMap
  sessionCardStatsMap: Record<string, SessionCardStats>
  onSelect: (username: string) => void
  onEnsureCardStats: (session: ChatSession) => void
  onOpenChatWindow: (session: ChatSession) => void
  onOpenCommonGroups: (session: ChatSession) => void
}

interface SessionCardGroupInfo {
  memberCount?: number
  friendMemberCount?: number
  selfMessageCount?: number
}

interface SessionCardStats {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  remark?: string
  nickName?: string
  alias?: string
  messageCount?: number
  firstMessageTime?: number
  latestMessageTime?: number
  imageCount?: number
  videoCount?: number
  voiceCount?: number
  emojiCount?: number
  commonGroupCount?: number
  groupInfo?: SessionCardGroupInfo
  groupInfoLoading?: boolean
  updatedAt?: number
}

const getAvatarLetter = (name: string) => {
  if (!name) return '?'
  return [...name][0] || '?'
}

const formatSessionCardDate = (timestamp?: number) => (
  timestamp ? new Date(timestamp * 1000).toLocaleDateString('zh-CN') : '--'
)

const SESSION_TABLE_HEADER_MEDIA_ICONS: Record<string, JSX.Element> = {
  图片: <Image size={11} />,
  视频: <Video size={11} />,
  表情包: <Smile size={11} />,
  语音: <Mic size={11} />
}

const getSessionTableLayoutClass = (filter: SessionTypeFilter) => {
  if (filter === 'private') return 'session-grid-private'
  if (filter === 'group') return 'session-grid-group'
  return 'session-grid-official'
}

const getSessionTableHeaderColumns = (filter: SessionTypeFilter) => {
  if (filter === 'private') {
    return ['会话信息', '总消息', '共同群聊', '最早时间', '最新时间', '图片', '视频', '表情包', '语音']
  }
  if (filter === 'group') {
    return ['会话信息', '总消息', '群人数', '群内好友数', '我发消息', '最早时间', '最新时间', '图片', '视频', '表情包', '语音']
  }
  return ['会话信息', '总消息', '最早时间', '最新时间', '图片', '视频', '表情包', '语音']
}

const SESSION_DETAIL_DIAG_STEP_LABELS: Record<SessionDetailDiagStepKey, string> = {
  init: '初始化会话状态',
  reconnect: '强制重连 chat 服务',
  exportRecords: '加载导出记录',
  sessionDetail: '加载会话详情 (getSessionDetail)',
  groupInfo: '加载群扩展信息',
  finish: '结束'
}

const SESSION_DETAIL_DIAG_STEP_ORDER: SessionDetailDiagStepKey[] = [
  'init',
  'reconnect',
  'exportRecords',
  'sessionDetail',
  'groupInfo',
  'finish'
]

const createSessionDetailDiagnostics = (
  runId: number,
  requestId: number,
  sessionId: string,
  source: 'select' | 'refresh',
  context?: SessionDetailLoadDiagnostics['context']
): SessionDetailLoadDiagnostics => ({
  runId,
  requestId,
  source,
  sessionId,
  status: 'running',
  startedAt: Date.now(),
  context,
  steps: {
    init: { status: 'pending' },
    reconnect: { status: 'pending' },
    exportRecords: { status: 'pending' },
    sessionDetail: { status: 'pending' },
    groupInfo: { status: 'pending' },
    finish: { status: 'pending' }
  },
  events: []
})

const matchesSessionTypeFilter = (session: ChatSession, filter: SessionTypeFilter) => {
  if (filter === 'group') return session.accountType === 'group'
  if (filter === 'private') return session.accountType === 'friend'
  return session.accountType === 'official'
}

const ExportSessionRow = (props: RowComponentProps<ExportSessionRowData>) => {
  const {
    index,
    style,
    sessions,
    selectedSession,
    sessionTypeFilter,
    sessionMessageCounts,
    sessionCardStatsMap,
    onSelect,
    onEnsureCardStats,
    onOpenChatWindow,
    onOpenCommonGroups
  } = props
  const session = sessions[index]
  const cardStats = sessionCardStatsMap[session.username]
  const messageCount = cardStats?.messageCount ?? sessionMessageCounts[session.username]
  const isGroup = session.username.includes('@chatroom')
  const isPrivate = session.accountType === 'friend'
  const isOfficial = session.accountType === 'official'
  const statsLoading = cardStats?.status === 'loading' || (isGroup && cardStats?.groupInfoLoading)
  const mediaStats = [
    { label: '图片', count: cardStats?.imageCount },
    { label: '视频', count: cardStats?.videoCount },
    { label: '表情包', count: cardStats?.emojiCount },
    { label: '语音', count: cardStats?.voiceCount }
  ] as const
  const gridClass = getSessionTableLayoutClass(sessionTypeFilter)
  const primaryName = (cardStats?.remark || cardStats?.nickName || session.displayName || session.username || '').trim()
  const secondaryParts = [cardStats?.nickName, cardStats?.remark]
    .map(v => v?.trim())
    .filter((v): v is string => Boolean(v))
    .filter((v, i, arr) => v !== primaryName && arr.indexOf(v) === i)
  const openChatLabel = isGroup ? '打开群聊' : isPrivate ? '打开私聊' : '打开公众号'
  const infoIdLine = cardStats?.alias ? `${session.username} · ${cardStats.alias}` : session.username

  useEffect(() => {
    onEnsureCardStats(session)
  }, [onEnsureCardStats, session])

  return (
    <div style={{ ...style, padding: 0, boxSizing: 'border-box' }}>
      <div
        className={`export-session-item ${selectedSession === session.username ? 'selected' : ''}`}
        onClick={() => onSelect(session.username)}
      >
        <div className={`export-session-table-row ${gridClass}`}>
          <div className="session-table-cell session-cell-info">
            <div className="export-avatar">
              {session.avatarUrl ? (
                <img src={session.avatarUrl} alt="" loading="lazy" />
              ) : (
                <span className={isGroup ? 'group-placeholder' : ''}>
                  {isGroup ? '群' : getAvatarLetter(session.displayName || session.username)}
                </span>
              )}
            </div>
            <div className="session-cell-info-main">
              <div className="session-cell-title-row">
                <div className="export-session-name">{primaryName || session.username}</div>
              </div>
              <div className="session-cell-subtitle">
                {secondaryParts.length > 0 ? secondaryParts.join(' · ') : (session.summary || '暂无消息')}
              </div>
              <div className="session-cell-weak" title={infoIdLine}>{infoIdLine}</div>
            </div>
            {(statsLoading || cardStats?.status === 'error') && (
              <div className={`session-card-inline-status ${cardStats?.status === 'error' && !statsLoading ? 'error' : ''}`}>
                {statsLoading ? <Loader2 size={12} className="spin" /> : null}
                <span>{statsLoading ? '统计中' : '统计失败'}</span>
              </div>
            )}
          </div>

          <div className="session-table-cell session-cell-kpi">
            <div className="export-session-count-value">
              {messageCount !== undefined ? messageCount.toLocaleString() : '--'}
            </div>
            <button
              type="button"
              className="session-table-inline-btn"
              onClick={(e) => {
                e.stopPropagation()
                onOpenChatWindow(session)
              }}
            >
              {openChatLabel}
            </button>
          </div>

          {isPrivate && (
            <>
              <div className="session-table-cell session-cell-metric">
                <div className="session-metric-inline-combo">
                  <span className="metric-inline-value">
                    {cardStats?.commonGroupCount !== undefined ? `${cardStats.commonGroupCount.toLocaleString()} 个` : '--'}
                  </span>
                  <button
                    type="button"
                    className="metric-inline-link"
                    onClick={async (e) => {
                      e.stopPropagation()
                      onOpenCommonGroups(session)
                    }}
                  >
                    <Eye size={11} />
                    <span>查看</span>
                  </button>
                </div>
              </div>
              <div className="session-table-cell session-cell-metric">{formatSessionCardDate(cardStats?.firstMessageTime)}</div>
              <div className="session-table-cell session-cell-metric">{formatSessionCardDate(cardStats?.latestMessageTime)}</div>
            </>
          )}

          {isGroup && (
            <>
              <div className="session-table-cell session-cell-metric">
                {cardStats?.groupInfo?.memberCount !== undefined ? cardStats.groupInfo.memberCount.toLocaleString() : '--'}
              </div>
              <div className="session-table-cell session-cell-metric">
                {cardStats?.groupInfo?.friendMemberCount !== undefined ? cardStats.groupInfo.friendMemberCount.toLocaleString() : '--'}
              </div>
              <div className="session-table-cell session-cell-metric">
                {cardStats?.groupInfo?.selfMessageCount !== undefined ? cardStats.groupInfo.selfMessageCount.toLocaleString() : '--'}
              </div>
              <div className="session-table-cell session-cell-metric">{formatSessionCardDate(cardStats?.firstMessageTime)}</div>
              <div className="session-table-cell session-cell-metric">{formatSessionCardDate(cardStats?.latestMessageTime)}</div>
            </>
          )}

          {isOfficial && (
            <>
              <div className="session-table-cell session-cell-metric">{formatSessionCardDate(cardStats?.firstMessageTime)}</div>
              <div className="session-table-cell session-cell-metric">{formatSessionCardDate((cardStats?.latestMessageTime ?? session.lastTimestamp) || undefined)}</div>
            </>
          )}

          {mediaStats.map(item => (
            <div key={item.label} className="session-table-cell session-cell-metric session-cell-media" title={item.label}>
              <span className="media-value">{item.count !== undefined ? item.count.toLocaleString() : '--'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ExportPage() {
  const [activeTab, setActiveTab] = useState<ExportTab>('chat')
  const setTitleBarContent = useTitleBarStore(state => state.setRightContent)
  const isDbConnected = useAppStore(state => state.isDbConnected)
  const dbPath = useAppStore(state => state.dbPath)
  const storeMyWxid = useAppStore(state => state.myWxid)
  const preloadedUserInfo = useAppStore(state => state.userInfo)
  const userInfoLoaded = useAppStore(state => state.userInfoLoaded)
  const exportPageChatCache = useExportPageCacheStore(state => state.chatCache)
  const setExportPageChatCache = useExportPageCacheStore(state => state.setChatCache)
  const taskCenterUpsertTask = useTaskCenterStore(state => state.upsertTask)
  const taskCenterPatchTask = useTaskCenterStore(state => state.patchTask)
  const taskCenterSetActiveExportTaskId = useTaskCenterStore(state => state.setActiveExportTaskId)
  const taskCenterOpen = useTaskCenterStore(state => state.openTaskCenter)
  const taskCenterHighlightTask = useTaskCenterStore(state => state.highlightTask)
  const hasRunningGlobalChatExportTask = useTaskCenterStore(state => state.tasks.some(
    task => task.kind === 'chat-export' && (task.status === 'pending' || task.status === 'running')
  ))
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
  const [isRefreshingSessions, setIsRefreshingSessions] = useState(false)
  const [isLoadingSessionCounts, setIsLoadingSessionCounts] = useState(false)
  const [loadedSessionCountUsernames, setLoadedSessionCountUsernames] = useState<Set<string>>(new Set())
  const [searchKeyword, setSearchKeyword] = useState('')
  const [sessionTypeFilter, setSessionTypeFilter] = useState<SessionTypeFilter>('private')
  const [exportFolder, setExportFolder] = useState<string>('')
  const [isExporting, setIsExporting] = useState(false)
  const [exportResult, setExportResult] = useState<ExportResult | null>(null)
  const [isSessionImageDecrypting, setIsSessionImageDecrypting] = useState(false)
  const [showSessionImageDecryptConfirm, setShowSessionImageDecryptConfirm] = useState(false)
  const [sessionImageDecryptTaskSessionId, setSessionImageDecryptTaskSessionId] = useState<string | null>(null)
  const [sessionImageOverviews, setSessionImageOverviews] = useState<Record<string, SessionImageDecryptOverview>>({})
  const [showSessionImageAssetsModal, setShowSessionImageAssetsModal] = useState(false)
  const [sessionImageAssetsLoading, setSessionImageAssetsLoading] = useState(false)
  const [sessionImageAssetsError, setSessionImageAssetsError] = useState<string | null>(null)
  const [sessionImageAssetsSessionId, setSessionImageAssetsSessionId] = useState<string | null>(null)
  const [sessionImageAssetsSessionName, setSessionImageAssetsSessionName] = useState('')
  const [sessionImageAssets, setSessionImageAssets] = useState<SessionImageAssetItem[]>([])
  const [sessionVideoOverviews, setSessionVideoOverviews] = useState<Record<string, SessionVideoAvailabilityOverview>>({})
  const [showSessionVideoAssetsModal, setShowSessionVideoAssetsModal] = useState(false)
  const [sessionVideoAssetsLoading, setSessionVideoAssetsLoading] = useState(false)
  const [sessionVideoAssetsError, setSessionVideoAssetsError] = useState<string | null>(null)
  const [sessionVideoAssetsSessionId, setSessionVideoAssetsSessionId] = useState<string | null>(null)
  const [sessionVideoAssetsSessionName, setSessionVideoAssetsSessionName] = useState('')
  const [sessionVideoAssets, setSessionVideoAssets] = useState<SessionVideoAssetItem[]>([])
  const [sessionImageMessages, setSessionImageMessages] = useState<{ imageMd5?: string; imageDatName?: string; createTime?: number }[] | null>(null)
  const [sessionImageDates, setSessionImageDates] = useState<string[]>([])
  const [sessionImageSelectedDates, setSessionImageSelectedDates] = useState<Set<string>>(new Set())

  const [showFormatPicker, setShowFormatPicker] = useState(false)
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const [sessionCardStatsMap, setSessionCardStatsMap] = useState<Record<string, SessionCardStats>>({})
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
    commonGroupCount?: number
    commonGroups?: Array<{ username: string; displayName: string }>
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
  const [showCommonGroupsPopup, setShowCommonGroupsPopup] = useState(false)
  const [groupFriendMessageCounts, setGroupFriendMessageCounts] = useState<Record<string, number>>({})
  const [groupFriendMessageCountsStatus, setGroupFriendMessageCountsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [groupFriendMessageCountsSessionId, setGroupFriendMessageCountsSessionId] = useState<string | null>(null)
  const [groupFriendsSortOrder, setGroupFriendsSortOrder] = useState<'desc' | 'asc'>('desc')
  const [commonGroupMessageCounts, setCommonGroupMessageCounts] = useState<Record<string, { selfMessageCount: number; peerMessageCount: number }>>({})
  const [commonGroupMessageCountsStatus, setCommonGroupMessageCountsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [commonGroupMessageCountsSessionId, setCommonGroupMessageCountsSessionId] = useState<string | null>(null)
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)
  const [isLoadingGroupInfo, setIsLoadingGroupInfo] = useState(false)
  const [exportRecords, setExportRecords] = useState<{ exportTime: number; format: string; messageCount: number }[]>([])
  const [sessionDetailDiagnostics, setSessionDetailDiagnostics] = useState<SessionDetailLoadDiagnostics | null>(null)
  const [showSessionDetailDiagnostics, setShowSessionDetailDiagnostics] = useState(false)
  const [showSessionDetailDiagPayloads, setShowSessionDetailDiagPayloads] = useState(false)
  const [showSessionDetailDiagEvents, setShowSessionDetailDiagEvents] = useState(false)
  const [isRefreshingSessionDetail, setIsRefreshingSessionDetail] = useState(false)
  const [showExportSettings, setShowExportSettings] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [showUsageTipsPopover, setShowUsageTipsPopover] = useState(false)
  const [snsUserPostCounts, setSnsUserPostCounts] = useState<Record<string, number>>({})
  const [snsUserPostCountsStatus, setSnsUserPostCountsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [copiedIdentityChip, setCopiedIdentityChip] = useState<'wxid' | 'alias' | null>(null)
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
  const [hideImageDecryptExportTip, setHideImageDecryptExportTip] = useState(false)

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
  const sessionCardStatsMapRef = useRef<Record<string, SessionCardStats>>({})
  const sessionCardStatsLoadingRef = useRef<Record<string, boolean>>({})
  const groupFriendMessageCountsRequestIdRef = useRef(0)
  const commonGroupMessageCountsRequestIdRef = useRef(0)
  const sessionImageOverviewRequestIdRef = useRef<Record<string, number>>({})
  const sessionImageOverviewPendingRef = useRef<Record<string, boolean>>({})
  const sessionImageAssetsRequestIdRef = useRef(0)
  const sessionVideoOverviewRequestIdRef = useRef<Record<string, number>>({})
  const sessionVideoAssetsRequestIdRef = useRef(0)
  const sessionTypeFilterRef = useRef<SessionTypeFilter>('private')
  const sessionTableHeaderScrollRef = useRef<HTMLDivElement | null>(null)
  const sessionTableScrollRef = useRef<HTMLDivElement | null>(null)
  const sessionTableScrollbarRef = useRef<HTMLDivElement | null>(null)
  const sessionTableScrollSyncSourceRef = useRef<'main' | 'header' | 'bar' | null>(null)
  const hasBootstrappedChatCacheRef = useRef(false)
  const bootstrappedChatCacheKeyRef = useRef<string | null>(null)
  const chatCacheDataLoadedAtRef = useRef(0)
  const pendingCachedSelectedSessionRef = useRef<string | null>(null)
  const identityChipCopyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionDetailDiagRunIdRef = useRef(0)

  useEffect(() => {
    sessionTypeFilterRef.current = sessionTypeFilter
  }, [sessionTypeFilter])

  useEffect(() => {
    sessionCardStatsMapRef.current = sessionCardStatsMap
  }, [sessionCardStatsMap])

  useEffect(() => {
    return () => {
      if (identityChipCopyResetTimerRef.current) {
        clearTimeout(identityChipCopyResetTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    setCopiedIdentityChip(null)
    if (identityChipCopyResetTimerRef.current) {
      clearTimeout(identityChipCopyResetTimerRef.current)
      identityChipCopyResetTimerRef.current = null
    }
  }, [selectedSession])

  useEffect(() => {
    setHideImageDecryptExportTip(false)
  }, [selectedSession])

  const exportChatCacheKey = useMemo(() => {
    if (!isDbConnected) return ''
    const accountWxid = preloadedUserInfo?.wxid || storeMyWxid || ''
    return [dbPath || 'no-db-path', accountWxid || 'unknown-account'].join('::')
  }, [dbPath, isDbConnected, preloadedUserInfo?.wxid, storeMyWxid])

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

  const loadSnsUserPostCounts = useCallback(() => {
    let cancelled = false

    if (!isDbConnected) {
      setSnsUserPostCounts({})
      setSnsUserPostCountsStatus('idle')
      return () => {
        cancelled = true
      }
    }

    setSnsUserPostCountsStatus('loading')
    window.electronAPI.sns.getUserPostCounts()
      .then((result) => {
        if (cancelled) return
        if (result.success) {
          setSnsUserPostCounts(result.counts || {})
          setSnsUserPostCountsStatus('ready')
          return
        }
        setSnsUserPostCounts({})
        setSnsUserPostCountsStatus('error')
      })
      .catch((e) => {
        if (cancelled) return
        console.error('导出页加载朋友圈总条数失败:', e)
        setSnsUserPostCounts({})
        setSnsUserPostCountsStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [isDbConnected])

  useEffect(() => {
    const cleanup = loadSnsUserPostCounts()
    return cleanup
  }, [loadSnsUserPostCounts])

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

  // 加载聊天会话
  const loadSessions = useCallback(async (options?: LoadSessionsOptions) => {
    const silent = Boolean(options?.silent)
    const preserveCounts = Boolean(options?.preserveCounts)

    if (silent) {
      setIsRefreshingSessions(true)
    } else {
      setIsLoading(true)
    }
    try {
      const result = await window.electronAPI.chat.connect()
      if (!result.success) {
        console.error('连接失败:', result.error)
        return
      }
      const sessionsResult = await window.electronAPI.chat.getSessions()
      if (sessionsResult.success && sessionsResult.sessions) {
        setSessions(sessionsResult.sessions)
        setSessionCardStatsMap({})
        sessionCardStatsLoadingRef.current = {}
        chatCacheDataLoadedAtRef.current = Date.now()

        const currentUsernames = new Set(sessionsResult.sessions.map(s => s.username))
        if (preserveCounts) {
          setSessionMessageCounts(prev => {
            const next: SessionMessageCountMap = {}
            for (const [username, count] of Object.entries(prev)) {
              if (currentUsernames.has(username)) {
                next[username] = count
              }
            }
            return next
          })
          setLoadedSessionCountUsernames(prev => {
            const next = new Set<string>()
            prev.forEach(username => {
              if (currentUsernames.has(username)) next.add(username)
            })
            return next
          })
        } else {
          setSessionMessageCounts({})
          setLoadedSessionCountUsernames(new Set())
        }
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
      if (silent) {
        setIsRefreshingSessions(false)
      } else {
        setIsLoading(false)
      }
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
    loadExportPath()
    loadDefaultExportConfig()
  }, [loadExportPath, loadDefaultExportConfig])

  useEffect(() => {
    if (!isDbConnected) {
      hasBootstrappedChatCacheRef.current = false
      bootstrappedChatCacheKeyRef.current = null
      chatCacheDataLoadedAtRef.current = 0
      pendingCachedSelectedSessionRef.current = null
      setSessions([])
      setSessionMessageCounts({})
      setLoadedSessionCountUsernames(new Set())
      setSelectedSession(null)
      setSearchKeyword('')
      setSessionTypeFilter('private')
      setIsLoading(false)
      setIsRefreshingSessions(false)
      return
    }

    if (!exportChatCacheKey) return
    if (bootstrappedChatCacheKeyRef.current === exportChatCacheKey) return

    bootstrappedChatCacheKeyRef.current = exportChatCacheKey

    const cache = exportPageChatCache
    const matchedCache = cache && cache.cacheKey === exportChatCacheKey ? cache : null
    const now = Date.now()

    if (matchedCache) {
      setSessions(matchedCache.sessions)
      setSessionMessageCounts(matchedCache.sessionMessageCounts || {})
      setLoadedSessionCountUsernames(new Set(matchedCache.loadedSessionCountUsernames || []))
      setSearchKeyword(matchedCache.searchKeyword || '')
      setSessionTypeFilter(matchedCache.sessionTypeFilter || 'private')
      const cachedSelectedSession = matchedCache.selectedSession && matchedCache.sessions.some(s => s.username === matchedCache.selectedSession)
        ? matchedCache.selectedSession
        : null
      pendingCachedSelectedSessionRef.current = cachedSelectedSession
      setSelectedSession(cachedSelectedSession)
      chatCacheDataLoadedAtRef.current = matchedCache.dataLoadedAt || 0
      setIsLoading(false)
    } else {
      pendingCachedSelectedSessionRef.current = null
      setIsLoading(true)
    }

    hasBootstrappedChatCacheRef.current = true

    const shouldRefresh = !matchedCache ||
      matchedCache.dirty ||
      !matchedCache.dataLoadedAt ||
      now - matchedCache.dataLoadedAt > EXPORT_CHAT_CACHE_TTL_MS

    if (shouldRefresh) {
      void loadSessions({
        silent: Boolean(matchedCache),
        preserveCounts: Boolean(matchedCache)
      })
    }
  }, [isDbConnected, exportChatCacheKey, exportPageChatCache, loadSessions])

  useEffect(() => {
    if (!isDbConnected || !exportChatCacheKey) return
    if (!hasBootstrappedChatCacheRef.current) return
    if (sessions.length === 0 && chatCacheDataLoadedAtRef.current === 0) return

    setExportPageChatCache({
      cacheKey: exportChatCacheKey,
      sessions,
      sessionMessageCounts,
      loadedSessionCountUsernames: Array.from(loadedSessionCountUsernames),
      selectedSession,
      searchKeyword,
      sessionTypeFilter,
      dataLoadedAt: chatCacheDataLoadedAtRef.current || Date.now(),
      dirty: false
    })
  }, [
    isDbConnected,
    exportChatCacheKey,
    sessions,
    sessionMessageCounts,
    loadedSessionCountUsernames,
    selectedSession,
    searchKeyword,
    sessionTypeFilter,
    setExportPageChatCache
  ])

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

    if (hasCountsForCurrentFiltered) {
      filtered = [...filtered].sort((a, b) => {
        const countDiff = (deferredSessionMessageCounts[b.username] || 0) - (deferredSessionMessageCounts[a.username] || 0)
        if (countDiff !== 0) return countDiff
        return (b.lastTimestamp || 0) - (a.lastTimestamp || 0)
      })
    }

    return filtered
  }, [sessions, sessionTypeFilter, deferredSearchKeyword, deferredSessionMessageCounts, loadedSessionCountUsernames])

  const sessionListHeaderColumns = useMemo(
    () => getSessionTableHeaderColumns(sessionTypeFilter),
    [sessionTypeFilter]
  )
  const sessionListGridClass = useMemo(
    () => getSessionTableLayoutClass(sessionTypeFilter),
    [sessionTypeFilter]
  )
  const sessionListRowHeight = useMemo(
    () => (sessionTypeFilter === 'group' ? 76 : 72),
    [sessionTypeFilter]
  )
  const [sessionTableHorizontalScrollState, setSessionTableHorizontalScrollState] = useState({
    scrollLeft: 0,
    viewportWidth: 0,
    contentWidth: 0
  })

  const updateSessionTableHorizontalScrollState = useCallback(() => {
    const el = sessionTableScrollRef.current
    if (!el) {
      setSessionTableHorizontalScrollState(prev => (
        prev.scrollLeft === 0 && prev.viewportWidth === 0 && prev.contentWidth === 0
          ? prev
          : { scrollLeft: 0, viewportWidth: 0, contentWidth: 0 }
      ))
      return
    }

    const next = {
      scrollLeft: el.scrollLeft,
      viewportWidth: el.clientWidth,
      contentWidth: el.scrollWidth
    }

    setSessionTableHorizontalScrollState(prev => (
      prev.scrollLeft === next.scrollLeft &&
      prev.viewportWidth === next.viewportWidth &&
      prev.contentWidth === next.contentWidth
        ? prev
        : next
    ))

    const header = sessionTableHeaderScrollRef.current
    if (header && Math.abs(header.scrollLeft - next.scrollLeft) > 1) {
      sessionTableScrollSyncSourceRef.current = 'main'
      header.scrollLeft = next.scrollLeft
    }

    const bar = sessionTableScrollbarRef.current
    if (bar && Math.abs(bar.scrollLeft - next.scrollLeft) > 1) {
      sessionTableScrollSyncSourceRef.current = 'main'
      bar.scrollLeft = next.scrollLeft
    }
  }, [])

  useEffect(() => {
    if (isLoading || filteredSessions.length === 0) {
      setSessionTableHorizontalScrollState(prev => (
        prev.scrollLeft === 0 && prev.viewportWidth === 0 && prev.contentWidth === 0
          ? prev
          : { scrollLeft: 0, viewportWidth: 0, contentWidth: 0 }
      ))
      return
    }

    let rafId = 0
    const scheduleUpdate = () => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        rafId = 0
        updateSessionTableHorizontalScrollState()
      })
    }

    scheduleUpdate()

    const el = sessionTableScrollRef.current
    const resizeObserver = (typeof ResizeObserver !== 'undefined' && el)
      ? new ResizeObserver(() => scheduleUpdate())
      : null

    if (resizeObserver && el) {
      resizeObserver.observe(el)
    }

    window.addEventListener('resize', scheduleUpdate)

    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      resizeObserver?.disconnect()
      window.removeEventListener('resize', scheduleUpdate)
    }
  }, [filteredSessions.length, isLoading, sessionTypeFilter, updateSessionTableHorizontalScrollState])

  const sessionTableHasHorizontalOverflow = sessionTableHorizontalScrollState.contentWidth > (sessionTableHorizontalScrollState.viewportWidth + 1)
  const sessionTableCanScrollLeft = sessionTableHasHorizontalOverflow && sessionTableHorizontalScrollState.scrollLeft > 1
  const sessionTableCanScrollRight = sessionTableHasHorizontalOverflow && (
    sessionTableHorizontalScrollState.scrollLeft < (sessionTableHorizontalScrollState.contentWidth - sessionTableHorizontalScrollState.viewportWidth - 1)
  )

  useEffect(() => {
    if (!selectedSession) return
    if (sessions.some(session => session.username === selectedSession)) return
    setSelectedSession(null)
  }, [selectedSession, sessions])

  const sessionByUsername = useMemo(() => {
    const map = new Map<string, ChatSession>()
    for (const session of sessions) {
      map.set(session.username, session)
    }
    return map
  }, [sessions])

  const selectedSessionItem = useMemo(
    () => (selectedSession ? sessionByUsername.get(selectedSession) : undefined),
    [selectedSession, sessionByUsername]
  )

  useEffect(() => {
    if (sessions.length === 0) {
      setSessionCardStatsMap({})
      sessionCardStatsLoadingRef.current = {}
      return
    }
    const currentUsernames = new Set(sessions.map(session => session.username))
    setSessionCardStatsMap(prev => {
      let changed = false
      const next: Record<string, SessionCardStats> = {}
      for (const [username, stats] of Object.entries(prev)) {
        if (currentUsernames.has(username)) {
          next[username] = stats
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    })
    Object.keys(sessionCardStatsLoadingRef.current).forEach(username => {
      if (!currentUsernames.has(username)) {
        delete sessionCardStatsLoadingRef.current[username]
      }
    })
  }, [sessions])

  const patchSessionCardStats = useCallback((username: string, patch: Partial<SessionCardStats>) => {
    setSessionCardStatsMap(prev => {
      const prevItem = prev[username] || { status: 'idle' as const }
      return {
        ...prev,
        [username]: {
          ...prevItem,
          ...patch
        }
      }
    })
  }, [])

  useEffect(() => {
    if (!selectedSession || !sessionDetail || sessionDetail.wxid !== selectedSession) return

    patchSessionCardStats(selectedSession, {
      status: 'ready',
      remark: sessionDetail.remark,
      nickName: sessionDetail.nickName,
      alias: sessionDetail.alias,
      messageCount: sessionDetail.messageCount,
      firstMessageTime: sessionDetail.firstMessageTime,
      latestMessageTime: sessionDetail.latestMessageTime,
      imageCount: sessionDetail.imageCount,
      videoCount: sessionDetail.videoCount,
      voiceCount: sessionDetail.voiceCount,
      emojiCount: sessionDetail.emojiCount,
      commonGroupCount: sessionDetail.commonGroupCount,
      groupInfo: sessionDetail.groupInfo ? {
        memberCount: sessionDetail.groupInfo.memberCount,
        friendMemberCount: sessionDetail.groupInfo.friendMemberCount,
        selfMessageCount: sessionDetail.groupInfo.selfMessageCount
      } : undefined,
      groupInfoLoading: isLoadingGroupInfo,
      updatedAt: Date.now(),
      error: undefined
    })
  }, [isLoadingGroupInfo, patchSessionCardStats, selectedSession, sessionDetail])

  const ensureSessionCardStats = useCallback(async (session: ChatSession) => {
    const username = session.username
    const current = sessionCardStatsMapRef.current[username]

    if (current?.status === 'ready' && (!username.includes('@chatroom') || current.groupInfo?.memberCount !== undefined || current.groupInfo?.friendMemberCount !== undefined || current.groupInfo?.selfMessageCount !== undefined)) {
      return
    }
    if (sessionCardStatsLoadingRef.current[username]) return

    sessionCardStatsLoadingRef.current[username] = true
    patchSessionCardStats(username, {
      status: current?.status === 'ready' ? 'ready' : 'loading',
      error: undefined,
      groupInfoLoading: username.includes('@chatroom')
    })

    try {
      const detailResult = await window.electronAPI.chat.getSessionDetail(username, { includeGroupInfo: false })
      if (!detailResult.success || !detailResult.detail) {
        throw new Error(detailResult.error || '获取会话统计失败')
      }

      patchSessionCardStats(username, {
        status: 'ready',
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
        commonGroupCount: detailResult.detail.commonGroupCount,
        groupInfoLoading: username.includes('@chatroom'),
        updatedAt: Date.now(),
        error: undefined
      })

      if (username.includes('@chatroom')) {
        const groupResult = await window.electronAPI.chat.getSessionGroupInfo(username)
        if (groupResult.success) {
          patchSessionCardStats(username, {
            status: 'ready',
            groupInfo: {
              memberCount: groupResult.groupInfo?.memberCount,
              friendMemberCount: groupResult.groupInfo?.friendMemberCount,
              selfMessageCount: groupResult.groupInfo?.selfMessageCount
            },
            groupInfoLoading: false,
            updatedAt: Date.now()
          })
        } else {
          patchSessionCardStats(username, {
            status: 'ready',
            groupInfoLoading: false
          })
        }
      } else {
        patchSessionCardStats(username, {
          groupInfoLoading: false
        })
      }
    } catch (error) {
      patchSessionCardStats(username, {
        status: 'error',
        error: String(error),
        groupInfoLoading: false
      })
    } finally {
      delete sessionCardStatsLoadingRef.current[username]
    }
  }, [patchSessionCardStats])

  const closeSessionDrawer = useCallback(() => {
    setShowExportSettings(false)
    setShowGroupFriendsPopup(false)
    setShowCommonGroupsPopup(false)
    setSelectedSession(null)
  }, [])

  const isSelectedFriendSession = selectedSessionItem?.accountType === 'friend'
  const selectedSessionMessageCountLabel = sessionDetail
    ? `${sessionDetail.messageCount.toLocaleString()} 条消息`
    : '--'
  const selectedSessionMomentsTotalCount = snsUserPostCountsStatus === 'ready'
    ? (snsUserPostCounts[(sessionDetail?.wxid || selectedSessionItem?.username || selectedSession || '').trim()] ?? 0)
    : null
  const selectedSessionMomentsCountLabel = isSelectedFriendSession
    ? (selectedSessionMomentsTotalCount !== null ? `${selectedSessionMomentsTotalCount.toLocaleString()} 条动态` : '--')
    : '不适用'

  const renderFieldLoading = () => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: 0.65, fontSize: 12 }}>
      <Loader2 size={12} style={{ animation: 'exportSpin 1s linear infinite' }} />
      <span>加载中...</span>
    </span>
  )

  const toDiagSummary = useCallback((value: unknown, maxLen = 720) => {
    if (value == null) return undefined
    try {
      const compact = (input: unknown, depth = 0): unknown => {
        if (input == null) return input
        if (typeof input === 'string') {
          if (input.length <= 160) return input
          return `${input.slice(0, 160)}...<${input.length - 160} chars>`
        }
        if (typeof input !== 'object') return input
        if (depth >= 2) {
          if (Array.isArray(input)) return `[Array(${input.length})]`
          return '[Object]'
        }
        if (Array.isArray(input)) {
          const slice = input.slice(0, 5).map(item => compact(item, depth + 1))
          if (input.length > 5) slice.push(`...(${input.length - 5} more)`)
          return slice
        }
        const obj = input as Record<string, unknown>
        const entries = Object.entries(obj)
          .filter(([k]) => !/(raw|content|html|xml|buffer|blob)/i.test(k))
          .slice(0, 12)
          .map(([k, v]) => [k, compact(v, depth + 1)] as const)
        const next: Record<string, unknown> = {}
        entries.forEach(([k, v]) => { next[k] = v })
        if (Object.keys(obj).length > 12) {
          next.__truncatedKeys = Object.keys(obj).length - 12
        }
        return next
      }

      const text = JSON.stringify(compact(value))
      if (!text) return undefined
      return text.length > maxLen ? `${text.slice(0, maxLen)}...<truncated ${text.length - maxLen} chars>` : text
    } catch {
      return String(value)
    }
  }, [])

  const updateSessionDetailDiagStep = useCallback((
    runId: number,
    step: SessionDetailDiagStepKey,
    status: SessionDetailDiagStepStatus,
    message?: string,
    payload?: unknown
  ) => {
    setSessionDetailDiagnostics(prev => {
      if (!prev || prev.runId !== runId) return prev
      const prevStep = prev.steps[step]
      const now = Date.now()
      const isLoading = status === 'loading'
      const nextStartedAt = isLoading ? now : (prevStep.startedAt ?? prevStep.updatedAt)
      const durationMs = (!isLoading && nextStartedAt) ? Math.max(0, now - nextStartedAt) : prevStep.durationMs
      return {
        ...prev,
        steps: {
          ...prev.steps,
          [step]: {
            status,
            message,
            payloadSummary: payload !== undefined ? toDiagSummary(payload) : prevStep.payloadSummary,
            startedAt: nextStartedAt,
            durationMs,
            updatedAt: now
          }
        }
      }
    })
  }, [toDiagSummary])

  const appendSessionDetailDiagEvent = useCallback((
    runId: number,
    level: 'info' | 'warn' | 'error',
    message: string,
    data?: unknown
  ) => {
    setSessionDetailDiagnostics(prev => {
      if (!prev || prev.runId !== runId) return prev
      const event: SessionDetailDiagEvent = {
        ts: Date.now(),
        level,
        message,
        data: data !== undefined ? toDiagSummary(data, 2000) : undefined
      }
      const nextEvents = [...prev.events, event]
      return {
        ...prev,
        events: nextEvents.length > 40 ? nextEvents.slice(-40) : nextEvents
      }
    })
  }, [toDiagSummary])

  const finishSessionDetailDiag = useCallback((
    runId: number,
    status: 'success' | 'error',
    error?: string
  ) => {
    setSessionDetailDiagnostics(prev => {
      if (!prev || prev.runId !== runId) return prev
      return {
        ...prev,
        status,
        error,
        finishedAt: Date.now()
      }
    })
  }, [])

  const formatDiagTime = useCallback((ts?: number) => {
    if (!ts) return '--'
    return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
  }, [])

  const getSessionDetailDiagnosticsText = useCallback(() => {
    if (!sessionDetailDiagnostics) return '暂无会话详情诊断记录'
    const lines: string[] = []
    lines.push(`runId: ${sessionDetailDiagnostics.runId}`)
    lines.push(`requestId: ${sessionDetailDiagnostics.requestId}`)
    lines.push(`会话: ${sessionDetailDiagnostics.sessionId}`)
    lines.push(`来源: ${sessionDetailDiagnostics.source === 'refresh' ? '手动刷新' : '选择会话'}`)
    lines.push(`状态: ${sessionDetailDiagnostics.status}`)
    if (sessionDetailDiagnostics.context) {
      lines.push(`上下文: ${JSON.stringify(sessionDetailDiagnostics.context)}`)
    }
    lines.push(`开始: ${new Date(sessionDetailDiagnostics.startedAt).toLocaleString('zh-CN')}`)
    if (sessionDetailDiagnostics.finishedAt) {
      lines.push(`结束: ${new Date(sessionDetailDiagnostics.finishedAt).toLocaleString('zh-CN')}`)
      lines.push(`耗时: ${Math.max(0, sessionDetailDiagnostics.finishedAt - sessionDetailDiagnostics.startedAt)} ms`)
    }
    SESSION_DETAIL_DIAG_STEP_ORDER.forEach(step => {
      const item = sessionDetailDiagnostics.steps[step]
      const time = item.updatedAt ? formatDiagTime(item.updatedAt) : '--'
      lines.push(`- ${SESSION_DETAIL_DIAG_STEP_LABELS[step]}: ${item.status}${item.message ? ` | ${item.message}` : ''}${item.durationMs != null ? ` | ${item.durationMs}ms` : ''} | ${time}`)
      if (item.payloadSummary) {
        lines.push(`  payload: ${item.payloadSummary}`)
      }
    })
    if (sessionDetailDiagnostics.events.length > 0) {
      lines.push('事件时间线:')
      sessionDetailDiagnostics.events.forEach((event, idx) => {
        lines.push(`${idx + 1}. [${formatDiagTime(event.ts)}] ${event.level.toUpperCase()} ${event.message}${event.data ? ` | ${event.data}` : ''}`)
      })
    }
    if (sessionDetailDiagnostics.error) {
      lines.push(`错误: ${sessionDetailDiagnostics.error}`)
    }
    return lines.join('\n')
  }, [formatDiagTime, sessionDetailDiagnostics])

  const copySessionDetailDiagnostics = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(getSessionDetailDiagnosticsText())
    } catch (e) {
      console.error('复制会话详情诊断信息失败:', e)
    }
  }, [getSessionDetailDiagnosticsText])

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

  const copyIdentityValue = useCallback(async (value: string, chip: 'wxid' | 'alias') => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopiedIdentityChip(chip)
      if (identityChipCopyResetTimerRef.current) {
        clearTimeout(identityChipCopyResetTimerRef.current)
      }
      identityChipCopyResetTimerRef.current = setTimeout(() => {
        setCopiedIdentityChip(current => (current === chip ? null : current))
      }, 1200)
    } catch (e) {
      console.error('复制身份信息失败:', e)
    }
  }, [])

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
        let timeoutId: number | undefined
        const cacheResult = await Promise.race([
          window.electronAPI.image.resolveCache({
            sessionId,
            imageMd5: img.imageMd5,
            imageDatName: img.imageDatName,
          }),
          new Promise<{ success: false; localPath?: string; error?: string }>((resolve) => {
            timeoutId = window.setTimeout(() => resolve({ success: false, error: 'timeout' }), IMAGE_CACHE_RESOLVE_TIMEOUT_MS)
          })
        ]).finally(() => {
          if (timeoutId !== undefined) {
            window.clearTimeout(timeoutId)
          }
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

  const inspectSessionVideoAssets = useCallback(async (sessionId: string) => {
    const listResult = await window.electronAPI.chat.getAllVideoMessages(sessionId)
    if (!listResult.success || !listResult.videos) {
      throw new Error(listResult.error || '读取会话视频失败')
    }

    const rawMessageCount = Number(listResult.stats?.rawMessageCount ?? listResult.videos.length)
    const parsedMessageCount = Number(listResult.stats?.parsedMessageCount ?? listResult.videos.length)
    const duplicateMessageCount = Number(listResult.stats?.duplicateMessageCount ?? Math.max(0, parsedMessageCount - listResult.videos.length))
    const parseFailedCount = Number(listResult.stats?.parseFailedCount ?? Math.max(0, rawMessageCount - parsedMessageCount))

    const assets: SessionVideoAssetItem[] = []
    let readyCount = 0
    let thumbOnlyCount = 0
    let missingCount = 0

    for (let i = 0; i < listResult.videos.length; i++) {
      const video = listResult.videos[i]
      let exists = false
      let videoUrl: string | undefined
      let coverUrl: string | undefined
      let thumbUrl: string | undefined

      if (video.videoMd5) {
        try {
          const infoResult = await window.electronAPI.video.getVideoInfo(video.videoMd5)
          if (infoResult.success) {
            exists = Boolean(infoResult.exists)
            videoUrl = infoResult.videoUrl
            coverUrl = infoResult.coverUrl
            thumbUrl = infoResult.thumbUrl
          }
        } catch {
          // 单条检测失败按缺失处理
        }
      }

      const hasPreview = Boolean(thumbUrl || coverUrl)
      if (exists) readyCount++
      else if (hasPreview) thumbOnlyCount++
      else missingCount++

      assets.push({
        ...video,
        exists,
        hasPreview,
        videoUrl,
        coverUrl,
        thumbUrl
      })

      if (i % 20 === 0) {
        await new Promise(r => setTimeout(r, 0))
      }
    }

    return {
      total: listResult.videos.length,
      readyCount,
      thumbOnlyCount,
      missingCount,
      rawMessageCount,
      parsedMessageCount,
      duplicateMessageCount,
      parseFailedCount,
      assets
    }
  }, [])

  const toLocalPathFromFileUrl = useCallback((fileUrl?: string) => {
    if (!fileUrl) return undefined
    try {
      const decoded = decodeURI(fileUrl)
      if (decoded.startsWith('file:///')) {
        return decoded.replace(/^file:\/\/\//, '/')
      }
      if (decoded.startsWith('file://')) {
        return decoded.replace(/^file:\/\//, '')
      }
      return decoded
    } catch {
      return fileUrl
    }
  }, [])

  const formatVideoDurationLabel = useCallback((seconds?: number) => {
    if (!seconds || Number.isNaN(seconds)) return ''
    const totalSeconds = Math.max(0, Math.floor(seconds))
    const mm = Math.floor(totalSeconds / 60)
    const ss = totalSeconds % 60
    return `${mm}:${String(ss).padStart(2, '0')}`
  }, [])

  const refreshSessionImageOverview = useCallback(async (sessionId: string) => {
    if (sessionImageOverviewPendingRef.current[sessionId]) return
    sessionImageOverviewPendingRef.current[sessionId] = true

    const requestId = (sessionImageOverviewRequestIdRef.current[sessionId] || 0) + 1
    sessionImageOverviewRequestIdRef.current[sessionId] = requestId

    setSessionImageOverviews(prev => ({
      ...prev,
      [sessionId]: {
        total: prev[sessionId]?.total || 0,
        decryptedCount: prev[sessionId]?.decryptedCount || 0,
        undecryptedCount: prev[sessionId]?.undecryptedCount || 0,
        status: 'checking',
        checkedAt: prev[sessionId]?.checkedAt,
        checkingStartedAt: Date.now(),
      }
    }))

    try {
      const result = await inspectSessionImageAssets(sessionId)
      if (requestId !== sessionImageOverviewRequestIdRef.current[sessionId]) return

      setSessionImageOverviews(prev => ({
        ...prev,
        [sessionId]: {
          total: result.total,
          decryptedCount: result.decryptedCount,
          undecryptedCount: result.undecryptedCount,
          status: result.total > 0 && result.undecryptedCount === 0 ? 'complete' : 'partial',
          checkedAt: Date.now(),
          checkingStartedAt: undefined,
        }
      }))
    } catch {
      if (requestId !== sessionImageOverviewRequestIdRef.current[sessionId]) return
      setSessionImageOverviews(prev => ({
        ...prev,
        [sessionId]: {
          total: prev[sessionId]?.total || 0,
          decryptedCount: prev[sessionId]?.decryptedCount || 0,
          undecryptedCount: prev[sessionId]?.undecryptedCount || 0,
          status: 'error',
          checkedAt: Date.now(),
          checkingStartedAt: undefined,
        }
      }))
    } finally {
      delete sessionImageOverviewPendingRef.current[sessionId]
    }
  }, [inspectSessionImageAssets])

  const refreshSessionVideoOverview = useCallback(async (sessionId: string) => {
    const requestId = (sessionVideoOverviewRequestIdRef.current[sessionId] || 0) + 1
    sessionVideoOverviewRequestIdRef.current[sessionId] = requestId

    setSessionVideoOverviews(prev => ({
      ...prev,
      [sessionId]: {
        total: prev[sessionId]?.total || 0,
        readyCount: prev[sessionId]?.readyCount || 0,
        thumbOnlyCount: prev[sessionId]?.thumbOnlyCount || 0,
        missingCount: prev[sessionId]?.missingCount || 0,
        rawMessageCount: prev[sessionId]?.rawMessageCount,
        parsedMessageCount: prev[sessionId]?.parsedMessageCount,
        duplicateMessageCount: prev[sessionId]?.duplicateMessageCount,
        parseFailedCount: prev[sessionId]?.parseFailedCount,
        status: 'checking',
        checkedAt: prev[sessionId]?.checkedAt,
        checkingStartedAt: Date.now(),
      }
    }))

    try {
      const result = await inspectSessionVideoAssets(sessionId)
      if (requestId !== sessionVideoOverviewRequestIdRef.current[sessionId]) return

      setSessionVideoOverviews(prev => ({
        ...prev,
        [sessionId]: {
          total: result.total,
          readyCount: result.readyCount,
          thumbOnlyCount: result.thumbOnlyCount,
          missingCount: result.missingCount,
          rawMessageCount: result.rawMessageCount,
          parsedMessageCount: result.parsedMessageCount,
          duplicateMessageCount: result.duplicateMessageCount,
          parseFailedCount: result.parseFailedCount,
          status: result.total > 0 && result.missingCount === 0 && result.thumbOnlyCount === 0 && result.parseFailedCount === 0 ? 'ready' : 'partial',
          checkedAt: Date.now(),
          checkingStartedAt: undefined,
        }
      }))
    } catch {
      if (requestId !== sessionVideoOverviewRequestIdRef.current[sessionId]) return
      setSessionVideoOverviews(prev => ({
        ...prev,
        [sessionId]: {
          total: prev[sessionId]?.total || 0,
          readyCount: prev[sessionId]?.readyCount || 0,
          thumbOnlyCount: prev[sessionId]?.thumbOnlyCount || 0,
          missingCount: prev[sessionId]?.missingCount || 0,
          rawMessageCount: prev[sessionId]?.rawMessageCount,
          parsedMessageCount: prev[sessionId]?.parsedMessageCount,
          duplicateMessageCount: prev[sessionId]?.duplicateMessageCount,
          parseFailedCount: prev[sessionId]?.parseFailedCount,
          status: 'error',
          checkedAt: Date.now(),
          checkingStartedAt: undefined,
        }
      }))
    }
  }, [inspectSessionVideoAssets])

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
          checkingStartedAt: undefined,
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

  const openSessionVideoAssetsModal = useCallback(async () => {
    if (!selectedSession) return

    const sessionId = selectedSession
    const requestId = ++sessionVideoAssetsRequestIdRef.current
    setShowSessionVideoAssetsModal(true)
    setSessionVideoAssetsLoading(true)
    setSessionVideoAssetsError(null)
    setSessionVideoAssetsSessionId(sessionId)
    setSessionVideoAssetsSessionName(getSessionDisplayName(sessionId))

    try {
      const result = await inspectSessionVideoAssets(sessionId)
      if (requestId !== sessionVideoAssetsRequestIdRef.current) return

      setSessionVideoAssets(result.assets)
      setSessionVideoOverviews(prev => ({
        ...prev,
        [sessionId]: {
          total: result.total,
          readyCount: result.readyCount,
          thumbOnlyCount: result.thumbOnlyCount,
          missingCount: result.missingCount,
          rawMessageCount: result.rawMessageCount,
          parsedMessageCount: result.parsedMessageCount,
          duplicateMessageCount: result.duplicateMessageCount,
          parseFailedCount: result.parseFailedCount,
          status: result.total > 0 && result.missingCount === 0 && result.thumbOnlyCount === 0 && result.parseFailedCount === 0 ? 'ready' : 'partial',
          checkedAt: Date.now(),
          checkingStartedAt: undefined,
        }
      }))
    } catch (e) {
      if (requestId !== sessionVideoAssetsRequestIdRef.current) return
      setSessionVideoAssets([])
      setSessionVideoAssetsError(String(e))
    } finally {
      if (requestId === sessionVideoAssetsRequestIdRef.current) {
        setSessionVideoAssetsLoading(false)
      }
    }
  }, [getSessionDisplayName, inspectSessionVideoAssets, selectedSession])

  const handleImageStatCardClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target
    if (target instanceof Element && target.closest('button, a, input, select, textarea')) return
    void openSessionImageAssetsModal()
  }, [openSessionImageAssetsModal])

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
  const shouldShowImageDecryptExportTip = Boolean(
    options.exportImages &&
    !hideImageDecryptExportTip &&
    selectedSession &&
    sessionDetail &&
    sessionDetail.imageCount > 0 &&
    currentSessionImageOverview &&
    currentSessionImageOverview.status !== 'checking' &&
    currentSessionImageUndecryptedCount > 0
  )
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
  const currentSessionVideoOverview = selectedSession ? sessionVideoOverviews[selectedSession] : undefined
  const currentSessionVideoHasCheckedOverview = Boolean(
    currentSessionVideoOverview?.checkedAt &&
    currentSessionVideoOverview.status !== 'checking' &&
    currentSessionVideoOverview.status !== 'error'
  )
  const currentSessionVideoReadyCount = currentSessionVideoOverview?.readyCount || 0
  const currentSessionVideoThumbOnlyCount = currentSessionVideoOverview?.thumbOnlyCount || 0
  const currentSessionVideoMissingCount = currentSessionVideoOverview?.missingCount || 0
  const currentSessionVideoUniqueCount = currentSessionVideoOverview?.total || 0
  const currentSessionVideoRawMessageCount = currentSessionVideoOverview?.rawMessageCount ?? sessionDetail?.videoCount ?? 0
  const currentSessionVideoParsedMessageCount = currentSessionVideoOverview?.parsedMessageCount ?? currentSessionVideoUniqueCount
  const currentSessionVideoDuplicateCount = currentSessionVideoOverview?.duplicateMessageCount ?? Math.max(0, currentSessionVideoParsedMessageCount - currentSessionVideoUniqueCount)
  const currentSessionVideoParseFailedCount = currentSessionVideoOverview?.parseFailedCount ?? Math.max(0, currentSessionVideoRawMessageCount - currentSessionVideoParsedMessageCount)
  const currentSessionVideoExportableCount = currentSessionVideoHasCheckedOverview ? currentSessionVideoReadyCount : (sessionDetail?.videoCount ?? 0)
  const currentSessionAllVideosReady = Boolean(
    currentSessionVideoOverview &&
    currentSessionVideoOverview.total > 0 &&
    currentSessionVideoOverview.thumbOnlyCount === 0 &&
    currentSessionVideoOverview.missingCount === 0 &&
    (currentSessionVideoOverview.parseFailedCount || 0) === 0 &&
    currentSessionVideoOverview.status === 'ready'
  )
  const hasCurrentSessionVideoPreviews = (currentSessionVideoReadyCount + currentSessionVideoThumbOnlyCount) > 0
  const readySessionVideoAssets = useMemo(
    () => sessionVideoAssets.filter(item => item.exists && item.videoUrl),
    [sessionVideoAssets]
  )
  const thumbOnlySessionVideoAssets = useMemo(
    () => sessionVideoAssets.filter(item => !item.exists && item.hasPreview),
    [sessionVideoAssets]
  )
  const sessionVideoAssetsOverview = useMemo(() => {
    if (!sessionVideoAssetsSessionId) return undefined
    return sessionVideoOverviews[sessionVideoAssetsSessionId]
  }, [sessionVideoAssetsSessionId, sessionVideoOverviews])
  const sessionVideoAssetsTotalCount = sessionVideoAssetsOverview?.total ?? sessionVideoAssets.length
  const sessionVideoAssetsRawMessageCount = sessionVideoAssetsOverview?.rawMessageCount ??
    (sessionDetail && sessionVideoAssetsSessionId && sessionDetail.wxid === sessionVideoAssetsSessionId ? sessionDetail.videoCount : undefined) ??
    sessionVideoAssetsTotalCount
  const sessionVideoAssetsParsedMessageCount = sessionVideoAssetsOverview?.parsedMessageCount ?? sessionVideoAssetsTotalCount
  const sessionVideoAssetsDuplicateCount = sessionVideoAssetsOverview?.duplicateMessageCount ?? Math.max(0, sessionVideoAssetsParsedMessageCount - sessionVideoAssetsTotalCount)
  const sessionVideoAssetsParseFailedCount = sessionVideoAssetsOverview?.parseFailedCount ?? Math.max(0, sessionVideoAssetsRawMessageCount - sessionVideoAssetsParsedMessageCount)
  const sessionVideoAssetsReadyCount = sessionVideoAssetsOverview?.readyCount ?? readySessionVideoAssets.length
  const sessionVideoAssetsThumbOnlyCount = sessionVideoAssetsOverview?.thumbOnlyCount ?? thumbOnlySessionVideoAssets.length
  const sessionVideoAssetsMissingCount = sessionVideoAssetsOverview?.missingCount ?? Math.max(0, sessionVideoAssetsTotalCount - sessionVideoAssetsReadyCount - sessionVideoAssetsThumbOnlyCount)
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
    if (overview?.status === 'checking') {
      const checkingStartedAt = overview.checkingStartedAt || overview.checkedAt || 0
      const elapsed = checkingStartedAt > 0 ? (Date.now() - checkingStartedAt) : OVERVIEW_CHECKING_TIMEOUT_MS
      if (elapsed < OVERVIEW_CHECKING_TIMEOUT_MS) {
        const timer = window.setTimeout(() => {
          void refreshSessionImageOverview(selectedSession)
        }, OVERVIEW_CHECKING_TIMEOUT_MS - elapsed + 50)
        return () => window.clearTimeout(timer)
      }
    }
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

  useEffect(() => {
    const commonGroups = sessionDetail?.commonGroups || []
    const isPrivateSession = !!selectedSession && !selectedSession.includes('@chatroom')
    if (!showCommonGroupsPopup || !selectedSession || !isPrivateSession) return
    if (commonGroups.length === 0) return

    const alreadyHandledCurrentSession = commonGroupMessageCountsSessionId === selectedSession &&
      (commonGroupMessageCountsStatus === 'loading' || commonGroupMessageCountsStatus === 'ready' || commonGroupMessageCountsStatus === 'error')
    if (alreadyHandledCurrentSession) return

    const requestId = ++commonGroupMessageCountsRequestIdRef.current
    setCommonGroupMessageCounts({})
    setCommonGroupMessageCountsSessionId(selectedSession)
    setCommonGroupMessageCountsStatus('loading')

    void (async () => {
      try {
        const result = await window.electronAPI.chat.getCommonGroupsWithFriendStats(selectedSession)
        if (requestId !== commonGroupMessageCountsRequestIdRef.current) return

        if (result.success && result.data) {
          const counts: Record<string, { selfMessageCount: number; peerMessageCount: number }> = {}
          for (const item of result.data) {
            if (!item?.username) continue
            counts[item.username] = {
              selfMessageCount: Number(item.selfMessageCount || 0),
              peerMessageCount: Number(item.peerMessageCount || 0)
            }
          }
          setCommonGroupMessageCounts(counts)
          setCommonGroupMessageCountsStatus('ready')
        } else {
          setCommonGroupMessageCounts({})
          setCommonGroupMessageCountsStatus('error')
        }
      } catch {
        if (requestId !== commonGroupMessageCountsRequestIdRef.current) return
        setCommonGroupMessageCounts({})
        setCommonGroupMessageCountsStatus('error')
      }
    })()
  }, [
    showCommonGroupsPopup,
    selectedSession,
    sessionDetail?.commonGroups,
    commonGroupMessageCountsSessionId,
    commonGroupMessageCountsStatus
  ])

  const selectSession = async (username: string, options?: SelectSessionOptions) => {
    const source = options?.source || 'select'
    const forceReconnect = Boolean(options?.forceReconnect)
    const requestId = ++sessionDetailRequestIdRef.current
    const diagRunId = ++sessionDetailDiagRunIdRef.current
    const selectedSessionBefore = selectedSession
    const sessionAccountType = sessionByUsername.get(username)?.accountType || (username.includes('@chatroom') ? 'group' : 'unknown')
    setSessionDetailDiagnostics(createSessionDetailDiagnostics(diagRunId, requestId, username, source, {
      forceReconnect,
      selectedSessionBefore,
      sessionAccountType
    }))
    updateSessionDetailDiagStep(diagRunId, 'init', 'loading', '重置右侧详情状态', {
      source,
      forceReconnect,
      username,
      requestId,
      selectedSessionBefore,
      sessionAccountType
    })
    appendSessionDetailDiagEvent(diagRunId, 'info', '开始会话详情加载', {
      requestId,
      source,
      forceReconnect,
      username,
      selectedSessionBefore,
      sessionAccountType
    })
    if (source === 'refresh') {
      setIsRefreshingSessionDetail(true)
      setShowSessionDetailDiagnostics(false)
      setShowSessionDetailDiagPayloads(false)
      setShowSessionDetailDiagEvents(false)
    }
    try {
      groupFriendMessageCountsRequestIdRef.current++
      commonGroupMessageCountsRequestIdRef.current++
      sessionImageAssetsRequestIdRef.current++
      sessionVideoAssetsRequestIdRef.current++
      setSelectedSession(username)
      setShowExportSettings(false)
      setShowGroupFriendsPopup(false)
      setShowCommonGroupsPopup(false)
      setGroupFriendMessageCounts({})
      setGroupFriendMessageCountsStatus('idle')
      setGroupFriendMessageCountsSessionId(null)
      setGroupFriendsSortOrder('desc')
      setCommonGroupMessageCounts({})
      setCommonGroupMessageCountsStatus('idle')
      setCommonGroupMessageCountsSessionId(null)
      setShowSessionImageAssetsModal(false)
      setSessionImageAssets([])
      setSessionImageAssetsError(null)
      setSessionImageAssetsLoading(false)
      setSessionImageAssetsSessionId(null)
      setSessionImageAssetsSessionName('')
      setShowSessionVideoAssetsModal(false)
      setSessionVideoAssets([])
      setSessionVideoAssetsError(null)
      setSessionVideoAssetsLoading(false)
      setSessionVideoAssetsSessionId(null)
      setSessionVideoAssetsSessionName('')
      setSessionDetail(null)
      setShowSessionImageDecryptConfirm(false)
      setSessionImageMessages(null)
      setSessionImageDates([])
      setSessionImageSelectedDates(new Set())
      setExportRecords([])
      setIsLoadingDetail(true)
      setIsLoadingGroupInfo(false)
      updateSessionDetailDiagStep(diagRunId, 'init', 'success', '详情区状态已重置', {
        selectedSessionAfterReset: username
      })
      if (forceReconnect) {
        updateSessionDetailDiagStep(diagRunId, 'reconnect', 'loading', '准备重连聊天服务')
        appendSessionDetailDiagEvent(diagRunId, 'info', '准备调用 chat.connect')
      } else {
        updateSessionDetailDiagStep(diagRunId, 'reconnect', 'skipped', '普通会话切换不强制重连')
      }
      updateSessionDetailDiagStep(diagRunId, 'exportRecords', 'loading', '读取导出记录中')
    } catch (e) {
      const initError = `初始化异常: ${String(e)}`
      updateSessionDetailDiagStep(diagRunId, 'init', 'error', initError, { error: String(e) })
      updateSessionDetailDiagStep(diagRunId, 'finish', 'error', initError)
      appendSessionDetailDiagEvent(diagRunId, 'error', '初始化阶段同步异常', { error: String(e) })
      finishSessionDetailDiag(diagRunId, 'error', initError)
      setShowSessionDetailDiagnostics(true)
      if (source === 'refresh') {
        setIsRefreshingSessionDetail(false)
      }
      setIsLoadingDetail(false)
      setIsLoadingGroupInfo(false)
      return
    }

    const isRequestActive = () => requestId === sessionDetailRequestIdRef.current
    const markSupersededIfNeeded = () => {
      if (isRequestActive()) return false
      const supersededError = `请求已被新的会话切换覆盖 (currentRequestId=${sessionDetailRequestIdRef.current}, localRequestId=${requestId})`
      appendSessionDetailDiagEvent(diagRunId, 'warn', '请求被覆盖', {
        currentRequestId: sessionDetailRequestIdRef.current,
        localRequestId: requestId,
        selectedSessionNow: selectedSession
      })
      updateSessionDetailDiagStep(diagRunId, 'finish', 'error', supersededError)
      finishSessionDetailDiag(diagRunId, 'error', supersededError)
      return true
    }

    const exportRecordsTask = (async () => {
      try {
        const records = await window.electronAPI.export.getExportRecords(username)
        if (!isRequestActive()) return
        setExportRecords(records)
        const exportRecordsSummary = {
          count: records.length,
          latest: records[0] || null
        }
        updateSessionDetailDiagStep(diagRunId, 'exportRecords', 'success', `共 ${records.length} 条导出记录`, exportRecordsSummary)
        appendSessionDetailDiagEvent(diagRunId, 'info', '导出记录加载完成', exportRecordsSummary)
      } catch (e) {
        if (!isRequestActive()) return
        updateSessionDetailDiagStep(diagRunId, 'exportRecords', 'error', String(e), { error: String(e) })
        appendSessionDetailDiagEvent(diagRunId, 'error', '导出记录加载失败', { error: String(e) })
      }
    })()

    let finalError: string | null = null
    try {
      if (forceReconnect) {
        const connectResult = await window.electronAPI.chat.connect()
        if (markSupersededIfNeeded()) return
        if (!connectResult.success) {
          const message = connectResult.error || 'chat.connect 失败'
          updateSessionDetailDiagStep(diagRunId, 'reconnect', 'error', message, connectResult)
          appendSessionDetailDiagEvent(diagRunId, 'error', 'chat.connect 失败', connectResult)
          throw new Error(message)
        }
        updateSessionDetailDiagStep(diagRunId, 'reconnect', 'success', 'chat.connect 成功', connectResult)
        appendSessionDetailDiagEvent(diagRunId, 'info', 'chat.connect 成功', connectResult)
      }

      updateSessionDetailDiagStep(diagRunId, 'sessionDetail', 'loading', '请求会话详情中')
      const detailResult = await window.electronAPI.chat.getSessionDetail(username, { includeGroupInfo: false })
      if (markSupersededIfNeeded()) return

      if (detailResult.success && detailResult.detail) {
        const isGroupChat = username.includes('@chatroom')
        const detailSummary = {
          success: detailResult.success,
          wxid: detailResult.detail.wxid,
          messageCount: detailResult.detail.messageCount,
          imageCount: detailResult.detail.imageCount,
          videoCount: detailResult.detail.videoCount,
          voiceCount: detailResult.detail.voiceCount,
          emojiCount: detailResult.detail.emojiCount,
          commonGroupCount: detailResult.detail.commonGroupCount,
          messageTablesCount: detailResult.detail.messageTables?.length || 0,
          isGroupChat
        }
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
          commonGroupCount: detailResult.detail.commonGroupCount,
          commonGroups: detailResult.detail.commonGroups,
          messageTables: detailResult.detail.messageTables || [],
          groupInfo: isGroupChat ? {} : detailResult.detail.groupInfo,
        })
        updateSessionDetailDiagStep(
          diagRunId,
          'sessionDetail',
          'success',
          `消息 ${Number(detailResult.detail.messageCount || 0).toLocaleString()} 条，表 ${detailResult.detail.messageTables?.length || 0} 个`
          , detailSummary
        )
        appendSessionDetailDiagEvent(diagRunId, 'info', 'getSessionDetail 成功', detailSummary)

        if (isGroupChat) {
          setIsLoadingGroupInfo(true)
          updateSessionDetailDiagStep(diagRunId, 'groupInfo', 'loading', '请求群扩展信息中')
          appendSessionDetailDiagEvent(diagRunId, 'info', '准备调用 getSessionGroupInfo', { username })
          try {
            const groupResult = await window.electronAPI.chat.getSessionGroupInfo(username)
            if (markSupersededIfNeeded()) return
            if (groupResult.success) {
              const groupSummary = {
                success: groupResult.success,
                ownerUsername: groupResult.groupInfo?.ownerUsername,
                ownerDisplayName: groupResult.groupInfo?.ownerDisplayName,
                memberCount: groupResult.groupInfo?.memberCount,
                friendMemberCount: groupResult.groupInfo?.friendMemberCount,
                friendMembersCount: groupResult.groupInfo?.friendMembers?.length || 0,
                selfMessageCount: groupResult.groupInfo?.selfMessageCount
              }
              setSessionDetail(prev => {
                if (!prev || prev.wxid !== username) return prev
                return {
                  ...prev,
                  groupInfo: groupResult.groupInfo || {}
                }
              })
              updateSessionDetailDiagStep(diagRunId, 'groupInfo', 'success', '群扩展信息加载完成', groupSummary)
              appendSessionDetailDiagEvent(diagRunId, 'info', 'getSessionGroupInfo 成功', groupSummary)
            } else {
              updateSessionDetailDiagStep(diagRunId, 'groupInfo', 'error', groupResult.error || '获取群扩展信息失败', groupResult)
              appendSessionDetailDiagEvent(diagRunId, 'error', 'getSessionGroupInfo 返回失败', groupResult)
            }
          } catch (e) {
            if (!isRequestActive()) return
            updateSessionDetailDiagStep(diagRunId, 'groupInfo', 'error', String(e), { error: String(e) })
            appendSessionDetailDiagEvent(diagRunId, 'error', 'getSessionGroupInfo 异常', { error: String(e) })
          } finally {
            if (isRequestActive()) {
              setIsLoadingGroupInfo(false)
            }
          }
        } else {
          updateSessionDetailDiagStep(diagRunId, 'groupInfo', 'skipped', '非群聊会话')
        }
      } else {
        const errorMessage = detailResult.error || 'getSessionDetail 返回空结果'
        updateSessionDetailDiagStep(diagRunId, 'sessionDetail', 'error', errorMessage, detailResult)
        appendSessionDetailDiagEvent(diagRunId, 'error', 'getSessionDetail 返回失败', detailResult)
        console.error('加载会话详情失败:', {
          username,
          error: errorMessage,
          note: '若会话列表来自缓存且未触发 chat.connect()，这里会失败'
        })
        throw new Error(errorMessage)
      }
    } catch (e) {
      finalError = String(e)
      console.error('加载会话详情异常:', e)
      appendSessionDetailDiagEvent(diagRunId, 'error', '会话详情加载流程异常', { error: finalError })
      setShowSessionDetailDiagnostics(true)
    }
    finally {
      await exportRecordsTask
      if (isRequestActive()) {
        if (finalError) {
          updateSessionDetailDiagStep(diagRunId, 'finish', 'error', finalError, {
            requestId,
            currentRequestId: sessionDetailRequestIdRef.current
          })
          appendSessionDetailDiagEvent(diagRunId, 'error', '流程结束（失败）', { error: finalError })
          finishSessionDetailDiag(diagRunId, 'error', finalError)
        } else {
          updateSessionDetailDiagStep(diagRunId, 'finish', 'success', '详情加载流程结束', {
            requestId,
            currentRequestId: sessionDetailRequestIdRef.current
          })
          appendSessionDetailDiagEvent(diagRunId, 'info', '流程结束（成功）', { requestId })
          finishSessionDetailDiag(diagRunId, 'success')
        }
        setIsLoadingDetail(false)
      }
      if (source === 'refresh') {
        setIsRefreshingSessionDetail(false)
      }
    }
  }

  const handleRefreshSelectedSessionDetail = useCallback(() => {
    if (!selectedSession) return
    void selectSession(selectedSession, {
      source: 'refresh',
      forceReconnect: true
    })
  }, [selectedSession, selectSession])

  const handleOpenChatWindowFromList = useCallback((session: ChatSession) => {
    void window.electronAPI.window.openChatWindow(session.username)
  }, [])

  const handleOpenCommonGroupsFromList = useCallback(async (session: ChatSession) => {
    if (session.accountType !== 'friend') return
    const isCurrentReady = selectedSession === session.username && sessionDetail?.wxid === session.username
    if (!isCurrentReady) {
      await selectSession(session.username)
    }
    setCommonGroupMessageCounts({})
    setCommonGroupMessageCountsStatus('idle')
    setCommonGroupMessageCountsSessionId(null)
    setShowCommonGroupsPopup(true)
  }, [selectSession, selectedSession, sessionDetail?.wxid])

  useEffect(() => {
    const cachedSelectedSession = pendingCachedSelectedSessionRef.current
    if (!cachedSelectedSession) return
    pendingCachedSelectedSessionRef.current = null
    void selectSession(cachedSelectedSession)
  }, [selectSession])

  useEffect(() => {
    if (!selectedSession || !sessionDetail || sessionDetail.wxid !== selectedSession) return
    if ((sessionDetail.videoCount ?? 0) <= 0) return

    const overview = sessionVideoOverviews[selectedSession]
    if (overview?.status === 'checking') {
      const checkingStartedAt = overview.checkingStartedAt || overview.checkedAt || 0
      const elapsed = checkingStartedAt > 0 ? (Date.now() - checkingStartedAt) : OVERVIEW_CHECKING_TIMEOUT_MS
      if (elapsed < OVERVIEW_CHECKING_TIMEOUT_MS) {
        const timer = window.setTimeout(() => {
          void refreshSessionVideoOverview(selectedSession)
        }, OVERVIEW_CHECKING_TIMEOUT_MS - elapsed + 50)
        return () => window.clearTimeout(timer)
      }
    }

    const rawCountChanged = overview?.rawMessageCount !== undefined && overview.rawMessageCount !== sessionDetail.videoCount
    const isStale = !overview?.checkedAt || (Date.now() - overview.checkedAt > EXPORT_CHAT_CACHE_TTL_MS)

    if (!overview || rawCountChanged || isStale) {
      void refreshSessionVideoOverview(selectedSession)
    }
  }, [
    refreshSessionVideoOverview,
    selectedSession,
    sessionDetail,
    sessionVideoOverviews
  ])

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

  const handleExportImagesToggle = (checked: boolean) => {
    setOptions(prev => ({ ...prev, exportImages: checked }))
    setHideImageDecryptExportTip(false)
  }

  const handleContinueDirectExportWithImages = () => {
    setHideImageDecryptExportTip(true)
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

    const targetSessionId = selectedSession
    const targetSessionName =
      sessionDetail?.remark ||
      sessionDetail?.nickName ||
      (targetSessionId ? sessionByUsername.get(targetSessionId)?.displayName : undefined) ||
      targetSessionId ||
      ''
    const decryptTaskId = `image-decrypt:${targetSessionId}:${Date.now()}`

    setShowSessionImageDecryptConfirm(false)
    setSessionImageMessages(null)
    setSessionImageDates([])
    setSessionImageSelectedDates(new Set())

    setIsSessionImageDecrypting(true)
    setSessionImageDecryptTaskSessionId(targetSessionId)

    taskCenterUpsertTask({
      id: decryptTaskId,
      kind: 'image-decrypt',
      typeLabel: '图片解密',
      sessionId: targetSessionId,
      sessionName: targetSessionName,
      status: 'running',
      progressCurrent: 0,
      progressTotal: images.length,
      successCount: 0,
      failCount: 0,
      unitLabel: '张',
      detail: '后台解密中，可继续操作页面',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    taskCenterHighlightTask(decryptTaskId)
    taskCenterOpen()

    let success = 0
    let fail = 0
    let processedCount = 0
    try {
      for (let i = 0; i < images.length; i++) {
        try {
          const r = await window.electronAPI.image.decrypt({
            sessionId: targetSessionId,
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
        processedCount = i + 1
        taskCenterPatchTask(decryptTaskId, {
          progressCurrent: processedCount,
          progressTotal: images.length,
          successCount: success,
          failCount: fail,
          detail: '后台解密中，可继续操作页面'
        })
      }
      taskCenterPatchTask(decryptTaskId, {
        status: 'success',
        progressCurrent: images.length,
        progressTotal: images.length,
        successCount: success,
        failCount: fail,
        detail: '解密完成'
      })
    } catch (e) {
      console.error('批量解密图片失败:', e)
      const errorMessage = e instanceof Error ? e.message : String(e)
      taskCenterPatchTask(decryptTaskId, {
        status: 'error',
        progressCurrent: processedCount,
        progressTotal: images.length,
        successCount: success,
        failCount: fail,
        error: errorMessage,
        detail: '解密任务失败'
      })
    }

    setIsSessionImageDecrypting(false)

    void refreshSessionImageOverview(targetSessionId)
    if (showSessionImageAssetsModal && sessionImageAssetsSessionId === targetSessionId) {
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
    if (!selectedSession || !exportFolder || hasRunningGlobalChatExportTask) return

    const targetSessionId = selectedSession
    const targetSessionName =
      (sessionDetail?.wxid === targetSessionId ? (sessionDetail?.remark || sessionDetail?.nickName || sessionDetail?.alias) : undefined) ||
      sessionByUsername.get(targetSessionId)?.displayName ||
      targetSessionId
    const targetMessageCount =
      (sessionDetail?.wxid === targetSessionId ? sessionDetail.messageCount : undefined) ??
      sessionMessageCounts[targetSessionId] ??
      0
    const exportTaskId = `chat-export:${targetSessionId}:${Date.now()}`
    const formatLabel = options.format.toUpperCase()

    setIsExporting(true)
    setExportResult(null)
    taskCenterUpsertTask({
      id: exportTaskId,
      kind: 'chat-export',
      typeLabel: '聊天导出',
      sessionId: targetSessionId,
      sessionName: targetSessionName,
      status: 'running',
      progressCurrent: 0,
      progressTotal: 1,
      unitLabel: '个会话',
      format: formatLabel,
      outputDir: exportFolder,
      phase: '正在准备...',
      detail: '可继续操作页面',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    taskCenterSetActiveExportTaskId(exportTaskId)

    try {
      const sessionList = [targetSessionId]
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
        if (result.success) {
          taskCenterPatchTask(exportTaskId, {
            status: 'success',
            progressCurrent: 1,
            progressTotal: 1,
            successCount: result.successCount ?? 1,
            failCount: result.failCount ?? 0,
            phase: '导出完成',
            detail: '',
            outputDir: exportFolder
          })

          await window.electronAPI.export.saveExportRecord(targetSessionId, options.format, targetMessageCount)
          const records = await window.electronAPI.export.getExportRecords(targetSessionId)
          setExportRecords(records)
        } else {
          taskCenterPatchTask(exportTaskId, {
            status: 'error',
            progressCurrent: 1,
            progressTotal: 1,
            successCount: result.successCount ?? 0,
            failCount: result.failCount ?? 1,
            phase: '导出失败',
            detail: '导出失败',
            error: result.error || '导出失败'
          })
        }
      } else {
        const errorMessage = `${options.format.toUpperCase()} 格式导出功能开发中...`
        setExportResult({ success: false, error: errorMessage })
        taskCenterPatchTask(exportTaskId, {
          status: 'error',
          progressCurrent: 1,
          progressTotal: 1,
          phase: '导出失败',
          detail: '导出失败',
          error: errorMessage
        })
      }
    } catch (e) {
      console.error('导出失败:', e)
      const errorMessage = e instanceof Error ? e.message : String(e)
      setExportResult({ success: false, error: errorMessage })
      taskCenterPatchTask(exportTaskId, {
        status: 'error',
        progressCurrent: 1,
        progressTotal: 1,
        phase: '导出失败',
        detail: '导出失败',
        error: errorMessage
      })
    } finally {
      setIsExporting(false)
      taskCenterSetActiveExportTaskId(null)
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
          <div className="chat-export-layout">
          <div className="session-panel chat-session-panel">
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

            <div className="session-list-controls">
              <div className="session-filter-row">
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
                <div className="search-bar session-filter-search">
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
              </div>
              {isLoadingSessionCounts && (
                <div className="session-count-loading-hint">
                  <Loader2 size={12} className="spin" />
                  <span>正在统计消息数量并排序...</span>
                </div>
              )}
              {isRefreshingSessions && sessions.length > 0 && (
                <div className="session-count-loading-hint">
                  <Loader2 size={12} className="spin" />
                  <span>列表正在后台更新...</span>
                </div>
              )}
            </div>

            <div
              className={[
                'session-table-layer',
                sessionTableHasHorizontalOverflow ? 'has-x-overflow' : '',
                sessionTableCanScrollLeft ? 'can-scroll-left' : '',
                sessionTableCanScrollRight ? 'can-scroll-right' : ''
              ].filter(Boolean).join(' ')}
            >
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
                <>
                  <div
                    className="export-session-table-header-scroll"
                    ref={sessionTableHeaderScrollRef}
                    onScroll={(e) => {
                      if (sessionTableScrollSyncSourceRef.current === 'main' || sessionTableScrollSyncSourceRef.current === 'bar') {
                        sessionTableScrollSyncSourceRef.current = null
                        return
                      }

                      const targetScrollLeft = e.currentTarget.scrollLeft

                      const main = sessionTableScrollRef.current
                      if (main && Math.abs(main.scrollLeft - targetScrollLeft) > 1) {
                        sessionTableScrollSyncSourceRef.current = 'header'
                        main.scrollLeft = targetScrollLeft
                      }

                      const bar = sessionTableScrollbarRef.current
                      if (bar && Math.abs(bar.scrollLeft - targetScrollLeft) > 1) {
                        sessionTableScrollSyncSourceRef.current = 'header'
                        bar.scrollLeft = targetScrollLeft
                      }
                    }}
                  >
                    <div className={`export-session-table-header ${sessionListGridClass}`}>
                      {sessionListHeaderColumns.map(label => (
                        <div
                          key={label}
                          className={`export-session-table-header-cell ${SESSION_TABLE_HEADER_MEDIA_ICONS[label] ? 'is-media-header' : ''}`}
                          title={label}
                        >
                          {SESSION_TABLE_HEADER_MEDIA_ICONS[label] ? (
                            <>
                              <span className="header-media-icon">{SESSION_TABLE_HEADER_MEDIA_ICONS[label]}</span>
                              <span>{label}</span>
                            </>
                          ) : (
                            <span>{label}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div
                    className="export-session-list"
                    ref={sessionTableScrollRef}
                    onScroll={(e) => {
                      if (sessionTableScrollSyncSourceRef.current === 'header' || sessionTableScrollSyncSourceRef.current === 'bar') {
                        sessionTableScrollSyncSourceRef.current = null
                        updateSessionTableHorizontalScrollState()
                        return
                      }

                      const current = e.currentTarget
                      setSessionTableHorizontalScrollState(prev => {
                        const next = {
                          scrollLeft: current.scrollLeft,
                          viewportWidth: current.clientWidth,
                          contentWidth: current.scrollWidth
                        }
                        return (
                          prev.scrollLeft === next.scrollLeft &&
                          prev.viewportWidth === next.viewportWidth &&
                          prev.contentWidth === next.contentWidth
                        ) ? prev : next
                      })

                      const header = sessionTableHeaderScrollRef.current
                      if (header && Math.abs(header.scrollLeft - current.scrollLeft) > 1) {
                        sessionTableScrollSyncSourceRef.current = 'main'
                        header.scrollLeft = current.scrollLeft
                      }

                      const bar = sessionTableScrollbarRef.current
                      if (bar && Math.abs(bar.scrollLeft - current.scrollLeft) > 1) {
                        sessionTableScrollSyncSourceRef.current = 'main'
                        bar.scrollLeft = current.scrollLeft
                      }
                    }}
                  >
                  <div className="export-session-list-body">
                  {/* @ts-ignore - react-window v2 类型定义与当前 rowProps 推断不一致 */}
                  <List
                    style={{ height: '100%', width: '100%' }}
                    rowCount={filteredSessions.length}
                    rowHeight={sessionListRowHeight}
                    rowProps={{
                      sessions: filteredSessions,
                      selectedSession,
                      sessionTypeFilter,
                      sessionMessageCounts,
                      sessionCardStatsMap,
                      onSelect: selectSession,
                      onEnsureCardStats: ensureSessionCardStats,
                      onOpenChatWindow: handleOpenChatWindowFromList,
                      onOpenCommonGroups: handleOpenCommonGroupsFromList
                    }}
                    rowComponent={ExportSessionRow}
                  />
                  </div>
                  </div>
                  {sessionTableHasHorizontalOverflow && (
                    <div
                      className="export-session-horizontal-scrollbar"
                      ref={sessionTableScrollbarRef}
                      onScroll={(e) => {
                        if (sessionTableScrollSyncSourceRef.current === 'main') {
                          sessionTableScrollSyncSourceRef.current = null
                          return
                        }

                        const main = sessionTableScrollRef.current
                        if (!main) return
                        if (Math.abs(main.scrollLeft - e.currentTarget.scrollLeft) <= 1) return
                        sessionTableScrollSyncSourceRef.current = 'bar'
                        main.scrollLeft = e.currentTarget.scrollLeft

                        const header = sessionTableHeaderScrollRef.current
                        if (header && Math.abs(header.scrollLeft - e.currentTarget.scrollLeft) > 1) {
                          header.scrollLeft = e.currentTarget.scrollLeft
                        }
                      }}
                      aria-hidden="true"
                    >
                      <div
                        className="export-session-horizontal-scrollbar-inner"
                        style={{ width: Math.max(sessionTableHorizontalScrollState.contentWidth, sessionTableHorizontalScrollState.viewportWidth) }}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {selectedSession && <div className="chat-session-drawer-backdrop" onClick={closeSessionDrawer} />}
          {selectedSession && (
            <div className="chat-session-drawer" role="dialog" aria-modal="false" aria-label="会话详情侧边栏">
              <button
                type="button"
                className="chat-session-drawer-close"
                onClick={closeSessionDrawer}
                aria-label="关闭会话详情"
              >
                <X size={16} />
              </button>
              <div className="settings-panel chat-session-drawer-panel">
            {!selectedSession ? (
              <div className="empty-state" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span>请选择一个会话</span>
              </div>
            ) : !showExportSettings ? (
              <>
                <div className="settings-content">
                  {(() => {
                    const session = selectedSession ? sessionByUsername.get(selectedSession) : undefined
                    const primaryName = (
                      sessionDetail?.remark ||
                      sessionDetail?.nickName ||
                      session?.displayName ||
                      selectedSession
                    )?.trim() || selectedSession
                    const subtitleCandidates = [
                      sessionDetail?.nickName?.trim(),
                      sessionDetail?.remark?.trim(),
                      session?.displayName?.trim()
                    ].filter(Boolean) as string[]
                    const subtitleParts = subtitleCandidates.filter((value, index, list) => (
                      value !== primaryName && list.indexOf(value) === index
                    ))
                    const diag = sessionDetailDiagnostics
                    const diagStatusLabel = diag
                      ? (diag.status === 'running' ? '加载中' : diag.status === 'success' ? '成功' : diag.status === 'error' ? '失败' : '待执行')
                      : '未执行'
                    const diagStatusColor = diag
                      ? (diag.status === 'running' ? '#2563eb' : diag.status === 'success' ? '#059669' : diag.status === 'error' ? '#dc2626' : 'var(--text-tertiary)')
                      : 'var(--text-tertiary)'
                    const diagLatestTs = diag?.finishedAt || diag?.startedAt
                    const diagStepSummary = diag ? SESSION_DETAIL_DIAG_STEP_ORDER.reduce((acc, stepKey) => {
                      const status = diag.steps[stepKey].status
                      acc[status] = (acc[status] || 0) + 1
                      return acc
                    }, {} as Record<SessionDetailDiagStepStatus, number>) : null
                    const renderDiagStepStatus = (status: SessionDetailDiagStepStatus) => {
                      if (status === 'loading') {
                        return (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#2563eb', fontSize: 12 }}>
                            <Loader2 size={12} className="spin" />
                            <span>加载中</span>
                          </span>
                        )
                      }
                      if (status === 'success') {
                        return (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#059669', fontSize: 12 }}>
                            <CheckCircle size={12} />
                            <span>成功</span>
                          </span>
                        )
                      }
                      if (status === 'error') {
                        return (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#dc2626', fontSize: 12 }}>
                            <XCircle size={12} />
                            <span>失败</span>
                          </span>
                        )
                      }
                      if (status === 'skipped') {
                        return <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>跳过</span>
                      }
                      return <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>待执行</span>
                    }
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '20px 16px 28px' }}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
                          <div className="session-identity-card" style={{ flex: 1 }}>
                            <div className="export-avatar session-identity-avatar">
                              {session?.avatarUrl ? (
                                <img src={session.avatarUrl} alt="" />
                              ) : (
                                <span className="session-identity-avatar-fallback">
                                  {session?.username.includes('@chatroom') ? '群' : getAvatarLetter(session?.displayName || session?.username || '')}
                                </span>
                              )}
                            </div>
                            <div className="session-identity-main">
                              <div className="session-identity-title" title={primaryName || undefined}>
                                {primaryName}
                              </div>
                              {subtitleParts.length > 0 && (
                                <div className="session-identity-subtitle" title={subtitleParts.join(' · ')}>
                                  {subtitleParts.join(' · ')}
                                </div>
                              )}
                              {sessionDetail && (
                                <div className="session-identity-chips">
                                  <button
                                    type="button"
                                    className={`session-identity-chip session-identity-chip-mono ${copiedIdentityChip === 'wxid' ? 'copied' : ''}`}
                                    title={`点击复制 wxid: ${sessionDetail.wxid}`}
                                    onClick={() => { void copyIdentityValue(sessionDetail.wxid, 'wxid') }}
                                  >
                                    <span className="session-identity-chip-label">wxid</span>
                                    <span className="session-identity-chip-value">{sessionDetail.wxid}</span>
                                    {copiedIdentityChip === 'wxid' && (
                                      <span className="session-identity-chip-state">已复制</span>
                                    )}
                                  </button>
                                  {sessionDetail.alias && (
                                    <button
                                      type="button"
                                      className={`session-identity-chip ${copiedIdentityChip === 'alias' ? 'copied' : ''}`}
                                      title={`点击复制 微信号: ${sessionDetail.alias}`}
                                      onClick={() => {
                                        if (sessionDetail.alias) {
                                          void copyIdentityValue(sessionDetail.alias, 'alias')
                                        }
                                      }}
                                    >
                                      <span className="session-identity-chip-label">微信号</span>
                                      <span className="session-identity-chip-value">{sessionDetail.alias}</span>
                                      {copiedIdentityChip === 'alias' && (
                                        <span className="session-identity-chip-state">已复制</span>
                                      )}
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={handleRefreshSelectedSessionDetail}
                            disabled={!selectedSession || isRefreshingSessionDetail}
                            title="强制重连 chat 服务并重新加载当前会话详情"
                            style={{
                              alignSelf: 'flex-start',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              height: 38,
                              padding: '0 12px',
                              borderRadius: 10,
                              border: '1px solid rgba(var(--primary-rgb), 0.22)',
                              background: isRefreshingSessionDetail ? 'rgba(var(--primary-rgb), 0.08)' : 'var(--bg-primary)',
                              color: 'var(--text-primary)',
                              cursor: (!selectedSession || isRefreshingSessionDetail) ? 'not-allowed' : 'pointer',
                              opacity: (!selectedSession || isRefreshingSessionDetail) ? 0.6 : 1,
                              flexShrink: 0
                            }}
                          >
                            <RefreshCw size={14} className={isRefreshingSessionDetail ? 'spin' : ''} />
                            <span style={{ fontSize: 12, fontWeight: 600 }}>刷新</span>
                          </button>
                        </div>
                        <div style={{
                          border: '1px solid var(--border-color)',
                          borderRadius: 12,
                          background: 'var(--bg-secondary)',
                          padding: 10,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>诊断状态</span>
                                <span style={{ fontSize: 12, fontWeight: 600, color: diagStatusColor }}>{diagStatusLabel}</span>
                              </div>
                              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                                最近一次: {diagLatestTs ? formatDiagTime(diagLatestTs) : '--'}
                                {diag ? ` · ${diag.source === 'refresh' ? '手动刷新' : '选择会话'}` : ''}
                              </div>
                              {diagStepSummary && (
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                                  {diagStepSummary.loading ? <span style={{ fontSize: 10, color: '#2563eb' }}>进行中 {diagStepSummary.loading}</span> : null}
                                  {diagStepSummary.success ? <span style={{ fontSize: 10, color: '#059669' }}>成功 {diagStepSummary.success}</span> : null}
                                  {diagStepSummary.error ? <span style={{ fontSize: 10, color: '#dc2626' }}>失败 {diagStepSummary.error}</span> : null}
                                  {diagStepSummary.pending ? <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>待执行 {diagStepSummary.pending}</span> : null}
                                  {diagStepSummary.skipped ? <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>跳过 {diagStepSummary.skipped}</span> : null}
                                </div>
                              )}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <button
                                type="button"
                                onClick={() => { void copySessionDetailDiagnostics() }}
                                disabled={!diag}
                                title="复制会话详情诊断日志"
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  width: 28,
                                  height: 28,
                                  borderRadius: 8,
                                  border: '1px solid var(--border-color)',
                                  background: 'var(--bg-primary)',
                                  color: 'var(--text-secondary)',
                                  cursor: diag ? 'pointer' : 'not-allowed',
                                  opacity: diag ? 1 : 0.5
                                }}
                              >
                                <Copy size={13} />
                              </button>
                              <button
                                type="button"
                                onClick={() => setShowSessionDetailDiagnostics(prev => !prev)}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 5,
                                  height: 28,
                                  padding: '0 8px',
                                  borderRadius: 8,
                                  border: '1px solid var(--border-color)',
                                  background: 'var(--bg-primary)',
                                  color: 'var(--text-secondary)',
                                  cursor: 'pointer'
                                }}
                              >
                                <span style={{ fontSize: 11 }}>{showSessionDetailDiagnostics ? '收起详情' : '展开详情'}</span>
                                <ChevronDown size={12} style={{ transform: showSessionDetailDiagnostics ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }} />
                              </button>
                            </div>
                          </div>
                          {showSessionDetailDiagnostics && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {diag ? (
                                <>
                                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 2 }}>
                                    <button
                                      type="button"
                                      onClick={() => setShowSessionDetailDiagPayloads(prev => !prev)}
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 4,
                                        height: 24,
                                        padding: '0 8px',
                                        borderRadius: 999,
                                        border: '1px solid var(--border-color)',
                                        background: showSessionDetailDiagPayloads ? 'rgba(var(--primary-rgb), 0.08)' : 'var(--bg-primary)',
                                        color: showSessionDetailDiagPayloads ? 'var(--primary)' : 'var(--text-secondary)',
                                        cursor: 'pointer',
                                        fontSize: 11
                                      }}
                                    >
                                      {showSessionDetailDiagPayloads ? '隐藏' : '显示'} Payload
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setShowSessionDetailDiagEvents(prev => !prev)}
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 4,
                                        height: 24,
                                        padding: '0 8px',
                                        borderRadius: 999,
                                        border: '1px solid var(--border-color)',
                                        background: showSessionDetailDiagEvents ? 'rgba(var(--primary-rgb), 0.08)' : 'var(--bg-primary)',
                                        color: showSessionDetailDiagEvents ? 'var(--primary)' : 'var(--text-secondary)',
                                        cursor: 'pointer',
                                        fontSize: 11
                                      }}
                                    >
                                      {showSessionDetailDiagEvents ? '隐藏' : '显示'} 时间线
                                    </button>
                                  </div>
                                  {SESSION_DETAIL_DIAG_STEP_ORDER.map(stepKey => {
                                    const step = diag.steps[stepKey]
                                    return (
                                      <div
                                        key={stepKey}
                                        style={{
                                          display: 'grid',
                                          gridTemplateColumns: 'minmax(0, 1fr) auto',
                                          gap: 8,
                                          alignItems: 'start',
                                          padding: '7px 8px',
                                          borderRadius: 8,
                                          background: 'var(--bg-primary)',
                                          border: '1px solid rgba(0,0,0,0.03)'
                                        }}
                                      >
                                        <div style={{ minWidth: 0 }}>
                                          <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                                            {SESSION_DETAIL_DIAG_STEP_LABELS[stepKey]}
                                          </div>
                                          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2, wordBreak: 'break-all' }}>
                                            {step.message || '—'}
                                            {step.durationMs != null ? ` · ${step.durationMs}ms` : ''}
                                            {step.updatedAt ? ` · ${formatDiagTime(step.updatedAt)}` : ''}
                                          </div>
                                          {showSessionDetailDiagPayloads && step.payloadSummary && (
                                            <div style={{
                                              marginTop: 5,
                                              padding: '5px 6px',
                                              borderRadius: 6,
                                              background: 'rgba(0,0,0,0.03)',
                                              color: 'var(--text-secondary)',
                                              fontSize: 10,
                                              lineHeight: 1.35,
                                              wordBreak: 'break-all',
                                              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
                                            }}>
                                              {step.payloadSummary}
                                            </div>
                                          )}
                                        </div>
                                        <div>{renderDiagStepStatus(step.status)}</div>
                                      </div>
                                    )
                                  })}
                                  {showSessionDetailDiagEvents && diag.events.length > 0 && (
                                    <div style={{
                                      marginTop: 2,
                                      padding: '8px',
                                      borderRadius: 8,
                                      border: '1px solid rgba(0,0,0,0.04)',
                                      background: 'var(--bg-primary)'
                                    }}>
                                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                                        事件时间线（最近 {diag.events.length} 条）
                                      </div>
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflowY: 'auto', paddingRight: 2 }}>
                                        {diag.events.map((event, idx) => (
                                          <div key={`${event.ts}-${idx}`} style={{ fontSize: 11, lineHeight: 1.35 }}>
                                            <div style={{ color: 'var(--text-secondary)' }}>
                                              <span style={{ color: event.level === 'error' ? '#dc2626' : event.level === 'warn' ? '#d97706' : '#2563eb', fontWeight: 600 }}>
                                                [{event.level.toUpperCase()}]
                                              </span>
                                              {' '}
                                              {formatDiagTime(event.ts)}
                                              {' · '}
                                              <span style={{ color: 'var(--text-primary)' }}>{event.message}</span>
                                            </div>
                                            {event.data && (
                                              <div style={{
                                                marginTop: 2,
                                                color: 'var(--text-tertiary)',
                                                wordBreak: 'break-all',
                                                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
                                              }}>
                                                {event.data}
                                              </div>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {diag.error && (
                                    <div style={{
                                      padding: '8px 10px',
                                      borderRadius: 8,
                                      border: '1px solid rgba(220, 38, 38, 0.18)',
                                      background: 'rgba(220, 38, 38, 0.05)',
                                      color: '#b91c1c',
                                      fontSize: 12,
                                      lineHeight: 1.4,
                                      wordBreak: 'break-all'
                                    }}>
                                      错误信息：{diag.error}
                                    </div>
                                  )}
                                </>
                              ) : (
                                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '4px 2px' }}>
                                  还没有会话详情诊断记录，点击右上角“刷新”开始诊断。
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        {isLoadingDetail && !sessionDetail ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: 0.6, padding: '8px 6px' }}>
                            <Loader2 size={16} className="spin" />
                            <span>加载中...</span>
                          </div>
                        ) : sessionDetail ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', padding: '0 16px' }}>
                            <div className="session-detail-divider" />
                            <div style={{ height: 8 }} />
                            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color, #e0e0e0)' }}>
                              <span style={{ opacity: 0.6 }}>消息总数</span>
                              <span style={{ fontWeight: 500 }}>{sessionDetail.messageCount.toLocaleString()} 条</span>
                            </div>
                            {session?.accountType === 'friend' && (
                              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color, #e0e0e0)' }}>
                                <span style={{ opacity: 0.6 }}>共同群聊</span>
                                {sessionDetail.commonGroupCount !== undefined ? (
                                  <button
                                    type="button"
                                    className="group-friend-count-btn"
                                    onClick={() => {
                                      setCommonGroupMessageCounts({})
                                      setCommonGroupMessageCountsStatus('idle')
                                      setCommonGroupMessageCountsSessionId(null)
                                      setShowCommonGroupsPopup(true)
                                    }}
                                  >
                                    <span>{sessionDetail.commonGroupCount.toLocaleString()}个</span>
                                    <Eye size={13} />
                                  </button>
                                ) : (
                                  <span>--</span>
                                )}
                              </div>
                            )}
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
                                  { icon: <Video size={13} />, label: '视频', count: sessionDetail.videoCount, action: 'check-video' as const },
                                  { icon: <Mic size={13} />, label: '语音', count: sessionDetail.voiceCount },
                                ] as const).filter(item => item.count > 0).map(item => {
                                  const isVideoStatCard = item.action === 'check-video'
                                  const showCheckedVideoCount = isVideoStatCard && currentSessionVideoHasCheckedOverview
                                  const primaryCount = showCheckedVideoCount ? currentSessionVideoReadyCount : item.count
                                  const secondaryCountLabel = isVideoStatCard
                                    ? (showCheckedVideoCount
                                      ? `原始消息 ${item.count.toLocaleString()} 条 · 唯一视频 ${currentSessionVideoUniqueCount.toLocaleString()} 个`
                                      : `原始视频消息 ${item.count.toLocaleString()} 条`)
                                    : null

                                  return (
                                  <div
                                    key={item.label}
                                    className={item.action === 'decrypt' ? 'session-media-stat-card clickable-image-card' : 'session-media-stat-card'}
                                    onClick={item.action === 'decrypt' ? handleImageStatCardClick : undefined}
                                    style={{
                                      flex: 1,
                                      display: 'flex',
                                      flexDirection: 'column',
                                      alignItems: 'stretch',
                                      gap: 4,
                                      padding: '8px 4px',
                                      background: 'var(--bg-secondary)',
                                      borderRadius: 8,
                                    }}
                                  >
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)', fontSize: 12 }}>
                                        {item.icon}
                                        <span>{item.label}</span>
                                      </div>
                                      {(item.action === 'decrypt' || item.action === 'check-video') && (
                                        <div className="session-media-image-actions">
                                          {item.action === 'decrypt' ? (
                                            isCurrentSessionImageTaskRunning ? (
                                              <span className="session-media-status-pill running">
                                                <Loader2 size={11} className="spin" />
                                                <span>解密中</span>
                                              </span>
                                            ) : currentSessionImageOverview?.status === 'checking' ? (
                                              <span className="session-media-status-pill checking">
                                                <Loader2 size={11} className="spin" />
                                                <span>解析中</span>
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
                                            ) : currentSessionImageOverview?.status === 'error' ? (
                                              <button
                                                type="button"
                                                className="session-media-action-btn"
                                                onClick={() => selectedSession && void refreshSessionImageOverview(selectedSession)}
                                                disabled={!selectedSession}
                                                title="重新检查该会话图片"
                                              >
                                                <span>重试</span>
                                              </button>
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
                                            )
                                          ) : (
                                            currentSessionVideoOverview?.status === 'checking' || sessionVideoAssetsLoading ? (
                                              <span className="session-media-status-pill checking">
                                                <Loader2 size={11} className="spin" />
                                                <span>检查中</span>
                                              </span>
                                            ) : currentSessionVideoOverview?.status === 'error' ? (
                                              <button
                                                type="button"
                                                className="session-media-action-btn"
                                                onClick={() => selectedSession && void refreshSessionVideoOverview(selectedSession)}
                                                disabled={!selectedSession}
                                                title="重新检查该会话视频文件"
                                              >
                                                <span>重试</span>
                                              </button>
                                            ) : hasCurrentSessionVideoPreviews ? (
                                              <>
                                                <button
                                                  type="button"
                                                  className="session-media-action-btn"
                                                  onClick={openSessionVideoAssetsModal}
                                                  disabled={!selectedSession}
                                                  title="查看可用视频"
                                                >
                                                  <span>查看视频</span>
                                                </button>
                                                {currentSessionVideoMissingCount > 0 ? (
                                                  <span className="session-media-status-pill warning">
                                                    <span>缺失 {currentSessionVideoMissingCount}</span>
                                                  </span>
                                                ) : currentSessionVideoThumbOnlyCount > 0 ? (
                                                  <span className="session-media-status-pill warning">
                                                    <span>仅缩略图 {currentSessionVideoThumbOnlyCount}</span>
                                                  </span>
                                                ) : currentSessionVideoParseFailedCount > 0 ? (
                                                  <span className="session-media-status-pill warning">
                                                    <span>未识别 {currentSessionVideoParseFailedCount}</span>
                                                  </span>
                                                ) : currentSessionAllVideosReady ? (
                                                  <span className="session-media-status-pill success">
                                                    <CheckCircle size={11} />
                                                    <span>已就绪</span>
                                                  </span>
                                                ) : null}
                                              </>
                                            ) : currentSessionVideoOverview?.status === 'partial' ? (
                                              <>
                                                <button
                                                  type="button"
                                                  className="session-media-action-btn"
                                                  onClick={() => selectedSession && void refreshSessionVideoOverview(selectedSession)}
                                                  disabled={!selectedSession}
                                                  title="重新检查该会话视频文件"
                                                >
                                                  <span>重试</span>
                                                </button>
                                                <span className="session-media-status-pill warning">
                                                  <span>
                                                    {currentSessionVideoMissingCount > 0
                                                      ? `缺失 ${currentSessionVideoMissingCount}`
                                                      : currentSessionVideoParseFailedCount > 0
                                                        ? `未识别 ${currentSessionVideoParseFailedCount}`
                                                        : '部分可用'}
                                                  </span>
                                                </span>
                                              </>
                                            ) : (
                                              <button
                                                type="button"
                                                className="session-media-action-btn"
                                                onClick={() => selectedSession && void refreshSessionVideoOverview(selectedSession)}
                                                disabled={!selectedSession}
                                                title="检查该会话视频文件可用性"
                                              >
                                                <span>检查</span>
                                              </button>
                                            )
                                          )}
                                        </div>
                                      )}
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                                      <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', textAlign: 'center' }}>
                                        {primaryCount.toLocaleString()}
                                      </span>
                                      {secondaryCountLabel && (
                                        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center', lineHeight: 1.3 }}>
                                          {secondaryCountLabel}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                )})}
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
                      className="export-btn export-btn-secondary export-btn-stat"
                      onClick={() => window.electronAPI.window.openChatWindow(selectedSession!)}
                    >
                      <span className="export-btn-mainline">
                        <Eye size={16} />
                        <span>查看会话</span>
                      </span>
                      <span className="export-btn-subline">{selectedSessionMessageCountLabel}</span>
                    </button>
                    <button
                      className="export-btn"
                      onClick={() => setShowExportSettings(true)}
                      disabled={!sessionDetail || sessionDetail.messageCount === 0}
                    >
                      <Download size={16} />
                      <span>导出此会话</span>
                    </button>
                    <button
                      className="export-btn export-btn-secondary export-btn-stat"
                      disabled={!isSelectedFriendSession || !selectedSession || !sessionDetail}
                      onClick={async () => {
                        const targetUsername = (
                          sessionDetail?.wxid
                          || selectedSessionItem?.username
                          || selectedSession
                          || ''
                        ).trim()
                        if (!targetUsername) return
                        const targetName = (
                          sessionDetail?.remark
                          || sessionDetail?.nickName
                          || selectedSessionItem?.displayName
                          || targetUsername
                        ).trim()
                        try {
                          await window.electronAPI.window.openMomentsWindow({
                            preset: {
                              type: 'user',
                              username: targetUsername,
                              label: `${targetName}的朋友圈`
                            }
                          })
                        } catch (e) {
                          console.error('打开对方朋友圈失败:', e)
                        }
                      }}
                    >
                      <span className="export-btn-mainline">
                        <Aperture size={16} />
                        <span>TA的朋友圈</span>
                      </span>
                      <span className="export-btn-subline">{selectedSessionMomentsCountLabel}</span>
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
                    <div className="export-options export-options-with-counts">
                      <label className="checkbox-item checkbox-item-with-count is-fixed">
                        <input type="checkbox" checked disabled readOnly />
                        <div className="custom-checkbox"></div>
                        <FileText size={16} style={{ color: 'var(--text-tertiary)' }} />
                        <div className="checkbox-item-content">
                          <span>导出纯文本聊天记录</span>
                          <span className="checkbox-item-badge">默认导出</span>
                        </div>
                        <span className="checkbox-item-count">
                          包含 {(sessionDetail?.messageCount ?? 0).toLocaleString()} 条消息
                        </span>
                      </label>
                      <label className="checkbox-item">
                        <input type="checkbox" checked={options.exportAvatars} onChange={e => setOptions(prev => ({ ...prev, exportAvatars: e.target.checked }))} />
                        <div className="custom-checkbox"></div>
                        <CircleUserRound size={16} style={{ color: 'var(--text-tertiary)' }} />
                        <span>导出头像</span>
                      </label>
                      <label className={`checkbox-item checkbox-item-with-count ${(sessionDetail?.imageCount ?? 0) === 0 ? 'is-zero-count' : ''}`}>
                        <input type="checkbox" checked={options.exportImages} onChange={e => handleExportImagesToggle(e.target.checked)} />
                        <div className="custom-checkbox"></div>
                        <Image size={16} style={{ color: 'var(--text-tertiary)' }} />
                        <div className="checkbox-item-content">
                          <span>导出图片</span>
                        </div>
                        <span className="checkbox-item-count">{(sessionDetail?.imageCount ?? 0).toLocaleString()} 条</span>
                      </label>
                      {shouldShowImageDecryptExportTip && (
                        <div className="export-image-decrypt-tip" role="note" aria-live="polite">
                          <div className="export-image-decrypt-tip-body">
                            <div className="export-image-decrypt-tip-title">建议先批量解密图片，可缩短导出等待时间</div>
                            <div className="export-image-decrypt-tip-meta">
                              未解密 {currentSessionImageUndecryptedCount.toLocaleString()} 张
                            </div>
                          </div>
                          <div className="export-image-decrypt-tip-actions">
                            <button
                              type="button"
                              className="tip-primary"
                              onClick={() => void openSessionImageDecrypt()}
                              disabled={isSessionImageDecrypting || !selectedSession}
                            >
                              先批量解密（推荐）
                            </button>
                            <button
                              type="button"
                              className="tip-secondary"
                              onClick={handleContinueDirectExportWithImages}
                            >
                              仍然直接导出
                            </button>
                          </div>
                        </div>
                      )}
                      <label className={`checkbox-item checkbox-item-with-count ${(sessionDetail?.videoCount ?? 0) === 0 ? 'is-zero-count' : ''}`}>
                        <input type="checkbox" checked={options.exportVideos} onChange={e => setOptions(prev => ({ ...prev, exportVideos: e.target.checked }))} />
                        <div className="custom-checkbox"></div>
                        <Video size={16} style={{ color: 'var(--text-tertiary)' }} />
                        <div className="checkbox-item-content">
                          <span>导出视频</span>
                          {(sessionDetail?.videoCount ?? 0) > 0 && (
                            <span style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.3 }}>
                              {currentSessionVideoOverview?.status === 'checking'
                                ? `正在检查可导出视频（原始消息 ${currentSessionVideoRawMessageCount.toLocaleString()} 条）`
                                : currentSessionVideoOverview?.status === 'error'
                                  ? `视频检查失败，暂显示原始消息 ${currentSessionVideoRawMessageCount.toLocaleString()} 条（可在会话详情中重试）`
                                : currentSessionVideoHasCheckedOverview
                                  ? `原始消息 ${currentSessionVideoRawMessageCount.toLocaleString()} 条 · 唯一视频 ${currentSessionVideoUniqueCount.toLocaleString()} 个（按 videoMd5 去重）${currentSessionVideoDuplicateCount > 0 ? ` · 重复引用 ${currentSessionVideoDuplicateCount.toLocaleString()} 条` : ''}${currentSessionVideoParseFailedCount > 0 ? ` · 未识别 ${currentSessionVideoParseFailedCount.toLocaleString()} 条` : ''}`
                                  : `原始消息 ${(sessionDetail?.videoCount ?? 0).toLocaleString()} 条 · 将自动检查可导出数量`}
                            </span>
                          )}
                        </div>
                        <span className="checkbox-item-count">
                          {currentSessionVideoHasCheckedOverview
                            ? `${currentSessionVideoExportableCount.toLocaleString()} 个可导出`
                            : `${(sessionDetail?.videoCount ?? 0).toLocaleString()} 条`}
                        </span>
                      </label>
                      <label className={`checkbox-item checkbox-item-with-count ${(sessionDetail?.emojiCount ?? 0) === 0 ? 'is-zero-count' : ''}`}>
                        <input type="checkbox" checked={options.exportEmojis} onChange={e => setOptions(prev => ({ ...prev, exportEmojis: e.target.checked }))} />
                        <div className="custom-checkbox"></div>
                        <Smile size={16} style={{ color: 'var(--text-tertiary)' }} />
                        <div className="checkbox-item-content">
                          <span>导出表情包</span>
                        </div>
                        <span className="checkbox-item-count">{(sessionDetail?.emojiCount ?? 0).toLocaleString()} 条</span>
                      </label>
                      <label className={`checkbox-item checkbox-item-with-count ${(sessionDetail?.voiceCount ?? 0) === 0 ? 'is-zero-count' : ''}`}>
                        <input type="checkbox" checked={options.exportVoices} onChange={e => setOptions(prev => ({ ...prev, exportVoices: e.target.checked }))} />
                        <div className="custom-checkbox"></div>
                        <Mic size={16} style={{ color: 'var(--text-tertiary)' }} />
                        <div className="checkbox-item-content">
                          <span>导出语音</span>
                        </div>
                        <span className="checkbox-item-count">{(sessionDetail?.voiceCount ?? 0).toLocaleString()} 条</span>
                      </label>
                    </div>
                    <p className="export-options-note">
                      图片/表情/语音数量显示的是消息条数；视频在检查完成后会显示“可导出唯一视频数（按 videoMd5 去重）”，更贴近实际导出结果。
                    </p>
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
                    disabled={!selectedSession || !exportFolder || isExporting || hasRunningGlobalChatExportTask}
                  >
                    {(isExporting || hasRunningGlobalChatExportTask) ? (
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
            </div>
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
                disabled={!exportFolder || isExporting || hasRunningGlobalChatExportTask}
              >
                {(isExporting || hasRunningGlobalChatExportTask) ? (
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

      {/* 共同群聊弹窗（私聊会话） */}
      {showCommonGroupsPopup && sessionDetail && (
        <div className="export-overlay" onClick={() => setShowCommonGroupsPopup(false)}>
          <div className="common-groups-modal" onClick={(e) => e.stopPropagation()}>
            <div className="group-friends-modal-header">
              <div>
                <h3>共同群聊</h3>
                <p>
                  {(sessionDetail.commonGroupCount ?? sessionDetail.commonGroups?.length ?? 0).toLocaleString()} 个
                </p>
              </div>
              <button
                type="button"
                className="group-friends-close-btn"
                onClick={() => setShowCommonGroupsPopup(false)}
                aria-label="关闭共同群聊列表"
              >
                <X size={16} />
              </button>
            </div>
            <div className="group-friends-modal-subtitle">
              <div className="group-friends-modal-subtitle-text">
                {sessionDetail.remark || sessionDetail.nickName || (selectedSession ? sessionByUsername.get(selectedSession)?.displayName : undefined) || selectedSession}
              </div>
            </div>
            <div className="common-groups-list">
              {(sessionDetail.commonGroups || []).length === 0 ? (
                <div className="group-friends-empty">暂无共同群聊</div>
              ) : (
                (sessionDetail.commonGroups || []).map((group, index) => {
                  const counts = commonGroupMessageCounts[group.username]
                  const isReady = commonGroupMessageCountsSessionId === selectedSession && commonGroupMessageCountsStatus === 'ready'
                  const isLoading = commonGroupMessageCountsSessionId === selectedSession && commonGroupMessageCountsStatus === 'loading'
                  const isError = commonGroupMessageCountsSessionId === selectedSession && commonGroupMessageCountsStatus === 'error'

                  return (
                    <div key={group.username} className="common-groups-item">
                      <div className="group-friends-index">{index + 1}</div>
                      <div className="group-friends-meta">
                        <div className="group-friends-name">{group.displayName}</div>
                        <div className="group-friends-username">{group.username}</div>
                      </div>
                      <div className={`common-groups-message-stats ${isLoading ? 'is-loading' : ''} ${isError ? 'is-error' : ''}`}>
                        {isReady ? (
                          <>
                            <div><span className="label">我</span><span className="value">{(counts?.selfMessageCount || 0).toLocaleString()}条</span></div>
                            <div><span className="label">TA</span><span className="value">{(counts?.peerMessageCount || 0).toLocaleString()}条</span></div>
                          </>
                        ) : isLoading ? (
                          <div className="single-line">统计中...</div>
                        ) : (
                          <div className="single-line">--</div>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>
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

      {/* 会话视频资产查看弹窗（可用性检查 + 可播放视频） */}
      {showSessionVideoAssetsModal && (
        <div
          className="export-overlay"
          onClick={() => setShowSessionVideoAssetsModal(false)}
        >
          <div className="session-image-assets-modal" onClick={(e) => e.stopPropagation()}>
            <div className="session-image-assets-header">
              <div>
                <h3>会话视频</h3>
                <p>查看可用视频，并检查缺失视频文件</p>
              </div>
              <button
                type="button"
                className="group-friends-close-btn"
                onClick={() => setShowSessionVideoAssetsModal(false)}
                aria-label="关闭会话视频弹窗"
              >
                <X size={16} />
              </button>
            </div>

            <div className="session-image-assets-subtitle">
              {sessionVideoAssetsSessionName || sessionVideoAssetsSessionId || selectedSession}
            </div>

            <div style={{
              marginBottom: 12,
              padding: '10px 12px',
              borderRadius: 10,
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-color, #e0e0e0)',
              display: 'flex',
              flexDirection: 'column',
              gap: 4
            }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                原始视频消息 <strong style={{ color: 'var(--text-primary)' }}>{sessionVideoAssetsRawMessageCount.toLocaleString()}</strong> 条
                {' '}→ 识别到唯一视频 <strong style={{ color: 'var(--text-primary)' }}>{sessionVideoAssetsTotalCount.toLocaleString()}</strong> 个（按 <code>videoMd5</code> 去重）
                {' '}→ 可导出视频 <strong style={{ color: 'var(--text-primary)' }}>{sessionVideoAssetsReadyCount.toLocaleString()}</strong> 个
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                差异说明：
                {sessionVideoAssetsDuplicateCount > 0 ? ` 重复引用 ${sessionVideoAssetsDuplicateCount.toLocaleString()} 条；` : ' 无重复引用；'}
                {sessionVideoAssetsParseFailedCount > 0 ? ` 无法解析 videoMd5 ${sessionVideoAssetsParseFailedCount.toLocaleString()} 条；` : ' 无解析失败；'}
                {sessionVideoAssetsThumbOnlyCount > 0 ? ` 仅缩略图 ${sessionVideoAssetsThumbOnlyCount.toLocaleString()} 个；` : ''}
                {sessionVideoAssetsMissingCount > 0 ? ` 源文件缺失 ${sessionVideoAssetsMissingCount.toLocaleString()} 个。` : ''}
              </div>
            </div>

            <div className="session-image-assets-toolbar">
              <div className="session-image-assets-stats">
                <div className="session-image-assets-stat">
                  <span className="label">原始消息</span>
                  <strong>{sessionVideoAssetsRawMessageCount.toLocaleString()}</strong>
                </div>
                <div className="session-image-assets-stat">
                  <span className="label">唯一视频</span>
                  <strong>{sessionVideoAssetsTotalCount.toLocaleString()}</strong>
                </div>
                <div className="session-image-assets-stat success">
                  <span className="label">已就绪</span>
                  <strong>{sessionVideoAssetsReadyCount.toLocaleString()}</strong>
                </div>
                <div className="session-image-assets-stat info">
                  <span className="label">仅缩略图</span>
                  <strong>{sessionVideoAssetsThumbOnlyCount.toLocaleString()}</strong>
                </div>
                <div className="session-image-assets-stat warning">
                  <span className="label">缺失</span>
                  <strong>{sessionVideoAssetsMissingCount.toLocaleString()}</strong>
                </div>
              </div>
              <div className="session-image-assets-actions">
                {sessionVideoAssetsLoading ? (
                  <span className="session-media-status-pill checking">
                    <Loader2 size={11} className="spin" />
                    <span>检查中</span>
                  </span>
                ) : sessionVideoAssetsError ? (
                  <button
                    type="button"
                    className="session-media-action-btn"
                    onClick={() => { void openSessionVideoAssetsModal() }}
                    disabled={!selectedSession}
                  >
                    <span>重试</span>
                  </button>
                ) : sessionVideoAssetsMissingCount > 0 ? (
                  <button
                    type="button"
                    className="session-media-action-btn"
                    onClick={() => { void openSessionVideoAssetsModal() }}
                    disabled={!selectedSession}
                  >
                    <span>重新检查</span>
                  </button>
                ) : sessionVideoAssetsThumbOnlyCount > 0 ? (
                  <span className="session-media-status-pill warning">
                    <span>仅缩略图 {sessionVideoAssetsThumbOnlyCount}</span>
                  </span>
                ) : sessionVideoAssetsParseFailedCount > 0 ? (
                  <span className="session-media-status-pill warning">
                    <span>未识别 {sessionVideoAssetsParseFailedCount}</span>
                  </span>
                ) : (
                  <span className="session-media-status-pill success">
                    <CheckCircle size={11} />
                    <span>已全部就绪</span>
                  </span>
                )}
              </div>
            </div>

            <div className="session-image-assets-content">
              {sessionVideoAssetsLoading ? (
                <div className="session-image-assets-loading">
                  <Loader2 size={14} className="spin" />
                  <span>正在检查会话视频...</span>
                </div>
              ) : sessionVideoAssetsError ? (
                <div className="session-image-assets-empty">
                  <span>加载失败：{sessionVideoAssetsError}</span>
                </div>
              ) : (readySessionVideoAssets.length === 0 && thumbOnlySessionVideoAssets.length === 0) ? (
                <div className="session-image-assets-empty">
                  <span>暂无可用视频预览</span>
                  <small>点击上方“重新检查”可再次扫描当前会话视频文件。</small>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {readySessionVideoAssets.length > 0 && (
                    <div className="session-assets-group">
                      <div className="session-assets-group-title">可播放视频（{readySessionVideoAssets.length}）</div>
                      <div className="session-image-assets-grid">
                        {readySessionVideoAssets
                          .slice()
                          .sort((a, b) => (b.createTime || 0) - (a.createTime || 0))
                          .map((item, index) => {
                            const localVideoPath = toLocalPathFromFileUrl(item.videoUrl)
                            const dateLabel = item.createTime
                              ? new Date(item.createTime * 1000).toLocaleDateString('zh-CN')
                              : '未知时间'
                            const durationLabel = formatVideoDurationLabel(item.videoDuration)

                            return (
                              <button
                                key={`${item.videoMd5 || 'video'}:${index}:${item.createTime || 0}`}
                                type="button"
                                className="session-image-assets-item"
                                onClick={() => localVideoPath && window.electronAPI.shell.openPath(localVideoPath)}
                                title="打开视频文件"
                              >
                                {item.thumbUrl || item.coverUrl ? (
                                  <img
                                    src={item.thumbUrl || item.coverUrl}
                                    alt=""
                                    loading="lazy"
                                  />
                                ) : (
                                  <div className="session-image-assets-placeholder">
                                    <Video size={18} />
                                  </div>
                                )}
                                <div className="session-image-assets-item-footer" style={{ justifyContent: 'space-between' }}>
                                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
                                    <span>{dateLabel}</span>
                                    {durationLabel && (
                                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{durationLabel}</span>
                                    )}
                                  </div>
                                  <ExternalLink size={12} />
                                </div>
                              </button>
                            )
                          })}
                      </div>
                    </div>
                  )}

                  {thumbOnlySessionVideoAssets.length > 0 && (
                    <div className="session-assets-group">
                      <div className="session-assets-group-title">仅缩略图（{thumbOnlySessionVideoAssets.length}）</div>
                      <div className="session-image-assets-grid">
                        {thumbOnlySessionVideoAssets
                          .slice()
                          .sort((a, b) => (b.createTime || 0) - (a.createTime || 0))
                          .map((item, index) => {
                            const dateLabel = item.createTime
                              ? new Date(item.createTime * 1000).toLocaleDateString('zh-CN')
                              : '未知时间'
                            const durationLabel = formatVideoDurationLabel(item.videoDuration)

                            return (
                              <div
                                key={`${item.videoMd5 || 'video-thumb'}:${index}:${item.createTime || 0}`}
                                className="session-image-assets-item is-disabled"
                                title="仅保留缩略图，视频源文件缺失"
                              >
                                {item.thumbUrl || item.coverUrl ? (
                                  <img
                                    src={item.thumbUrl || item.coverUrl}
                                    alt=""
                                    loading="lazy"
                                  />
                                ) : (
                                  <div className="session-image-assets-placeholder">
                                    <Video size={18} />
                                  </div>
                                )}
                                <div className="session-image-assets-item-footer" style={{ justifyContent: 'space-between' }}>
                                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
                                    <span>{dateLabel}</span>
                                    {durationLabel && (
                                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{durationLabel}</span>
                                    )}
                                  </div>
                                  <span className="session-assets-preview-badge">仅缩略图</span>
                                </div>
                              </div>
                            )
                          })}
                      </div>
                    </div>
                  )}
                </div>
              )}
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
