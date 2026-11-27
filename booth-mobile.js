/* global boothDefaults, Layout */
// Electron supplies window.booth in preload.js. Capacitor injects the native plugins in the tablet web view.
;(() => {
  const cap = window.Capacitor
  if (window.booth || !cap?.isNativePlatform()) return

  document.documentElement.dataset.platform = cap.getPlatform()
  const outputDir = cap.getPlatform() === 'ios' ? 'Files · On My iPad / Open Photo Booth' : 'Pictures / Open Photo Booth'
  let database, bundled

  // One transaction stores a layout together with all of its images, including imported artwork.
  async function access(storeName, mode, operation) {
    database ??= new Promise((resolve, reject) => {
      const open = indexedDB.open('open-photo-booth', 1)
      open.onupgradeneeded = () => {
        open.result.createObjectStore('settings')
        open.result.createObjectStore('templates', { keyPath: 'id' })
      }
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    }).catch(error => { database = null; throw error })
    const db = await database
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode)
      const request = operation(tx.objectStore(storeName))
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => reject(tx.error || new Error('Storage transaction interrupted'))
    })
  }

  async function getSettings() {
    const stored = await access('settings', 'readonly', store => store.get('booth'))
    return { ...boothDefaults(outputDir), ...stored, outputDir }
  }

  function builtins() {
    bundled ??= fetch('templates/manifest.json').then(response => {
      if (!response.ok) throw new Error('Could not load the bundled layouts')
      return response.json()
    }).catch(error => { bundled = null; throw error })
    return bundled
  }

  async function templateById(id) {
    if (!id) return null
    if (id.startsWith('builtin:')) return (await builtins()).find(t => t.id === id)
    return access('templates', 'readonly', store => store.get(id))
  }

  const basename = name => name.replace(/\\/g, '/').split('/').pop()
  function assetUrl(assets, path) {
    // Layouts made on Windows may contain an absolute path to an image beside template.xml.
    for (const key of [path.replace(/\\/g, '/'), basename(path)]) {
      if (assets && Object.hasOwn(assets, key)) return assets[key]
    }
    return null
  }

  async function saveTemplate({ id, name, xml, copyFrom, files }) {
    Layout.parse(xml)
    const source = await templateById(id || copyFrom)
    if (id && (!id.startsWith('user:') || !source)) throw new Error('Select a saved user layout to overwrite')
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'layout'
    const record = { id: id || `user:${slug}-${crypto.randomUUID()}`, xml, assets: { ...source?.assets, ...files } }
    await access('templates', 'readwrite', store => store.put(record))
    return record.id
  }

  function pickFiles({ multiple = false, accept = '' } = {}) {
    return new Promise(resolve => {
      const input = Object.assign(document.createElement('input'), { type: 'file', multiple, accept, hidden: true })
      const finish = () => {
        window.removeEventListener('pointerdown', nextInteraction, true)
        window.removeEventListener('keydown', nextInteraction, true)
        input.remove()
        resolve(Array.from(input.files || []))
      }
      // Older web views send no event when the picker is dismissed. The next booth
      // interaction confirms it is closed, without racing a slow file selection on focus.
      const nextInteraction = () => { if (!input.files.length) finish() }
      window.addEventListener('pointerdown', nextInteraction, true)
      window.addEventListener('keydown', nextInteraction, true)
      input.onchange = input.oncancel = finish
      document.body.append(input)
      input.click()
    })
  }

  function dataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  }

  async function importTemplate() {
    const selection = await pickFiles({ multiple: true })
    if (!selection.length) return null
    const templates = selection.filter(file => /\.xml$/i.test(file.name))
    if (templates.length !== 1) throw new Error('Select one template.xml and its images together.')
    const bytes = new Uint8Array(await templates[0].arrayBuffer())
    const xml = new TextDecoder(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : 'utf-8').decode(bytes)
    const layout = Layout.parse(xml)
    const files = Object.create(null)
    const paths = new Set(layout.elements.filter(e => e.type === 'Image' && e.src).map(e => e.src))
    for (const path of paths) {
      const file = selection.find(item => item.name === basename(path))
      if (!file) throw new Error(`Select ${basename(path)} together with the layout file.`)
      files[path.replace(/\\/g, '/')] = await dataUrl(file)
    }
    return saveTemplate({ name: layout.name, xml, files })
  }

  window.booth = {
    mobile: true,
    getSettings,
    async saveSettings(values) {
      const next = { ...boothDefaults(outputDir), ...values, outputDir }
      await access('settings', 'readwrite', store => store.put(next, 'booth'))
      return next
    },
    async listTemplates() {
      const users = await access('templates', 'readonly', store => store.getAll())
      return [...await builtins(), ...users].map(({ id, xml }) => ({ id, xml }))
    },
    saveTemplate, importTemplate,
    async deleteTemplate(id) {
      if (id.startsWith('user:')) await access('templates', 'readwrite', store => store.delete(id))
    },
    async templateAsset(id, path) { return assetUrl((await templateById(id))?.assets, path) },
    async pickImage() {
      const [file] = await pickFiles({ accept: 'image/png,image/jpeg,image/gif,image/webp' })
      if (!file) return null
      const url = await dataUrl(file)
      return { name: file.name, path: url, dataUrl: url }
    },
    confirm: message => window.confirm(message),
    async savePhoto(name, bytes, eventName) {
      const url = await dataUrl(new Blob([bytes], { type: 'image/jpeg' }))
      const saved = await cap.Plugins.BoothMedia.savePhoto({
        eventName: eventName ?? (await getSettings()).eventName, name, data: url.slice(url.indexOf(',') + 1),
      })
      return saved.file
    },
    async print(file, widthIn, heightIn) {
      const result = await cap.Plugins.BoothMedia.printPhoto({ file, widthIn, heightIn })
      return result?.cancelled ? { cancelled: true } : null
    },
    // The platform print sheet supplies its own printer list and copy count.
    listPrinters: async () => [],
  }
})()
