import { BaseAIProvider } from './base'

/**
 * 腾讯混元（元宝）提供商元数据
 */
export const TencentMetadata = {
    id: 'tencent',
    name: 'tencent',
    displayName: '腾讯元宝',
    description: '腾讯混元大模型，全链路自研',
    models: [
        'Tencent HY 2.0 Instruct',
        'Tencent HY 2.0 Think',
        'hunyuan-large-role',
        'hunyuan-T1',
        'hunyuan-turboS',
        'hunyuan-A13B'
    ],
    pricing: '¥0.01/1K tokens (Std)',
    pricingDetail: {
        input: 0.01,
        output: 0.01
    },
    website: 'https://cloud.tencent.com/product/hunyuan',
    logo: './AI-logo/yuanbao-color.svg'
}

const MODEL_MAPPING: Record<string, string> = {
    'Tencent HY 2.0 Instruct': 'hunyuan-2.0-instruct-20251111',
    'Tencent HY 2.0 Think': 'hunyuan-2.0-thinking-20251109',
    'hunyuan-large-role': 'hunyuan-large-role-latest',
    'hunyuan-T1': 'hunyuan-t1-latest',
    'hunyuan-turboS': 'hunyuan-turbos-latest',
    'hunyuan-A13B': 'hunyuan-a13b'
}

/**
 * 腾讯混元提供商
 * 使用腾讯云 OpenAI 兼容接口
 * API Key 格式建议: "SecretId|SecretKey" (我们会处理成 Bearer 格式)
 * 或者直接输入 "SecretId;SecretKey" 如果用户知道对应格式
 */
export class TencentProvider extends BaseAIProvider {
    name = TencentMetadata.name
    displayName = TencentMetadata.displayName
    models = TencentMetadata.models
    pricing = TencentMetadata.pricingDetail

    constructor(apiKey: string) {
        // 腾讯云 OpenAI 兼容接口地址
        super(apiKey, 'https://api.hunyuan.cloud.tencent.com/v1')
    }

    /**
     * 获取真实模型ID
     */
    private getModelId(displayName: string): string {
        return MODEL_MAPPING[displayName] || displayName
    }

    /**
     * 重写 getClient 以处理特殊的鉴权格式
     */
    protected async getClient() {
        // 处理 API Key 格式
        // ... (同上，不修改鉴权逻辑)
        let finalKey = this.apiKey
        if (this.apiKey.includes('|')) {
            const [secretId, secretKey] = this.apiKey.split('|').map(s => s.trim())
            if (secretId && secretKey) {
                finalKey = `${secretId};${secretKey}`
            }
        }

        // 临时修改实例的 apiKey 供父类 BaseAIProvider 使用
        const originalKey = this.apiKey
        this.apiKey = finalKey

        try {
            const client = await super.getClient()
            return client
        } finally {
            this.apiKey = originalKey
        }
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
