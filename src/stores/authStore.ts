import { create } from 'zustand'
import * as configService from '../services/config'
import { toBase64Url, fromBase64Url } from '@/utils/base64'

interface AuthState {
    isAuthEnabled: boolean
    isLocked: boolean
    isAuthenticated: boolean
    credentialId: string | null
    authMethod: 'biometric' | 'password' | null

    // Actions
    init: () => Promise<void>
    enableAuth: () => Promise<{ success: boolean; error?: string }>
    disableAuth: () => Promise<void>

    // Password Actions
    setupPassword: (password: string) => Promise<{ success: boolean; error?: string }>
    verifyPassword: (password: string) => Promise<{ success: boolean; error?: string }>

    unlock: () => Promise<{ success: boolean; error?: string }>
    lock: () => void
    setLocked: (locked: boolean) => void
}

import { hashPassword } from '@/utils/crypto'

// WebAuthn 错误消息映射
function getFriendlyErrorMessage(error: any): string {
    const msg = error.message || ''

    // 常见 WebAuthn 错误映射
    if (msg.includes('The operation either timed out or was not allowed')) {
        return '操作超时或被用户取消，请重试'
    }
    if (msg.includes('User verification requirement not met')) {
        return '无法验证用户身份，请检查 PIN 码或生物特征设置'
    }
    if (msg.includes('The relying party ID is not allowed')) {
        return '当前环境不支持此认证方式 (Origin 不匹配)'
    }
    if (msg.includes('Authenticator is not capable')) {
        return '当前设备不支持 Windows Hello 或未设置 PIN 码'
    }
    if (msg.includes('The user aborted a request')) {
        return '用户取消了操作'
    }

    return msg || '认证过程发生未知错误'
}

export const useAuthStore = create<AuthState>((set, get) => ({
    // ... (其他状态保持不变)
    isAuthEnabled: false,
    isLocked: false,
    isAuthenticated: false,
    credentialId: null,
    authMethod: null,

    init: async () => {
        try {
            // 同时检查 password hash
            const passwordHash = await configService.getAuthPasswordHash()
            const enabled = await configService.getAuthEnabled()
            const credId = await configService.getAuthCredentialId()

            // 确定当前认证方式
            let method: 'biometric' | 'password' | null = null
            if (passwordHash) {
                method = 'password'
            } else if (credId) {
                method = 'biometric'
            }

            // 如果 config 记录 enabled 但没有实际 credential/hash，则视为未开启
            const isReallyEnabled = enabled && (!!credId || !!passwordHash)

            set({
                isAuthEnabled: isReallyEnabled,
                credentialId: credId,
                authMethod: method,
                // 如果开启了验证，初始状态为锁定
                isLocked: isReallyEnabled,
                isAuthenticated: !isReallyEnabled
            })
        } catch (e) {
            console.error('初始化认证状态失败:', e)
        }
    },

    enableAuth: async () => {
        try {
            const prevAuthMethod = get().authMethod

            // 优先尝试使用原生 Windows Hello DLL (更快)
            if (window.electronAPI?.windowsHello) {
                const available = await window.electronAPI.windowsHello.isAvailable()
                if (available) {
                    // 使用原生 API 进行首次验证
                    const result = await window.electronAPI.windowsHello.verify('请验证您的身份以启用 Windows Hello 保护')
                    if (result.success) {
                        if (prevAuthMethod === 'password') {
                            const secureResult = await window.electronAPI.profileSecurity.disableProtection()
                            if (!secureResult.success) {
                                return { success: false, error: secureResult.error || '切换认证方式失败：无法恢复敏感配置' }
                            }
                        }
                        // 保存状态 (使用简单标记，原生 API 不需要 credential ID)
                        set({
                            isAuthEnabled: true,
                            credentialId: 'native-windows-hello',
                            authMethod: 'biometric'
                        })
                        await configService.setAuthEnabled(true)
                        await configService.setAuthCredentialId('native-windows-hello')
                        // 清除密码配置，确保互斥
                        await configService.setAuthPasswordHash(null)
                        await configService.setAuthPasswordSalt(null)
                        return { success: true }
                    } else {
                        return { success: false, error: result.error || '验证失败' }
                    }
                }
            }

            // 回退到 WebAuthn (兼容性)
            const publicKey: PublicKeyCredentialCreationOptions = {
                challenge: new Uint8Array([1, 2, 3, 4]),
                rp: { name: 'VXdaochu' },
                user: {
                    id: new Uint8Array([1, 2, 3, 4]),
                    name: 'user',
                    displayName: 'User'
                },
                pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
                authenticatorSelection: {
                    authenticatorAttachment: 'platform',
                    userVerification: 'required'
                },
                timeout: 60000
            }

            const credential = await navigator.credentials.create({ publicKey }) as PublicKeyCredential
            if (!credential) throw new Error('创建凭证失败')

            if (prevAuthMethod === 'password') {
                const secureResult = await window.electronAPI.profileSecurity.disableProtection()
                if (!secureResult.success) {
                    return { success: false, error: secureResult.error || '切换认证方式失败：无法恢复敏感配置' }
                }
            }
            set({
                isAuthEnabled: true,
                credentialId: credential.id,
                authMethod: 'biometric'
            })
            await configService.setAuthEnabled(true)
            await configService.setAuthCredentialId(credential.id)
            await configService.setAuthPasswordHash(null)
            await configService.setAuthPasswordSalt(null)

            return { success: true }
        } catch (e: any) {
            console.error('启用认证失败:', e)
            return { success: false, error: getFriendlyErrorMessage(e) }
        }
    },

    setupPassword: async (password: string) => {
        try {
            const { hash, salt } = await hashPassword(password)

            set({
                isAuthEnabled: true,
                authMethod: 'password',
                credentialId: null // 清除生物识别
            })

            await configService.setAuthEnabled(true)
            await configService.setAuthPasswordHash(hash)
            await configService.setAuthPasswordSalt(salt)
            await configService.setAuthCredentialId(null) // 清除生物识别

            const secureResult = await window.electronAPI.profileSecurity.enableWithPassword(password)
            if (!secureResult.success) {
                return { success: false, error: secureResult.error || '敏感配置加密失败' }
            }

            return { success: true }
        } catch (e: any) {
            return { success: false, error: e.message || '设置密码失败' }
        }
    },

    verifyPassword: async (password: string) => {
        try {
            const savedHash = await configService.getAuthPasswordHash()
            const savedSalt = await configService.getAuthPasswordSalt()

            if (!savedHash || !savedSalt) return { success: false, error: '未设置密码' }

            const { hash } = await hashPassword(password, savedSalt)

            if (hash === savedHash) {
                const secureResult = await window.electronAPI.profileSecurity.unlockWithPassword(password)
                if (!secureResult.success) {
                    return { success: false, error: secureResult.error || '敏感配置解锁失败' }
                }
                const migrateResult = await window.electronAPI.profileSecurity.enableWithPassword(password)
                if (!migrateResult.success) {
                    return { success: false, error: migrateResult.error || '敏感配置升级失败' }
                }
                set({
                    isLocked: false,
                    isAuthenticated: true
                })
                return { success: true }
            } else {
                return { success: false, error: '密码错误' }
            }
        } catch (e: any) {
            return { success: false, error: e.message || '验证失败' }
        }
    },

    disableAuth: async () => {
        const currentMethod = get().authMethod
        if (currentMethod === 'password') {
            const secureResult = await window.electronAPI.profileSecurity.disableProtection()
            if (!secureResult.success) {
                throw new Error(secureResult.error || '无法关闭密码保护：敏感配置仍处于加密状态')
            }
        }
        await window.electronAPI.profileSecurity.lock()
        set({
            isAuthEnabled: false,
            credentialId: null,
            authMethod: null,
            isLocked: false,
            isAuthenticated: true
        })
        await configService.setAuthEnabled(false)
        await configService.setAuthCredentialId(null)
        await configService.setAuthPasswordHash(null)
        await configService.setAuthPasswordSalt(null)
    },

    unlock: async () => {
        const { credentialId, authMethod } = get()

        // 如果是密码模式，无需调用验证，可以直接返回(等待 UI 输入密码)
        if (authMethod === 'password') {
            return { success: false, error: '请使用密码解锁' }
        }

        if (!credentialId) return { success: false, error: '未找到凭证' }

        try {
            // 优先使用原生 Windows Hello DLL (更快)
            if (credentialId === 'native-windows-hello' && window.electronAPI?.windowsHello) {
                const result = await window.electronAPI.windowsHello.verify('请验证您的身份以解锁 VXdaochu')
                if (result.success) {
                    set({
                        isLocked: false,
                        isAuthenticated: true
                    })
                    return { success: true }
                }
                return { success: false, error: result.error || '验证失败' }
            }

            // 回退到 WebAuthn (兼容旧凭证)
            const credential = await navigator.credentials.get({
                publicKey: {
                    challenge: new Uint8Array([1, 2, 3, 4]),
                    allowCredentials: [{
                        id: fromBase64Url(credentialId) as BufferSource,
                        type: 'public-key'
                    }],
                    userVerification: 'required'
                }
            })

            if (credential) {
                set({
                    isLocked: false,
                    isAuthenticated: true
                })
                return { success: true }
            }
            return { success: false, error: '验证失败' }
        } catch (e: any) {
            console.error('解锁失败:', e)
            return { success: false, error: getFriendlyErrorMessage(e) }
        }
    },

    lock: () => {
        if (get().isAuthEnabled) {
            window.electronAPI.profileSecurity.lock().catch(() => { })
            set({ isLocked: true })
        }
    },

    setLocked: (locked) => {
        if (locked) {
            window.electronAPI.profileSecurity.lock().catch(() => { })
        }
        set({ isLocked: locked })
    }
}))
