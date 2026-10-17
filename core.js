/**
 * Encrypted local credential vault.
 *
 * Every secret is sealed individually with AES-256-GCM under a 32-byte master
 * key. The master key lives beside the vault by default (`vault.key`, mode
 * 0600) or comes from an environment variable when `keyEnv` names one, so the
 * key can be kept out of the data directory (for example in an OS secret
 * store that exports it before DSH starts).
 *
 * The file holds only ciphertext, its IV and auth tag, plus non-secret
 * metadata: entry names, kinds, usernames, tags and the usage log.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const FORMAT = 1
const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const MAX_SECRET_CHARS = 16_384
const MAX_USAGE = 500
const KIND_VALUES = ['login', 'token', 'api-key', 'ssh', 'note']

/** A failure carrying a stable code and a message meant for a human or model. */
export class VaultError extends Error {
  constructor(message, code = 'KEYMANAGER_ERROR') {
    super(message)
    this.name = 'VaultError'
    this.code = code
  }
}

/** Trim and bound one optional text field. */
function text(value, max, label) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new VaultError(`${label}必须是字符串`, 'BAD_INPUT')
  const trimmed = value.trim()
  if (trimmed.length > max) throw new VaultError(`${label}不能超过 ${max} 个字符`, 'BAD_INPUT')
  return trimmed
}

/** Normalize and validate one credential name. */
export function credentialName(value) {
  const name = text(value, 64, '名称')
  if (name.length === 0) throw new VaultError('缺少名称', 'BAD_INPUT')
  if (/[\r\n\t]/.test(name)) throw new VaultError('名称必须是单行，且不含制表符', 'BAD_INPUT')
  return name
}

/** Normalize one tag list. */
function tagList(value) {
  if (value === undefined || value === null) return []
  const source = Array.isArray(value) ? value : [value]
  const tags = []
  for (const item of source.slice(0, 8)) {
    const tag = text(item, 32, '标签')
    if (tag.length > 0 && !tags.includes(tag)) tags.push(tag)
  }
  return tags
}

/** Normalize one kind, falling back to `login`. */
function kindValue(value) {
  const kind = text(value, 32, '类型').toLowerCase()
  if (kind.length === 0) return 'login'
  return KIND_VALUES.includes(kind) ? kind : 'login'
}

/** Decode a master key from hex or base64 text. */
function decodeKey(raw, source) {
  const trimmed = raw.trim()
  const candidates = []
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) candidates.push(Buffer.from(trimmed, 'hex'))
  candidates.push(Buffer.from(trimmed, 'base64'))
  for (const candidate of candidates) {
    if (candidate.length === KEY_BYTES) return candidate
  }
  throw new VaultError(
    `主密钥来源 ${source} 不是 ${KEY_BYTES} 字节；需要 64 位十六进制，或 32 字节的 base64`,
    'BAD_KEY',
  )
}

/** Seal one plaintext under the master key, bound to its entry id. */
function seal(key, id, plaintext) {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(Buffer.from(id, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ciphertext.toString('base64'),
  }
}

/** Open one sealed secret, or explain why it cannot be opened. */
function open(key, id, sealed) {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, 'base64'))
    decipher.setAAD(Buffer.from(id, 'utf8'))
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new VaultError(
      '当前主密钥无法解密这条记录：主密钥已更换，或保险库被外部修改',
      'DECRYPT_FAILED',
    )
  }
}

/** Seal the account identifiers that belong with a secret. */
function sealMeta(key, id, meta) {
  return seal(key, `${id}/meta`, JSON.stringify({ username: meta.username ?? '', notes: meta.notes ?? '' }))
}

/** Open one sealed metadata blob; `locked` says why it is empty. */
function openMeta(key, id, sealed) {
  try {
    const parsed = JSON.parse(open(key, `${id}/meta`, sealed))
    return { username: typeof parsed.username === 'string' ? parsed.username : '', notes: typeof parsed.notes === 'string' ? parsed.notes : '', locked: false }
  } catch {
    return { username: '', notes: '', locked: true }
  }
}

/** Present one stored entry without its secret material. */
function entryView(entry, meta) {
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    username: meta.username,
    notes: meta.notes,
    locked: meta.locked === true,
    tags: [...entry.tags],
    autoGrant: entry.autoGrant === true,
    hasSecret: true,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastUsedAt: entry.lastUsedAt ?? null,
    useCount: entry.useCount ?? 0,
  }
}

/** The encrypted, file-backed credential store. */
export class KeyVault {
  #dir
  #keyEnv
  #envKey
  #key = null
  #state = null
  #ready = null
  #queue = Promise.resolve()

  constructor({ dir, keyEnv = 'DSH_KEYMANAGER_KEY' }) {
    this.#dir = dir
    this.#keyEnv = keyEnv
  }

  get vaultPath() {
    return join(this.#dir, 'vault.json')
  }

  get keyPath() {
    return join(this.#dir, 'vault.key')
  }

  /** Resolve once the key and state are loaded. */
  ready() {
    if (this.#ready === null) this.#ready = this.#init()
    return this.#ready
  }

  /** Paths and cipher facts for the UI. */
  async location() {
    await this.ready()
    return {
      dataDir: this.#dir,
      vaultPath: this.vaultPath,
      keyPath: this.#envKey === undefined ? this.keyPath : null,
      keySource: this.#envKey === undefined ? 'key-file' : `env:${this.#keyEnv}`,
      keyEnv: this.#keyEnv,
      algorithm: ALGORITHM,
      format: FORMAT,
    }
  }

  async #init() {
    await fs.mkdir(this.#dir, { recursive: true })
    this.#key = await this.#loadKey()
    this.#state = await this.#loadState()
  }

  async #loadKey() {
    const fromEnv = process.env[this.#keyEnv]
    if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
      this.#envKey = fromEnv
      return decodeKey(fromEnv, `环境变量 ${this.#keyEnv}`)
    }
    this.#envKey = undefined
    try {
      const existing = await fs.readFile(this.keyPath)
      if (existing.length !== KEY_BYTES) {
        throw new VaultError(`主密钥文件 ${this.keyPath} 不是 ${KEY_BYTES} 字节`, 'BAD_KEY')
      }
      return existing
    } catch (error) {
      if (error instanceof VaultError) throw error
      if (error?.code !== 'ENOENT') throw error
    }
    const created = randomBytes(KEY_BYTES)
    await this.#atomicWrite(this.keyPath, created, 0o600)
    return created
  }

  async #loadState() {
    let raw
    try {
      raw = await fs.readFile(this.vaultPath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return { format: FORMAT, algorithm: ALGORITHM, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), entries: [], usage: [] }
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new VaultError(`保险库文件 ${this.vaultPath} 不是合法 JSON`, 'BAD_VAULT')
    }
    if (parsed === null || typeof parsed !== 'object' || parsed.format !== FORMAT) {
      throw new VaultError(`保险库文件 ${this.vaultPath} 的格式不受支持`, 'BAD_VAULT')
    }
    if (!Array.isArray(parsed.entries) || !Array.isArray(parsed.usage)) {
      throw new VaultError(`保险库文件 ${this.vaultPath} 缺少条目列表或审计记录`, 'BAD_VAULT')
    }
    return parsed
  }

  async #atomicWrite(file, data, mode) {
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(temporary, data, { mode })
    await fs.rename(temporary, file)
    try {
      await fs.chmod(file, mode)
    } catch {
      /* Windows ignores POSIX modes; the profile directory ACL still applies. */
    }
  }

  async #save() {
    this.#state.updatedAt = new Date().toISOString()
    await this.#atomicWrite(this.vaultPath, `${JSON.stringify(this.#state, null, 2)}\n`, 0o600)
  }

  /** Serialize one read-modify-write cycle. */
  #mutate(operation) {
    const run = this.#queue.then(async () => {
      await this.ready()
      const result = await operation()
      await this.#save()
      return result
    })
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  #find(id) {
    const entry = this.#state.entries.find((candidate) => candidate.id === id)
    if (entry === undefined) throw new VaultError('没有这个 id 对应的凭据', 'NOT_FOUND')
    return entry
  }

  #findByName(name) {
    const wanted = credentialName(name).toLowerCase()
    return this.#state.entries.find((entry) => entry.name.toLowerCase() === wanted)
  }

  /** Decode the account identifiers sealed beside one secret. */
  #meta(entry) {
    if (entry.meta === undefined) return { username: '', notes: '', locked: false }
    return openMeta(this.#key, entry.id, entry.meta)
  }

  /** Every entry, without secrets. */
  async list() {
    await this.ready()
    return this.#state.entries.map((entry) => entryView(entry, this.#meta(entry)))
  }

  /** One entry, without its secret. */
  async get(id) {
    await this.ready()
    const entry = this.#find(id)
    return entryView(entry, this.#meta(entry))
  }

  /** One entry by name, without its secret, or undefined. */
  async findByName(name) {
    await this.ready()
    const entry = this.#findByName(name)
    return entry === undefined ? undefined : entryView(entry, this.#meta(entry))
  }

  /** Create one entry and return its view. */
  async create(input = {}) {
    return this.#mutate(async () => {
      const name = credentialName(input.name)
      if (this.#findByName(name) !== undefined) {
        throw new VaultError(`已存在名为「${name}」的凭据`, 'NAME_TAKEN')
      }
      const secret = typeof input.secret === 'string' ? input.secret : ''
      if (secret.length === 0) throw new VaultError('缺少密钥', 'BAD_INPUT')
      if (secret.length > MAX_SECRET_CHARS) {
        throw new VaultError(`密钥不能超过 ${MAX_SECRET_CHARS} 个字符`, 'BAD_INPUT')
      }
      const now = new Date().toISOString()
      const entry = {
        id: randomUUID(),
        name,
        kind: kindValue(input.kind),
        tags: tagList(input.tags),
        autoGrant: input.autoGrant === true,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
        useCount: 0,
      }
      // The AAD binds the ciphertext to the entry id, which exists from here on.
      entry.secret = seal(this.#key, entry.id, secret)
      entry.meta = sealMeta(this.#key, entry.id, {
        username: text(input.username, 256, '用户名'),
        notes: text(input.notes, 2000, '备注'),
      })
      this.#state.entries.push(entry)
      return entryView(entry, this.#meta(entry))
    })
  }

  /** Change one entry; a provided `secret` replaces the sealed value. */
  async update(id, patch = {}) {
    return this.#mutate(async () => {
      const entry = this.#find(id)
      if (patch.name !== undefined) {
        const name = credentialName(patch.name)
        const clash = this.#findByName(name)
        if (clash !== undefined && clash.id !== entry.id) {
          throw new VaultError(`已存在名为「${name}」的凭据`, 'NAME_TAKEN')
        }
        entry.name = name
      }
      if (patch.kind !== undefined) entry.kind = kindValue(patch.kind)
      if (patch.username !== undefined || patch.notes !== undefined) {
        const current = this.#meta(entry)
        entry.meta = sealMeta(this.#key, entry.id, {
          username: patch.username !== undefined ? text(patch.username, 256, '用户名') : current.username,
          notes: patch.notes !== undefined ? text(patch.notes, 2000, '备注') : current.notes,
        })
      }
      if (patch.tags !== undefined) entry.tags = tagList(patch.tags)
      if (patch.autoGrant !== undefined) entry.autoGrant = patch.autoGrant === true
      if (patch.secret !== undefined) {
        const secret = typeof patch.secret === 'string' ? patch.secret : ''
        if (secret.length === 0) throw new VaultError('密钥不能为空；保持不变就不要传这个字段', 'BAD_INPUT')
        if (secret.length > MAX_SECRET_CHARS) {
          throw new VaultError(`密钥不能超过 ${MAX_SECRET_CHARS} 个字符`, 'BAD_INPUT')
        }
        entry.secret = seal(this.#key, entry.id, secret)
      }
      entry.updatedAt = new Date().toISOString()
      return entryView(entry, this.#meta(entry))
    })
  }

  /** Delete one entry and its usage rows. */
  async remove(id) {
    return this.#mutate(async () => {
      const entry = this.#find(id)
      this.#state.entries = this.#state.entries.filter((candidate) => candidate.id !== entry.id)
      this.#state.usage = this.#state.usage.filter((row) => row.entryId !== entry.id)
      return { id: entry.id, name: entry.name }
    })
  }

  /**
   * Decrypt one entry and record the read.
   * @returns the plaintext plus the entry view.
   */
  async reveal(id, { sessionId, purpose, callId } = {}) {
    await this.ready()
    const entry = this.#find(id)
    const secret = open(this.#key, entry.id, entry.secret)
    entry.lastUsedAt = new Date().toISOString()
    entry.useCount = (entry.useCount ?? 0) + 1
    this.#state.usage.push({
      at: entry.lastUsedAt,
      entryId: entry.id,
      entryName: entry.name,
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      purpose: text(purpose, 200, 'purpose'),
      callId: typeof callId === 'string' ? callId : null,
    })
    if (this.#state.usage.length > MAX_USAGE) this.#state.usage = this.#state.usage.slice(-MAX_USAGE)
    await this.#save()
    return { entry: entryView(entry, this.#meta(entry)), secret }
  }

  /** Recent reads, newest first. */
  async usage(limit = 50) {
    await this.ready()
    const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_USAGE) : 50
    return this.#state.usage.slice(-cap).reverse()
  }
}
