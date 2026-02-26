import { useRef, useState, useEffect, useMemo } from 'react'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
import { Lock, Fingerprint, AlertCircle, ChevronRight, CircleUserRound, ChevronDown, Loader2, Plus, RefreshCw, RotateCcw } from 'lucide-react'
import * as localProfileService from '../services/profile'
import './LockScreen.scss'

export default function LockScreen() {
    const { userInfo } = useAppStore()
    const [password, setPassword] = useState('')
    const { unlock, verifyPassword, authMethod } = useAuthStore()
    const [isVerifying, setIsVerifying] = useState(false)
    const [error, setError] = useState('')
    const [profiles, setProfiles] = useState<localProfileService.LocalProfileSummary[]>([])
    const [isLoadingProfiles, setIsLoadingProfiles] = useState(false)
    const [showProfileSwitchPanel, setShowProfileSwitchPanel] = useState(false)
    const [profileActionPending, setProfileActionPending] = useState<'switch' | 'create' | 'reset' | null>(null)
    const [profileActionMessage, setProfileActionMessage] = useState<string>('')
    const hasInvokedRef = useRef(false)

    const currentProfile = useMemo(
        () => profiles.find(profile => profile.isCurrent) || null,
        [profiles]
    )

    const displayName = userInfo?.nickName || currentProfile?.nickName || currentProfile?.wxid || '当前账号'
    const displayAvatar = userInfo?.avatarUrl || currentProfile?.avatarUrl || ''

    useEffect(() => {
        // 自动触发一次验证 (仅当生物识别时)
        if (authMethod === 'biometric' && !hasInvokedRef.current) {
            hasInvokedRef.current = true
            handleUnlock()
        }
    }, [authMethod])

    useEffect(() => {
        void loadProfiles()
    }, [])

    const loadProfiles = async () => {
        setIsLoadingProfiles(true)
        try {
            const list = await localProfileService.listProfiles()
            setProfiles(list)
        } catch (e) {
            console.error('LockScreen 加载账号列表失败:', e)
        } finally {
            setIsLoadingProfiles(false)
        }
    }

    const handleUnlock = async () => {
        if (isVerifying) return
        setIsVerifying(true)
        setError('')

        try {
            const result = await unlock()
            if (!result.success) {
                // 如果是用户取消（比如刚启动时自动弹出被取消），可以不显示红色错误，或者显示比较温和的提示
                // 这里我们直接显示 store 中转换好的友好错误信息
                setError(result.error || '验证失败')
            }
        } catch (e: any) {
            // unlock 内部已经 catch 了所有错误并返回 friendly error，
            // 这里的 catch 理论上不会触发，除非 unlock 实现有变。
            // 依然做一个兜底
            console.error('LockScreen unlock error:', e)
            setError('验证过程发生意外错误')
        } finally {
            setIsVerifying(false)
        }
    }

    const handlePasswordUnlock = async (e?: React.FormEvent) => {
        e?.preventDefault()
        if (!password.trim() || isVerifying) return

        setIsVerifying(true)
        setError('')

        const result = await verifyPassword(password)
        if (!result.success) {
            setError(result.error || '密码错误')
            setIsVerifying(false)
        } else {
            // 成功，store 会自动更新状态，组件卸载
        }
    }

    const handleSwitchProfile = async (profile: localProfileService.LocalProfileSummary) => {
        if (profile.isCurrent || isVerifying || profileActionPending) return

        const targetName = profile.nickName || profile.wxid || '该账号'
        const confirmed = window.confirm(
            `将切换到「${targetName}」。\n\n应用会短暂重载，以确保账号数据完全隔离。是否继续？`
        )
        if (!confirmed) return

        setProfileActionPending('switch')
        setProfileActionMessage('正在切换账号并重载应用...')
        try {
            const result = await localProfileService.switchProfile(profile.id)
            if (!result.success) {
                setProfileActionPending(null)
                setProfileActionMessage('')
                setError(result.error || '切换账号失败')
            }
        } catch (e: any) {
            console.error('LockScreen 切换账号失败:', e)
            setProfileActionPending(null)
            setProfileActionMessage('')
            setError('切换账号失败，请重试')
        }
    }

    const handleCreateProfile = async () => {
        if (isVerifying || profileActionPending) return

        const confirmed = window.confirm(
            '将创建一个新的本机账号空间，并在重载后进入新账号。之后请重新配置/登录。是否继续？'
        )
        if (!confirmed) return

        setProfileActionPending('create')
        setProfileActionMessage('正在创建新账号空间并重载应用...')
        try {
            const result = await localProfileService.createAndSwitchProfile()
            if (!result.success) {
                setProfileActionPending(null)
                setProfileActionMessage('')
                setError(result.error || '创建账号失败')
            }
        } catch (e) {
            console.error('LockScreen 创建账号失败:', e)
            setProfileActionPending(null)
            setProfileActionMessage('')
            setError('创建账号失败，请重试')
        }
    }

    const handleResetCurrentProfile = async () => {
        if (authMethod !== 'password' || isVerifying || profileActionPending) return

        const profileName = displayName || '当前账号'
        const confirmed = window.confirm(
            `将重置「${profileName}」在本机的账号数据（包含登录状态、密码保护、本地配置与缓存），然后重启应用。\n\n该操作不可撤销，重置后需要重新登录。是否继续？`
        )
        if (!confirmed) return

        setProfileActionPending('reset')
        setProfileActionMessage('正在排队重置当前账号本机数据，并准备重启应用...')
        setError('')

        try {
            const result = await localProfileService.resetCurrentProfileAndRelaunch()
            if (!result.success) {
                setProfileActionPending(null)
                setProfileActionMessage('')
                setError(result.error || '重置失败')
            }
        } catch (e) {
            console.error('LockScreen 重置当前账号失败:', e)
            setProfileActionPending(null)
            setProfileActionMessage('')
            setError('重置失败，请重试')
        }
    }

    return (
        <div className="lock-screen-overlay">
            <div className="lock-content">
                <div className="lock-avatar-container">
                    {displayAvatar ? (
                        <img src={displayAvatar} alt="Avatar" className="lock-avatar" />
                    ) : (
                        <div className="lock-avatar" style={{ background: '#e0e0e0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <Lock size={32} color="#999" />
                        </div>
                    )}
                    <div className="lock-icon">
                        <Lock size={14} />
                    </div>
                </div>

                <div className="lock-info">
                    <h2>VXdaochu 已锁定</h2>
                    <p>{displayName ? `欢迎回来，${displayName}` : '需要验证身份以继续'}</p>
                </div>

                {authMethod === 'biometric' ? (
                    <button
                        className="unlock-btn"
                        onClick={handleUnlock}
                        disabled={isVerifying}
                    >
                        <Fingerprint size={20} />
                        {isVerifying ? '正在验证...' : '使用 Windows Hello 解锁'}
                    </button>
                ) : (
                    <form className="password-form" onSubmit={handlePasswordUnlock}>
                        <div className="password-input-wrapper">
                            <input
                                type="password"
                                placeholder="请输入应用密码"
                                className="password-input"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                autoFocus
                            />
                            <button
                                type="submit"
                                className="password-submit-btn"
                                disabled={isVerifying || !password}
                            >
                                <ChevronRight size={20} />
                            </button>
                        </div>
                    </form>
                )}

                <div className="lock-secondary-actions">
                    <button
                        type="button"
                        className={`lock-secondary-btn ${showProfileSwitchPanel ? 'active' : ''}`}
                        onClick={() => {
                            setShowProfileSwitchPanel(v => !v)
                            setProfileActionMessage('')
                            setError('')
                        }}
                        disabled={isVerifying || !!profileActionPending}
                    >
                        <CircleUserRound size={15} />
                        <span>切换到其他账号</span>
                        <ChevronDown size={14} />
                    </button>

                    {authMethod === 'password' && (
                        <button
                            type="button"
                            className="lock-danger-btn"
                            onClick={handleResetCurrentProfile}
                            disabled={isVerifying || !!profileActionPending}
                        >
                            {profileActionPending === 'reset' ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />}
                            <span>忘记密码，重置本机数据</span>
                        </button>
                    )}
                </div>

                {showProfileSwitchPanel && (
                    <div className="lock-profile-panel">
                        <div className="lock-profile-panel-header">
                            <span>本机账号</span>
                            <button
                                type="button"
                                className="lock-profile-icon-btn"
                                onClick={() => { void loadProfiles() }}
                                disabled={isLoadingProfiles || !!profileActionPending}
                                title="刷新账号列表"
                            >
                                <RefreshCw size={13} className={isLoadingProfiles ? 'spin' : ''} />
                            </button>
                        </div>

                        <div className="lock-profile-list">
                            {profiles.filter(p => !p.isCurrent).length === 0 ? (
                                <div className="lock-profile-empty">
                                    {isLoadingProfiles ? <Loader2 size={14} className="spin" /> : <CircleUserRound size={14} />}
                                    <span>{isLoadingProfiles ? '正在加载账号列表...' : '暂无其他账号'}</span>
                                </div>
                            ) : (
                                profiles.filter(p => !p.isCurrent).map(profile => (
                                    <div key={profile.id} className="lock-profile-item">
                                        <div className="lock-profile-item-avatar">
                                            {profile.avatarUrl ? <img src={profile.avatarUrl} alt="" /> : <CircleUserRound size={14} />}
                                        </div>
                                        <div className="lock-profile-item-main">
                                            <div className="lock-profile-item-name">{profile.nickName || profile.wxid || '未登录账号'}</div>
                                            <div className="lock-profile-item-meta">
                                                {profile.isProtected
                                                    ? (profile.authMode === 'password' ? '切换后需输入本机密码' : '切换后需生物识别验证')
                                                    : '未设置密码，可直接进入'}
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            className="lock-profile-item-action"
                                            onClick={() => { void handleSwitchProfile(profile) }}
                                            disabled={isVerifying || !!profileActionPending}
                                        >
                                            {profileActionPending === 'switch' ? <Loader2 size={13} className="spin" /> : null}
                                            <span>切换</span>
                                        </button>
                                    </div>
                                ))
                            )}
                        </div>

                        <button
                            type="button"
                            className="lock-profile-create-btn"
                            onClick={handleCreateProfile}
                            disabled={isVerifying || !!profileActionPending}
                        >
                            {profileActionPending === 'create' ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
                            <span>添加账号（新建独立空间）</span>
                        </button>
                    </div>
                )}

                {profileActionMessage && (
                    <div className="lock-info-tip">
                        <Loader2 size={14} className="spin" />
                        <span>{profileActionMessage}</span>
                    </div>
                )}

                {error && (
                    <div className="error-message">
                        <AlertCircle size={14} />
                        <span>{error}</span>
                    </div>
                )}
            </div>
        </div>
    )
}
