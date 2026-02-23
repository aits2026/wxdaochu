import { BaseAIProvider } from './base'

/**
 * DeepSeek 提供商元数据
 */
export const DeepSeekMetadata = {
  id: 'deepseek',
  name: 'deepseek',
  displayName: 'DeepSeek',
  description: '最便宜的选择，性价比极高',
  models: ['DeepSeek V3', 'DeepSeek R1 (推理)'],
  pricing: '¥0.001/1K tokens',
  pricingDetail: {
    input: 0.001,   // 0.001元/1K tokens（最便宜）
    output: 0.002
  },
  website: 'https://www.deepseek.com/',
  logo: './AI-logo/deepseek-color.svg'
}

const MODEL_MAPPING: Record<string, string> = {
  'DeepSeek V3': 'deepseek-chat',
  'DeepSeek R1 (推理)': 'deepseek-reasoner'
}

/**
 * DeepSeek 提供商
 */
export class DeepSeekProvider extends BaseAIProvider {
  name = DeepSeekMetadata.name
  displayName = DeepSeekMetadata.displayName
  models = DeepSeekMetadata.models
  pricing = DeepSeekMetadata.pricingDetail

  constructor(apiKey: string) {
    super(apiKey, 'https://api.deepseek.com/v1')
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
