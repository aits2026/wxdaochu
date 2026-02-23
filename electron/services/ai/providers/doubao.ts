import { BaseAIProvider } from './base'

/**
 * 豆包提供商元数据
 */
export const DoubaoMetadata = {
  id: 'doubao',
  name: 'doubao',
  displayName: '豆包',
  description: '字节跳动出品，响应快速',
  models: ['豆包2.0 Pro', '豆包2.0 Lite', '豆包2.0 Mini', '豆包Seed 1.8', '豆包Seed 1.6', '豆包Seed 1.6 Lite', '豆包Seed 1.6 Flash', 'DeepSeek V3.2', 'GLM-4.7', '豆包1.5 Pro 32K'],
  pricing: '¥0.008/1K tokens',
  pricingDetail: {
    input: 0.008,   // 0.008元/1K tokens
    output: 0.008
  },
  website: 'https://www.volcengine.com/',
  logo: './AI-logo/doubao-color.svg'
}

const MODEL_MAPPING: Record<string, string> = {
  '豆包2.0 Pro': 'doubao-seed-2-0-pro-260215',
  '豆包2.0 Lite': 'doubao-seed-2-0-lite-260215',
  '豆包2.0 Mini': 'doubao-seed-2-0-mini-260215',
  '豆包Seed 1.8': 'doubao-seed-1-8-251228',
  '豆包Seed 1.6': 'doubao-seed-1-6-251015',
  '豆包Seed 1.6 Lite': 'doubao-seed-1-6-lite-251015',
  '豆包Seed 1.6 Flash': 'doubao-seed-1-6-flash-250828',
  'DeepSeek V3.2': 'deepseek-v3-2-251201',
  'GLM-4.7': 'glm-4-7-251222',
  '豆包1.5 Pro 32K': 'doubao-1-5-pro-32k-250115'
}

/**
 * 豆包提供商
 */
export class DoubaoProvider extends BaseAIProvider {
  name = DoubaoMetadata.name
  displayName = DoubaoMetadata.displayName
  models = DoubaoMetadata.models
  pricing = DoubaoMetadata.pricingDetail

  constructor(apiKey: string) {
    super(apiKey, 'https://ark.cn-beijing.volces.com/api/v3')
  }

  private getModelId(displayName: string): string {
    return MODEL_MAPPING[displayName] || displayName
  }

  async chat(messages: any[], options?: any): Promise<string> {
    const modelId = this.getModelId(options?.model || this.models[0])
    return super.chat(messages, { ...options, model: modelId })
  }

  async streamChat(messages: any[], options: any, onChunk: (chunk: string) => void): Promise<void> {
    const modelId = this.getModelId(options?.model || this.models[0])
    return super.streamChat(messages, { ...options, model: modelId }, onChunk)
  }
}
