import { BaseAIProvider } from './base'

/**
 * xAI (Grok) 提供商元数据
 */
export const XAIMetadata = {
    id: 'xai',
    name: 'xai',
    displayName: 'xAI (Grok)',
    description: 'Elon Musk 旗下 xAI 出品，具备实时搜索能力',
    models: [
        'Grok 4.1 Fast',
        'Grok 4.1 Fast (非推理)',
        'Grok Code Fast 1',
        'Grok 4 Fast',
        'Grok 4 Fast (非推理)',
        'Grok 4',
        'Grok 3 Mini',
        'Grok 3',
        'Grok 2 Vision'
    ],
    pricing: '$5/1M tokens',  // 约 ¥0.035/1K tokens
    pricingDetail: {
        input: 0.035,
        output: 0.035
    },
    website: 'https://x.ai/',
    logo: './AI-logo/xai.svg'
}

const MODEL_MAPPING: Record<string, string> = {
    'Grok 4.1 Fast': 'grok-4-1-fast-reasoning',
    'Grok 4.1 Fast (非推理)': 'grok-4-1-fast-non-reasoning',
    'Grok Code Fast 1': 'grok-code-fast-1',
    'Grok 4 Fast': 'grok-4-fast-reasoning',
    'Grok 4 Fast (非推理)': 'grok-4-fast-non-reasoning',
    'Grok 4': 'grok-4-0709',
    'Grok 3 Mini': 'grok-3-mini',
    'Grok 3': 'grok-3',
    'Grok 2 Vision': 'grok-2-vision-1212'
}

/**
 * xAI 提供商
 * 完全兼容 OpenAI 接口
 */
export class XAIProvider extends BaseAIProvider {
    name = XAIMetadata.name
    displayName = XAIMetadata.displayName
    models = XAIMetadata.models
    pricing = XAIMetadata.pricingDetail

    constructor(apiKey: string) {
        super(apiKey, 'https://api.x.ai/v1')
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
