import { useMemo } from 'react'
import { 
  Smile, Star, Heart, Cloud, Music, Mail, 
  Camera, Gift, Coffee, Sun, Moon, Zap,
  Sparkles, MessageCircle, ThumbsUp, Bell,
  Bookmark, Flag, Leaf, Flower2, Send, Image,
  Phone, Video, Mic, MapPin, Clock, Calendar
} from 'lucide-react'
import './ChatBackground.scss'

const iconComponents = [
  Smile, Star, Heart, Cloud, Music, Mail, 
  Camera, Gift, Coffee, Sun, Moon, Zap,
  Sparkles, MessageCircle, ThumbsUp, Bell,
  Bookmark, Flag, Leaf, Flower2, Send, Image,
  Phone, Video, Mic, MapPin, Clock, Calendar
]

// 使用种子生成伪随机数，保证每次渲染结果一致
function seededRandom(seed: number) {
  const x = Math.sin(seed) * 10000
  return x - Math.floor(x)
}

function ChatBackground() {
  const icons = useMemo(() => {
    const result = []
    const gridSize = 90 // 网格大小
    const padding = 15 // 边距，防止图标太靠近格子边缘
    const cols = Math.ceil(1920 / gridSize) + 1
    const rows = Math.ceil(1080 / gridSize) + 1
    
    let seed = 42
    
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        seed++
        // 在每个格子内随机放置，但保持一定边距
        // 这样确保每个格子都有图标（均匀），但位置随机（不规则）
        const minX = col * gridSize + padding
        const maxX = (col + 1) * gridSize - padding
        const minY = row * gridSize + padding
        const maxY = (row + 1) * gridSize - padding
        
        const x = minX + seededRandom(seed) * (maxX - minX)
        const y = minY + seededRandom(seed + 1000) * (maxY - minY)
        
        // 随机选择图标
        const iconIndex = Math.floor(seededRandom(seed + 2000) * iconComponents.length)
        const Icon = iconComponents[iconIndex]
        
        // 随机旋转和缩放
        const rotate = (seededRandom(seed + 3000) - 0.5) * 50
        const scale = 0.85 + seededRandom(seed + 4000) * 0.3
        
        result.push({ Icon, x, y, rotate, scale })
      }
    }
    
    return result
  }, [])

  return (
    <div className="chat-background">
      {icons.map((item, index) => (
        <div
          key={index}
          className="bg-icon"
          style={{
            left: item.x,
            top: item.y,
            transform: `rotate(${item.rotate}deg) scale(${item.scale})`,
          }}
        >
          <item.Icon size={38} strokeWidth={1.2} />
        </div>
      ))}
    </div>
  )
}

export default ChatBackground
