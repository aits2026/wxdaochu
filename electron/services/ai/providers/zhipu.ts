import { BaseAIProvider } from './base'

/**
 * 智谱AI提供商元数据
 */
export const ZhipuMetadata = {
  id: 'zhipu',
  name: 'zhipu',
  displayName: '智谱AI',
  description: '国产大模型，性能优秀',
  models: [
    'GLM-5',
    'GLM-4.7 Flash',
    'GLM-4.6v Flash',
    'GLM-4.5 Flash',
    'GLM-4.7',
    'GLM-4.6',
    'GLM-4.5'
  ],
  pricing: '¥0.005/1K tokens',
  pricingDetail: {
    input: 0.005,   // 0.005元/1K tokens
    output: 0.005
  },
  website: 'https://open.bigmodel.cn/',
  logo: './AI-logo/zhipu-color.svg'
}

const MODEL_MAPPING: Record<string, string> = {
  'GLM-5': 'glm-5',
  'GLM-4.7 Flash': 'glm-4.7-flash',
  'GLM-4.6v Flash': 'glm-4.6v-flash',
  'GLM-4.5 Flash': 'glm-4.5-flash',
  'GLM-4.7': 'glm-4.7',
  'GLM-4.6': 'glm-4.6',
  'GLM-4.5': 'glm-4.5'
}

/**
 * 智谱AI提供商
 */
export class ZhipuProvider extends BaseAIProvider {
  name = ZhipuMetadata.name
  displayName = ZhipuMetadata.displayName
  models = ZhipuMetadata.models
  pricing = ZhipuMetadata.pricingDetail

  constructor(apiKey: string) {
    super(apiKey, 'https://open.bigmodel.cn/api/paas/v4')
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
