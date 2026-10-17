/**
 * Host half of the key manager: an encrypted credential vault, the session
 * grants that decide what the agent may read, the agent tools, and the
 * authenticated HTTP endpoint the Client half uses.
 *
 * The endpoint is an exact webServer route at POST /keymanager/rpc. It runs
 * `connection.admit()` first, so the Host/Origin fence and the browser-session
 * cookie are enforced by the host's own connection service, not by this
 * plugin.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendFile, mkdir, stat, truncate } from 'node:fs/promises'
import { KeyVault, VaultError, credentialName } from './core.js'

/** Stable Loader identity. */
const RPC_PATH = '/keymanager/rpc'
const TOOL_PREFIX = 'credential'
const MAX_BODY_BYTES = 256 * 1024
const DIAG_MAX_BYTES = 256 * 1024

/** Services this half needs; without them the whole plugin stays inactive. */
export const inject = ['tools', 'webServer', 'connection']

/** Where the vault lives unless the patch config overrides it. */
function resolveDataDir(config) {
  const configured = typeof config?.dataDir === 'string' ? config.dataDir.trim() : ''
  if (configured.length > 0) return configured
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'keymanager')
}

/**
 * Append-only diagnostic log beside the vault. It records RPC outcomes only
 * (endpoint, status, error text), never argument values or secrets, and is
 * best-effort: a failed write never breaks a call.
 */
function createDiagnostics(dir) {
  const file = join(dir, 'rpc.log')
  let chain = Promise.resolve()
  return (line) => {
    chain = chain.then(async () => {
      try {
        await mkdir(dir, { recursive: true })
        const info = await stat(file).catch(() => undefined)
        if (info !== undefined && info.size > DIAG_MAX_BYTES) await truncate(file, 0)
        await appendFile(file, `${new Date().toISOString()} ${line}\n`)
      } catch {
        /* diagnostics must never break a call */
      }
    })
  }
}

/** One sentence naming the next action after a refusal. */
const NOT_AVAILABLE_HELP =
  '是否允许某个对话读取凭据由用户决定：请让用户在输入框旁的钥匙面板里为本对话打开这条凭据，或在「设置 > 凭据」里勾选「所有对话都可读取」。'

/** How long one in-conversation access request waits for the user's answer. */
const APPROVAL_TIMEOUT_MS = 120_000
const ALLOW_LABEL = '允许本对话使用'
const DENY_LABEL = '拒绝'

/**
 * Ask the user, inside the conversation, whether this session may read one
 * entry. Returns 'allowed' | 'denied' | 'timeout' | 'unavailable'; only the
 * user's own answer can produce 'allowed'.
 */
async function requestAccess({ userQuestions, agent, callId, signal, entry, purpose }) {
  if (userQuestions === undefined || typeof userQuestions.askTimed !== 'function') return 'unavailable'
  if (agent === undefined || callId === undefined) return 'unavailable'
  const question = {
    id: 'keymanager-access',
    header: '凭据访问申请',
    question: `允许本对话读取凭据「${entry.name}」吗？`,
    detail: purpose.length > 0 ? `Agent 说明的用途：${purpose}` : 'Agent 没有说明用途。',
    options: [
      { label: ALLOW_LABEL, description: '本对话内可反复读取，应用重启后失效。' },
      { label: DENY_LABEL, description: '不开放，Agent 拿不到这条密钥。' },
    ],
  }
  let result
  try {
    result = await userQuestions.askTimed(
      { agent, questions: [question], ...(signal === undefined ? {} : { signal }) },
      callId,
      APPROVAL_TIMEOUT_MS,
    )
  } catch {
    return 'unavailable'
  }
  if (result === undefined || result === null) return 'unavailable'
  if (result.pending === true) return 'timeout'
  const selected = result.answers?.[0]?.selected?.[0] ?? ''
  return selected === ALLOW_LABEL ? 'allowed' : 'denied'
}

/** Session-aware facade over the vault. Grants live in process memory only. */
class KeyManager {
  #vault
  #grants = new Map()

  constructor(vault) {
    this.#vault = vault
  }

  #granted(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    return this.#grants.get(sessionId)
  }

  #available(entry, sessionId) {
    if (entry.autoGrant === true) return true
    return this.#granted(sessionId)?.has(entry.id) === true
  }

  #sessionsGranting(entryId) {
    let count = 0
    for (const set of this.#grants.values()) if (set.has(entryId)) count += 1
    return count
  }

  async describe(sessionId) {
    const [storage, entries, usage] = await Promise.all([
      this.#vault.location(),
      this.#vault.list(),
      this.#vault.usage(50),
    ])
    const views = entries.map((entry) => ({
      ...entry,
      available: this.#available(entry, sessionId),
      sessionCount: this.#sessionsGranting(entry.id),
    }))
    return {
      storage,
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      availableCount: views.filter((entry) => entry.available).length,
      entries: views,
      usage,
    }
  }

  async create(input = {}) {
    return this.#vault.create(input)
  }

  async update(input = {}) {
    if (typeof input.id !== 'string') throw new VaultError('缺少 id', 'BAD_INPUT')
    return this.#vault.update(input.id, input.patch ?? {})
  }

  async remove(id) {
    if (typeof id !== 'string') throw new VaultError('缺少 id', 'BAD_INPUT')
    const removed = await this.#vault.remove(id)
    for (const set of this.#grants.values()) set.delete(removed.id)
    return removed
  }

  async setGrant(sessionId, id, enabled) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new VaultError('这个操作需要对话 id', 'NO_SESSION')
    }
    if (typeof id !== 'string') throw new VaultError('缺少 id', 'BAD_INPUT')
    await this.#vault.get(id)
    const set = this.#grants.get(sessionId) ?? new Set()
    if (enabled) set.add(id)
    else set.delete(id)
    if (set.size === 0) this.#grants.delete(sessionId)
    else this.#grants.set(sessionId, set)
    if (this.#grants.size > 200) {
      const oldest = this.#grants.keys().next().value
      if (oldest !== undefined && oldest !== sessionId) this.#grants.delete(oldest)
    }
    return { sessionId, id, enabled: Boolean(enabled) }
  }

  /** Find one entry by name (preferred) or id, refusing names that do not exist. */
  async locate(reference) {
    const name = credentialName(reference)
    const byName = await this.#vault.findByName(name)
    if (byName !== undefined) return byName
    const listed = await this.#vault.list()
    const byId = listed.find((entry) => entry.id === reference)
    if (byId !== undefined) return byId
    const known = listed.map((entry) => entry.name)
    const suffix = known.length === 0 ? '保险库为空' : `已知名称：${known.join('、')}`
    throw new VaultError(`找不到名为「${name}」的凭据（${suffix}）`, 'NOT_FOUND')
  }

  /** Whether this conversation may read the entry right now. */
  mayRead(entry, sessionId) {
    return this.#available(entry, sessionId)
  }

  async reveal({ sessionId, reference, purpose, callId }) {
    const found = await this.locate(reference)
    if (!this.#available(found, sessionId)) {
      throw new VaultError(`凭据「${found.name}」未对本对话开放。${NOT_AVAILABLE_HELP}`, 'NOT_AVAILABLE')
    }
    const { entry, secret } = await this.#vault.reveal(found.id, { sessionId, purpose, callId })
    return { ...entry, secret }
  }

  /** Store one credential from conversation input; never reads secrets back. */
  async save(input = {}) {
    const existing = await this.#vault.findByName(input.name)
    if (existing === undefined) return this.#vault.create(input)
    if (input.overwrite !== true) {
      throw new VaultError(
        `凭据「${existing.name}」已存在；确需覆盖请传 overwrite=true，或换一个名称`,
        'NAME_TAKEN',
      )
    }
    return this.#vault.update(existing.id, {
      kind: input.kind,
      username: input.username,
      notes: input.notes,
      tags: input.tags,
      secret: input.secret,
    })
  }
}

/** Chinese label for one stored kind, for model-facing summaries. */
const KIND_LABELS = {
  login: '登录',
  token: '令牌',
  'api-key': 'API Key',
  ssh: 'SSH 密钥',
  note: '备注',
}

/** Compact model-facing summary of a vault listing. */
function renderListing(value) {
  const lines = [`保险库：${value.storage.vaultPath}（${value.storage.algorithm}）`]
  lines.push(`本对话：${value.sessionId ?? '无'} · 可读 ${value.availableCount}/${value.entries.length}`)
  if (value.entries.length === 0) {
    lines.push('尚无任何凭据')
    return lines.join('\n')
  }
  for (const entry of value.entries) {
    const facts = [KIND_LABELS[entry.kind] ?? entry.kind]
    if (entry.username.length > 0) facts.push(`用户名 ${entry.username}`)
    facts.push(entry.available ? '本对话可读' : '本对话未开放（可向用户申请）')
    if (entry.autoGrant) facts.push('所有对话可读')
    if (entry.useCount > 0) facts.push(`已读取 ${entry.useCount} 次`)
    lines.push(`- ${entry.name}［${facts.join('，')}］`)
    if (entry.notes.length > 0) lines.push(`  备注：${entry.notes}`)
  }
  return lines.join('\n')
}

const entryViewSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string' },
    username: { type: 'string' },
    notes: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    autoGrant: { type: 'boolean' },
    available: { type: 'boolean' },
    sessionCount: { type: 'integer' },
    useCount: { type: 'integer' },
    lastUsedAt: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
}

/** Read one JSON request body, refusing oversized payloads. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** Register the agent tools and the Client endpoint. */
export function apply(ctx, config = {}) {
  const dataDir = resolveDataDir(config)
  const vault = new KeyVault({
    dir: dataDir,
    keyEnv: typeof config?.keyEnv === 'string' && config.keyEnv.length > 0 ? config.keyEnv : undefined,
  })
  const manager = new KeyManager(vault)
  const diag = createDiagnostics(dataDir)

  const sessionOf = (exec) => {
    const id = exec?.agent?.id ?? exec?.agent?.session?.id
    return typeof id === 'string' ? id : undefined
  }

  const dispatch = async (method, args) => {
    const input = args !== null && typeof args === 'object' ? args : {}
    switch (method) {
      case 'list':
        return manager.describe(typeof input.sessionId === 'string' ? input.sessionId : undefined)
      case 'create':
        return manager.create(input)
      case 'update':
        return manager.update(input)
      case 'remove':
        return manager.remove(input.id)
      case 'grant':
        return manager.setGrant(input.sessionId, input.id, input.enabled !== false)
      case 'usage':
        return vault.usage(typeof input.limit === 'number' ? input.limit : 50)
      default:
        throw new VaultError(`未知方法「${method}」`, 'UNKNOWN_METHOD')
    }
  }

  ctx.effect(
    () =>
      ctx.tools.register({
        name: `${TOOL_PREFIX}_list`,
        description:
          '列出用户本地加密凭据库中的全部凭据（不论本对话是否可用）：名称、类型、用户名、备注、标签，以及本对话是否可读。只返回元数据，绝不返回密钥。未开放的条目可以调用 credential_reveal 向用户申请，用户同意后即可读取。',
        parameters: { type: 'object', properties: {}, additionalProperties: false, required: [] },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
            properties: {
              storage: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  vaultPath: { type: 'string' },
                  dataDir: { type: 'string' },
                  algorithm: { type: 'string' },
                  keySource: { type: 'string' },
                  keyPath: { type: 'string' },
                },
              },
              sessionId: { type: 'string' },
              availableCount: { type: 'integer' },
              entries: { type: 'array', items: entryViewSchema },
              usage: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
          },
          render: (_args, value) => [{ type: 'text', text: renderListing(value) }],
        },
        async execute(_args, exec) {
          const value = await manager.describe(sessionOf(exec))
          // The tool output schema is strings only: fold absent values into ''.
          return {
            ...value,
            sessionId: value.sessionId ?? '',
            storage: { ...value.storage, keyPath: value.storage.keyPath ?? '' },
            entries: value.entries.map((entry) => ({ ...entry, lastUsedAt: entry.lastUsedAt ?? '' })),
          }
        },
      }),
    'keymanager: credential_list',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: `${TOOL_PREFIX}_reveal`,
        description:
          '读取某条凭据的密钥，供当前对话使用。未对本对话开放的条目会向用户弹出授权确认：用户同意后本条对话随即开放，拒绝或超时则拿不到密钥。每次读取都会写入审计记录。密钥会进入本对话记录，请直接使用，不要在回复里复述。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'purpose'],
          properties: {
            name: { type: 'string', description: '凭据名称，与 credential_list 返回的一致。' },
            purpose: {
              type: 'string',
              description: '简短用途，会显示在审计记录里，例如「登录 example.com」。',
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
            properties: {
              name: { type: 'string' },
              kind: { type: 'string' },
              username: { type: 'string' },
              secret: { type: 'string' },
              notes: { type: 'string' },
              retrievedAt: { type: 'string' },
            },
          },
          render: (_args, value) => {
            const lines = []
            const account = value.username.length > 0 ? `（用户名：${value.username}）` : ''
            lines.push(`凭据「${value.name}」${account}的密钥：`)
            lines.push(value.secret)
            if (value.notes.length > 0) lines.push(`备注：${value.notes}`)
            return [{ type: 'text', text: lines.join('\n') }]
          },
        },
        async execute(args, exec) {
          const name = typeof args?.name === 'string' ? args.name : ''
          const purpose = typeof args?.purpose === 'string' ? args.purpose : ''
          if (name.length === 0) throw new Error('缺少 name')
          const sessionId = sessionOf(exec)
          const found = await manager.locate(name)
          if (!manager.mayRead(found, sessionId)) {
            const outcome = await requestAccess({
              userQuestions: ctx.get('userQuestions'),
              agent: exec.agent,
              callId: exec.callId,
              signal: exec.signal,
              entry: found,
              purpose,
            })
            if (outcome !== 'allowed') {
              if (outcome === 'denied') {
                throw new VaultError(`用户拒绝了本对话读取凭据「${found.name}」的申请。`, 'ACCESS_DENIED')
              }
              if (outcome === 'timeout') {
                throw new VaultError(
                  `等待用户授权超时（${APPROVAL_TIMEOUT_MS / 1000} 秒）。请让用户在输入框旁的钥匙面板里打开该凭据，或重新发起一次读取申请。`,
                  'ACCESS_TIMEOUT',
                )
              }
              throw new VaultError(
                `当前环境无法弹出授权确认，请让用户在输入框旁的钥匙面板里打开凭据「${found.name}」。`,
                'NOT_AVAILABLE',
              )
            }
            // The user's own answer granted this conversation; remember it.
            await manager.setGrant(sessionId, found.id, true)
          }
          const revealed = await manager.reveal({
            sessionId,
            reference: name,
            purpose,
            callId: typeof exec?.callId === 'string' ? exec.callId : undefined,
          })
          return {
            name: revealed.name,
            kind: revealed.kind,
            username: revealed.username,
            secret: revealed.secret,
            notes: revealed.notes,
            retrievedAt: revealed.lastUsedAt ?? '',
          }
        },
      }),
    'keymanager: credential_reveal',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: `${TOOL_PREFIX}_save`,
        description:
          '把登录凭据、令牌或备注存入用户的本地加密凭据库，供以后的对话使用。不会读回已有密钥。覆盖用户已命名的条目必须显式传 overwrite=true，覆盖前先征得用户同意。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'secret'],
          properties: {
            name: { type: 'string', description: '以后读取时用的稳定名称，例如 example.com。' },
            secret: { type: 'string', description: '密码、令牌或私钥原文。' },
            kind: {
              type: 'string',
              enum: ['login', 'token', 'api-key', 'ssh', 'note'],
              description: '凭据类型；默认 login（登录）。',
            },
            username: { type: 'string', description: '账号名或邮箱（这条凭据有的话）。' },
            notes: { type: 'string', description: '用在哪里，或使用它需要知道什么。' },
            tags: { type: 'array', items: { type: 'string' }, description: '可选标签。' },
            autoGrant: {
              type: 'boolean',
              description: '让它在所有对话里都可读，省去每个对话单独开关。默认 false。',
            },
            overwrite: { type: 'boolean', description: '覆盖同名条目。' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              kind: { type: 'string' },
              username: { type: 'string' },
              created: { type: 'boolean' },
            },
          },
          render: (_args, value) => [
            {
              type: 'text',
              text: `${value.created ? '已存入' : '已更新'}凭据「${value.name}」（${KIND_LABELS[value.kind] ?? value.kind}），保存在本地加密保险库里。用户可以在输入框旁的钥匙面板里为某个对话打开它。`,
            },
          ],
        },
        async execute(args, exec) {
          if (typeof args?.name !== 'string' || args.name.trim().length === 0) throw new Error('缺少 name')
          if (typeof args?.secret !== 'string' || args.secret.length === 0) throw new Error('缺少 secret')
          const existed = (await vault.findByName(args.name)) !== undefined
          const saved = await manager.save({ ...args, overwrite: args.overwrite === true })
          const sessionId = sessionOf(exec)
          if (!existed && args.autoGrant !== true && typeof sessionId === 'string') {
            // The conversation that stored it can read it back immediately.
            await manager.setGrant(sessionId, saved.id, true)
          }
          return {
            id: saved.id,
            name: saved.name,
            kind: saved.kind,
            username: saved.username,
            created: !existed,
          }
        },
      }),
    'keymanager: credential_save',
  )

  // Client endpoint: the host connection service owns the request fence and
  // the browser-session check, so no second authentication scheme exists here.
  const endpoint = async (req, res) => {
    const admission = ctx.connection.admit({ headers: req.headers })
    if ('rejection' in admission) {
      diag(`reject ${admission.rejection} ${req.method ?? '?'} ${req.url ?? '?'}`)
      res.writeHead(admission.rejection)
      res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    const body = await readJsonBody(req)
    if (body === undefined || body === null || typeof body !== 'object' || typeof body.method !== 'string') {
      diag('bad-request')
      writeJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: '需要 { method, args } 形式的请求体' } })
      return
    }
    try {
      const value = await dispatch(body.method, body.args ?? null)
      writeJson(res, 200, { ok: true, value })
      diag(`ok ${body.method}`)
    } catch (error) {
      const code = error instanceof VaultError ? error.code : 'KEYMANAGER_FAILED'
      const message = error instanceof Error ? error.message : String(error)
      writeJson(res, 200, { ok: false, error: { code, message } })
      diag(`error ${body.method} ${code} ${message.slice(0, 300)}`)
    }
  }

  ctx.effect(() => {
    diag('apply')
    const dispose = ctx.webServer.register({ kind: 'exact', path: RPC_PATH, handler: endpoint })
    diag(`route ${RPC_PATH}`)
    return () => {
      diag('dispose')
      dispose()
    }
  }, 'keymanager: rpc endpoint')
}
