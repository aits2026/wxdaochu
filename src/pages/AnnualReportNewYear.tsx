import { forwardRef, useEffect, useRef } from 'react'
import { Wind, Cloud, Zap, Sun, Moon } from 'lucide-react'
import './AnnualReportNewYear.scss'

// Custom SVG Icons for "Horse" Theme
const OrientalIcons = {
  Horse: ({ className = '' }: { className?: string }) => (
    <svg className={`deco-horse ${className}`} viewBox="0 0 100 100" fill="currentColor">
      <path d="M20,60 Q25,30 40,20 Q50,15 65,18 Q75,20 80,30 L82,45 Q75,40 65,42 Q55,45 50,55 L45,75 Q40,85 30,80 Z" opacity="0.8" />
      {/* 抽象的奔马鬃毛线条, 可根据实际设计替换更复杂的 Path */}
      <path d="M40,20 Q55,5 75,10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M42,25 Q58,12 78,18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  CloudPattern: ({ className = '' }: { className?: string }) => (
    <svg className={`deco-cloud-pattern ${className}`} viewBox="0 0 200 100" fill="none" stroke="currentColor">
      <path d="M10,80 Q30,40 50,60 T90,60 T130,60 T170,60" strokeWidth="1" opacity="0.3" />
      <path d="M20,90 Q40,50 60,70 T100,70 T140,70" strokeWidth="1" opacity="0.2" />
    </svg>
  ),
  Seal: ({ size = 24 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="currentColor">
      <rect x="2" y="2" width="36" height="36" rx="4" stroke="currentColor" strokeWidth="2" fill="none" />
      <text x="50%" y="55%" textAnchor="middle" dominantBaseline="middle" fontSize="20" fontFamily="serif">印</text>
    </svg>
  )
}

const Avatar = ({ url, name, size = 'md' }: { url?: string; name: string; size?: 'sm' | 'md' | 'lg' }) => {
  const initial = name?.[0] || '友'
  return (
    <div className={`art-avatar ${size}`}>
      {url ? (
        <img src={url} alt="" crossOrigin="anonymous" />
      ) : (
        <div className="placeholder">{initial}</div>
      )}
    </div>
  )
}

interface NewYearReportProps {
  data: {
    year: number
    totalMessages: number
    totalFriends: number
    coreFriends: Array<{
      username: string
      displayName: string
      avatarUrl?: string
      messageCount: number
      sentCount: number
      receivedCount: number
    }>
    monthlyTopFriends: Array<{
      month: number
      displayName: string
      avatarUrl?: string
      messageCount: number
    }>
    peakDay: { date: string; messageCount: number; topFriend?: string; topFriendCount?: number } | null
    longestStreak: { friendName: string; days: number; startDate: string; endDate: string } | null
    activityHeatmap: { data: number[][] }
    midnightKing: { displayName: string; count: number; percentage: number } | null
    selfAvatarUrl?: string
    mutualFriend?: { displayName: string; avatarUrl?: string; sentCount: number; receivedCount: number; ratio: number } | null
    socialInitiative?: { initiatedChats: number; receivedChats: number; initiativeRate: number } | null
    responseSpeed?: { avgResponseTime: number; fastestFriend: string; fastestTime: number } | null
    topPhrases?: { phrase: string; count: number }[]
  }
  sectionRefs: Record<string, React.RefObject<HTMLElement | null>>
}

const formatNumber = (num: number) => num.toLocaleString()

const AnnualReportNewYear = forwardRef<HTMLDivElement, NewYearReportProps>(({ data, sectionRefs }, ref) => {
  const { year, totalMessages, totalFriends, coreFriends, peakDay, longestStreak, midnightKing, mutualFriend, topPhrases } = data
  const topFriend = coreFriends[0]
  const containerRef = useRef<HTMLDivElement>(null)

  // 视差滚动与入场动画观察者
  useEffect(() => {
    if (!containerRef.current) return

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible')
          // 触发背景大字的显示
          const bgText = entry.target.getAttribute('data-bg-text')
          if (bgText) {
            const bgEl = document.getElementById('ny-bg-char')
            if (bgEl) {
              bgEl.textContent = bgText
              bgEl.classList.add('active')
              // 偶数屏使用描边模式
              if (entry.target.classList.contains('theme-light')) {
                bgEl.classList.remove('stroke-mode')
              } else {
                bgEl.classList.add('stroke-mode')
              }
            }
          }
        }
      })
    }, { threshold: 0.3 })

    containerRef.current.querySelectorAll('.ny-section').forEach(el => observer.observe(el))
    containerRef.current.querySelectorAll('.fade-in-up, .scale-reveal').forEach(el => observer.observe(el))

    return () => observer.disconnect()
  }, [])

  return (
    <div className="ny-report" ref={ref}>
      {/* 动态背景层 */}
      <div className="ny-texture" />
      <div className="ny-flow-gold" />
      <div id="ny-bg-char" className="ny-bg-character"></div>

      <div className="ny-container" ref={containerRef}>

        {/* Cover: 御风 */}
        <section className="ny-section theme-dark" ref={sectionRefs.cover} data-bg-text="御风">
          <div className="ny-cover-wrapper">
            <div className="seal-mark fade-in-up">乙巳</div>
            <h1 className="main-title">
              <span>御</span><span>风</span><span>奔</span><span>腾</span>
            </h1>
            <div className="sub-meta fade-in-up delay-400">
              THE YEAR OF HORSE · {year}
            </div>
          </div>
        </section>

        {/* Overview: 浩瀚 */}
        <section className="ny-section theme-light" ref={sectionRefs.overview} data-bg-text="浩瀚">
          <div className="vertical-title-box left">
            <span className="en">OVERVIEW</span>
            <span className="cn">年度概览</span>
          </div>

          <div className="ny-content-axis fade-in-up">
            <div className="stat-art">
              <span className="stat-label">TOTAL MESSAGES</span>
              <span className="big-stat-val">{formatNumber(totalMessages)}</span>
              <span className="stat-unit-cn">条·鸿雁传书</span>
            </div>

            <p className="narrative-text">
              时光如白驹过隙，这一年，你与 <strong>{formatNumber(totalFriends)}</strong> 位故交新知
              <br />在数字世界中留下了深刻的足迹。
            </p>
          </div>
        </section>

        {/* Top Friend: 知己 */}
        {topFriend && (
          <section className="ny-section theme-dark" ref={sectionRefs.bestFriend} data-bg-text="知己">
            <div className="vertical-title-box right">
              <span className="en">SOULMATE</span>
              <span className="cn">高山流水</span>
            </div>

            <div className="ny-content-axis">
              <Avatar url={topFriend.avatarUrl} name={topFriend.displayName} size="lg" />
              <h2 className="main-title" style={{ fontSize: '60px', margin: '20px 0' }}>{topFriend.displayName}</h2>

              <div className="stat-art">
                <span className="big-stat-val">{formatNumber(topFriend.messageCount)}</span>
                <span className="stat-label">MESSAGES EXCHANGED</span>
              </div>

              <div style={{ display: 'flex', gap: '40px', marginTop: '40px' }}>
                <div>
                  <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '12px', display: 'block' }}>SEND</span>
                  <span style={{ fontSize: '24px', fontFamily: 'var(--font-serif-en)' }}>{formatNumber(topFriend.sentCount)}</span>
                </div>
                <div>
                  <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '12px', display: 'block' }}>RECEIVE</span>
                  <span style={{ fontSize: '24px', fontFamily: 'var(--font-serif-en)' }}>{formatNumber(topFriend.receivedCount)}</span>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Mutual Friend: 默契 */}
        {mutualFriend && (
          <section className="ny-section theme-light" ref={sectionRefs.mutualFriend} data-bg-text="默契">
            <div className="vertical-title-box left">
              <span className="en">RESONANCE</span>
              <span className="cn">心有灵犀</span>
            </div>

            <div className="ny-content-axis">
              <div className="narrative-text" style={{ textAlign: 'center', marginBottom: '40px' }}>
                与 <strong>{mutualFriend.displayName}</strong> 的对话
                <br />如双马并辔，步伐一致
              </div>

              <div className="resonance-flow scale-reveal delay-200">
                <div className="flow-node">
                  <div className="label">发出</div>
                  <div className="val">{formatNumber(mutualFriend.sentCount)}</div>
                </div>
                <div className="flow-center">
                  <Wind size={24} />
                </div>
                <div className="flow-node">
                  <div className="label">收到</div>
                  <div className="val">{formatNumber(mutualFriend.receivedCount)}</div>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Streak: 恒久 */}
        {longestStreak && (
          <section className="ny-section theme-dark" ref={sectionRefs.streak} data-bg-text="恒久">
            <div className="vertical-title-box right">
              <span className="en">PERSEVERANCE</span>
              <span className="cn">日日相伴</span>
            </div>

            <div className="ny-content-axis">
              <div className="stat-art">
                <span className="big-stat-val">{longestStreak.days}</span>
                <span className="stat-unit-cn">天·连绵不绝</span>
              </div>
              <p className="narrative-text">
                从 {longestStreak.startDate} 到 {longestStreak.endDate}
                <br />你与 <strong>{longestStreak.friendName}</strong> 的联络从未间断
                <br />路遥知马力，日久见人心
              </p>
            </div>
          </section>
        )}

        {/* Midnight: 守夜 */}
        {midnightKing && (
          <section className="ny-section theme-light" ref={sectionRefs.midnightKing} data-bg-text="守夜">
            <div className="ny-content-axis">
              <Moon size={48} color="var(--vermilion)" style={{ marginBottom: '20px' }} />
              <h2 className="main-title" style={{ fontSize: '48px', color: 'var(--vermilion-dark)' }}>{midnightKing.displayName}</h2>
              <div className="stat-art">
                <span className="big-stat-val">{midnightKing.count}</span>
                <span className="stat-label">MIDNIGHT TALKS</span>
              </div>
              <p className="narrative-text">
                当万籁俱寂，只有你们的灯火依旧
              </p>
            </div>
          </section>
        )}

        {/* Top Phrases: 锦句 */}
        {topPhrases && topPhrases.length > 0 && (
          <section className="ny-section theme-dark" ref={sectionRefs.topPhrases} data-bg-text="锦句">
            <div className="vertical-title-box left">
              <span className="en">KEYWORDS</span>
              <span className="cn">年度锦句</span>
            </div>

            <div className="ny-content-axis">
              <div className="seal-cloud">
                {topPhrases.slice(0, 8).map((p, i) => (
                  <div key={i} className={`seal-item scale-reveal delay-${i}00`}>
                    <div className="seal-txt">{p.phrase}</div>
                    <div className="seal-count">{p.count}</div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Ranking: 群贤 */}
        <section className="ny-section theme-light" ref={sectionRefs.ranking} data-bg-text="群贤">
          <div className="vertical-title-box right">
            <span className="en">TOP FRIENDS</span>
            <span className="cn">群贤毕至</span>
          </div>

          <div className="ny-content-axis" style={{ alignItems: 'stretch' }}>
            <div className="scroll-rank-list fade-in-up">
              {coreFriends.slice(0, 5).map((friend, i) => (
                <div key={friend.username} className="rank-row">
                  <span className="rank-idx">0{i + 1}</span>
                  <img className="rank-avt" src={friend.avatarUrl} alt="" crossOrigin="anonymous" onError={(e) => (e.currentTarget.style.display = 'none')} />
                  <div className="rank-info">
                    <div className="name">{friend.displayName}</div>
                    <div className="detail">{formatNumber(friend.messageCount)} MESSAGES</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Ending: 尾声 */}
        <section className="ny-section theme-dark ny-ending-section" ref={sectionRefs.ending} data-bg-text="乙巳">
          <OrientalIcons.Horse className="horse-totem fade-in-up" />

          <div className="final-poem fade-in-up delay-200">
            <p>老骥伏枥 · 志在千里</p>
            <p>烈士暮年 · 壮心不已</p>
            <p>愿你在新的一年</p>
            <p>一马平川 · 前程似锦</p>
          </div>

          <div className="stamp-logo scale-reveal delay-500">
            VXdaochu · VXdaochu
          </div>
        </section>

      </div>
    </div>
  )
})

AnnualReportNewYear.displayName = 'AnnualReportNewYear'

export default AnnualReportNewYear
