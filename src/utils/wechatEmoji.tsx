import React from 'react'
import { getEmojiPath, hasEmoji, type EmojiName } from 'wechat-emojis'

// 微信表情名称到图片的映射正则
const emojiPattern = /\[([^\]]+)\]/g

/**
 * 获取表情图片的完整URL
 */
function getEmojiUrl(name: string): string | null {
  if (!hasEmoji(name)) return null
  const relativePath = getEmojiPath(name as EmojiName)
  if (!relativePath) return null
  // 转换为 public 目录下的路径
  return `./wechat-emojis/${relativePath.replace('assets/', '')}`
}

/**
 * 将文本中的微信表情 [xxx] 转换为图片
 */
export function parseWechatEmoji(text: string): React.ReactNode {
  if (!text) return text
  
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  
  // 重置正则
  emojiPattern.lastIndex = 0
  
  while ((match = emojiPattern.exec(text)) !== null) {
    const emojiName = match[1]
    
    // 检查是否是有效的微信表情
    if (hasEmoji(emojiName)) {
      // 添加表情前的文本
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index))
      }
      
      // 添加表情图片
      const emojiUrl = getEmojiUrl(emojiName)
      if (emojiUrl) {
        parts.push(
          <img
            key={match.index}
            src={emojiUrl}
            alt={`[${emojiName}]`}
            title={emojiName}
            className="wechat-emoji"
          />
        )
      } else {
        // 如果获取路径失败，保留原文本
        parts.push(match[0])
      }
      
      lastIndex = match.index + match[0].length
    }
  }
  
  // 添加剩余文本
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }
  
  return parts.length > 0 ? parts : text
}

/**
 * 检查文本是否包含微信表情
 */
export function hasWechatEmoji(text: string): boolean {
  if (!text) return false
  emojiPattern.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = emojiPattern.exec(text)) !== null) {
    if (hasEmoji(match[1])) return true
  }
  return false
}
