// Vault round-trip probe: crypto, persistence, audit, and a wrong-key run.
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { KeyVault } from '../core.js'

const out = []
const log = (...parts) => out.push(parts.join(' '))

const base = mkdtempSync(join(tmpdir(), 'dkm-'))
const dir = join(base, 'vault-a')
process.env.DKM_TEST_KEY = ''
const vault = new KeyVault({ dir, keyEnv: 'DKM_TEST_KEY' })

const created = await vault.create({
  name: 'example.com',
  kind: 'login',
  username: 'me@example.com',
  secret: 'S3cr3t-\u00dcn\u00efcode-\u503c',
  notes: 'test account',
  tags: ['test', 'web'],
})
log('created', created.id.length === 36, created.name, created.kind, created.autoGrant === false, created.username === 'me@example.com')

const listing = await vault.list()
log('listed', listing.length === 1, 'secret' in listing[0] === false, listing[0].username === 'me@example.com')

const revealed = await vault.reveal(created.id, { sessionId: 'session-abc', purpose: 'unit probe' })
log('reveal', revealed.secret === 'S3cr3t-\u00dcn\u00efcode-\u503c')

const raw = readFileSync(vault.vaultPath, 'utf8')
log('encrypted-at-rest', !raw.includes('S3cr3t'), !raw.includes('me@example.com'), !raw.includes('test account'))
log('raw-has-ciphertext', raw.includes('"ct"') && raw.includes('"tag"') && raw.includes('"meta"'))

const usage = await vault.usage(10)
log('usage', usage.length === 1, usage[0].entryName === 'example.com', usage[0].sessionId === 'session-abc')

await vault.update(created.id, { secret: 'rotated-value', notes: 'changed' })
const second = await vault.reveal(created.id, {})
log('rotate', second.secret === 'rotated-value', second.entry.notes === 'changed', second.entry.username === 'me@example.com', second.entry.useCount === 2)

// A second instance over the same directory reuses the persisted key.
const reopened = new KeyVault({ dir, keyEnv: 'DKM_TEST_KEY' })
const third = await reopened.reveal(created.id, {})
log('reopen', third.secret === 'rotated-value', third.entry.username === 'me@example.com')

// Another directory with its own key must not open this ciphertext.
const foreignDir = join(base, 'vault-b')
mkdirSync(foreignDir, { recursive: true })
copyFileSync(join(dir, 'vault.json'), join(foreignDir, 'vault.json'))
const foreign = new KeyVault({ dir: foreignDir, keyEnv: 'DKM_TEST_KEY' })
let foreignCode = 'none'
try {
  await foreign.reveal(created.id, {})
} catch (error) {
  foreignCode = error.code
}
const foreignList = await foreign.list()
log('wrong-key', foreignCode === 'DECRYPT_FAILED', foreignCode, foreignList[0].locked === true)

let duplicate = 'none'
try {
  await vault.create({ name: 'EXAMPLE.COM', secret: 'x' })
} catch (error) {
  duplicate = error.code
}
log('duplicate-name', duplicate === 'NAME_TAKEN', duplicate)

const removed = await vault.remove(created.id)
log('removed', removed.name === 'example.com', (await vault.list()).length === 0, (await vault.usage()).length === 0)

// The key file holds exactly 32 bytes.
const keyBytes = readFileSync(join(dir, 'vault.key'))
log('key-file', keyBytes.length === 32)

writeFileSync(process.env.PROBE_OUT ?? 'vault-probe.txt', out.join('\n') + '\n')
