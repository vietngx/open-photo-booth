import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = path.join(root, 'www')
const staging = mkdtempSync(path.join(root, '.www-'))
const templateRoot = path.join(root, 'templates')
const renderer = ['index.html', 'booth-defaults.js', 'booth-mobile.js', 'app.js', 'editor.js', 'layout.js']

// Web views cannot enumerate packaged directories. Index each layout and its local images.
function bundleTemplate(folder) {
  const source = path.join(templateRoot, folder)
  const destination = path.join(staging, 'templates', folder)
  const xmlBytes = readFileSync(path.join(source, 'template.xml'))
  const xml = xmlBytes.toString(xmlBytes[0] === 0xff && xmlBytes[1] === 0xfe ? 'utf16le' : 'utf8')
  mkdirSync(destination, { recursive: true })
  writeFileSync(path.join(destination, 'template.xml'), xmlBytes)

  const images = readdirSync(source, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(png|jpe?g|gif|webp)$/i.test(entry.name))
    .map(entry => path.relative(source, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort()
  const assets = {}
  for (const image of images) {
    const target = path.join(destination, image)
    mkdirSync(path.dirname(target), { recursive: true })
    copyFileSync(path.join(source, image), target)
    assets[image] = ['templates', folder, ...image.split('/')].map(encodeURIComponent).join('/')
  }
  return { id: `builtin:${folder}`, xml, assets }
}

try {
  for (const name of renderer) copyFileSync(path.join(root, name), path.join(staging, name))
  const folders = readdirSync(templateRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name).sort()
  const manifest = folders.map(bundleTemplate)
  mkdirSync(path.join(staging, 'templates'), { recursive: true })
  writeFileSync(path.join(staging, 'templates', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  // Replace the generated directory after all sources were read, retiring any deleted layouts.
  rmSync(output, { recursive: true, force: true })
  renameSync(staging, output)
  console.log(`Built tablet web assets with ${manifest.length} bundled layouts.`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
