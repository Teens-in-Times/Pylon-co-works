// Read-only visual evidence from an isolated, running Tauri/WebView2 instance.
// Usage: node scripts/check-workspace-layout.mjs --label=overview-modern-light
// Navigate the application first; this checks the rendered cascade, not CSS spelling.
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const endpoint = option('endpoint', 'http://127.0.0.1:9222')
const label = option('label', 'workspace').replace(/[^\w-]/g, '_')
const output = resolve(option('out', 'target/qa-728/evidence'))
const targets = await (await fetch(`${endpoint}/json/list`)).json()
const pages = targets.filter(target => target.type === 'page' && /^https?:\/\/tauri\.localhost\/?$/.test(target.url))
assert.equal(pages.length, 1, 'Use an isolated instance with exactly one Pylon application page')
const socket = new WebSocket(pages[0].webSocketDebuggerUrl)
await new Promise((resolveOpen, reject) => { socket.onopen = resolveOpen; socket.onerror = reject })
let sequence = 0
const pending = new Map()
socket.onmessage = event => {
  const message = JSON.parse(event.data)
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
  else entry.resolve(message.result)
}
function call(method, params = {}) {
  return new Promise((resolveCall, reject) => {
    const id = ++sequence
    pending.set(id, { resolve: resolveCall, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
const timeout = setTimeout(() => { socket.close(); process.exitCode = 1; throw new Error('Layout probe timed out') }, 15000)
try {
  const result = await call('Runtime.evaluate', { returnByValue: true, expression: `(() => {
    const visible = element => element.checkVisibility() && element.getBoundingClientRect().width > 0;
    const box = element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { name: element.getAttribute('aria-label') || element.className || element.tagName,
        x:rect.x, y:rect.y, width:rect.width, height:rect.height, right:rect.right, bottom:rect.bottom,
        scrollWidth:element.scrollWidth, clientWidth:element.clientWidth,
        radius:style.borderRadius, font:style.fontSize, display:style.display };
    };
    return { viewport:{width:innerWidth,height:innerHeight},
      mode:document.querySelector('.app')?.getAttribute('data-interface-mode'),
      title:document.querySelector('main h1, main h2, .settings h2')?.textContent,
      document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},
      tauri:typeof window.__TAURI_INTERNALS__?.invoke,
      bindingErrors:[...document.querySelectorAll('.input-binding-status--error')].filter(visible).map(element => element.textContent),
      surfaces:[...document.querySelectorAll('.workspace-titlebar,.layout,.layout > .sidebar,.right-rail-host,.renderer-suite-workbench,main,.settings')].filter(visible).map(box),
      controls:[...document.querySelectorAll('.workspace-titlebar-icon,.workspace-window-native-controls > button,.sheet-tab-overflow-trigger')].filter(visible).map(box),
      menuLabels:[...document.querySelectorAll('.workspace-menu-item-copy')].filter(visible).map(box),
      composer:document.activeElement?.matches('.input-textarea') ? (() => {
        const style = getComputedStyle(document.activeElement);
        return { radius:style.borderRadius, shadow:style.boxShadow, outline:style.outlineStyle };
      })() : null,
      collapsed:[...document.querySelectorAll('.right-rail-host.is-collapsed,.layout[data-sidebar="collapsed"] > .sidebar')].map(box)
    };
  })()` })
  assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
  const evidence = result.result.value
  const screenshot = await call('Page.captureScreenshot', { format: 'png' })
  await mkdir(output, { recursive: true })
  await writeFile(resolve(output, `${label}.png`), Buffer.from(screenshot.data, 'base64'))
  await writeFile(resolve(output, `${label}.json`), `${JSON.stringify(evidence, null, 2)}\n`)
  assert.equal(evidence.tauri, 'function', 'The probe must run inside Tauri')
  assert.deepEqual(evidence.bindingErrors, [], 'The active conversation has a session binding error')
  assert.ok(evidence.document.width <= evidence.viewport.width + 1, 'Document overflows horizontally')
  assert.ok(evidence.document.height <= evidence.viewport.height + 1, 'Document overflows vertically')
  for (const surface of evidence.surfaces) {
    assert.ok(surface.x >= -1 && surface.right <= evidence.viewport.width + 1, `${surface.name}: surface outside viewport`)
    assert.ok(surface.y >= -1 && surface.bottom <= evidence.viewport.height + 1, `${surface.name}: surface clipped vertically`)
  }
  for (const rail of evidence.collapsed) assert.ok(rail.width <= 1, `${rail.name}: collapsed rail occupies space`)
  if (evidence.mode === 'modern-gui') {
    for (const control of evidence.controls) {
      assert.ok(control.height >= 28 && control.height <= 44, `${control.name}: inconsistent titlebar control height`)
    }
    for (const label of evidence.menuLabels) assert.ok(label.width >= 100, 'Settings menu text column is squeezed out')
    if (evidence.composer) {
      assert.equal(evidence.composer.shadow, 'none', 'Textarea has a second focus ring inside its row')
      assert.equal(evidence.composer.outline, 'none', 'Textarea has a second outline inside its row')
      assert.equal(evidence.composer.radius, '0px', 'Textarea retains a nested capsule')
    }
  }
  console.log(`${label}: ${evidence.viewport.width}×${evidence.viewport.height}, ${evidence.surfaces.length} surfaces; layout passed. Evidence: ${output}`)
} finally {
  clearTimeout(timeout)
  socket.close()
}
