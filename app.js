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
let settings, templates = [], template, assets = {}, stream, current, reviewTimer
let cameraGeneration = 0, cameraPending = false

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

function stopCamera() {
  cameraGeneration++
  cameraPending = false
  stream?.getTracks().forEach(t => t.stop())
  stream = null
  video.srcObject = null
}

async function startCamera() {
  stopCamera()
  if (booth.mobile && document.hidden) return
  const generation = cameraGeneration
  cameraPending = true
  const size = { width: { ideal: booth.mobile ? 1920 : 3840 }, height: { ideal: booth.mobile ? 1080 : 2160 } }
  if (booth.mobile) size.facingMode = { ideal: 'user' }
  video.classList.toggle('mirror', settings.mirror)
  try {
    const capture = constraints => navigator.mediaDevices.getUserMedia({ audio: false, video: constraints })
    let next
    if (settings.cameraId) {
      try { next = await capture({ ...size, deviceId: { exact: settings.cameraId } }) }
      catch (error) { if (!['OverconstrainedError', 'NotFoundError'].includes(error.name)) throw error }
    }
    next ??= await capture(size)
    if (generation !== cameraGeneration) { next.getTracks().forEach(t => t.stop()); return }
    stream = next
    video.srcObject = stream
    await video.play()
  } catch (error) {
    if (generation !== cameraGeneration) return
    stopCamera()
    toast(error.name === 'NotAllowedError'
      ? 'Camera access is off. Allow camera access in system settings, then tap to start.'
      : 'No camera available. Hold the top-right corner to open settings.')
  } finally {
    if (generation === cameraGeneration) cameraPending = false
  }
}

if (booth.mobile) document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera()
  else if (settings) startCamera()
})

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

async function applySettings() {
  $('#eventTitle').textContent = settings.eventName
  $('#startText').textContent = settings.startText
  await loadTemplates()
  await startCamera()
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

function compose(shots, t = template, { filter = settings.filter, images = assets[t.id] || {} } = {}) {
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
        const k = Layout.cover(s.width, s.height, e.w, e.h)
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
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92))
  if (!blob) throw new Error('Could not encode the photo.')
  return booth.savePhoto(name, await blob.arrayBuffer(), eventName)
}

// Every session is written to disk as soon as it is captured, so nothing is lost if the booth is closed mid-review.
async function saveSession({ shots, sheet, eventName }) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').replace('Z', '')
  for (const [i, s] of shots.entries()) await save(s, `${stamp}_${i + 1}.jpg`, eventName)
  return { stamp, file: await save(sheet, `${stamp}.jpg`, eventName) }
}

async function startSession() {
  if (screen() !== 'attract' || !settings || cameraPending) return
  if (booth.mobile && !stream?.active) await startCamera()
  if (!stream) { if (!booth.mobile) toast('No camera found.'); return }
  if (!template) return toast('No layout available.')
  if (!video.videoWidth || video.readyState < 2) return toast('Camera is starting, try again in a moment.')
  clearTimeout(reviewTimer)
  const generation = cameraGeneration
  show('capture')
  try {
    const shots = []
    for (let i = 1; i <= template.shots; i++) {
      $('#status').textContent = template.shots > 1 ? `Photo ${i} of ${template.shots}` : ''
      for (let n = settings.countdown; n > 0; n--) { $('#count').textContent = n; await sleep(1000) }
      $('#count').textContent = ''
      if (generation !== cameraGeneration || !stream.active || video.readyState < 2) throw new Error('Camera interrupted. Tap to start again.')
      shots.push(grab())
      $('#flash').classList.remove('on'); void $('#flash').offsetWidth; $('#flash').classList.add('on')
      if (i < template.shots) await sleep(settings.betweenShots * 1000)
    }
    current = { shots, sheet: compose(shots), template, eventName: settings.eventName, print2up: settings.print2up }
    current.saved = saveSession(current)
    current.saved.catch(e => toast(`Could not save photos: ${e.message}`))
    $('#result').src = current.sheet.toDataURL('image/jpeg', 0.9)
    $('#print').disabled = false
    show('review')
    reviewTimer = setTimeout(done, settings.reviewSeconds * 1000)
    if (settings.autoPrint) printCurrent()
  } catch (e) {
    show('attract')
    toast(`Something went wrong: ${e.message}`)
  }
}

async function printCurrent() {
  if ($('#print').disabled || !current) return
  const session = current
  clearTimeout(reviewTimer)
  $('#print').disabled = true // one print per session from the booth; reprint from the photos folder
  try {
    const { stamp, file } = await session.saved
    const t = session.template, strip = Math.max(t.width, t.height) / Math.min(t.width, t.height) >= 2.5
    let path = file, w = t.width, h = t.height
    if (strip && session.print2up) {
      const sheet = twoUp(session.sheet)
      session.printFile ??= await save(sheet, `${stamp}_print.jpg`, session.eventName)
      path = session.printFile
      w = sheet.width; h = sheet.height
    }
    if (session !== current || screen() !== 'review') return
    toast('Printing…')
    const err = await booth.print(path, w / t.dpi, h / t.dpi)
    if (err?.cancelled) {
      if (session === current) $('#print').disabled = false
      toast('Print cancelled.')
    } else if (err) throw new Error(err)
  } catch (e) {
    if (session === current) $('#print').disabled = false
    toast(`Print failed: ${e.message}`)
  } finally {
    if (session === current && screen() === 'review') reviewTimer = setTimeout(done, settings.reviewSeconds * 1000)
  }
}

function done() {
  clearTimeout(reviewTimer)
  if (screen() === 'review') { current = null; show('attract') }
}

// Settings
const fillTemplates = () => fill(form.templateId, templates.map(t => [t.id, `${t.name} (${t.shots} photo${t.shots > 1 ? 's' : ''})`]))
function updatePreview() {
  const t = templates.find(t => t.id === form.templateId.value)
  if (t) $('#preview').src = compose(placeholderShots(t.shots), t, { filter: form.filter.value }).toDataURL('image/jpeg', 0.85)
}

function requestSettings() {
  if (!settings || document.querySelector('dialog[open]') || ['capture', 'editor'].includes(screen())) return
  if (!settings.pin) return openSettings()
  $('#pinInput').value = ''
  $('#pinDialog').showModal()
}

async function openSettings() {
  const devices = await navigator.mediaDevices?.enumerateDevices().catch(() => [])
  const cams = (devices || []).filter(d => d.kind === 'videoinput')
  fill(form.cameraId, [['', 'Default camera'], ...cams.map((d, i) => [d.deviceId, d.label || `Camera ${i + 1}`])])
  fillTemplates()
  fill(form.filter, Object.entries(FILTERS).map(([k, [label]]) => [k, label]))
  fill(form.printer, [['', 'Ask each time (print dialog)'], ...(await booth.listPrinters()).map(p => [p.name, p.displayName || p.name])])
  for (const el of form.elements) if (el.name in settings) el[el.type === 'checkbox' ? 'checked' : 'value'] = settings[el.name]
  updatePreview()
  $('#settings').showModal()
}

async function saveForm() {
  const next = { ...settings }
  for (const el of form.elements) {
    if (el.name in settings) next[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value
  }
  settings = await booth.saveSettings(next)
  await applySettings()
}

form.addEventListener('submit', e => { if (e.submitter?.value === 'save') saveForm().catch(error => toast(`Could not apply settings: ${error.message}`)) })
form.templateId.onchange = form.filter.onchange = updatePreview
$('#pinForm').addEventListener('submit', () => {
  if ($('#pinInput').value === settings.pin) openSettings()
  else toast('Wrong PIN')
})
$('#pinCancel').onclick = () => $('#pinDialog').close()
$('#cancelSettings').onclick = () => $('#settings').close()
$('#choose').onclick = async () => { form.outputDir.value = (await booth.chooseFolder()) || form.outputDir.value }
$('#import').onclick = async () => {
  try {
    const id = await booth.importTemplate()
    if (!id) return
    await loadTemplates()
    fillTemplates()
    if (templates.some(t => t.id === id)) { form.templateId.value = id; updatePreview() }
    else toast('That template.xml could not be read.')
  } catch (e) {
    toast(`Import failed: ${e.message}`)
  }
}
$('#openEditor').onclick = () => { $('#settings').close(); Editor.open(form.templateId.value) }
$('#openFolder').onclick = () => booth.openFolder()
$('#quit').onclick = () => booth.quit()

// Booth controls
$('#attract').onclick = startSession
$('#retake').onclick = () => { clearTimeout(reviewTimer); show('attract'); startSession() }
$('#print').onclick = printCurrent
$('#done').onclick = done

let pressTimer
$('#corner').addEventListener('pointerdown', () => { pressTimer = setTimeout(requestSettings, 1500) })
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) $('#corner').addEventListener(ev, () => clearTimeout(pressTimer))
addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === ',') return requestSettings()
  if (document.querySelector('dialog[open]') || (e.key !== ' ' && e.key !== 'Enter')) return
  if (screen() === 'attract') { e.preventDefault(); startSession() }
  else if (screen() === 'review') { e.preventDefault(); done() }
})

booth.getSettings().then(s => { settings = s; return applySettings() }).catch(error => toast(`Could not start booth: ${error.message}`))
