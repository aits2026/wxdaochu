import { BaseAIProvider } from './base'

/**
 * 通义千问提供商元数据
 */
export const QwenMetadata = {
  id: 'qwen',
  name: 'qwen',
  displayName: '通义千问',
  description: '阿里云出品，稳定可靠',
  models: [
    'Qwen Plus',
    'Qwen Flash',
    'Qwen Turbo',
    'QwQ Plus',
    'QwQ Flash',
    'QwQ Turbo',
    'Qwen 3 Omni Flash',
    'Qwen 3 Omni Turbo',
    'Qwen 3 Omni Flash Turbo',
    'Qwen 3 Omni Flash Turbo Flash',
    'Qwen 3 Next 80B Thinking',
    'Qwen 3 Next 80B Instruct',
    'DeepSeek V3.2',
    'Kimi k2 Thinking',
    'GLM 4.7'
  ],
  pricing: '¥0.008/1K tokens',
  pricingDetail: {
    input: 0.008,   // 0.008元/1K tokens
    output: 0.008
  },
  website: 'https://dashscope.aliyun.com/',
  logo: './AI-logo/qwen-color.svg'
}

const MODEL_MAPPING: Record<string, string> = {
  'Qwen Plus': 'qwen-plus',
  'Qwen Flash': 'qwen-flash',
  'Qwen Turbo': 'qwen-turbo',
  'QwQ Plus': 'qwq-plus',
  'QwQ Flash': 'qwq-flash',
  'QwQ Turbo': 'qwq-turbo',
  'Qwen 3 Omni Flash': 'qwen3-omni-flash',
  'Qwen 3 Omni Turbo': 'qwen3-omni-turbo',
  'Qwen 3 Omni Flash Turbo': 'qwen3-omni-flash-turbo',
  'Qwen 3 Omni Flash Turbo Flash': 'qwen3-omni-flash-turbo-flash',
  'Qwen 3 Next 80B Thinking': 'qwen3-next-80b-a3b-thinking',
  'Qwen 3 Next 80B Instruct': 'qwen3-next-80b-a3b-instruct',
  'DeepSeek V3.2': 'deepseek-v3.2',
  'Kimi k2 Thinking': 'kimi-k2-thinking',
  'GLM 4.7': 'glm-4.7'
}

/**
 * 通义千问提供商
 */
export class QwenProvider extends BaseAIProvider {
  name = QwenMetadata.name
  displayName = QwenMetadata.displayName
  models = QwenMetadata.models
  pricing = QwenMetadata.pricingDetail

  constructor(apiKey: string) {
    super(apiKey, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
  }

  /**
   * 获取真实模型ID
   */
  private getModelId(displayName: string): string {
    return MODEL_MAPPING[displayName] || displayName
  }

  /**
   * 重写 chat 方法以使用映射后的模型ID
   */
  async chat(messages: any[], options?: any): Promise<string> {
    const modelId = this.getModelId(options?.model || this.models[0])
    return super.chat(messages, { ...options, model: modelId })
  }

  /**
   * 重写 streamChat 方法以使用映射后的模型ID
   */
  async streamChat(messages: any[], options: any, onChunk: (chunk: string) => void): Promise<void> {
    const modelId = this.getModelId(options?.model || this.models[0])
    return super.streamChat(messages, { ...options, model: modelId }, onChunk)
  }
}
