# 自定义 AI 服务使用指南

## 什么是自定义 AI 服务？

自定义 AI 服务支持任何兼容 OpenAI API 格式的第三方服务,包括但不限于：

- **API 中转服务**：OneAPI、API2D、OpenAI-SB 等
- **自建中转**：使用 one-api、new-api 等搭建的中转服务
- **第三方聚合平台**：集成多个 AI 模型的聚合服务
- **企业内部服务**：公司内部部署的 AI 服务

## 适用场景

✅ 使用 API 中转服务（如 OneAPI）  
✅ 自建 AI 服务中转  
✅ 使用第三方聚合平台  
✅ 企业内部 AI 服务  
✅ 需要自定义 API 端点的场景

## 配置步骤

### 1. 获取服务信息

从你的 AI 服务提供商获取以下信息：

- **API 地址**：服务的 API 端点（必须兼容 OpenAI 格式）
- **API 密钥**：用于身份验证的密钥
- **模型名称**：可用的模型列表

### 2. 在密语中配置

1. 打开密语设置页面
2. 切换到「AI 摘要」标签
3. 选择「自定义（OpenAI 兼容）」提供商
4. 填写配置信息：
   - **API 密钥**：输入你的 API 密钥
   - **服务地址**：输入完整的 API 地址（必须包含 `/v1`）
   - **选择模型**：从下拉列表选择或手动输入模型名称

5. 点击「测试连接」验证配置
6. 测试成功后即可使用

## 服务地址格式

服务地址必须是完整的 API 端点，格式如下：

```
https://your-api-domain.com/v1
```

### 常见服务地址示例

#### OneAPI
```
https://your-oneapi-domain.com/v1
```

#### API2D
```
https://openai.api2d.net/v1
```

#### 自建 one-api
```
http://localhost:3000/v1
或
https://your-domain.com/v1
```

#### OpenAI-SB
```
https://api.openai-sb.com/v1
```

## 模型配置

### 预设模型

系统预设了常用模型：

- `gpt-4o`
- `gpt-4o-mini`
- `gpt-4-turbo`
- `gpt-3.5-turbo`
- `claude-3-5-sonnet-20241022`
- `claude-3-5-haiku-20241022`
- `gemini-2.0-flash-exp`
- `deepseek-chat`
- `qwen-plus`

### 自定义模型

如果你的服务提供其他模型，可以手动输入模型名称：

1. 点击「选择模型」下拉框
2. 直接输入模型名称（例如：`gpt-4-1106-preview`）
3. 系统会自动保存你输入的模型名称

## 常见问题

### Q: 提示"连接失败"

**A:** 请检查：
1. 服务地址是否正确（必须包含 `/v1`）
2. API 密钥是否有效
3. 网络连接是否正常
4. 是否需要开启代理（如果服务在国外）

### Q: 提示"API 端点不存在"

**A:** 服务地址格式不正确，确保：
- 地址以 `/v1` 结尾
- 使用 `https://` 或 `http://` 协议
- 没有多余的路径（如 `/chat/completions`）

### Q: 提示"API Key 无效"

**A:** 请检查：
1. API 密钥是否正确复制（没有多余空格）
2. API 密钥是否已过期
3. API 密钥是否有足够的权限

### Q: 如何知道服务是否兼容 OpenAI API？

**A:** 兼容 OpenAI API 的服务通常会：
- 提供 `/v1/chat/completions` 端点
- 支持 OpenAI 的请求格式
- 在文档中明确说明"兼容 OpenAI API"

### Q: 可以使用本地部署的服务吗？

**A:** 可以！只要服务兼容 OpenAI API 格式，就可以使用。例如：
```
http://localhost:8000/v1
http://192.168.1.100:3000/v1
```

### Q: 支持哪些模型？

**A:** 理论上支持所有兼容 OpenAI API 的模型，包括：
- OpenAI 系列（GPT-4、GPT-3.5 等）
- Claude 系列（通过中转）
- Gemini 系列（通过中转）
- 国产大模型（通义千问、文心一言等，通过中转）
- 开源模型（通过 vLLM、Ollama 等部署）

## 推荐服务

### OneAPI（推荐）

- **官网**：https://github.com/songquanpeng/one-api
- **特点**：开源、免费、支持多种模型
- **部署**：可自行部署或使用公共实例

### API2D

- **官网**：https://api2d.com/
- **特点**：稳定、快速、支持多种模型
- **价格**：按量计费

### OpenAI-SB

- **官网**：https://openai-sb.com/
- **特点**：国内可用、稳定
- **价格**：按量计费

## 安全提示

⚠️ **注意事项**：

1. **API 密钥安全**：不要将 API 密钥分享给他人
2. **服务可信度**：使用可信的服务提供商
3. **数据隐私**：了解服务商的数据处理政策
4. **费用控制**：注意 API 使用量，避免超额消费

## 优势与劣势

### ✅ 优势

- 灵活性高，可使用任何兼容服务
- 可以使用自建服务，完全掌控
- 支持多种模型切换
- 可以使用更便宜的中转服务

### ❌ 劣势

- 需要自行寻找可靠的服务商
- 配置相对复杂
- 服务质量取决于提供商
- 可能需要额外的网络配置

## 技术支持

如果遇到问题，可以：

1. 检查服务商的文档
2. 确认服务是否兼容 OpenAI API
3. 使用「测试连接」功能诊断问题
4. 查看错误提示信息

## 相关链接

- [OpenAI API 文档](https://platform.openai.com/docs/api-reference)
- [OneAPI 项目](https://github.com/songquanpeng/one-api)
- [New API 项目](https://github.com/Calcium-Ion/new-api)
