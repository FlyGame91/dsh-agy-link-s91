// Repair tool for the Windows credential-slot corruption (2026-10-03).
//
// Restores the primary account's system-wide login and quarantines any
// isolated account whose token file was overwritten by another account's
// credential. Those accounts cannot be repaired from disk — their OAuth grant
// is gone — so they are flagged for re-login instead of silently reporting (and
// spending) the primary's quota.
//
// Usage:
//   node --experimental-transform-types scripts/repair-pool.mts            # dry run
//   node --experimental-transform-types scripts/repair-pool.mts --apply    # write
import { homedir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { AccountPoolManager } from '../src/host/pool.ts'
import {
  accountTokenFilePath,
  credentialFingerprint,
  findDuplicateCredentialIdentities,
  resolvePrimaryCredential,
  sameCredentialGrant,
} from '../src/host/credential-slot.ts'
import { readWindowsCredentialRaw, writeWindowsCredentialRaw } from '../src/host/wincred.ts'

const APPLY = process.argv.includes('--apply')
const SLOT = 'gemini:antigravity'

const pool = new AccountPoolManager()
const homeDir = homedir()
const log = (m: string): void => console.log('  ' + m)

console.log(`dsh-agy-link pool repair — ${APPLY ? 'APPLY' : 'DRY RUN'}`)
console.log(`pool dir: ${pool.dir}`)
console.log('')

// ---- 1. Primary credential ------------------------------------------------
console.log('[1] primary credential')

// Always re-derive here: the store may itself hold a degraded document (the
// pre-fix writer dropped refresh tokens), and a refresh-token-less credential
// cannot be identified.
const primary = await resolvePrimaryCredential(pool, {
  baseDir: pool.dir,
  homeDir,
  log,
  force: true,
})
if (!primary) {
  console.log('  !! cannot verify a primary credential — leaving everything untouched')
  process.exit(2)
}
log(`resolved as ${primary.email ?? 'unknown (email not recorded)'}`)

// ---- 2. Slot contents -----------------------------------------------------
console.log('')
console.log('[2] windows credential slot')
const slotRaw = readWindowsCredentialRaw(SLOT)
const slotFp = credentialFingerprint(slotRaw)
const slotIsPrimary = sameCredentialGrant(slotRaw, primary.raw)

if (slotIsPrimary) {
  log('slot already holds the primary credential')
} else {
  log(`slot holds a different credential (${slotFp?.slice(0, 20) ?? 'empty'}…) — primary must be restored`)
  if (APPLY) {
    const ok = writeWindowsCredentialRaw(primary.raw, SLOT)
    log(ok ? 'slot restored to the primary credential' : '!! failed to write the slot')
  } else {
    log('(dry run) would restore the slot to the primary credential')
  }
}

// ---- 3. Corrupted isolated accounts ---------------------------------------
console.log('')
console.log('[3] isolated accounts')

const accounts = pool.getAccounts()
const dupes = findDuplicateCredentialIdentities(accounts, homeDir)
const duplicates = new Map<string, string[]>()
for (const d of dupes) duplicates.set(d.fingerprint, d.locations)

let quarantined = 0
for (const acc of accounts) {
  if (!acc.dir || acc.systemHome) continue
  const file = accountTokenFilePath(acc, homeDir)
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : null
  const fp = raw ? credentialFingerprint(raw) : null
  const alias = acc.alias || acc.id

  if (fp === null) {
    log(`${alias}: no readable credential — will need a sign-in`)
    continue
  }
  if (!sameCredentialGrant(raw, primary.raw)) {
    log(`${alias}: holds its own credential (ok)`)
    continue
  }

  quarantined++
  const label = acc.email ?? '(no email)'
  log(`${alias}: BROKEN — its file holds the primary's credential (row currently claims ${label})`)
  if (APPLY) {
    pool.clearAccountEmail(acc.id)
    pool.markAuthRequired(acc.id, 'credential was overwritten by the shared credential slot — sign in again')
    log(`${alias}: quarantined and wrong email label cleared`)
  } else {
    log(`${alias}: (dry run) would clear the wrong email label and quarantine the slot`)
  }
}

if (quarantined === 0) {
  console.log('  no overwritten isolated accounts found')
}

// ---- 4. Summary -----------------------------------------------------------
console.log('')
console.log('summary')
log(`slot identity matches the pool primary: ${slotIsPrimary ? 'yes' : (APPLY ? 'repaired' : 'needs repair')}`)
log(`overwritten isolated accounts: ${quarantined}`)
if (quarantined > 0) {
  log('these accounts must be signed in again (Settings → Antigravity → add/re-login) to restore their own token')
}
if (!APPLY) {
  console.log('')
  console.log('Nothing was written. Re-run with --apply to perform the repairs.')
}
