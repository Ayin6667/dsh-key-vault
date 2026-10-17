// Client-half smoke probe: load the bundle with a stub React, register slots,
// and call every registered component once so module-level and render-time
// failures surface without a browser.
import { readFileSync, writeFileSync } from 'node:fs'

const out = []
const log = (...parts) => out.push(parts.join(' '))

const nested = []
function makeElement(type, props, ...children) {
  return { type, props: props ?? {}, children }
}

const ReactStub = {
  createElement: makeElement,
  Fragment: 'Fragment',
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useLayoutEffect() {},
  useRef(value) {
    return { current: value }
  },
  useCallback(fn) {
    return fn
  },
  useMemo(factory) {
    return factory()
  },
}

let captured
globalThis.window = {
  innerHeight: 800,
  innerWidth: 1200,
  __ModuleLoader__: {
    load(spec) {
      captured = spec
    },
  },
}
globalThis.window.addEventListener = () => {}
globalThis.window.removeEventListener = () => {}

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const factory = new Function('window', 'require', source)
factory(
  globalThis.window,
  (name) => {
    if (name === 'react') return ReactStub
    throw new Error(`unexpected require(${name})`)
  },
)
log('module-id', captured?.id)

const registrations = []
const fakeConnection = {
  rpc: {
    async call(channel, endpoint, payload) {
      log('rpc', channel, endpoint, JSON.stringify(payload))
      return { ok: true, value: { storage: { vaultPath: 'C:/vault.json', dataDir: 'C:/', algorithm: 'aes-256-gcm', keySource: 'key-file', keyPath: 'C:/vault.key', keyEnv: 'X' }, sessionId: payload?.sessionId ?? null, availableCount: 0, entries: [], usage: [] } }
    },
  },
}

const ctx = {
  get(name) {
    if (name === 'connection') return fakeConnection
    if (name === 'locale') {
      const active = process.env.PROBE_LOCALE ?? 'zh-CN'
      return {
        getSnapshot: () => ({ active }),
        subscribe: () => () => {},
      }
    }
    return undefined
  },
  effect(callback) {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  logger: { warn: (...args) => log('warn', ...args) },
  slots: {
    inject(key, callback) {
      const registered = callback()
      registrations.push({ key, ...registered })
      return () => {}
    },
    register(options, component) {
      return { options, component }
    },
  },
}

const plugin = captured.factory((name) => {
  if (name === 'react') return ReactStub
  throw new Error(`unexpected require(${name})`)
})
plugin.apply(ctx)
log('registrations', registrations.map((entry) => `${entry.options.name}#${entry.options.id}`).join(' | '))

/** Expand function components so their elements are observable. */
function expand(tree) {
  if (tree === null || typeof tree !== 'object') return tree
  if (typeof tree.type === 'function') return expand(tree.type(tree.props))
  return { ...tree, children: (tree.children ?? []).map(expand) }
}

/** Whether one rendered tree carries its own stylesheet element. */
function hasStyle(tree) {
  if (tree === null || typeof tree !== 'object') return false
  if (tree.type === 'style') return true
  return (tree.children ?? []).some(hasStyle)
}

for (const entry of registrations) {
  const label = `${entry.options.name}#${entry.options.id}`
  try {
    const props = entry.options.name === 'conversation.input.left' ? { sessionId: 'session-probe' } : {}
    const tree = expand(entry.component(props))
    log('render', label, tree === null ? 'null' : 'ok', tree === null ? '' : `style=${hasStyle(tree)}`, typeof entry.options.label === 'function' ? `label=${entry.options.label()}` : '')
  } catch (error) {
    log('render-failed', label, error?.stack ?? String(error))
  }
}

/** First button element in an expanded tree. */
function firstButton(tree) {
  if (tree === null || typeof tree !== 'object') return undefined
  if (tree.type === 'button') return tree
  for (const child of tree.children ?? []) {
    const found = firstButton(child)
    if (found !== undefined) return found
  }
  return undefined
}

const wantChinese = (process.env.PROBE_LOCALE ?? 'zh-CN').toLowerCase().startsWith('zh')

const pillEntry = registrations.find((entry) => entry.options.id === 'keymanager-pill')
const panelEntry = registrations.find((entry) => entry.options.id === 'keymanager-panel')
const settingsEntry = registrations.find((entry) => entry.options.id === 'keymanager')

if (settingsEntry !== undefined) {
  const settingsText = collectText(expand(settingsEntry.component({})))
  const title = wantChinese ? '凭据' : 'Credentials'
  log(
    'i18n-settings',
    settingsText.includes(title),
    !settingsText.includes('settings.title'),
    `nav=${settingsEntry.options.label()}`,
  )
}

if (pillEntry !== undefined && panelEntry !== undefined) {
  const pillTree = expand(pillEntry.component({ sessionId: 'session-probe' }))
  const trigger = firstButton(pillTree)
  trigger.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 120, top: 700 }) } })
  const panelTree = expand(panelEntry.component({}))
  const panelText = collectText(panelTree)
  const panelTitle = wantChinese ? '本对话可用的凭据' : 'Credentials in this conversation'
  log(
    'panel-open',
    panelTree !== null,
    `style=${hasStyle(panelTree)}`,
    `i18n=${panelText.includes(panelTitle)}`,
    `no-raw-keys=${!panelText.includes('panel.title') && !panelText.includes('panel.hint')}`,
  )
}

/** Concatenate the text children of an expanded tree, skipping stylesheets. */
function collectText(tree) {
  if (tree === null || tree === undefined) return ''
  if (typeof tree === 'string') return tree
  if (typeof tree !== 'object') return ''
  if (tree.type === 'style') return ''
  return (tree.children ?? []).map(collectText).join(' ')
}

writeFileSync(process.env.PROBE_OUT ?? 'client-probe.txt', out.join('\n') + '\n')
