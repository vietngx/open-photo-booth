/* global booth, Layout */
let reviewTimer
let cameraGeneration = 0, cameraPending = false

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

async function applySettings() {
  $('#eventTitle').textContent = settings.eventName
  $('#startText').textContent = settings.startText
  await loadTemplates()
  await startCamera()
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
    current = { shots, sheet: compose(shots, template, { qr: null }), template, eventName: settings.eventName, print2up: settings.print2up }
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
