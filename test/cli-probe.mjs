// CLI probe: the helper a script uses instead of keeping its own plaintext copy.
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { KeyVault } from '../core.js'

const out = []
const log = (...parts) => out.push(parts.join(' '))

process.env.DKM_CLI_KEY = 'a'.repeat(64)
const dir = mkdtempSync(join(tmpdir(), 'dkm-cli-'))
const vault = new KeyVault({ dir, keyEnv: 'DKM_CLI_KEY' })
await vault.create({ name: 'cli.example', secret: 's3cret-value', username: 'me@cli', notes: 'cli note' })

const script = fileURLToPath(new URL('../get-secret.mjs', import.meta.url))
const run = (...args) => execFileSync(process.execPath, [script, ...args], { env: process.env, encoding: 'utf8' })
const base = ['--data-dir', dir, '--key-env', 'DKM_CLI_KEY']

log('cli-secret', run('cli.example', ...base).trim() === 's3cret-value')
log('cli-username', run('cli.example', ...base, '--field', 'username').trim() === 'me@cli')
log('cli-notes', run('cli.example', ...base, '--field', 'notes').trim() === 'cli note')

let missing = 0
try {
  run('nope', ...base)
} catch (error) {
  missing = error.status
}
log('cli-missing', missing === 1)

// The read is audited like any other read — checked from a fresh instance,
// because the CLI process wrote the audit rows to disk.
const reader = new KeyVault({ dir, keyEnv: 'DKM_CLI_KEY' })
const usage = await reader.usage(10)
log('cli-audited', usage.length === 3, usage.every((row) => row.purpose === 'get-secret.mjs'), usage[0]?.sessionId === null)

writeFileSync(process.env.PROBE_OUT ?? 'cli-probe.txt', out.join('\n') + '\n')
