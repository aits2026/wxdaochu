const { parentPort, workerData } = require('worker_threads')
const Database = require('better-sqlite3')
const crypto = require('crypto')

function buildHashMap(usernames) {
  const hashToUsername = new Map()
  for (const username of usernames || []) {
    const hash = crypto.createHash('md5').update(username).digest('hex').toLowerCase()
    hashToUsername.set(hash, username)
    hashToUsername.set(hash.slice(0, 16), username)
  }
  return hashToUsername
}

function matchUsernameByTableName(tableName, hashToUsername) {
  const lowerTableName = String(tableName || '').toLowerCase()
  const tableSuffix = lowerTableName.startsWith('msg_') ? lowerTableName.slice(4) : ''

  let matchedUsername =
    hashToUsername.get(tableSuffix) ||
    (tableSuffix.length >= 16 ? hashToUsername.get(tableSuffix.slice(0, 16)) : undefined)

  if (!matchedUsername) {
    const hashMatch = lowerTableName.match(/[a-f0-9]{32}|[a-f0-9]{16}/i)
    if (hashMatch && hashMatch[0]) {
      const matchedHash = hashMatch[0].toLowerCase()
      matchedUsername =
        hashToUsername.get(matchedHash) ||
        (matchedHash.length >= 16 ? hashToUsername.get(matchedHash.slice(0, 16)) : undefined)
    }
  }

  return matchedUsername || null
}

function run() {
  const dbPaths = Array.isArray(workerData?.dbPaths) ? workerData.dbPaths : []
  const usernames = Array.isArray(workerData?.usernames) ? workerData.usernames : []
  const hashToUsername = buildHashMap(usernames)
  const counts = {}
  const openedDbs = []

  try {
    for (const dbPath of dbPaths) {
      let db = null
      try {
        db = new Database(dbPath, { readonly: true })
        openedDbs.push(db)
      } catch {
        continue
      }

      let tables = []
      try {
        tables = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
        ).all()
      } catch {
        continue
      }

      for (const table of tables) {
        const tableName = table && table.name
        if (!tableName) continue

        const matchedUsername = matchUsernameByTableName(tableName, hashToUsername)
        if (!matchedUsername) continue

        try {
          const result = db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get()
          counts[matchedUsername] = (counts[matchedUsername] || 0) + (result && result.count ? result.count : 0)
        } catch {
          // ignore malformed/corrupt table queries
        }
      }
    }

    parentPort?.postMessage({ success: true, counts })
  } catch (error) {
    parentPort?.postMessage({ success: false, error: String(error) })
  } finally {
    for (const db of openedDbs) {
      try { db.close() } catch {}
    }
  }
}

run()
