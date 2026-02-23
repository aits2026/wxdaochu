<div align="center">

# 🔐 VXdaochu VXdaochu

**一款现代化的微信聊天记录查看与导出工具**

[![License](https://img.shields.io/badge/license-CC--BY--NC--SA--4.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.2.5-green.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6.svg?logo=windows)]()
[![Electron](https://img.shields.io/badge/Electron-39-47848F.svg?logo=electron)]()
[![React](https://img.shields.io/badge/React-19-61DAFB.svg?logo=react)]()
[![Telegram](https://img.shields.io/badge/Telegram-Join%20Group-26A5E4.svg?logo=telegram)](https://t.me/nobody2026go)

[功能特性](#-功能特性) • [快速开始](#-快速开始) • [技术栈](#️-技术栈) • [许可证](#-许可证)

</div>

---

## ✨ 功能特性

<table>
  <tr>
    <td width="50%">
      <h3>💬 聊天记录查看</h3>
      <p>现代化聊天界面，支持文字、图片、语音、视频、表情包、文件等多种消息类型，完整还原微信聊天体验。支持关键词搜索与日期范围筛选，快速定位目标消息。</p>
    </td>
    <td width="50%">
      <h3>📤 多格式数据导出</h3>
      <p>支持将聊天记录导出为 JSON、HTML、CSV、Excel、SQL、VCF 联系人及 ChatLab 等多种格式。导出前可预览会话详情（消息总数、媒体统计、历史导出记录及数据增量），灵活满足备份与迁移需求。</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🖼️ 数据管理与解密</h3>
      <p>支持对微信本地存储的图片与表情包进行批量解密还原，方便查看和管理媒体资源。</p>
    </td>
    <td width="50%">
      <h3>📅 朋友圈浏览</h3>
      <p>支持浏览微信朋友圈内容，方便统一查看与管理历史动态。</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🔒 隐私安全保护</h3>
      <p>支持密码锁屏与生物识别（指纹/面容）解锁，有效保护聊天数据隐私，防止未授权访问。</p>
    </td>
    <td width="50%">
      <h3>🎨 个性化主题</h3>
      <p>浅色 / 深色模式自由切换，多种主题色可选，支持语音消息转文字（STT），打造舒适的个性化使用体验。</p>
    </td>
  </tr>
</table>

## 🛠️ 技术栈

<div align="center">

| 类别 | 技术 |
|:---:|:---|
| **前端框架** | React 19 + TypeScript + Zustand |
| **桌面应用** | Electron 39 |
| **构建工具** | Vite + electron-builder |
| **样式方案** | SCSS + CSS Variables |
| **其他** | jieba-wasm (分词) • lucide-react (图标) • marked (Markdown) |

</div>

---

## 🚀 快速开始

### 📋 环境要求

- **Node.js**: 18.x 或更高版本
- **操作系统**: Windows 10/11
- **内存**: 建议 4GB 以上

### 📦 安装依赖

```bash
npm install
```

### 🔧 开发模式

启动开发服务器（支持热重载）：

```bash
npm run dev
```

### 📦 构建应用

构建生产版本：

```bash
# 构建完整安装包
npm run build

# 仅构建核心版本（不包含依赖）
npm run build:core
```

构建产物位于 `release/` 目录。

---

## 🎯 核心功能说明

### 📤 数据导出

支持将单个会话导出为多种格式：

| 格式 | 说明 |
|:---:|:---|
| **JSON** | 结构化原始数据，适合二次开发 |
| **HTML** | 可在浏览器直接查看的聊天页面 |
| **CSV** | 表格格式，适合数据分析工具导入 |
| **Excel** | 电子表格格式（.xlsx） |
| **SQL** | 标准 SQL 转储，便于数据库导入 |
| **VCF** | 联系人名片格式 |
| **ChatLab** | 专用导入格式 |

**导出前会话详情包含：**
- 微信 ID、备注名、昵称、微信号等身份信息
- 图片、视频、语音、表情包数量统计
- 历次导出记录及与当前消息总数的差值（帮助判断是否需要重新导出）

---

## 📄 许可证

本项目采用 **CC BY-NC-SA 4.0** 许可证  
（知识共享 署名-非商业性使用-相同方式共享 4.0 国际许可协议）

<div align="center">

### ✅ 您可以自由地

| 权利 | 说明 |
|:---:|:---|
| 📥 **共享** | 复制、发行本软件 |
| 🔧 **演绎** | 修改、转换或以本软件为基础进行创作 |
| 👤 **个人使用** | 用于学习和个人项目 |

### 📋 但必须遵守

| 要求 | 说明 |
|:---:|:---|
| 📝 **署名** | 必须给出适当的署名，提供指向本许可协议的链接 |
| 🚫 **非商业性使用** | 不得用于商业目的 |
| 🔄 **相同方式共享** | 如果修改本软件，必须使用相同的许可协议 |

### ❌ 严格禁止

- 销售本软件或其修改版本
- 用于任何商业服务或产品
- 通过本软件获取商业利益

</div>

查看 [LICENSE](LICENSE) 文件了解完整协议内容。

---

## ⚠️ 免责声明

> **重要提示**
> 
> - 本项目仅供**学习和研究**使用
> - 请遵守相关**法律法规**和用户协议
> - 使用本项目产生的任何后果由**用户自行承担**
> - 请勿将本项目用于任何**非法用途**

---

## 📞 联系方式

<div align="center">

| 渠道 | 链接 |
|:---:|:---|
| 📱 **Telegram 群组** | [加入群聊](https://t.me/+toZ7bY15IZo3NjVl) |

</div>

---

## 🙏 致谢

感谢所有为开源社区做出贡献的开发者们！

特别感谢：
- **[WeFlow](https://github.com/hicccc77/WeFlow)** - 提供了部分功能参考
- **所有贡献者** - 感谢每一位为本项目做出贡献的开发者

---

## 📈 Star History

<div align="center">

<a href="https://www.star-history.com/#ILoveBingLu/VXdaochu&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=ILoveBingLu/VXdaochu&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=ILoveBingLu/VXdaochu&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=ILoveBingLu/VXdaochu&type=date&legend=top-left" />
 </picture>
</a>

---

<sub>一鲸落，万物生 · 愿每一段对话都被温柔以待 ❤️ by the VXdaochu Team</sub>

</div>
