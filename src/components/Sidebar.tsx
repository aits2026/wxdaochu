import { NavLink, useLocation } from 'react-router-dom'
import { Settings, Download, Sun, Moon, Monitor } from 'lucide-react'
import { useThemeStore } from '../stores/themeStore'
import GlobalTaskCenter from './GlobalTaskCenter'
import './Sidebar.scss'

function Sidebar() {
  const location = useLocation()
  const { themeMode, setThemeMode } = useThemeStore()
  const isActive = (path: string) => {
    return location.pathname === path
  }

  return (
    <aside className="sidebar">
      <nav className="nav-menu">
        {/* 导出 */}
        <NavLink
          to="/export"
          className={`nav-item ${isActive('/export') ? 'active' : ''}`}
        >
          <span className="nav-icon"><Download size={20} /></span>
          <span className="nav-label">导出</span>
        </NavLink>

        <GlobalTaskCenter variant="sidebar" label="任务" />
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
