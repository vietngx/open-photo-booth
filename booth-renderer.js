/* global booth, Layout */
const $ = s => document.querySelector(s)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const FILTERS = {
  none: ['None', 'none'],
  bw: ['Black & white', 'grayscale(1) contrast(1.15)'],
  sepia: ['Sepia', 'sepia(.85)'],
  warm: ['Warm', 'sepia(.3) saturate(1.4)'],
  vivid: ['Vivid', 'saturate(1.6) contrast(1.1)'],
  fade: ['Faded', 'contrast(.85) brightness(1.1) saturate(.7)'],
}
const video = $('#video'), form = $('#settingsForm')
let settings, templates = [], template, assets = {}, stream, current

const show = screen => { document.body.dataset.screen = screen }
const screen = () => document.body.dataset.screen
const fill = (select, options) => select.replaceChildren(...options.map(([value, text]) => new Option(text, value)))
const loadImage = src => new Promise((res, rej) => Object.assign(new Image(), { onload() { res(this) }, onerror: rej, src }))
function canvas(w, h) { return Object.assign(document.createElement('canvas'), { width: w, height: h }) }
function toast(msg) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('on')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => t.classList.remove('on'), 4000)
}

// Parses every template and preloads their images into assets[templateId][src].
async function loadTemplates() {
  templates = (await booth.listTemplates()).flatMap(t => {
    try { return [{ id: t.id, builtin: t.id.startsWith('builtin:'), ...Layout.parse(t.xml) }] } catch { return [] }
  })
  template = templates.find(t => t.id === settings.templateId) || templates[0]
  assets = {}
  await Promise.all(templates.flatMap(t => t.elements.filter(e => e.type === 'Image' && e.src).map(async e => {
    const url = await booth.templateAsset(t.id, e.src)
    const img = url && await loadImage(url).catch(() => null)
    if (img) (assets[t.id] ??= {})[e.src] = img
  })))
}

function grab() {
  const c = canvas(video.videoWidth, video.videoHeight), ctx = c.getContext('2d')
  if (settings.mirror) ctx.setTransform(-1, 0, 0, 1, c.width, 0)
  ctx.drawImage(video, 0, 0)
  return c
}

// Colorful numbered stand-ins for photos, used by layout previews and the editor.
const placeholders = []
function placeholder(i) {
  if (placeholders[i]) return placeholders[i]
  const c = canvas(1500, 1000), ctx = c.getContext('2d'), g = ctx.createLinearGradient(0, 0, 1500, 1000)
  g.addColorStop(0, `hsl(${200 + i * 67} 65% 60%)`)
  g.addColorStop(1, `hsl(${250 + i * 67} 55% 35%)`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 1500, 1000)
  Object.assign(ctx, { fillStyle: 'rgba(255,255,255,.85)', font: 'bold 420px system-ui, sans-serif', textAlign: 'center', textBaseline: 'middle' })
  ctx.fillText(i + 1, 750, 530)
  return (placeholders[i] = c)
}
const placeholderShots = n => Array.from({ length: n }, (_, i) => placeholder(i))

// Older tablet web views support CSS filters on screen, but omit them when exporting a canvas.
// Filter just the cropped slot so the original camera photo keeps its full colour and resolution.
function filterSlot(source, crop, w, h, filter) {
  const slot = canvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)))
  const ctx = slot.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, slot.width, slot.height)
  const image = ctx.getImageData(0, 0, slot.width, slot.height), pixels = image.data
  const sepia = filter === 'sepia' ? 0.85 : filter === 'warm' ? 0.3 : 0
  const saturation = { bw: 0, warm: 1.4, vivid: 1.6, fade: 0.7 }[filter] ?? 1
  const contrast = { bw: 1.15, vivid: 1.1, fade: 0.85 }[filter] ?? 1
  const brightness = filter === 'fade' ? 1.1 : 1
  for (let i = 0; i < pixels.length; i += 4) {
    let r = pixels[i], g = pixels[i + 1], b = pixels[i + 2]
    if (sepia) {
      const sr = 0.393 * r + 0.769 * g + 0.189 * b
      const sg = 0.349 * r + 0.686 * g + 0.168 * b
      const sb = 0.272 * r + 0.534 * g + 0.131 * b
      r = Math.min(255, r + sepia * (sr - r))
      g = Math.min(255, g + sepia * (sg - g))
      b = Math.min(255, b + sepia * (sb - b))
    }
    const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b
    pixels[i] = ((gray + saturation * (r - gray) - 127.5) * contrast + 127.5) * brightness
    pixels[i + 1] = ((gray + saturation * (g - gray) - 127.5) * contrast + 127.5) * brightness
    pixels[i + 2] = ((gray + saturation * (b - gray) - 127.5) * contrast + 127.5) * brightness
  }
  ctx.putImageData(image, 0, 0)
  return slot
}

// qr: a QR code canvas for the layout's QRCode elements (nothing fills them in this app); null draws nothing
// there (sharing is off); left out, a placeholder shows where it goes (previews and the layout editor).
function compose(shots, t = template, { filter = settings.filter, images = assets[t.id] || {}, qr } = {}) {
  const c = canvas(t.width, t.height), ctx = c.getContext('2d')
  const vars = { event: settings.eventName, date: new Date().toLocaleDateString() }
  ctx.fillStyle = Layout.css(t.background)
  ctx.fillRect(0, 0, c.width, c.height)
  for (const e of t.elements) {
    ctx.save()
    ctx.globalAlpha = e.opacity / 100
    ctx.translate(e.x + e.w / 2, e.y + e.h / 2)
    ctx.rotate(e.rotation * Math.PI / 180)
    ctx.translate(-e.w / 2, -e.h / 2)
    if (e.shadow) {
      const a = e.shadowAngle * Math.PI / 180
      Object.assign(ctx, { shadowColor: Layout.css(e.shadowColor), shadowBlur: e.shadowBlur, shadowOffsetX: e.shadowDepth * Math.cos(a), shadowOffsetY: -e.shadowDepth * Math.sin(a) })
    }
    if (e.type === 'Photo') {
      // ponytail: photo slots always cover-crop; KeepAspect only changes how Image elements are fitted
      const s = shots[e.photo - 1]
      if (s) {
        const k = Layout.cover(s.width, s.height, e.w, e.h, s.focus?.x, s.focus?.y) // focus: where the faces are, if known
        if (FILTERS[filter] && filter !== 'none' && !('filter' in ctx)) {
          const slot = filterSlot(s, k, e.w, e.h, filter)
          ctx.drawImage(slot, 0, 0, e.w, e.h)
          slot.width = slot.height = 0
        } else {
          if ('filter' in ctx) ctx.filter = FILTERS[filter]?.[1] || 'none'
          ctx.drawImage(s, k.sx, k.sy, k.sw, k.sh, 0, 0, e.w, e.h)
          if ('filter' in ctx) ctx.filter = 'none'
        }
      }
    } else if (e.type === 'Image') {
      const img = images[e.src]
      if (img && e.keepAspect) { const k = Layout.contain(img.width, img.height, e.w, e.h); ctx.drawImage(img, k.dx, k.dy, k.dw, k.dh) }
      else if (img) ctx.drawImage(img, 0, 0, e.w, e.h)
    } else if (e.type === 'QRCode') {
      if (qr !== null) {
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, e.w, e.h)
      }
      if (qr) {
        const pad = Math.min(e.w, e.h) * 0.06, k = Layout.contain(qr.width, qr.height, e.w - 2 * pad, e.h - 2 * pad)
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(qr, pad + k.dx, pad + k.dy, k.dw, k.dh)
        ctx.imageSmoothingEnabled = true
      } else if (qr === undefined) {
        Object.assign(ctx, { fillStyle: '#999', font: `bold ${Math.min(e.w, e.h) * 0.3}px system-ui, sans-serif`, textAlign: 'center', textBaseline: 'middle' })
        ctx.fillText('QR', e.w / 2, e.h / 2)
      }
    } else if (e.type === 'Text') {
      const align = ['left', 'right'].includes(e.align) ? e.align : 'center'
      const lines = Layout.fillText(e.text, vars).split('\n'), font = size => `${size}px "${e.font}", sans-serif`
      // Text shrinks to fit its box, so long event names never spill over the photos.
      ctx.font = font(e.size)
      const widest = Math.max(...lines.map(l => ctx.measureText(l).width))
      const size = e.size * Math.min(1, e.w / widest, e.h / (lines.length * e.size * 1.2))
      Object.assign(ctx, { font: font(size), fillStyle: Layout.css(e.textColor), textAlign: align, textBaseline: 'middle' })
      const x = { left: 0, right: e.w, center: e.w / 2 }[align]
      lines.forEach((l, i) => ctx.fillText(l, x, e.h / 2 + (i - (lines.length - 1) / 2) * size * 1.2))
    } else {
      ctx.beginPath()
      if (e.type === 'Ellipse') ctx.ellipse(e.w / 2, e.h / 2, e.w / 2, e.h / 2, 0, 0, Math.PI * 2)
      else ctx.rect(0, 0, e.w, e.h)
      ctx.fillStyle = Layout.css(e.fill)
      ctx.fill()
    }
    if (e.strokeWidth > 0) {
      Object.assign(ctx, { shadowColor: 'transparent', lineWidth: e.strokeWidth, strokeStyle: Layout.css(e.strokeColor) })
      if (e.type === 'Ellipse') ctx.stroke()
      else ctx.strokeRect(e.strokeWidth / 2, e.strokeWidth / 2, e.w - e.strokeWidth, e.h - e.strokeWidth)
    }
    ctx.restore()
  }
  return c
}

// A 2x6 strip printed twice side by side fills a 4x6 sheet (cut in half after printing).
function twoUp(c) {
  const wide = c.width > c.height, out = canvas(wide ? c.width : c.width * 2, wide ? c.height * 2 : c.height)
  const ctx = out.getContext('2d')
  ctx.drawImage(c, 0, 0)
  ctx.drawImage(c, wide ? 0 : c.width, wide ? c.height : 0)
  return out
}

async function save(c, name, eventName) {
  if (c.original) return booth.savePhoto(name, c.original, eventName) // a controlled camera's photo, as the camera took it
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92))
  if (!blob) throw new Error('Could not encode the photo.')
  return booth.savePhoto(name, await blob.arrayBuffer(), eventName)
}

const fillTemplates = () => fill(form.templateId, templates.map(t => [t.id, `${t.name} (${t.shots} photo${t.shots > 1 ? 's' : ''})`]))
function updatePreview() {
  const t = templates.find(t => t.id === form.templateId.value)
  if (t) $('#preview').src = compose(placeholderShots(t.shots), t, { filter: form.filter.value }).toDataURL('image/jpeg', 0.85)
}
