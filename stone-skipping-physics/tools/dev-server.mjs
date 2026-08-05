/**
 * Zero-dependency static server for the demo.
 *
 * Exists because `python -m http.server` sends no cache headers, and browsers cache
 * ES modules hard: editing src/stoneSkipping.js and reloading kept running the OLD
 * module, which shows up as baffling "sim.checksum is not a function" errors against
 * source that plainly has the method. Everything here is served `no-store`.
 *
 *   node tools/dev-server.mjs [port]
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PORT = Number(process.argv[2] || 5291)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
}

const server = createServer(async (req, res) => {
  const noCache = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
  }
  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (urlPath.endsWith('/')) urlPath += 'demo/index.html'
    if (urlPath === '/demo' || urlPath === '/demo/') urlPath = '/demo/index.html'

    // keep the request inside ROOT
    const target = resolve(join(ROOT, normalize(urlPath)))
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      res.writeHead(403, noCache).end('403 outside root')
      return
    }

    const info = await stat(target)
    const file = info.isDirectory() ? join(target, 'index.html') : target
    const body = await readFile(file)
    res.writeHead(200, {
      ...noCache,
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
    })
    res.end(body)
  } catch (err) {
    const code = err.code === 'ENOENT' ? 404 : 500
    res.writeHead(code, noCache).end(`${code} ${err.code || 'error'}`)
  }
})

server.listen(PORT, () => {
  console.log(`serving ${ROOT}`)
  console.log(`  http://localhost:${PORT}/demo/index.html`)
  console.log('  (no-store: edits are picked up on a normal reload)')
})
