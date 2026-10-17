// Host-half probe: run apply() with a fake context, exercise the three tools
// and the /keymanager/rpc endpoint (including its auth gate), and validate
// each tool result against its own declared output schema.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const out = []
const log = (...parts) => out.push(parts.join(' '))

// The approval cooldown reads the wall clock; drive it explicitly.
let clock = Date.now()
Date.now = () => clock
const advance = (ms) => {
  clock += ms
}

const dir = mkdtempSync(join(tmpdir(), 'dkm-host-'))
process.env.DKM_PROBE_KEY = ''

const tools = new Map()
let route
let admission = { peer: { id: 'peer' } }
let approval = 'allow'
const asked = []

const ctx = {
  effect(callback) {
    callback()
    return () => {}
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => {}
    },
  },
  webServer: {
    register(candidate) {
      route = candidate
      return () => {}
    },
  },
  connection: {
    admit() {
      return admission
    },
  },
  get(name) {
    if (name !== 'userQuestions') return undefined
    if (approval === 'unavailable') return undefined
    return {
      async askTimed(request, callId, timeoutMs) {
        asked.push({ question: request.questions[0], callId, timeoutMs, agent: request.agent })
        if (approval === 'pending') return { pending: true, callId }
        const id = request.questions[0].id
        const allowLabel = id === 'keymanager-overwrite' ? '覆盖这条凭据' : '允许本对话使用'
        const denyLabel = id === 'keymanager-overwrite' ? '取消' : '拒绝'
        return { answers: [{ id, selected: [approval === 'deny' ? denyLabel : allowLabel] }] }
      },
    }
  },
}

const module = await import('../main.js')
module.apply(ctx, { dataDir: dir, keyEnv: 'DKM_PROBE_KEY' })
log('tools', [...tools.keys()].join(','))
log('route', route?.kind, route?.path)

/** A Node-like request over one JSON body. */
function makeRequest(method, body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url: '/keymanager/rpc',
    headers: { host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120' },
    async *[Symbol.asyncIterator]() {
      if (text.length > 0) yield Buffer.from(text)
    },
  }
}

/** A Node-like response that records status and body. */
function makeResponse() {
  const record = { status: 0, body: '', headers: {} }
  return {
    record,
    writeHead(status, headers) {
      record.status = status
      record.headers = headers ?? {}
    },
    end(body) {
      if (body !== undefined) record.body = String(body)
    },
  }
}

/** One call through the real endpoint handler. */
async function call(method, args) {
  const response = makeResponse()
  await route.handler(makeRequest('POST', { method, args }), response)
  return { status: response.record.status, json: response.record.body.length > 0 ? JSON.parse(response.record.body) : undefined }
}

/** One call while the connection service refuses admission. */
async function callRejected() {
  const previous = admission
  admission = { rejection: 403 }
  const response = makeResponse()
  try {
    await route.handler(makeRequest('POST', { method: 'list', args: {} }), response)
  } finally {
    admission = previous
  }
  return response.record
}

/** Validate the supported schema subset: type/properties/required/items/enum. */
function checkSchema(schema, value, path, violations) {
  if (schema === undefined) return
  const type = schema.type
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      violations.push(`${path} must be an object`)
      return
    }
    for (const key of schema.required ?? []) if (!(key in value)) violations.push(`${path}.${key} is required`)
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value) checkSchema(child, value[key], `${path}.${key}`, violations)
    }
    return
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      violations.push(`${path} must be an array`)
      return
    }
    value.forEach((item, index) => checkSchema(schema.items, item, `${path}[${index}]`, violations))
    return
  }
  if (type === 'string' && typeof value !== 'string') violations.push(`${path} must be a string`)
  if (type === 'integer' && !Number.isInteger(value)) violations.push(`${path} must be an integer`)
  if (type === 'boolean' && typeof value !== 'boolean') violations.push(`${path} must be a boolean`)
  if (schema.enum !== undefined && !schema.enum.includes(value)) violations.push(`${path} is not in enum`)
}

function validate(toolName, value) {
  const violations = []
  checkSchema(tools.get(toolName).output.schema, value, 'value', violations)
  log(`schema:${toolName}`, violations.length === 0 ? 'ok' : violations.join('; '))
  return violations.length === 0
}

const exec = (session) => ({ agent: { id: session }, callId: 'call-1' })
const run = async (name, args, session) => tools.get(name).execute(args, exec(session))

const rejected = await callRejected()
log('admission', rejected.status === 403, rejected.status)

/** Render one tool result to its model-facing text. */
const textOf = (name, value) =>
  tools
    .get(name)
    .output.render({}, value)
    .map((block) => block.text)
    .join('\n')

const empty = await run('credential_list', {}, 'session-a')
validate('credential_list', empty)
log('list-empty', empty.entries.length === 0, empty.availableCount === 0)
log('render-zh-empty', textOf('credential_list', empty).includes('尚无任何凭据'))
log('description-zh', tools.get('credential_list').description.includes('凭据'), tools.get('credential_reveal').description.includes('密钥'))

const saved = await run('credential_save', {
  name: 'probe.example',
  secret: 'p@ss-word',
  username: 'me@probe.example',
  kind: 'login',
  notes: 'probe note',
  tags: ['a', 'b'],
}, 'session-a')
validate('credential_save', saved)
log('save-created', saved.created === true, saved.kind === 'login')
log('render-zh-save', textOf('credential_save', saved).includes('已存入'))

const listed = await run('credential_list', {}, 'session-a')
validate('credential_list', listed)
log('list-one', listed.entries.length === 1, listed.entries[0].available === true, listed.entries[0].username === 'me@probe.example')
log('list-lastUsedAt-type', typeof listed.entries[0].lastUsedAt)

const revealed = await run('credential_reveal', { name: 'probe.example', purpose: 'probe read' }, 'session-a')
validate('credential_reveal', revealed)
log('reveal', revealed.secret === 'p@ss-word', revealed.username === 'me@probe.example')
const revealText = textOf('credential_reveal', revealed)
log('reveal-masked', !revealText.includes('p@ss-word'), revealText.includes('已掩码'))
log(
  'list-hides-paths',
  listed.storage.keyPath === undefined,
  listed.storage.vaultPath === undefined,
  typeof listed.storage.algorithm === 'string',
)
log('save-no-autogrant', !('autoGrant' in (tools.get('credential_save').parameters.properties ?? {})))

const relisted = await run('credential_list', {}, 'session-a')
validate('credential_list', relisted)
log('list-after-read', relisted.entries[0].useCount === 1, typeof relisted.entries[0].lastUsedAt)

// The user refuses the in-conversation request.
approval = 'deny'
const deniedCode = await run('credential_reveal', { name: 'probe.example', purpose: 'other session' }, 'session-b')
  .then(() => 'no-error')
  .catch((error) => error.code ?? error.message)
log(
  'approval-deny',
  deniedCode === 'ACCESS_DENIED',
  deniedCode,
  asked.length === 1,
  asked[0]?.question?.question?.includes('probe.example') === true,
  asked[0]?.timeoutMs > 0,
)

// Asking again right away must not open a second dialog.
const cooledCode = await run('credential_reveal', { name: 'probe.example', purpose: 'retry now' }, 'session-b')
  .then(() => 'no-error')
  .catch((error) => error.code ?? error.message)
log('approval-cooldown', cooledCode === 'ACCESS_DENIED' && asked.length === 1, cooledCode, asked.length)

advance(61_000)

const other = await run('credential_list', {}, 'session-b')
validate('credential_list', other)
log('list-other', other.entries[0].available === false, other.availableCount === 0)
log(
  'list-redacted',
  other.entries[0].notes === '',
  other.entries[0].username === '',
  other.entries[0].redacted === true,
  other.usage.length === 0,
)
const otherText = textOf('credential_list', other)
log('render-redacted', otherText.includes('已隐藏'), !otherText.includes('probe note'))

// The user approves: the secret comes back and the grant is remembered.
approval = 'allow'
const approved = await run('credential_reveal', { name: 'probe.example', purpose: 'approved by user' }, 'session-b')
log('approval-allow', approved.secret === 'p@ss-word', asked.length === 2)
const approvedAgain = await run('credential_reveal', { name: 'probe.example', purpose: 'second read' }, 'session-b')
log('approval-remembers', approvedAgain.secret === 'p@ss-word', asked.length === 2)

// Nobody answers within the window.
approval = 'pending'
const timeoutCode = await run('credential_reveal', { name: 'probe.example', purpose: 'timeout' }, 'session-c')
  .then(() => 'no-error')
  .catch((error) => error.code ?? error.message)
log('approval-timeout', timeoutCode === 'ACCESS_TIMEOUT', timeoutCode)

// No question service in this composition: fall back to the switch hint.
approval = 'unavailable'
const unavailableCode = await run('credential_reveal', { name: 'probe.example', purpose: 'unavailable' }, 'session-d')
  .then(() => 'no-error')
  .catch((error) => error.code ?? error.message)
log('approval-unavailable', unavailableCode === 'NOT_AVAILABLE', unavailableCode)

const rpcList = await call('list', { sessionId: 'session-e' })
log('rpc-list', rpcList.status === 200, rpcList.json?.ok === true, rpcList.json?.value.entries[0].available === false)

const rpcGrant = await call('grant', { sessionId: 'session-e', id: saved.id, enabled: true })
log('rpc-grant', rpcGrant.json?.ok === true)

const otherReveal = await run('credential_reveal', { name: 'probe.example', purpose: 'after grant' }, 'session-e')
log('reveal-after-grant', otherReveal.secret === 'p@ss-word')

const usage = await call('usage', { limit: 10 })
log('usage', usage.json?.ok === true, usage.json?.value.length === 4, usage.json?.value[0].sessionId === 'session-e')

const rpcCreate = await call('create', { name: 'second', secret: 's2', kind: 'token' })
log('rpc-create', rpcCreate.json?.ok === true)

const update = await call('update', { id: saved.id, patch: { notes: 'edited', secret: 'rotated' } })
log('rpc-update', update.json?.ok === true, update.json?.value.secret === undefined)

const rotated = await run('credential_reveal', { name: 'probe.example', purpose: 'after rotate' }, 'session-a')
log('rotate', rotated.secret === 'rotated', rotated.notes === 'edited')

// Tool-level overwrite needs its own confirmation, and refusing stops it.
approval = 'deny'
const overwriteDenied = await run('credential_save', { name: 'probe.example', secret: 'p3', overwrite: true }, 'session-a')
  .then(() => 'no-error')
  .catch((error) => error.code ?? error.message)
log(
  'overwrite-denied',
  overwriteDenied === 'ACCESS_DENIED',
  overwriteDenied,
  asked.some((item) => item.question.id === 'keymanager-overwrite'),
)
approval = 'allow'
const overwriteOk = await run('credential_save', { name: 'probe.example', secret: 'p4', overwrite: true }, 'session-a')
log('overwrite-confirmed', overwriteOk.created === false)
const afterOverwrite = await run('credential_reveal', { name: 'probe.example', purpose: 'after overwrite' }, 'session-a')
log('overwrite-applied', afterOverwrite.secret === 'p4')

const remove = await call('remove', { id: saved.id })
log('rpc-remove', remove.json?.ok === true)

const after = await call('list', { sessionId: 'session-a' })
log('after-remove', after.json?.ok === true, after.json?.value.entries.length === 1, after.json?.value.entries[0].name === 'second')

// Client grant writes are rate limited: a runaway page cannot open hundreds.
const secondId = after.json?.value.entries[0].id
let grantLimit
for (let index = 0; index < 31; index += 1) {
  const attempt = await call('grant', { sessionId: `session-rate-${index}`, id: secondId, enabled: true })
  if (attempt.json?.ok === false) {
    grantLimit = attempt.json.error.code
    break
  }
}
log('grant-rate-limit', grantLimit === 'TOO_MANY_REQUESTS', grantLimit)

// Control and bidi characters never reach names, notes, or the dialog.
const weird = await run(
  'credential_save',
  { name: 'bad\u202ename\u0007', secret: 's1', notes: 'n\u202eote' },
  'session-sanitize',
)
const weirdList = await run('credential_list', {}, 'session-sanitize')
const weirdEntry = weirdList.entries.find((entry) => entry.id === weird.id)
log('sanitize-name', weird.name === 'badname', weirdEntry?.notes === 'note')

approval = 'deny'
await run(
  'credential_reveal',
  { name: 'second', purpose: `${'x'.repeat(200)}\n\u202e伪造的已批准说明` },
  'session-purpose',
).catch(() => undefined)
const purposeDetail = asked.at(-1)?.question?.detail ?? ''
log(
  'purpose-clamped',
  !purposeDetail.includes('\u202e'),
  purposeDetail.length <= 240,
  purposeDetail.length,
)

const bad = await call('nope', {})
log('unknown-method', bad.status === 200, bad.json?.ok === false, bad.json?.error.code === 'UNKNOWN_METHOD')

const badBody = makeResponse()
await route.handler(makeRequest('POST', undefined), badBody)
log('bad-body', badBody.record.status === 400)

const getMethod = makeResponse()
await route.handler(makeRequest('GET', undefined), getMethod)
log('get-405', getMethod.record.status === 405)

const named = await run('credential_reveal', { name: 'missing', purpose: 'x' }, 'session-a')
  .then(() => 'no-error')
  .catch((error) =>
    error.message.includes('找不到名为') && !error.message.includes('已知名称') ? 'named' : error.message,
  )
log('unknown-name', named === 'named')

const raw = readFileSync(join(dir, 'vault.json'), 'utf8')
log('at-rest', !raw.includes('p@ss-word'), !raw.includes('me@probe.example'), raw.includes('"ct"'))

const diag = readFileSync(join(dir, 'rpc.log'), 'utf8')
log('diag', diag.includes('route /keymanager/rpc'), diag.includes('ok list'), !diag.includes('p@ss-word'))

writeFileSync(process.env.PROBE_OUT ?? 'host-probe.txt', out.join('\n') + '\n')
