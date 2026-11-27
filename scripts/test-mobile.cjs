// Run the tablet renderer offline with real Chromium storage and its native services substituted.
const { app, BrowserWindow, net, protocol } = require('electron')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const profile = mkdtempSync(path.join(os.tmpdir(), 'booth-mobile-test-'))
app.setPath('userData', profile)
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
protocol.registerSchemesAsPrivileged([{ scheme: 'booth-test', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

// This function and the two test phases below execute in the isolated application window.
function installTestBridge() {
  window.printCancelled = false
  window.savedNames = []
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: { BoothMedia: {
      async savePhoto(args) {
        window.lastSave = args
        window.savedNames.push(args.name)
        return { file: 'content://media/' + args.name }
      },
      async printPhoto(args) { window.lastPrint = args; return { cancelled: window.printCancelled } },
    } },
  }
  window.check = (condition, message) => { if (!condition) throw new Error(message) }
  window.until = async (condition, message) => {
    const end = Date.now() + 5000
    while (!(await condition())) {
      if (Date.now() >= end) throw new Error(message)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  // Deliver selected Files through the same input and change/cancel events as the platform picker.
  window.selectFiles = files => {
    const originalClick = HTMLInputElement.prototype.click
    HTMLInputElement.prototype.click = function () {
      HTMLInputElement.prototype.click = originalClick
      if (files == null) return // older picker dismissed without an event
      const selection = new DataTransfer()
      for (const file of files) selection.items.add(file)
      this.files = selection.files
      queueMicrotask(() => this.dispatchEvent(new Event(files.length ? 'change' : 'cancel')))
    }
  }
}

async function createLayouts() {
  await until(() => typeof template === 'object' && template?.id, 'Renderer did not load a layout')
  const builtins = (await booth.listTemplates()).map(t => t.id)
  for (const name of ['classic-strip', 'grid', 'postcard', 'single']) check(builtins.includes('builtin:' + name), 'Missing layout ' + name)
  const png = await new Promise(resolve => document.createElement('canvas').toBlob(resolve, 'image/png'))
  const image = new File([png], 'frame one.png', { type: 'image/png' })

  Editor.open('builtin:single')
  selectFiles([image])
  document.querySelector('[data-add="Image"]').click()
  await until(() => document.querySelector('#edProps [data-key="src"]')?.textContent === image.name, 'Editor did not pick an image')
  document.querySelector('#edSaveCopy').click()
  await until(() => document.querySelector('#edList').value.startsWith('user:'), 'Editor did not save its copy')
  const copy = document.querySelector('#edList').value
  const xml = (await booth.listTemplates()).find(t => t.id === copy).xml
  check(xml.includes(image.name), 'Saved layout lost its image reference')
  selectFiles([])
  check(await booth.importTemplate() == null, 'Cancelled import must leave templates unchanged')
  selectFiles(null)
  const pending = booth.importTemplate()
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  check(await pending == null && !document.querySelector('input[type=file]'), 'Silent dismissal left a picker open')
  selectFiles([new File([xml], 'template.xml', { type: 'text/xml' }), image])
  const imported = await booth.importTemplate()
  check(imported && imported !== copy, 'Import did not create a separate layout')
  await booth.saveSettings({ ...await booth.getSettings(), eventName: 'Tablet test', templateId: imported, countdown: 1 })
  return { copy, imported }
}

async function checkAfterReload({ copy, imported }) {
  await until(() => typeof template === 'object' && template?.id === imported, 'Selected layout did not survive reload')
  check((await booth.getSettings()).eventName === 'Tablet test', 'Event name did not survive reload')
  for (const id of [copy, imported]) {
    const url = await booth.templateAsset(id, 'frame one.png')
    check(url && (await loadImage(url)).naturalWidth > 0, 'Persisted image is unreadable for ' + id)
  }
  await booth.deleteTemplate(copy)
  check(!(await booth.listTemplates()).some(t => t.id === copy), 'Deleted layout was returned')
  check(await booth.templateAsset(imported, 'frame one.png'), 'Deleting one layout removed another layout’s image')
  const bytes = Uint8Array.of(255, 216, 255, 217)
  const file = await booth.savePhoto('session.jpg', bytes.buffer)
  check(file === 'content://media/session.jpg', 'Photo reference changed')
  check(lastSave.eventName === 'Tablet test' && lastSave.name === 'session.jpg' && lastSave.data === '/9j/2Q==', 'Wrong native save arguments')
  check(await booth.print(file, 4, 6) === null, 'Successful print reported an error')
  check(lastPrint.file === file && lastPrint.widthIn === 4 && lastPrint.heightIn === 6, 'Wrong native print arguments')
  window.printCancelled = true
  check((await booth.print(file, 4, 6))?.cancelled, 'Cancelled print reported success')

  const source = canvas(1, 1), color = source.getContext('2d')
  color.fillStyle = 'red'
  color.fillRect(0, 0, 1, 1)
  const gray = filterSlot(source, Layout.cover(1, 1, 1, 1), 1, 1, 'bw')
  const [r, g, b] = gray.getContext('2d').getImageData(0, 0, 1, 1).data
  check(r === g && g === b && Math.abs(r - 43) <= 1, 'Canvas filter fallback did not export grayscale')

  await until(() => !cameraPending && video.readyState >= 2, 'Simulated camera preview did not start')
  await startSession()
  check(screen() === 'review', 'Capture did not reach the photo review')
  const saved = await current.saved
  check(savedNames.includes(saved.stamp + '_1.jpg') && savedNames.includes(saved.stamp + '.jpg'), 'Session lost its original or layout')
  check(lastSave.data.startsWith('/9j/') && lastSave.name.endsWith('.jpg'), 'Session did not save a JPEG')
  await printCurrent()
  check(!document.querySelector('#print').disabled, 'Print button unavailable after cancellation')
  window.printCancelled = false
  await printCurrent()
  check(document.querySelector('#print').disabled && lastPrint.file === saved.file, 'Could not retry the saved layout print')
}

async function run() {
  await app.whenReady()
  const www = path.join(__dirname, '../www')
  protocol.handle('booth-test', request => {
    const name = decodeURIComponent(new URL(request.url).pathname)
    return net.fetch(pathToFileURL(path.join(www, name)).href)
  })
  const preload = path.join(profile, 'test-bridge.cjs')
  writeFileSync(preload, `require('electron').contextBridge.executeInMainWorld({ func: ${installTestBridge} })`)
  const win = new BrowserWindow({ show: false, webPreferences: { preload, backgroundThrottling: false } })
  const web = win.webContents
  const url = 'booth-test://localhost/index.html'
  await win.loadURL(url)
  console.log('Opened tablet renderer.')
  const ids = await web.executeJavaScript(`(${createLayouts})()`)
  console.log('Saved and imported layouts. Reloading the tablet renderer.')
  await win.loadURL(url)
  await web.executeJavaScript(`(${checkAfterReload})(${JSON.stringify(ids)})`)
  console.log('Tablet settings, layouts, import, reload, capture, filter, photo save and print retry passed.')
}

setTimeout(() => { console.error('Tablet renderer test timed out'); app.exit(1) }, 30000).unref()
run().then(() => app.exit(0), err => { console.error(err); app.exit(1) })
app.on('quit', () => rmSync(profile, { recursive: true, force: true, maxRetries: 3 }))
