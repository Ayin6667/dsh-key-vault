#!/usr/bin/env node
/**
 * Print one secret from the vault so a local script can use it without keeping
 * a plaintext copy of its own. That is the whole point: no second copy of the
 * secret on disk, and every read goes through the audit trail.
 *
 * Usage:
 *   node get-secret.mjs <name> [--data-dir <dir>] [--key-env <VAR>] [--field secret|username|notes]
 *
 * The secret goes to stdout and nothing else does; diagnostics go to stderr and
 * every failure exits non-zero, so a shell can gate on the exit status.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { KeyVault, VaultError } from './core.js'

function parseArgs(argv) {
  const options = { field: 'secret', dataDir: undefined, keyEnv: undefined, name: undefined }
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--data-dir') {
      options.dataDir = argv[index + 1]
      index += 1
    } else if (token === '--key-env') {
      options.keyEnv = argv[index + 1]
      index += 1
    } else if (token === '--field') {
      options.field = argv[index + 1]
      index += 1
    } else if (token.startsWith('--')) {
      throw new Error(`未知参数 ${token}`)
    } else {
      rest.push(token)
    }
  }
  options.name = rest[0]
  return options
}

function resolveDataDir(dataDir) {
  if (typeof dataDir === 'string' && dataDir.length > 0) return dataDir
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'keymanager')
}

try {
  const options = parseArgs(process.argv.slice(2))
  if (options.name === undefined) throw new Error('用法：node get-secret.mjs <凭据名称>')
  if (!['secret', 'username', 'notes'].includes(options.field)) throw new Error(`不支持的字段 ${options.field}`)
  const vault = new KeyVault({
    dir: resolveDataDir(options.dataDir),
    keyEnv: options.keyEnv,
  })
  // Resolve by name first (the stable identifier), then by id.
  const listed = await vault.list()
  const wanted = options.name.toLowerCase()
  const entry = listed.find((candidate) => candidate.name.toLowerCase() === wanted)
  if (entry === undefined) throw new VaultError(`找不到名为「${options.name}」的凭据`, 'NOT_FOUND')
  const { secret, entry: view } = await vault.reveal(entry.id, { purpose: 'get-secret.mjs' })
  process.stdout.write(`${options.field === 'secret' ? secret : String(view[options.field] ?? '')}\n`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`keymanager: ${message}\n`)
  process.exitCode = 1
}
