import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import './SplashPage.scss'

import { useThemeStore } from '../stores/themeStore'

function SplashPage() {
  const [fadeOut, setFadeOut] = useState(false)
  const appIcon = useThemeStore(state => state.appIcon)

  useEffect(() => {
    // 等待入场动画完成后再通知主进程（入场动画 0.4s + 额外停留 0.6s = 1s）
    const readyTimer = setTimeout(() => {
      try {
        // @ts-ignore - splashReady 方法在运行时可用
        window.electronAPI?.window?.splashReady?.()
      } catch (e) {
        console.error('通知启动屏就绪失败:', e)
      }
    }, 1000)

    // 监听淡出事件
    const cleanup = window.electronAPI?.window?.onSplashFadeOut?.(() => {
      setFadeOut(true)
    })

    return () => {
      clearTimeout(readyTimer)
      cleanup?.()
    }
  }, [])

  return (
    <div className={`splash-page ${fadeOut ? 'fade-out' : ''}`}>
      <div className="splash-content">
        <div className="splash-logo">
          {/* 尝试加载logo图片，如果不存在则显示文字 */}
          <img
            src={appIcon === 'xinnian' ? "./xinnian.png" : "./logo.png"}
            alt="密语"
            onError={(e) => {
              // 如果图片加载失败，隐藏img，显示文字
              e.currentTarget.style.display = 'none'
              const textEl = e.currentTarget.nextElementSibling as HTMLElement
              if (textEl) textEl.style.display = 'block'
            }}
          />
          <div className="logo-icon" style={{ display: 'none' }}>密语</div>
        </div>
        <div className="splash-text">
          <Loader2 size={20} className="spin" />
          <span>正在连接数据库...</span>
        </div>
      </div>
    </div>
  )
}

export default SplashPage

