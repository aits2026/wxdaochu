import { NavLink, useLocation } from 'react-router-dom'
import { Database, Settings, Download, Aperture, Sun, Moon, Monitor } from 'lucide-react'
import { useThemeStore } from '../stores/themeStore'
import './Sidebar.scss'

function Sidebar() {
  const location = useLocation()
  const { themeMode, setThemeMode } = useThemeStore()
  const isActive = (path: string) => {
    return location.pathname === path
  }

  const openMomentsWindow = async () => {
    try {
      await window.electronAPI.window.openMomentsWindow()
    } catch (e) {
      console.error('打开朋友圈窗口失败:', e)
    }
  }

  return (
    <aside className="sidebar">
      <nav className="nav-menu">
        {/* 朋友圈 - 打开独立窗口 */}
        <button
          className="nav-item"
          onClick={openMomentsWindow}
        >
          <span className="nav-icon"><Aperture size={20} /></span>
          <span className="nav-label">朋友圈</span>
        </button>

        {/* 导出 */}
        <NavLink
          to="/export"
          className={`nav-item ${isActive('/export') ? 'active' : ''}`}
        >
          <span className="nav-icon"><Download size={20} /></span>
          <span className="nav-label">导出</span>
        </NavLink>

        {/* 数据管理 */}
        <NavLink
          to="/data-management"
          className={`nav-item ${isActive('/data-management') ? 'active' : ''}`}
        >
          <span className="nav-icon"><Database size={20} /></span>
          <span className="nav-label">DB</span>
        </NavLink>
      </nav>
      
      <div className="sidebar-footer">
        <NavLink
          to="/settings"
          className={`nav-item ${isActive('/settings') ? 'active' : ''}`}
        >
          <span className="nav-icon">
            <Settings size={20} />
          </span>
          <span className="nav-label">设置</span>
        </NavLink>

        <button
          className="nav-item"
          onClick={() => {
            const next = themeMode === 'light' ? 'dark' : themeMode === 'dark' ? 'system' : 'light'
            setThemeMode(next)
          }}
        >
          <span className="nav-icon">
            {themeMode === 'light' && <Sun size={20} />}
            {themeMode === 'dark' && <Moon size={20} />}
            {themeMode === 'system' && <Monitor size={20} />}
          </span>
          <span className="nav-label">
            {themeMode === 'light' ? '浅色' : themeMode === 'dark' ? '深色' : '跟随'}
          </span>
        </button>
      </div>
    </aside>
  )
}

export default Sidebar
