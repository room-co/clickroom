// Dev-only reverse proxy (:5177) in front of the Vite SPA (:5180). Managed by `make up`.
// Kept as a separate origin so cookie / CORS behaviour in dev matches a front-door deployment.
import http from 'node:http'
import httpProxy from 'http-proxy-3'

const PROXY_PORT = Number(process.env.PROXY_PORT ?? 5177)
const SPA_PORT = Number(process.env.SPA_PORT ?? 5180)

const proxy = httpProxy.createProxyServer({ ws: true })

proxy.on('error', (_err, _req, res) => {
  if (res && 'writeHead' in res) {
    res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end('Dev proxy: web SPA not ready yet. The dev server must be up.')
  }
})

const target = `http://localhost:${SPA_PORT}`

const server = http.createServer((req, res) => {
  proxy.web(req, res, { target })
})

// Forward WebSocket upgrades (Vite HMR).
server.on('upgrade', (req, socket, head) => {
  proxy.ws(req, socket, head, { target })
})

server.listen(PROXY_PORT, () => {
  console.log(`Dev proxy listening on http://localhost:${PROXY_PORT}`)
  console.log(`  → web SPA: ${target}`)
})
