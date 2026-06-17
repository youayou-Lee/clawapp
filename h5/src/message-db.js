/**
 * 本地消息存储 - 使用 IndexedDB 实现离线消息持久化
 * 
 * 功能：
 * - 连接时自动加载本地缓存
 * - 发送/接收消息自动存入本地
 * - 断网时使用本地缓存
 * - 网络恢复后与服务器同步
 */

const DB_NAME = 'clawapp-messages'
const DB_VERSION = 2
const STORE_NAME = 'messages'
const STORE_SESSIONS = 'sessions'
const STORE_TOOL_EVENTS = 'tool_events'

let _db = null

/** 打开数据库 */
function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db)
    
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    
    request.onerror = () => reject(request.error)
    
    request.onsuccess = () => {
      _db = request.result
      resolve(_db)
    }
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result
      
      // 消息存储
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const msgStore = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        msgStore.createIndex('sessionKey', 'sessionKey', { unique: false })
        msgStore.createIndex('timestamp', 'timestamp', { unique: false })
        msgStore.createIndex('sessionKey_timestamp', ['sessionKey', 'timestamp'], { unique: false })
      }
      
      // 会话索引存储
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: 'sessionKey' })
      }

      // v2: 工具调用事件存储（用于刷新后重建调用链）
      if (!db.objectStoreNames.contains(STORE_TOOL_EVENTS)) {
        const toolStore = db.createObjectStore(STORE_TOOL_EVENTS, { keyPath: 'id', autoIncrement: true })
        toolStore.createIndex('sessionKey', 'sessionKey', { unique: false })
        toolStore.createIndex('sessionKey_runId', ['sessionKey', 'runId'], { unique: false })
        toolStore.createIndex('toolCallId', 'toolCallId', { unique: false })
        toolStore.createIndex('timestamp', 'timestamp', { unique: false })
        toolStore.createIndex('sessionKey_timestamp', ['sessionKey', 'timestamp'], { unique: false })
      }
    }
  })
}

/** 保存消息到本地 */
export async function saveMessage(message) {
  if (!message || !message.id) return
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    
    // 确保有必需字段
    const msg = {
      id: message.id,
      sessionKey: message.sessionKey || '',
      role: message.role || 'assistant',
      content: message.content || message.text || '',
      attachments: message.attachments || undefined,
      timestamp: message.timestamp || Date.now(),
      sync: true  // 已同步标记
    }
    
    store.put(msg)
  } catch (e) {
    console.error('[db] saveMessage error:', e)
  }
}

/** 批量保存消息（用于加载历史后） */
export async function saveMessages(messages) {
  if (!messages || !messages.length) return
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    
    messages.forEach(msg => {
      if (!msg.id) return
      store.put({
        id: msg.id,
        sessionKey: msg.sessionKey || '',
        role: msg.role || 'assistant',
        content: msg.content || msg.text || '',
        timestamp: msg.timestamp || Date.now(),
        sync: true
      })
    })
  } catch (e) {
    console.error('[db] saveMessages error:', e)
  }
}

/** 保存 agent 工具事件到本地 */
export async function saveToolEvent(event) {
  if (!event) return
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_TOOL_EVENTS, 'readwrite')
    const store = tx.objectStore(STORE_TOOL_EVENTS)

    const record = {
      sessionKey: event.sessionKey || '',
      runId: event.runId || '',
      toolCallId: event.toolCallId || '',
      stream: event.stream || '',
      phase: event.phase || '',
      data: event.data || null,
      timestamp: event.timestamp || Date.now(),
      commandOutput: event.commandOutput || ''
    }

    // 对 tool/item 事件做轻量去重：同一 toolCallId + phase 在 5s 内只更新
    if (record.toolCallId && (record.stream === 'tool' || record.stream === 'item') && record.phase) {
      const index = store.index('toolCallId')
      const range = IDBKeyRange.bound(record.toolCallId, record.toolCallId)
      const existing = await new Promise((resolve, reject) => {
        let found = null
        const req = index.openCursor(range, 'prev')
        req.onsuccess = (e) => {
          const cursor = e.target.result
          if (cursor && !found) {
            const val = cursor.value
            if (val.sessionKey === record.sessionKey &&
                val.stream === record.stream &&
                val.phase === record.phase &&
                Math.abs(val.timestamp - record.timestamp) < 5000) {
              found = { value: val, cursor }
            }
            if (!found) cursor.continue()
            else resolve(found)
          } else {
            resolve(null)
          }
        }
        req.onerror = () => reject(req.error)
      }).catch(() => null)

      if (existing) {
        existing.value.data = record.data
        existing.value.timestamp = record.timestamp
        store.put(existing.value)
        return
      }
    }

    store.put(record)
  } catch (e) {
    console.error('[db] saveToolEvent error:', e)
  }
}

/** 获取会话的工具事件（按时间正序） */
export async function getToolEvents(sessionKey, since = 0, limit = 500) {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_TOOL_EVENTS, 'readonly')
      const store = tx.objectStore(STORE_TOOL_EVENTS)
      const index = store.index('sessionKey_timestamp')
      const range = IDBKeyRange.bound(
        [sessionKey, since],
        [sessionKey, Date.now()]
      )
      const events = []
      const request = index.openCursor(range, 'next')
      request.onsuccess = (event) => {
        const cursor = event.target.result
        if (cursor && events.length < limit) {
          events.push(cursor.value)
          cursor.continue()
        }
      }
      tx.oncomplete = () => resolve(events)
      tx.onerror = () => resolve([])
    })
  } catch (e) {
    console.error('[db] getToolEvents error:', e)
    return []
  }
}

/** 删除会话的所有工具事件 */
export async function clearToolEvents(sessionKey) {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_TOOL_EVENTS, 'readwrite')
    const store = tx.objectStore(STORE_TOOL_EVENTS)
    const index = store.index('sessionKey')
    const request = index.openCursor(sessionKey)
    request.onsuccess = (event) => {
      const cursor = event.target.result
      if (cursor) {
        cursor.delete()
        cursor.continue()
      }
    }
  } catch (e) {
    console.error('[db] clearToolEvents error:', e)
  }
}

/** 删除指定时间之前的所有工具事件 */
export async function pruneToolEvents(beforeTimestamp) {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_TOOL_EVENTS, 'readwrite')
    const store = tx.objectStore(STORE_TOOL_EVENTS)
    const index = store.index('timestamp')
    const range = IDBKeyRange.upperBound(beforeTimestamp)
    const request = index.openCursor(range)
    request.onsuccess = (event) => {
      const cursor = event.target.result
      if (cursor) {
        cursor.delete()
        cursor.continue()
      }
    }
  } catch (e) {
    console.error('[db] pruneToolEvents error:', e)
  }
}

/** 把累积的 command_output 快照更新到对应的工具事件 */
export async function updateToolEventOutput(sessionKey, toolCallId, commandOutput) {
  if (!sessionKey || !toolCallId || !commandOutput) return
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_TOOL_EVENTS, 'readwrite')
    const store = tx.objectStore(STORE_TOOL_EVENTS)
    const index = store.index('toolCallId')
    const range = IDBKeyRange.bound(toolCallId, toolCallId)

    const updated = await new Promise((resolve, reject) => {
      let resolved = false
      const req = index.openCursor(range, 'prev')
      req.onsuccess = (e) => {
        const cursor = e.target.result
        if (!cursor) {
          if (!resolved) { resolved = true; resolve(false) }
          return
        }
        const val = cursor.value
        if (val.sessionKey === sessionKey && val.toolCallId === toolCallId && val.stream !== 'command_output') {
          val.commandOutput = commandOutput
          cursor.update(val)
          if (!resolved) { resolved = true; resolve(true) }
          return
        }
        cursor.continue()
      }
      req.onerror = () => reject(req.error)
    }).catch(() => false)

    // 找不到对应工具事件时，创建一条快照记录
    if (!updated) {
      store.put({
        sessionKey,
        runId: '',
        toolCallId,
        stream: 'command_output',
        phase: '',
        data: { output: commandOutput },
        timestamp: Date.now(),
        commandOutput
      })
    }
  } catch (e) {
    console.error('[db] updateToolEventOutput error:', e)
  }
}

/** 删除某个 toolCallId 的 command_output 碎片（快照后清理） */
export async function deleteCommandOutputChunks(sessionKey, toolCallId) {
  if (!sessionKey || !toolCallId) return
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_TOOL_EVENTS, 'readwrite')
    const store = tx.objectStore(STORE_TOOL_EVENTS)
    const index = store.index('toolCallId')
    const range = IDBKeyRange.bound(toolCallId, toolCallId)
    const request = index.openCursor(range)
    request.onsuccess = (event) => {
      const cursor = event.target.result
      if (cursor) {
        const val = cursor.value
        if (val.sessionKey === sessionKey && val.stream === 'command_output') {
          cursor.delete()
        }
        cursor.continue()
      }
    }
  } catch (e) {
    console.error('[db] deleteCommandOutputChunks error:', e)
  }
}

/** 获取会话消息（本地） */
export async function getLocalMessages(sessionKey, limit = 200) {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const index = store.index('sessionKey_timestamp')
      const range = IDBKeyRange.bound(
        [sessionKey, 0],
        [sessionKey, Date.now() + 1]
      )
      
      const messages = []
      const request = index.openCursor(range, 'prev')  // 倒序获取（最新的在前）
      
      request.onsuccess = (event) => {
        const cursor = event.target.result
        if (cursor && messages.length < limit) {
          messages.push(cursor.value)
          cursor.continue()
        }
      }
      
      tx.oncomplete = () => resolve(messages.reverse())  // 转为正序
      tx.onerror = () => resolve([])
    })
  } catch (e) {
    console.error('[db] getLocalMessages error:', e)
    return []
  }
}

/** 删除会话的所有消息 */
export async function clearSessionMessages(sessionKey) {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const index = store.index('sessionKey')
    const request = index.openCursor(sessionKey)
    
    request.onsuccess = (event) => {
      const cursor = event.target.result
      if (cursor) {
        cursor.delete()
        cursor.continue()
      }
    }
  } catch (e) {
    console.error('[db] clearSessionMessages error:', e)
  }
}

/** 保存会话信息 */
export async function saveSessionInfo(session) {
  if (!session || !session.sessionKey) return
  try {
    const db = await openDB()
    const tx = db.transaction(STORE_SESSIONS, 'readwrite')
    const store = tx.objectStore(STORE_SESSIONS)
    store.put({
      sessionKey: session.sessionKey,
      name: session.name || '',
      updatedAt: session.updatedAt || Date.now(),
      lastActivity: session.lastActivity || Date.now()
    })
  } catch (e) {
    console.error('[db] saveSessionInfo error:', e)
  }
}

/** 获取所有本地会话 */
export async function getLocalSessions() {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_SESSIONS, 'readonly')
      const store = tx.objectStore(STORE_SESSIONS)
      const request = store.getAll()
      
      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => resolve([])
    })
  } catch (e) {
    console.error('[db] getLocalSessions error:', e)
    return []
  }
}

/** 检查 IndexedDB 是否可用 */
export function isStorageAvailable() {
  try {
    return 'indexedDB' in window && !!indexedDB
  } catch (e) {
    return false
  }
}

/** 获取存储使用情况 */
export async function getStorageUsage() {
  if (navigator.storage && navigator.storage.estimate) {
    const estimate = await navigator.storage.estimate()
    return {
      usage: estimate.usage || 0,
      quota: estimate.quota || 0,
      usagePercent: estimate.quota ? (estimate.usage / estimate.quota * 100).toFixed(2) : 0
    }
  }
  return null
}
