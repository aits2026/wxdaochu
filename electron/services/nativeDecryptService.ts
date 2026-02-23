/**
 * 原生 DLL 解密服务 (Worker 多线程版)
 * 
 * 使用独立的 Worker 线程加载 DLL 并执行解密，
 * 彻底避免主线程阻塞，并支持实时进度回报。
 */

import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'
import { Worker } from 'worker_threads'

// 简单的 ID 生成器
const generateId = () => Math.random().toString(36).substring(2, 15)

interface DecryptTask {
    resolve: (value: { success: boolean; error?: string }) => void
    onProgress?: (current: number, total: number) => void
}

/**
 * 原生解密服务
 */
export class NativeDecryptService {
    private worker: Worker | null = null
    private dllPath: string | null = null
    private initialized: boolean = false
    private initError: string | null = null
    private tasks: Map<string, DecryptTask> = new Map()

    constructor() {
        this.init()
    }

    /**
     * 初始化服务和 Worker
     */
    private init(): void {
        if (this.initialized) return

        try {
            // 1. 查找 DLL 路径
            this.dllPath = this.findDllPath()
            if (!this.dllPath) {
                this.initError = '未找到 wcdb_decrypt.dll'
                console.warn('[NativeDecrypt] ' + this.initError)
                return
            }

            // 2. 查找 Worker 脚本路径
            const workerScript = this.findWorkerPath()
            if (!workerScript) {
                this.initError = '未找到 decryptWorker.js'
                console.warn('[NativeDecrypt] ' + this.initError)
                return
            }

            console.log('[NativeDecrypt] 启动 Worker:', workerScript)
            console.log('[NativeDecrypt] DLL 路径:', this.dllPath)

            // 3. 启动 Worker 线程
            this.worker = new Worker(workerScript, {
                workerData: { dllPath: this.dllPath }
            })

            // 4. 监听 Worker 消息
            this.worker.on('message', (msg) => this.handleWorkerMessage(msg))
            this.worker.on('error', (err: Error) => {
                console.error('[NativeDecrypt] Worker 错误:', err)
                this.initError = `Worker error: ${err.message}`
            })
            this.worker.on('exit', (code) => {
                if (code !== 0) {
                    console.error(`[NativeDecrypt] Worker 异常退出，代码: ${code}`)
                    this.worker = null
                    this.initialized = false
                }
            })

            this.initialized = true

        } catch (e) {
            this.initError = `初始化失败: ${e}`
            console.error('[NativeDecrypt]', this.initError)
        }
    }

    /**
     * 处理 Worker 发来的消息
     */
    private handleWorkerMessage(msg: any): void {
        if (msg.type === 'ready') {
            console.log('[NativeDecrypt] Worker 已就绪')
            return
        }

        const task = this.tasks.get(msg.id)
        if (!task) return

        switch (msg.type) {
            case 'success':
                task.resolve({ success: true })
                this.tasks.delete(msg.id)
                break

            case 'error':
                task.resolve({ success: false, error: msg.error })
                this.tasks.delete(msg.id)
                break

            case 'progress':
                if (task.onProgress) {
                    task.onProgress(msg.current, msg.total)
                }
                break
        }
    }

    /**
     * 查找 DLL 路径
     */
    private findDllPath(): string | null {
        const candidates: string[] = []
        if (app.isPackaged) {
            candidates.push(
                path.join(process.resourcesPath, 'wcdb_decrypt.dll'),
                path.join(process.resourcesPath, 'resources', 'wcdb_decrypt.dll'),
                path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'wcdb_decrypt.dll')
            )
        } else {
            candidates.push(
                path.join(app.getAppPath(), 'resources', 'wcdb_decrypt.dll'),
                path.join(app.getAppPath(), 'native-dlls', 'wcdb_decrypt', 'build', 'bin', 'Release', 'wcdb_decrypt.dll')
            )
        }
        return candidates.find(p => fs.existsSync(p)) || null
    }

    /**
     * 查找 Worker 脚本路径
     */
    private findWorkerPath(): string | null {
        const candidates: string[] = []

        if (app.isPackaged) {
            // 生产模式：Worker 被编译到 dist-electron/workers 目录
            candidates.push(
                path.join(process.resourcesPath, 'app.asar.unpacked', 'dist-electron', 'workers', 'decryptWorker.js'),
                path.join(process.resourcesPath, 'dist-electron', 'workers', 'decryptWorker.js'),
                path.join(__dirname, 'workers', 'decryptWorker.js'),
                path.join(__dirname, '..', 'workers', 'decryptWorker.js')
            )
        } else {
            // 开发模式：Worker 在源码目录
            candidates.push(
                path.join(app.getAppPath(), 'electron', 'workers', 'decryptWorker.js'),
                path.join(__dirname, '..', 'workers', 'decryptWorker.js')
            )
        }

        const found = candidates.find(p => fs.existsSync(p))
        if (found) {
            console.log('[NativeDecrypt] 找到 Worker:', found)
        } else {
            console.error('[NativeDecrypt] 未找到 Worker，尝试的路径:', candidates)
        }
        return found || null
    }

    /**
     * 检查服务是否可用
     */
    isAvailable(): boolean {
        return this.initialized && this.worker !== null
    }

    /**
     * 异步解密数据库（通过 Worker）
     */
    async decryptDatabaseAsync(
        inputPath: string,
        outputPath: string,
        hexKey: string,
        onProgress?: (current: number, total: number) => void
    ): Promise<{ success: boolean; error?: string }> {
        if (!this.worker) {
            // 如果 Worker 挂了，尝试重启
            if (!this.initialized && !this.initError) {
                this.init()
            }
            if (!this.worker) {
                return { success: false, error: this.initError || 'Worker 未启动' }
            }
        }

        return new Promise((resolve) => {
            const id = generateId()

            // 注册任务
            this.tasks.set(id, { resolve, onProgress })

            // 发送消息
            this.worker!.postMessage({
                type: 'decrypt',
                id,
                inputPath,
                outputPath,
                hexKey
            })
        })
    }
}

// 导出单例
export const nativeDecryptService = new NativeDecryptService()
