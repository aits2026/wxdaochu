import { BaseAIProvider } from './base'

/**
 * 自定义提供商元数据
 */
export const CustomMetadata = {
  id: 'custom',
  name: 'custom',
  displayName: '自定义（OpenAI 兼容）',
  description: '支持任何 OpenAI 兼容的 API 服务',
  models: [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4-turbo',
    'gpt-3.5-turbo',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022',
    'gemini-2.0-flash-exp',
    'deepseek-chat',
    'qwen-plus',
    'custom-model'
  ],
  pricing: '根据实际服务商定价',
  pricingDetail: {
    input: 0,      // 自定义服务，价格未知
    output: 0      // 自定义服务，价格未知
  },
  website: '',
  logo: './AI-logo/custom.svg'
}

/**
 * 自定义提供商
 * 支持任何 OpenAI 兼容的 API 服务
 * 例如：OneAPI、API2D、自建中转等
 */
export class CustomProvider extends BaseAIProvider {
  name = CustomMetadata.name
  displayName = CustomMetadata.displayName
  models = CustomMetadata.models
  pricing = CustomMetadata.pricingDetail

  constructor(apiKey: string, baseURL: string) {
    // 自定义服务必须提供 baseURL
    super(apiKey, baseURL || 'https://api.openai.com/v1')
  }

  /**
   * 测试连接 - 重写以提供更友好的错误提示
   */
  async testConnection(): Promise<{ success: boolean; error?: string; needsProxy?: boolean }> {
    try {
      const client = await this.getClient()
      
      // 创建超时 Promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('CONNECTION_TIMEOUT')), 15000) // 15秒超时
      })
      
      // 竞速：API 请求 vs 超时
      await Promise.race([
        client.models.list(),
        timeoutPromise
      ])
      
      return { success: true }
    } catch (error: any) {
      const errorMessage = error?.message || String(error)
      console.error(`[${this.name}] 连接测试失败:`, errorMessage)
      
      // 判断是否需要代理
      const needsProxy = 
        errorMessage.includes('ECONNREFUSED') ||
        errorMessage.includes('ETIMEDOUT') ||
        errorMessage.includes('ENOTFOUND') ||
        errorMessage.includes('CONNECTION_TIMEOUT') ||
        errorMessage.includes('getaddrinfo') ||
        error?.code === 'ECONNREFUSED' ||
        error?.code === 'ETIMEDOUT' ||
        error?.code === 'ENOTFOUND'
      
      // 构建错误提示
      let errorMsg = '连接失败'
      
      if (errorMessage.includes('CONNECTION_TIMEOUT')) {
        errorMsg = '连接超时，请检查服务地址或开启代理'
      } else if (errorMessage.includes('ECONNREFUSED')) {
        errorMsg = '连接被拒绝，请检查服务地址是否正确'
      } else if (errorMessage.includes('ETIMEDOUT')) {
        errorMsg = '连接超时，请检查网络或开启代理'
      } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
        errorMsg = '无法解析域名，请检查服务地址'
      } else if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
        errorMsg = 'API Key 无效，请检查配置'
      } else if (errorMessage.includes('403') || errorMessage.includes('Forbidden')) {
        errorMsg = '访问被禁止，请检查 API Key 权限'
      } else if (errorMessage.includes('404')) {
        errorMsg = 'API 端点不存在，请检查服务地址（需包含 /v1）'
      } else if (errorMessage.includes('429')) {
        errorMsg = '请求过于频繁，请稍后再试'
      } else if (errorMessage.includes('500') || errorMessage.includes('502') || errorMessage.includes('503')) {
        errorMsg = '服务器错误，请稍后再试'
      } else if (needsProxy) {
        errorMsg = '网络连接失败，请检查服务地址或开启代理'
      } else {
        errorMsg = `连接失败: ${errorMessage}`
      }
      
      return { 
        success: false, 
        error: errorMsg,
        needsProxy 
      }
    }
  }
}
