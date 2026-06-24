/**
 * 会话选择器 - 会话列表/新建/删除/切换 UI
 */

import { wsClient } from './api-client.js'
import { t, formatRelativeTime } from './i18n.js'

let _sessionKey = ''
let _onSwitch = null
let _onSystemMsg = null
let _onClearSessionMessages = null

function escapeText(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

/**
 * 初始化会话选择器
 * @param {object} opts
 * @param {() => string} opts.getSessionKey - 获取当前 sessionKey
 * @param {(key: string) => void} opts.onSwitch - 切换会话回调
 * @param {(text: string) => void} opts.onSystemMsg - 系统消息回调
 */
export function initSessionPicker(opts) {
  _onSwitch = opts.onSwitch
  _onSystemMsg = opts.onSystemMsg
}

export function setPickerSessionKey(key) {
  _sessionKey = key
}

/** 会话选择面板 */
export async function showSessionPicker() {
  document.querySelector('.session-overlay')?.remove()
  document.querySelector('.session-panel')?.remove()

  const overlay = document.createElement('div')
  overlay.className = 'session-overlay cmd-overlay visible'
  overlay.onclick = () => closeSessionPicker()

  const panel = document.createElement('div')
  panel.className = 'session-panel cmd-panel visible'
  panel.innerHTML = `
    <div class="cmd-panel-header">
      <h3>${t('session.title')}</h3>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="session-action-btn" id="session-new-btn" title="${t('session.new')}">＋</button>
        <button class="close-btn">×</button>
      </div>
    </div>
    <div class="session-list cmd-list">
      <div class="session-loading">${t('session.loading')}</div>
    </div>
  `
  panel.querySelector('.close-btn').onclick = () => closeSessionPicker()
  panel.querySelector('#session-new-btn').onclick = () => promptNewSession()

  document.body.appendChild(overlay)
  document.body.appendChild(panel)

  await refreshSessionList()
}

/** 刷新会话列表 */
export async function refreshSessionList() {
  const listEl = document.querySelector('.session-list')
  if (!listEl) return
  listEl.innerHTML = '<div class="session-loading">' + t('session.loading') + '</div>'

  try {
    const result = await wsClient.sessionsList(50)
    const sessions = (result?.sessions || result || [])
      .filter(s => {
        const key = s.sessionKey || s.key || ''
        return key.startsWith('agent:role-gong:')
      })
    listEl.innerHTML = ''

    if (!sessions.length) {
      listEl.innerHTML = '<div class="session-loading">' + t('session.empty') + '</div>'
      return
    }

    sessions.forEach(s => {
      const key = s.sessionKey || s.key || ''
      const isActive = key === _sessionKey
      const item = document.createElement('div')
      item.className = `cmd-item${isActive ? ' session-active' : ''}`

      // 解析会话信息
      const parts = key.split(':')
      let name = key
      let detail = ''
      if (parts.length >= 3) {
        const agent = parts[1]
        const channel = parts.slice(2).join(':')
        // role-gong agent：标题栏显示时间戳，列表中显示会话名
        name = channel === 'main' ? `${t('session.main')}` : channel
        detail = agent !== 'main' ? `agent: ${agent}` : ''
      }

      // 最后活跃时间
      const updated = s.updatedAt || s.lastActivity
      const timeStr = formatRelativeTime(updated)

      item.innerHTML = `
        <div class="session-item-content" style="flex:1;min-width:0">
          <div class="cmd-text" style="font-family:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeText(name)}</div>
          ${detail ? `<div class="cmd-desc">${escapeText(detail)}</div>` : ''}
        </div>
        ${timeStr ? `<div class="cmd-desc" style="flex-shrink:0">${timeStr}</div>` : ''}
        ${isActive ? '<div style="color:var(--success);flex-shrink:0">●</div>' : ''}
        <button class="session-delete-btn" title="${t('session.delete')}">✕</button>
      `

      // 点击切换会话
      item.querySelector('.session-item-content').onclick = () => {
        if (key === _sessionKey) { closeSessionPicker(); return }
        _onSwitch?.(key)
        closeSessionPicker()
      }

      // 删除按钮
      item.querySelector('.session-delete-btn').onclick = (e) => {
        e.stopPropagation()
        confirmDeleteSession(key, name)
      }

      listEl.appendChild(item)
    })
  } catch (e) {
    listEl.innerHTML = `<div class="session-loading" style="color:var(--danger)">${t('session.load.error')}: ${escapeText(e.message)}</div>`
  }
}

function autoName() {
  const now = new Date()
  const mm = (now.getMonth() + 1).toString().padStart(2, '0')
  const dd = now.getDate().toString().padStart(2, '0')
  const h = now.getHours().toString().padStart(2, '0')
  const m = now.getMinutes().toString().padStart(2, '0')
  return `${mm}-${dd} ${h}:${m}`
}

/** 新建会话弹窗 */
function promptNewSession() {
  closeSessionPicker()
  const defaultAgent = wsClient.snapshot?.sessionDefaults?.defaultAgentId || 'main'

  const overlay = document.createElement('div')
  overlay.className = 'session-overlay cmd-overlay visible'

  const dialog = document.createElement('div')
  dialog.className = 'session-dialog'
  dialog.innerHTML = `
    <h3>${t('session.new')}</h3>
    <div class="form-group" style="margin:16px 0">
      <label style="font-size:13px;color:var(--text-secondary);margin-bottom:6px;display:block">${t('session.new.name')}</label>
      <input type="text" id="new-session-name" placeholder="${autoName()}"
        style="width:100%;height:40px;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:0 12px;color:var(--text-primary);font-size:14px;outline:none" />
    </div>
    <div style="margin:0 0 16px">
      <div id="agent-toggle" style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none">
        <span style="font-size:13px;color:var(--text-muted)">${t('session.new.agent')}</span>
        <span id="agent-arrow" style="font-size:11px;color:var(--text-muted)">▶</span>
      </div>
      <div id="agent-field" style="display:none;margin-top:8px">
        <input type="text" id="new-session-agent" value="${defaultAgent}" placeholder="main"
          style="width:100%;height:40px;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:0 12px;color:var(--text-primary);font-size:14px;outline:none" />
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('session.new.agent.hint')}</div>
      </div>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="session-dialog-btn cancel">${t('cancel')}</button>
      <button class="session-dialog-btn confirm">${t('session.new.create')}</button>
    </div>
  `

  dialog.querySelector('#agent-toggle').style.display = 'none'
  dialog.querySelector('#agent-field').style.display = 'none'
  dialog.querySelector('#new-session-agent').value = 'role-gong'
  overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); dialog.remove() } }
  dialog.querySelector('.cancel').onclick = () => { overlay.remove(); dialog.remove() }
  dialog.querySelector('.confirm').onclick = () => {
    let name = dialog.querySelector('#new-session-name').value.trim()
    if (!name) name = autoName()
    const agent = dialog.querySelector('#new-session-agent')?.value.trim() || defaultAgent
    const newKey = `agent:${agent}:${name}`
    overlay.remove()
    dialog.remove()
    _onSwitch?.(newKey)
    _onSystemMsg?.(t('session.created', { name }))
  }

  document.body.appendChild(overlay)
  document.body.appendChild(dialog)
  dialog.querySelector('#new-session-name').focus()
  dialog.querySelector('#new-session-name').onkeydown = (e) => {
    if (e.key === 'Enter') dialog.querySelector('.confirm').click()
  }
}

/** 确认删除会话 */
function confirmDeleteSession(key, name) {
  const overlay = document.createElement('div')
  overlay.className = 'session-overlay cmd-overlay visible'

  const dialog = document.createElement('div')
  dialog.className = 'session-dialog'
  dialog.innerHTML = `
    <h3>${t('session.delete')}</h3>
    <p style="color:var(--text-secondary);font-size:14px;margin:12px 0">
      ${t('session.delete.confirm', { name: escapeText(name) })}<br>${t('session.delete.warning')}
    </p>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="session-dialog-btn cancel">${t('cancel')}</button>
      <button class="session-dialog-btn danger">${t('session.delete.btn')}</button>
    </div>
  `

  overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); dialog.remove() } }
  dialog.querySelector('.cancel').onclick = () => { overlay.remove(); dialog.remove() }
  dialog.querySelector('.danger').onclick = async () => {
    overlay.remove()
    dialog.remove()
    try {
      await wsClient.sessionsDelete(key)
      // 如果删的是当前会话，切回主会话
      if (key === _sessionKey) {
        const mainKey = wsClient.snapshot?.sessionDefaults?.mainSessionKey || 'agent:main:main'
        _onSwitch?.(mainKey)
      }
      await refreshSessionList()
    } catch (e) {
      _onSystemMsg?.(`${t('session.delete.fail')}: ${e.message}`)
    }
  }

  document.body.appendChild(overlay)
  document.body.appendChild(dialog)
}

export function closeSessionPicker() {
  document.querySelector('.session-overlay')?.remove()
  document.querySelector('.session-panel')?.remove()
}
