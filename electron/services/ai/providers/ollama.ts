import { BaseAIProvider } from './base'

/**
 * Ollama提供商元数据
 */
export const OllamaMetadata = {
  id: 'ollama',
  name: 'ollama',
  displayName: 'Ollama (本地)',
  description: '本地运行的开源大模型服务',
  models: [
    'qwen2.5:latest',
    'llama3.3:latest',
    'deepseek-r1:latest',
    'gemma2:latest',
    'mistral:latest',
    'phi4:latest',
    'qwen2.5-coder:latest'
  ],
  pricing: '免费（本地运行）',
  pricingDetail: {
    input: 0,      // 本地运行，无费用
    output: 0      // 本地运行，无费用
  },
  website: 'https://ollama.com/',
  logo: './AI-logo/ollama.svg'
}

/**
 * Ollama提供商
 * 支持本地运行的 Ollama 服务
 */
export class OllamaProvider extends BaseAIProvider {
  name = OllamaMetadata.name
  displayName = OllamaMetadata.displayName
  models = OllamaMetadata.models
  pricing = OllamaMetadata.pricingDetail

  constructor(apiKey: string = 'ollama', baseURL?: string) {
    // Ollama 默认运行在 http://localhost:11434
    // apiKey 对于 Ollama 不是必需的，但为了保持接口一致性，我们接受它
    super(apiKey, baseURL || 'http://localhost:11434/v1')
  }

  /**
   * 测试连接 - 重写以适配 Ollama
   */
  async testConnection(): Promise<{ success: boolean; error?: string; needsProxy?: boolean }> {
    try {
      const client = await this.getClient()
      
      // 创建超时 Promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('CONNECTION_TIMEOUT')), 10000) // 10秒超时
      })
      
      // Ollama 使用 /api/tags 端点获取模型列表
      // 但由于我们使用 OpenAI 兼容接口，尝试列出模型
      await Promise.race([
        client.models.list(),
        timeoutPromise
      ])
      
      return { success: true }
    } catch (error: any) {
      const errorMessage = error?.message || String(error)
      console.error(`[${this.name}] 连接测试失败:`, errorMessage)
      
      // Ollama 是本地服务，不需要代理
      const needsProxy = false
      
      // 构建错误提示
      let errorMsg = '连接失败'
      
      if (errorMessage.includes('CONNECTION_TIMEOUT')) {
        errorMsg = '连接超时，请确认 Ollama 服务已启动（默认端口 11434）'
      } else if (errorMessage.includes('ECONNREFUSED')) {
        errorMsg = 'Ollama 服务未启动，请先运行 "ollama serve"'
      } else if (errorMessage.includes('ETIMEDOUT')) {
        errorMsg = '连接超时，请检查 Ollama 服务状态'
      } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
        errorMsg = '无法连接到 Ollama 服务，请检查地址配置'
      } else if (errorMessage.includes('404')) {
        errorMsg = 'Ollama API 端点不存在，请检查服务版本'
      } else {
        errorMsg = `连接失败: ${errorMessage}。请确认 Ollama 已安装并运行`
      }
      
      return { 
        success: false, 
        error: errorMsg,
        needsProxy 
      }
    }
  }
}
