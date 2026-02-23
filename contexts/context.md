# 项目核心上下文 (Context)

## 项目概述
**项目名称**: 密语 (VXdaochu)
**核心功能**: 微信聊天记录查看、分析与导出工具。支持从 Android 设备（模拟器）中提取并解密微信数据库，提供现代化的查看界面。
**技术栈**:
- **前端**: React 19, TypeScript, Zustand, SCSS
- **后端/桌面**: Electron 39, NodeJS
- **打包**: Vite, electron-builder
- **关键依赖**:
  - `better-sqlite3`: 数据库操作
  - `sherpa-onnx-node`, `sense-voice`: 离线语音转文字
  - `silk-wasm`: 语音解码
  - `dom-to-image-more`, `html2canvas`: 图片生成
  - `echarts`: 数据可视化
  - `jieba-wasm`: 中文分词

## 目录结构
- `src/`: React 前端源码
  - `pages/`: 页面 (Welcome, DataManagement, Chat, etc.)
  - `stores/`: 状态管理 (useStore)
  - `components/`: UI 组件
  - `services/`: 前端服务逻辑
- `electron/`: Electron 主进程与 Worker
  - `main.ts`: 主入口
  - `transcribeWorker.ts`: 语音转写子线程
- `scripts/`: 构建与辅助脚本

## 核心业务流程
1. **启动与解密**:
   - 用户提供数据库路径与密钥 (或自动扫描)。
   - 使用 SQLCipher (通过 `better-sqlite3` 或 DLL) 解密 `EnMicroMsg.db`。
   - 解密图片/语音等多媒体文件。
2. **聊天记录查看**:
   - 加载会话列表。
   - 渲染消息气泡 (文本、图片、语音、表情)。
   - 虚拟滚动优化长列表。
3. **高级功能**:
   - 语音转文字 (本地 SenseVoice 模型)。
   - 聊天记录导出。
   - 数据统计与可视化。

## 关键配置与规范
- **语言**: 中文优先 (代码注释、Commit 信息)。
- **样式**: SCSS 模块化，使用 CSS 变量管理主题。
- **状态管理**: Zustand store 存放全局状态（当前会话、数据库连接状态等）。
- **IPC 通信**: Electron 主进程与渲染进程通过 IPC 交换数据（如数据库查询结果、文件操作）。

## 当前开发重点
- 提升应用的健壮性与错误处理。
- 优化长列表和大量数据下的性能。
- 完善 CI/CD 和自动化工作流。
