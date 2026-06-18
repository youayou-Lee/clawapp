import markdownit from 'markdown-it'
import markdownItTaskLists from 'markdown-it-task-lists'
import DOMPurify from 'dompurify'

const KEYWORDS = new Set([
  'const','let','var','function','return','if','else','for','while','do',
  'switch','case','break','continue','new','this','class','extends','import',
  'export','from','default','try','catch','finally','throw','async','await',
  'yield','of','in','typeof','instanceof','void','delete','true','false',
  'null','undefined','static','get','set','super','with','debugger',
  'def','print','self','elif','lambda','pass','raise','except','None','True','False',
  'fn','pub','mut','impl','struct','enum','match','use','mod','crate','trait',
  'int','string','bool','float','double','char','byte','long','short','unsigned',
  'package','main','fmt','go','chan','defer','select','type','interface','map','range',
])

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

function highlightCode(code, lang) {
  let escaped = escapeHtml(code)

  // 第一遍：注释、字符串、数字（会生成 span）
  escaped = escaped
    .replace(/(\/\/.*$|#.*$)/gm, '<span class="hl-comment">$1</span>')
    .replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="hl-comment">$1</span>')
    .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;|&#x27;(?:[^&]|&(?!#x27;))*?&#x27;|`[^`]*`)/g, '<span class="hl-string">$1</span>')
    .replace(/\b(\d+\.?\d*)\b/g, '<span class="hl-number">$1</span>')

  // 第二遍：把已生成的 HTML 标签和文本拆开，避免 keyword/type/func 正则匹配到 class="..." 等属性
  return escaped.split(/(<[^\u003e]+>)/).map(part => {
    if (part.startsWith('<') && part.endsWith('>')) return part
    // 先处理 keyword，再处理 func/type，避免后生成的 <span class="..."> 中的 class 被 keyword 命中
    return part
      .replace(/\b(\w+)\b/g, (m, w) =>
        KEYWORDS.has(w) ? `<span class="hl-keyword">${w}</span>` : m)
      .replace(/\b(\w+)(?=\s*\()/g, (m, w) =>
        KEYWORDS.has(w) ? m : `<span class="hl-func">${w}</span>`)
      .replace(/\b([A-Z][a-zA-Z0-9_]*)\b/g, (m, w) =>
        KEYWORDS.has(w) ? m : `<span class="hl-type">${w}</span>`)
  }).join('')
}

const md = markdownit({
  html: true,
  breaks: true,
  linkify: true,
  highlight(code, lang) {
    const highlighted = lang ? highlightCode(code, lang) : escapeHtml(code)
    const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : ''
    return `<pre data-lang="${escapeHtml(lang)}">${langLabel}<button class="code-copy-btn" type="button">Copy</button><code class="${lang ? `language-${escapeHtml(lang)}` : ''}">${highlighted}</code></pre>`
  }
})

md.enable('strikethrough')
md.linkify.set({ fuzzyLink: false })
md.validateLink = () => true
md.use(markdownItTaskLists, { enabled: false, label: false })

const ALLOWED_TAGS = [
  'a','b','blockquote','br','button','code','del','details','div','em','h1','h2','h3','h4','h5','h6',
  'hr','i','img','input','li','ol','p','pre','s','span','strong','summary','sup','table','tbody','td',
  'th','thead','tr','ul','video'
]

const ALLOWED_ATTR = [
  'alt','aria-label','checked','class','controls','data-lang','data-src','disabled','href','playsinline',
  'preload','rel','src','start','target','title','type'
]

const MEDIA_RE = /MEDIA:(\/[^\n<"]+)/g

// 移除表格行之间的空行，让 markdown-it 能正确解析模型常输出的“带空行表格”
function normalizeTables(text) {
  const lines = text.split('\n')
  const result = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' && i > 0 && i < lines.length - 1) {
      const prevHasPipe = lines[i - 1].includes('|')
      let nextHasPipe = false
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '') continue
        nextHasPipe = lines[j].includes('|')
        break
      }
      if (prevHasPipe && nextHasPipe) continue
    }
    result.push(line)
  }
  return result.join('\n')
}

function renderMediaWidget(path) {
  const src = `/media?path=${encodeURIComponent(path)}`
  const fileName = escapeHtml(path.split('/').pop().split('?')[0] || '文件')
  const ext = fileName.split('.').pop().toLowerCase()

  if (/\.(mp3|wav|ogg|m4a|aac|flac|opus|wma)$/i.test(path)) {
    return `<div class="voice-bubble" data-src="${src}"><span class="voice-icon">&#9654;</span><span class="voice-bar"></span><span class="voice-dur">0″</span></div>`
  }
  if (/\.(mp4|mov|webm|mkv|avi|flv)$/i.test(path)) {
    return `<div class="msg-video-wrap"><video controls preload="metadata" playsinline src="${src}" class="msg-video"></video></div>`
  }
  if (/\.(jpe?g|png|gif|webp|heic|svg)$/i.test(path)) {
    return `<img src="${src}" alt="${fileName}" class="msg-img" />`
  }

  const iconMap = { pdf: '📄', doc: '📝', docx: '📝', txt: '📃', md: '📃', json: '📋', csv: '📊', zip: '📦', rar: '📦' }
  const icon = iconMap[ext] || '📎'
  const dlSrc = `${src}&download=1`
  return `<div class="msg-file-card" onclick="window.open('${dlSrc}','_blank')"><span class="msg-file-icon">${icon}</span><div class="msg-file-info"><span class="msg-file-name">${fileName}</span></div></div>`
}

function postprocessMedia(html) {
  return html.replace(MEDIA_RE, (match, rawPath) => renderMediaWidget(rawPath.trim()))
}

function postprocessClasses(html) {
  html = html.replace(/<table>/g, '<table class="md-table">')
  html = html.replace(/<img /g, '<img class="msg-img" ')
  return html
}

export function renderMarkdown(text) {
  if (!text) return ''

  let html = md.render(normalizeTables(text))
  html = postprocessClasses(html)
  html = postprocessMedia(html)

  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ADD_DATA_URI_TAGS: ['img'],
    ALLOW_DATA_ATTR: false
  })
}

export function copyCode(btn) {
  const pre = btn.closest('pre')
  const code = pre?.querySelector('code')
  if (!code) return
  navigator.clipboard.writeText(code.innerText).then(() => {
    btn.textContent = '✓'
    setTimeout(() => { btn.textContent = 'Copy' }, 1500)
  }).catch(() => {
    btn.textContent = '✗'
    setTimeout(() => { btn.textContent = 'Copy' }, 1500)
  })
}
