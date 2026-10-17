/**
 * Client half of the key manager: a per-conversation credential switch beside
 * the composer and a vault page in Settings -> Credentials.
 *
 * Both call the Host half at POST /keymanager/rpc. That exact route runs the
 * host connection service's own fence and browser-session check, so the
 * request is authorized by the page's session rather than by this plugin.
 */
window.__ModuleLoader__.load({
  id: 'dsh-key-vault',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    const RPC_PATH = 'keymanager/rpc'
    const KINDS = ['login', 'token', 'api-key', 'ssh', 'note']

    /** Resolve the endpoint against the page's mount point, not the origin root. */
    function rpcUrl() {
      try {
        return new URL(RPC_PATH, document.baseURI).toString()
      } catch {
        return `/${RPC_PATH}`
      }
    }

    /* ------------------------------------------------------------------ *
     * Text
     * ------------------------------------------------------------------ */

    const DICT = {
      en: {
        'nav': 'Credentials',
        'pill.title': 'Credentials this conversation can use',
        'pill.count': '{on}/{total}',
        'pill.error': 'Key vault unavailable',
        'panel.title': 'Credentials in this conversation',
        'panel.hint': 'The agent can read a secret only while its switch is on. Grants last until the app restarts.',
        'panel.empty': 'The vault is empty. Add a credential in Settings > Credentials.',
        'panel.usageTitle': 'Used in this conversation',
        'panel.usageNone': 'No credential has been read here yet.',
        'panel.settingsHint': 'Settings > Credentials',
        'panel.close': 'Close',
        'panel.auto': 'auto',
        'settings.title': 'Credentials',
        'settings.desc': 'Login credentials the agent can read in a conversation you allow. Every secret is encrypted with AES-256-GCM before it reaches this file.',
        'settings.storage': 'Storage',
        'settings.vaultPath': 'Vault file',
        'settings.keySource': 'Master key',
        'settings.keySourceFile': 'key file beside the vault',
        'settings.keySourceEnv': 'environment variable',
        'settings.algorithm': 'Cipher',
        'settings.entries': 'Stored credentials',
        'settings.addTitle': 'Add a credential',
        'settings.editTitle': 'Edit "{name}"',
        'settings.count': '{n} stored',
        'settings.empty': 'Nothing stored yet. Add the first credential below.',
        'settings.grantedSessions': '{n} conversation(s) enabled',
        'settings.usageTitle': 'Agent reads',
        'settings.usageEmpty': 'The agent has not read a secret yet.',
        'settings.usageDesc': 'Every read the agent performs is recorded here, including reads in other conversations.',
        'field.name': 'Name',
        'field.nameHint': 'How the agent refers to it, for example example.com',
        'field.kind': 'Kind',
        'field.username': 'Username or e-mail',
        'field.secret': 'Secret',
        'field.secretEdit': 'New secret (leave blank to keep the current one)',
        'field.notes': 'Notes',
        'field.notesHint': 'Where it is used, or what is needed to use it',
        'field.tags': 'Tags',
        'field.tagsHint': 'Comma separated',
        'field.autoGrant': 'Readable in every conversation',
        'field.autoGrantHint': 'Off keeps the per-conversation switch in charge.',
        'kind.login': 'Login',
        'kind.token': 'Token',
        'kind.api-key': 'API key',
        'kind.ssh': 'SSH key',
        'kind.note': 'Note',
        'action.save': 'Save',
        'action.saving': 'Saving...',
        'action.cancel': 'Cancel',
        'action.edit': 'Edit',
        'action.delete': 'Delete',
        'action.confirmDelete': 'Delete for good',
        'action.retry': 'Retry',
        'col.time': 'Time',
        'col.credential': 'Credential',
        'col.conversation': 'Conversation',
        'col.purpose': 'Purpose',
        'state.loading': 'Loading...',
        'badge.locked': 'Cannot decrypt',
        'err.name': 'A name is required.',
        'err.secret': 'A secret is required for a new credential.',
        'err.notReady': 'The credential service is not reachable yet; reload the page.',
        'err.reach': 'Cannot reach the credential service: {message}',
        'err.http': 'The credential service answered HTTP {status}',
        'err.httpSession': ' (the page session was not accepted)',
        'err.nonJson': 'The credential service returned a non-JSON response.',
        'err.refused': 'The credential service refused the request.',
      },
      zh: {
        'nav': '凭据',
        'pill.title': '本对话可用的凭据',
        'pill.count': '{on}/{total}',
        'pill.error': '凭据库不可用',
        'panel.title': '本对话可用的凭据',
        'panel.hint': '只有打开开关的凭据，Agent 才能读取。授权在应用重启后失效。',
        'panel.empty': '凭据库还是空的。可在「设置 > 凭据」里添加。',
        'panel.usageTitle': '本对话已使用',
        'panel.usageNone': '本对话尚未读取过凭据。',
        'panel.settingsHint': '设置 > 凭据',
        'panel.close': '关闭',
        'panel.auto': '自动',
        'settings.title': '凭据',
        'settings.desc': 'Agent 可在你允许的对话里读取的登录凭据。每个密钥在写入文件前都用 AES-256-GCM 加密。',
        'settings.storage': '存储',
        'settings.vaultPath': '保险库文件',
        'settings.keySource': '主密钥',
        'settings.keySourceFile': '保险库旁的主密钥文件',
        'settings.keySourceEnv': '环境变量',
        'settings.algorithm': '加密算法',
        'settings.entries': '已存凭据',
        'settings.addTitle': '新增凭据',
        'settings.editTitle': '编辑「{name}」',
        'settings.count': '共 {n} 条',
        'settings.empty': '还没有任何凭据。在下面添加第一条。',
        'settings.grantedSessions': '{n} 个对话已授权',
        'settings.usageTitle': 'Agent 读取记录',
        'settings.usageEmpty': 'Agent 还没有读取过任何密钥。',
        'settings.usageDesc': 'Agent 每次读取都会记在这里，包括其他对话里的读取。',
        'field.name': '名称',
        'field.nameHint': 'Agent 用它来称呼这条凭据，例如 example.com',
        'field.kind': '类型',
        'field.username': '用户名或邮箱',
        'field.secret': '密钥',
        'field.secretEdit': '新密钥（留空表示保持不变）',
        'field.notes': '备注',
        'field.notesHint': '用在哪里，或使用它需要知道什么',
        'field.tags': '标签',
        'field.tagsHint': '用逗号分隔',
        'field.autoGrant': '所有对话都可读取',
        'field.autoGrantHint': '关闭时由每个对话自己的开关决定。',
        'kind.login': '登录',
        'kind.token': '令牌',
        'kind.api-key': 'API Key',
        'kind.ssh': 'SSH 密钥',
        'kind.note': '备注',
        'action.save': '保存',
        'action.saving': '保存中...',
        'action.cancel': '取消',
        'action.edit': '编辑',
        'action.delete': '删除',
        'action.confirmDelete': '确认删除',
        'action.retry': '重试',
        'col.time': '时间',
        'col.credential': '凭据',
        'col.conversation': '对话',
        'col.purpose': '用途',
        'state.loading': '加载中...',
        'badge.locked': '无法解密',
        'err.name': '需要填写名称。',
        'err.secret': '新增凭据需要填写密钥。',
        'err.notReady': '凭据服务还没就绪，请刷新页面。',
        'err.reach': '无法访问凭据服务：{message}',
        'err.http': '凭据服务返回 HTTP {status}',
        'err.httpSession': '（页面会话未被接受）',
        'err.nonJson': '凭据服务返回了非 JSON 响应。',
        'err.refused': '凭据服务拒绝了这次请求。',
      },
    }

    /**
     * Text resolution stays inside this bundle. The host locale service is
     * followed for the active language, but the dictionaries are never
     * registered into its shared namespace: during hot reload an older bundle
     * generation still owns that namespace, a re-registration throws, and every
     * label then degrades to its raw key.
     */
    let activeLocale = 'en'

    function familyOf(id) {
      const value = String(id ?? '').toLowerCase()
      return value.startsWith('zh') ? 'zh' : 'en'
    }

    function readActiveLocale(locale) {
      try {
        const snapshot = locale && typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : undefined
        if (sourceHasLocale(snapshot)) return familyOf(snapshot.active)
      } catch {
        /* fall through to the browser preference */
      }
      try {
        const preferred = globalThis.navigator?.language
        if (typeof preferred === 'string' && preferred.length > 0) return familyOf(preferred)
      } catch {
        /* no browser locale available */
      }
      return 'en'
    }

    function sourceHasLocale(snapshot) {
      return snapshot !== undefined && snapshot !== null && typeof snapshot.active === 'string' && snapshot.active.length > 0
    }

    function localTranslate(key, params) {
      const dict = DICT[activeLocale] ?? DICT.en
      return interpolate(dict[key] ?? DICT.en[key] ?? key, params)
    }

    let translate = localTranslate

    function interpolate(template, params) {
      if (!params) return template
      return String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    /* ------------------------------------------------------------------ *
     * Host calls
     * ------------------------------------------------------------------ */

    let callHost = async () => {
      throw new Error(translate('err.notReady'))
    }

    function messageOf(error) {
      if (error && typeof error.message === 'string') return error.message
      return String(error)
    }

    /* ------------------------------------------------------------------ *
     * Data stores
     * ------------------------------------------------------------------ */

    function createStore() {
      let snapshot = { loading: false, error: null, data: null, sessionId: null }
      const subscribers = new Set()
      const publish = (next) => {
        snapshot = next
        for (const notify of [...subscribers]) notify()
      }
      return {
        get: () => snapshot,
        subscribe(notify) {
          subscribers.add(notify)
          return () => {
            subscribers.delete(notify)
          }
        },
        async load(sessionId, force) {
          const target = sessionId ?? null
          if (!force && snapshot.data !== null && snapshot.sessionId === target && snapshot.error === null) return
          publish({ ...snapshot, loading: true, error: null, sessionId: target })
          try {
            const data = await callHost('list', { sessionId: target })
            publish({ loading: false, error: null, data, sessionId: target })
          } catch (error) {
            publish({ ...snapshot, loading: false, error: messageOf(error), sessionId: target })
          }
        },
      }
    }

    const sessionStore = createStore()
    const adminStore = createStore()

    async function mutate(endpoint, payload) {
      const value = await callHost(endpoint, payload)
      await Promise.all([
        sessionStore.load(sessionStore.get().sessionId, true),
        adminStore.load(null, true),
      ])
      return value
    }

    function useStore(store) {
      const [, bump] = useState(0)
      useEffect(() => {
        const off = store.subscribe(() => bump((value) => value + 1))
        return () => {
          off()
        }
      }, [store])
      return store.get()
    }

    /* ------------------------------------------------------------------ *
     * Overlay state shared by the pill and the floating panel
     * ------------------------------------------------------------------ */

    let overlay = { open: false, sessionId: null, anchor: null }
    const overlaySubscribers = new Set()

    function setOverlay(next) {
      overlay = { ...overlay, ...next }
      for (const notify of [...overlaySubscribers]) notify()
    }

    function useOverlay() {
      const [, bump] = useState(0)
      useEffect(() => {
        const notify = () => bump((value) => value + 1)
        overlaySubscribers.add(notify)
        return () => {
          overlaySubscribers.delete(notify)
        }
      }, [])
      return overlay
    }

    /* ------------------------------------------------------------------ *
     * Small presentational pieces
     * ------------------------------------------------------------------ */

    const KEY_ICON = h(
      'svg',
      { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': true, focusable: false },
      h('path', {
        d: 'M14.5 3a6.5 6.5 0 0 0-6.2 8.4L3 16.7V21h4.3l1.2-1.2v-2h2v-2h2l1.3-1.3A6.5 6.5 0 1 0 14.5 3Zm2.3 4.2a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Z',
        fill: 'currentColor',
      }),
    )

    function Switch({ checked, onChange, label, disabled }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dkm-switch',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          title: label,
          disabled: disabled === true,
          onClick: () => onChange(!checked),
        },
        h('span', { className: 'dkm-knob', 'aria-hidden': true }),
      )
    }

    function formatTime(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return '-'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return iso
      return date.toLocaleString()
    }

    function conversationLabel(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return '-'
      return sessionId.replace(/^session-/, '').slice(0, 8)
    }

    function Pill({ sessionId }) {
      const snapshot = useStore(sessionStore)
      const current = useOverlay()
      const data = snapshot.data

      useEffect(() => {
        if (sessionId) sessionStore.load(sessionId)
      }, [sessionId])

      const on = data ? data.availableCount : 0
      const total = data ? data.entries.length : 0
      const failed = snapshot.error !== null && data === null

      const toggle = (event) => {
        if (current.open && current.sessionId === (sessionId ?? null)) {
          setOverlay({ open: false })
          return
        }
        const rect = event.currentTarget.getBoundingClientRect()
        setOverlay({ open: true, sessionId: sessionId ?? null, anchor: { left: rect.left, top: rect.top } })
      }

      return h(
        React.Fragment,
        null,
        h(Styles),
        h(
          'button',
          {
            type: 'button',
            className: 'dkm-pill',
            'data-on': on > 0 ? 'true' : 'false',
            'data-failed': failed ? 'true' : 'false',
            'aria-expanded': current.open ? 'true' : 'false',
            title: failed ? translate('pill.error') : translate('pill.title'),
            'aria-label': translate('pill.title'),
            onClick: toggle,
          },
          h('span', { className: 'dkm-pill-icon' }, KEY_ICON),
          h(
            'span',
            { className: 'dkm-pill-text' },
            failed ? translate('pill.error') : data === null ? translate('state.loading') : translate('pill.count', { on, total }),
          ),
        ),
      )
    }

    /** The one stylesheet every entry carries, so no entry depends on another. */
    function Styles() {
      return h('style', null, CSS)
    }

    function Panel() {
      const state = useOverlay()
      const snapshot = useStore(sessionStore)
      const [busyId, setBusyId] = useState(null)
      const panelRef = useRef(null)

      useEffect(() => {
        if (!state.open) return undefined
        // Force a refresh on open: the agent may have been granted an entry
        // from the conversation, which this page learns about only by fetching.
        if (state.sessionId) sessionStore.load(state.sessionId, true)
        const onKey = (event) => {
          if (event.key === 'Escape') setOverlay({ open: false })
        }
        // No full-viewport backdrop: another plugin's floating UI stays
        // clickable, and a click outside this panel simply closes it.
        const onPointerDown = (event) => {
          const box = panelRef.current
          const target = event.target
          if (box !== null && target instanceof Node && box.contains(target)) return
          setOverlay({ open: false })
        }
        window.addEventListener('keydown', onKey)
        document.addEventListener('mousedown', onPointerDown, true)
        return () => {
          window.removeEventListener('keydown', onKey)
          document.removeEventListener('mousedown', onPointerDown, true)
        }
      }, [state.open, state.sessionId])

      if (!state.open) return null

      const data = snapshot.data
      const viewportHeight = window.innerHeight || 800
      const viewportWidth = window.innerWidth || 1200
      const anchor = state.anchor ?? { left: 24, top: viewportHeight - 120 }
      const bottom = Math.max(12, viewportHeight - anchor.top + 8)
      const left = Math.max(12, Math.min(anchor.left, viewportWidth - 356))

      const toggle = async (entry, next) => {
        setBusyId(entry.id)
        try {
          await mutate('grant', { sessionId: state.sessionId, id: entry.id, enabled: next })
        } catch (error) {
          console.error('[keymanager] grant failed', error)
        } finally {
          setBusyId(null)
        }
      }

      const usage = (data?.usage ?? []).filter((row) => row.sessionId === state.sessionId).slice(0, 5)
      const entries = data?.entries ?? []

      return h(
        React.Fragment,
        null,
        h(Styles),
        h(
          'div',
          { className: 'dkm-panel', role: 'dialog', 'aria-label': translate('panel.title'), style: { left, bottom }, ref: panelRef },
          h(
            'div',
            { className: 'dkm-panel-head' },
            h('span', { className: 'dkm-panel-title' }, translate('panel.title')),
            h(
              'button',
              {
                type: 'button',
                className: 'dkm-icon-btn',
                onClick: () => setOverlay({ open: false }),
                'aria-label': translate('panel.close'),
                title: translate('panel.close'),
              },
              '×',
            ),
          ),
          h('p', { className: 'dkm-hint' }, translate('panel.hint')),
          snapshot.error !== null && data === null ? h('p', { className: 'dkm-error' }, snapshot.error) : null,
          h(
            'div',
            { className: 'dkm-panel-body' },
            entries.length === 0 && data !== null ? h('p', { className: 'dkm-empty' }, translate('panel.empty')) : null,
            entries.map((entry) =>
              h(
                'div',
                { className: 'dkm-row', key: entry.id },
                h(
                  'div',
                  { className: 'dkm-row-main' },
                  h('span', { className: 'dkm-row-name' }, entry.name),
                  h(
                    'span',
                    { className: 'dkm-row-meta' },
                    entry.kind === 'login' && entry.username ? entry.username : translate(`kind.${entry.kind}`),
                    entry.autoGrant ? ` - ${translate('panel.auto')}` : '',
                  ),
                ),
                h(Switch, {
                  checked: entry.available,
                  disabled: busyId === entry.id,
                  label: `${translate('panel.title')}: ${entry.name}`,
                  onChange: (next) => toggle(entry, next),
                }),
              ),
            ),
            h(
              'div',
              { className: 'dkm-usage' },
              h('div', { className: 'dkm-usage-head' }, translate('panel.usageTitle')),
              usage.length === 0
                ? h('p', { className: 'dkm-empty' }, translate('panel.usageNone'))
                : usage.map((row, index) =>
                    h(
                      'div',
                      { className: 'dkm-usage-row', key: `${row.at}-${index}` },
                      h('span', { className: 'dkm-usage-name' }, row.entryName),
                      h('span', { className: 'dkm-usage-purpose' }, row.purpose || '-'),
                      h('span', { className: 'dkm-usage-time' }, formatTime(row.at)),
                    ),
                  ),
            ),
          ),
          h('div', { className: 'dkm-panel-foot' }, h('span', { className: 'dkm-foot-note' }, translate('panel.settingsHint'))),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Settings page
     * ------------------------------------------------------------------ */

    const EMPTY_FORM = { name: '', kind: 'login', username: '', secret: '', notes: '', tags: '', autoGrant: false }

    function SettingsPage() {
      const snapshot = useStore(adminStore)
      const [form, setForm] = useState(EMPTY_FORM)
      const [editing, setEditing] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [pendingDelete, setPendingDelete] = useState(null)

      useEffect(() => {
        adminStore.load(null, true)
      }, [])

      const data = snapshot.data
      const entries = data?.entries ?? []

      const update = (field) => (event) => {
        const target = event.target
        setForm((current) => ({ ...current, [field]: target.type === 'checkbox' ? target.checked : target.value }))
      }

      const reset = () => {
        setForm(EMPTY_FORM)
        setEditing(null)
        setError(null)
      }

      const beginEdit = (entry) => {
        setEditing(entry)
        setError(null)
        setPendingDelete(null)
        setForm({
          name: entry.name,
          kind: entry.kind,
          username: entry.username,
          secret: '',
          notes: entry.notes,
          tags: entry.tags.join(', '),
          autoGrant: entry.autoGrant,
        })
      }

      const submit = async (event) => {
        if (event) event.preventDefault()
        setError(null)
        setNotice(null)
        if (form.name.trim().length === 0) {
          setError(translate('err.name'))
          return
        }
        if (editing === null && form.secret.length === 0) {
          setError(translate('err.secret'))
          return
        }
        setBusy(true)
        try {
          const tags = form.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
          if (editing === null) {
            await mutate('create', {
              name: form.name,
              kind: form.kind,
              username: form.username,
              secret: form.secret,
              notes: form.notes,
              tags,
              autoGrant: form.autoGrant,
            })
          } else {
            const patch = {
              name: form.name,
              kind: form.kind,
              username: form.username,
              notes: form.notes,
              tags,
              autoGrant: form.autoGrant,
            }
            if (form.secret.length > 0) patch.secret = form.secret
            await mutate('update', { id: editing.id, patch })
          }
          setNotice(form.name)
          reset()
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy(false)
        }
      }

      const remove = async (entry) => {
        setBusy(true)
        setError(null)
        try {
          await mutate('remove', { id: entry.id })
          if (editing !== null && editing.id === entry.id) reset()
          setPendingDelete(null)
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy(false)
        }
      }

      const storage = data?.storage

      return h(
        React.Fragment,
        null,
        h(Styles),
        h(
          'div',
          { className: 'dkm-page' },
          h(
            'header',
            { className: 'dkm-page-head' },
            h('h2', { className: 'dkm-page-title' }, translate('settings.title')),
            h('p', { className: 'dkm-page-desc' }, translate('settings.desc')),
          ),

          storage
            ? h(
                'section',
                { className: 'dkm-card' },
                h('div', { className: 'dkm-card-title' }, translate('settings.storage')),
                h(
                  'dl',
                  { className: 'dkm-facts' },
                  h('dt', null, translate('settings.vaultPath')),
                  h('dd', null, storage.vaultPath),
                  h('dt', null, translate('settings.keySource')),
                  h(
                    'dd',
                    null,
                    storage.keySource === 'key-file'
                      ? translate('settings.keySourceFile')
                      : `${translate('settings.keySourceEnv')} ${storage.keyEnv ?? ''}`,
                  ),
                  h('dt', null, translate('settings.algorithm')),
                  h('dd', null, storage.algorithm),
                ),
              )
            : null,

          h(
            'section',
            { className: 'dkm-section' },
            h(
              'div',
              { className: 'dkm-section-head' },
              h('h3', { className: 'dkm-section-title' }, translate('settings.entries')),
              h('span', { className: 'dkm-section-count' }, data ? translate('settings.count', { n: entries.length }) : ''),
            ),
            snapshot.error !== null ? h('p', { className: 'dkm-error' }, snapshot.error) : null,
            entries.length === 0
              ? h('p', { className: 'dkm-empty' }, snapshot.loading ? translate('state.loading') : translate('settings.empty'))
              : h(
                  'div',
                  { className: 'dkm-list' },
                  entries.map((entry) =>
                    h(
                      'div',
                      { className: `dkm-item${editing !== null && editing.id === entry.id ? ' is-editing' : ''}`, key: entry.id },
                      h(
                        'div',
                        { className: 'dkm-item-main' },
                        h(
                          'div',
                          { className: 'dkm-item-title' },
                          h('span', { className: 'dkm-item-name' }, entry.name),
                          h('span', { className: 'dkm-badge' }, translate(`kind.${entry.kind}`)),
                          entry.autoGrant ? h('span', { className: 'dkm-badge dkm-badge-brand' }, translate('panel.auto')) : null,
                          entry.locked ? h('span', { className: 'dkm-badge dkm-badge-error' }, translate('badge.locked')) : null,
                        ),
                        h(
                          'div',
                          { className: 'dkm-item-meta' },
                          entry.username ? h('span', null, entry.username) : null,
                          entry.sessionCount > 0 ? h('span', null, translate('settings.grantedSessions', { n: entry.sessionCount })) : null,
                          entry.lastUsedAt ? h('span', null, formatTime(entry.lastUsedAt)) : null,
                        ),
                      ),
                      h(
                        'div',
                        { className: 'dkm-item-actions' },
                        pendingDelete === entry.id
                          ? h(
                              React.Fragment,
                              null,
                              h('button', { type: 'button', className: 'dkm-btn dkm-btn-danger', disabled: busy, onClick: () => remove(entry) }, translate('action.confirmDelete')),
                              h('button', { type: 'button', className: 'dkm-btn', onClick: () => setPendingDelete(null) }, translate('action.cancel')),
                            )
                          : h(
                              React.Fragment,
                              null,
                              h('button', { type: 'button', className: 'dkm-btn', onClick: () => beginEdit(entry) }, translate('action.edit')),
                              h('button', { type: 'button', className: 'dkm-btn dkm-btn-ghost', onClick: () => setPendingDelete(entry.id) }, translate('action.delete')),
                            ),
                      ),
                    ),
                  ),
                ),
          ),

          h(
            'section',
            { className: 'dkm-section' },
            h('h3', { className: 'dkm-section-title' }, editing === null ? translate('settings.addTitle') : translate('settings.editTitle', { name: editing.name })),
            h(
              'form',
              { className: 'dkm-form', onSubmit: submit },
              h(
                'label',
                { className: 'dkm-field' },
                h('span', { className: 'dkm-label' }, translate('field.name')),
                h('input', { className: 'dkm-input', value: form.name, onChange: update('name'), placeholder: translate('field.nameHint'), autoComplete: 'off' }),
              ),
              h(
                'label',
                { className: 'dkm-field' },
                h('span', { className: 'dkm-label' }, translate('field.kind')),
                h(
                  'select',
                  { className: 'dkm-select', value: form.kind, onChange: update('kind') },
                  KINDS.map((kind) => h('option', { key: kind, value: kind }, translate(`kind.${kind}`))),
                ),
              ),
              h(
                'label',
                { className: 'dkm-field' },
                h('span', { className: 'dkm-label' }, translate('field.username')),
                h('input', { className: 'dkm-input', value: form.username, onChange: update('username'), autoComplete: 'off' }),
              ),
              h(
                'label',
                { className: 'dkm-field' },
                h('span', { className: 'dkm-label' }, editing === null ? translate('field.secret') : translate('field.secretEdit')),
                h('input', { className: 'dkm-input', type: 'password', value: form.secret, onChange: update('secret'), autoComplete: 'new-password' }),
              ),
              h(
                'label',
                { className: 'dkm-field dkm-field-wide' },
                h('span', { className: 'dkm-label' }, translate('field.notes')),
                h('textarea', { className: 'dkm-textarea', rows: 2, value: form.notes, onChange: update('notes'), placeholder: translate('field.notesHint') }),
              ),
              h(
                'label',
                { className: 'dkm-field' },
                h('span', { className: 'dkm-label' }, translate('field.tags')),
                h('input', { className: 'dkm-input', value: form.tags, onChange: update('tags'), placeholder: translate('field.tagsHint'), autoComplete: 'off' }),
              ),
              h(
                'label',
                { className: 'dkm-check' },
                h('input', { type: 'checkbox', checked: form.autoGrant, onChange: update('autoGrant') }),
                h(
                  'span',
                  null,
                  h('span', { className: 'dkm-check-title' }, translate('field.autoGrant')),
                  h('span', { className: 'dkm-check-hint' }, translate('field.autoGrantHint')),
                ),
              ),
              error !== null ? h('p', { className: 'dkm-error' }, error) : null,
              notice !== null ? h('p', { className: 'dkm-notice' }, notice) : null,
              h(
                'div',
                { className: 'dkm-form-actions' },
                h('button', { type: 'submit', className: 'dkm-btn dkm-btn-primary', disabled: busy }, busy ? translate('action.saving') : translate('action.save')),
                editing !== null ? h('button', { type: 'button', className: 'dkm-btn', onClick: reset }, translate('action.cancel')) : null,
              ),
            ),
          ),

          h(
            'section',
            { className: 'dkm-section' },
            h('h3', { className: 'dkm-section-title' }, translate('settings.usageTitle')),
            h('p', { className: 'dkm-desc' }, translate('settings.usageDesc')),
            (data?.usage ?? []).length === 0
              ? h('p', { className: 'dkm-empty' }, translate('settings.usageEmpty'))
              : h(
                  'div',
                  { className: 'dkm-table' },
                  h(
                    'div',
                    { className: 'dkm-table-head' },
                    h('span', null, translate('col.time')),
                    h('span', null, translate('col.credential')),
                    h('span', null, translate('col.conversation')),
                    h('span', null, translate('col.purpose')),
                  ),
                  (data?.usage ?? []).slice(0, 20).map((row, index) =>
                    h(
                      'div',
                      { className: 'dkm-table-row', key: `${row.at}-${index}` },
                      h('span', { className: 'dkm-mono' }, formatTime(row.at)),
                      h('span', null, row.entryName),
                      h('span', { className: 'dkm-mono', title: row.sessionId ?? '' }, conversationLabel(row.sessionId)),
                      h('span', null, row.purpose || '-'),
                    ),
                  ),
                ),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Styles (theme tokens only)
     * ------------------------------------------------------------------ */

    const CSS = `
.dkm-pill{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:background .12s,color .12s,border-color .12s}
.dkm-pill:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dkm-pill[data-on="true"]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);color:var(--dsw-alias-label-primary)}
.dkm-pill[data-failed="true"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dkm-pill-icon{display:inline-flex;color:var(--dsw-alias-brand-primary)}
.dkm-pill[data-on="false"] .dkm-pill-icon{color:var(--dsw-alias-state-idle-primary)}
.dkm-panel{position:fixed;z-index:61;width:344px;max-height:min(62vh,540px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 16px 40px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);color:var(--dsw-alias-label-primary);font-size:13px;overflow:hidden;pointer-events:auto}
.dkm-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px 6px}
.dkm-panel-title{font-size:13px;font-weight:600}
.dkm-icon-btn{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1;padding:4px 6px;border-radius:6px}
.dkm-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dkm-hint{margin:0;padding:0 14px 8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}
.dkm-panel-body{overflow:auto;padding:0 6px 6px}
.dkm-row{display:flex;align-items:center;gap:10px;padding:8px;border-radius:8px}
.dkm-row:hover{background:var(--dsw-alias-bg-layer-1)}
.dkm-row-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dkm-row-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dkm-row-meta{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dkm-switch{position:relative;flex:0 0 auto;width:34px;height:20px;padding:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background .12s,border-color .12s}
.dkm-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dkm-switch:disabled{opacity:.55;cursor:default}
.dkm-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-overlay);transition:left .14s}
.dkm-switch[aria-checked="true"] .dkm-knob{left:16px}
.dkm-usage{margin-top:8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}
.dkm-usage-head{padding:0 8px 4px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-secondary)}
.dkm-usage-row{display:grid;grid-template-columns:1fr auto;gap:2px 8px;padding:5px 8px;border-radius:6px}
.dkm-usage-name{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dkm-usage-purpose{grid-column:1;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dkm-usage-time{grid-row:1;grid-column:2;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dkm-panel-foot{padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px}
.dkm-empty{margin:0;padding:10px 8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}
.dkm-error{margin:8px 0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5;white-space:pre-wrap}
.dkm-notice{margin:8px 0;color:var(--dsw-alias-state-success-primary);font-size:12px}
.dkm-page{display:flex;flex-direction:column;gap:22px;padding:4px 2px 48px}
.dkm-page-head{display:flex;flex-direction:column;gap:6px}
.dkm-page-title{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dkm-page-desc{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);max-width:640px}
.dkm-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1)}
.dkm-card-title{font-size:12px;font-weight:600;margin-bottom:8px;color:var(--dsw-alias-label-primary)}
.dkm-facts{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:0;font-size:12px}
.dkm-facts dt{color:var(--dsw-alias-label-secondary)}
.dkm-facts dd{margin:0;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-primary)}
.dkm-section{display:flex;flex-direction:column;gap:10px}
.dkm-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.dkm-section-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dkm-section-count{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dkm-desc{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.dkm-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden}
.dkm-item{display:flex;align-items:center;gap:12px;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l1)}
.dkm-item:first-child{border-top:none}
.dkm-item:hover{background:var(--dsw-alias-bg-layer-1)}
.dkm-item.is-editing{background:var(--dsw-alias-bg-layer-1)}
.dkm-item-main{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.dkm-item-title{display:flex;align-items:center;gap:8px;min-width:0}
.dkm-item-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dkm-item-meta{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dkm-badge{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dkm-badge-brand{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);color:var(--dsw-alias-brand-primary)}
.dkm-badge-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);color:var(--dsw-alias-state-error-primary)}
.dkm-item-actions{display:flex;gap:6px;flex:0 0 auto}
.dkm-btn{font:inherit;font-size:12px;height:28px;padding:0 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}
.dkm-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.dkm-btn:disabled{opacity:.55;cursor:default}
.dkm-btn-primary{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary)}
.dkm-btn-primary:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent)}
.dkm-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.dkm-btn-ghost{color:var(--dsw-alias-label-secondary);border-color:transparent}
.dkm-form{display:flex;flex-wrap:wrap;gap:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px}
.dkm-field{display:flex;flex-direction:column;gap:5px;flex:1 1 220px;min-width:0}
.dkm-field-wide{flex-basis:100%}
.dkm-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dkm-input,.dkm-select,.dkm-textarea{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dkm-textarea{resize:vertical;min-height:52px}
.dkm-input:focus,.dkm-select:focus,.dkm-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.dkm-check{display:flex;align-items:flex-start;gap:8px;flex-basis:100%;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer}
.dkm-check input{margin-top:2px}
.dkm-check-title{display:block}
.dkm-check-hint{display:block;color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:2px}
.dkm-form-actions{display:flex;gap:8px;flex-basis:100%}
.dkm-table{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;font-size:12px}
.dkm-table-head,.dkm-table-row{display:grid;grid-template-columns:150px minmax(90px,1fr) 90px minmax(120px,1.4fr);gap:10px;padding:7px 12px;align-items:center}
.dkm-table-head{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px}
.dkm-table-row{border-top:1px solid var(--dsw-alias-border-l1)}
.dkm-table-row>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dkm-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}
`

    /* ------------------------------------------------------------------ *
     * Plugin body
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots'],
      apply(ctx) {
        callHost = async (endpoint, payload) => {
          let response
          try {
            response = await fetch(rpcUrl(), {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ method: endpoint, args: payload ?? null }),
            })
          } catch (error) {
            throw new Error(translate('err.reach', { message: messageOf(error) }))
          }
          if (!response.ok) {
            const hint = response.status === 401 || response.status === 403 ? translate('err.httpSession') : ''
            throw new Error(`${translate('err.http', { status: response.status })}${hint}`)
          }
          let body
          try {
            body = await response.json()
          } catch {
            throw new Error(translate('err.nonJson'))
          }
          if (body && body.ok === true) return body.value
          const failure = body && body.error
          throw new Error(failure && failure.message ? failure.message : translate('err.refused'))
        }

        // Follow the host's active language; keep the dictionaries local.
        const locale = ctx.get('locale')
        activeLocale = readActiveLocale(locale)
        if (locale && typeof locale.subscribe === 'function') {
          const unsubscribe = locale.subscribe(() => {
            activeLocale = readActiveLocale(locale)
          })
          ctx.effect(() => unsubscribe)
        }

        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register({ name: 'conversation.input.left', id: 'keymanager-pill', order: 140 }, Pill),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'keymanager-panel', order: 500 }, Panel),
        )

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'keymanager', order: 210, label: () => translate('nav') },
            SettingsPage,
          ),
        )
      },
    }
  },
})
