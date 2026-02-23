import { BaseAIProvider } from './base'

/**
 * Kimi提供商元数据
 */
export const KimiMetadata = {
  id: 'kimi',
  name: 'kimi',
  displayName: 'Kimi',
  description: '支持超长上下文',
  models: ['Kimi 2.5', 'Kimi K2 (0711)', 'Kimi K2 (0905)', 'Kimi K2 Thinking', 'Kimi K2 Thinking Turbo', 'Kimi K2 Turbo Preview', 'Kimi K2 Turbo', 'Kimi Latest', 'Moonshot 128K', 'Moonshot 32K', 'Moonshot 8K', 'Moonshot 8K Flash', 'Moonshot Auto'],
  pricing: '¥0.012/1K tokens',
  pricingDetail: {
    input: 0.012,   // 0.012元/1K tokens
    output: 0.012
  },
  website: 'https://platform.moonshot.cn/',
  logo: './AI-logo/kimi-color.svg'
}

const MODEL_MAPPING: Record<string, string> = {
  'Kimi 2.5': 'kimi-k2.5',
  'Kimi K2 (0711)': 'kimi-k2-0711-preview',
  'Kimi K2 (0905)': 'kimi-k2-0905-preview',
  'Kimi K2 Thinking': 'kimi-k2-thinking',
  'Kimi K2 Thinking Turbo': 'kimi-k2-thinking-turbo',
  'Kimi K2 Turbo Preview': 'kimi-k2-turbo-preview',
  'Kimi K2 Turbo': 'kimi-k2-turbo',
  'Kimi Latest': 'kimi-latest',
  'Moonshot 128K': 'moonshot-v1-128k',
  'Moonshot 32K': 'moonshot-v1-32k',
  'Moonshot 8K': 'moonshot-v1-8k',
  'Moonshot 8K Flash': 'moonshot-v1-8k-flash',
  'Moonshot Auto': 'moonshot-v1-auto'
}

/**
 * Kimi提供商
 */
export class KimiProvider extends BaseAIProvider {
  name = KimiMetadata.name
  displayName = KimiMetadata.displayName
  models = KimiMetadata.models
  pricing = KimiMetadata.pricingDetail

  constructor(apiKey: string) {
    super(apiKey, 'https://api.moonshot.cn/v1')
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
