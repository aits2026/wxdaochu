import { useAppStore } from '../stores/appStore'
import './DecryptProgressOverlay.scss'

function DecryptProgressOverlay() {
  const { isDecrypting, decryptingDatabase, decryptProgress, decryptTotal } = useAppStore()

  if (!isDecrypting) return null

  const percent = decryptTotal > 0 ? Math.round((decryptProgress / decryptTotal) * 100) : 0

  return (
    <div className="decrypt-overlay">
      <div className="decrypt-card">
        <h2 className="decrypt-title">正在加载数据库</h2>
        
        <div className="progress-ring-container">
          <svg className="progress-ring" viewBox="0 0 120 120">
            <circle
              className="progress-ring-bg"
              cx="60"
              cy="60"
              r="52"
              fill="none"
              strokeWidth="8"
            />
            <circle
              className="progress-ring-fill"
              cx="60"
              cy="60"
              r="52"
              fill="none"
              strokeWidth="8"
              strokeDasharray={`${2 * Math.PI * 52}`}
              strokeDashoffset={`${2 * Math.PI * 52 * (1 - percent / 100)}`}
              transform="rotate(-90 60 60)"
            />
          </svg>
          <span className="progress-percent">{percent}%</span>
        </div>

        {decryptingDatabase && (
          <p className="decrypt-database">解密: {decryptingDatabase}</p>
        )}

        {decryptTotal > 0 && (
          <p className="decrypt-detail">{decryptProgress} / {decryptTotal} 页</p>
        )}

        <p className="decrypt-hint">首次加载可能需要几秒钟...</p>
      </div>
    </div>
  )
}

export default DecryptProgressOverlay
