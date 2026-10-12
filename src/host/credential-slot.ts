// Windows credential-slot handoff (dsh-agy-link).
//
// WHY THIS MODULE EXISTS
// ---------------------
// On Windows every `agy.exe` process resolves its Google credential from ONE
// process-global store: Windows Credential Manager target `gemini:antigravity`.
// `agy` ignores HOME/USERPROFILE there, so an isolated per-account directory
// does NOT isolate credentials the way a per-account Keychain does on macOS.
// Multi-account support therefore requires handing the single slot back and
// forth around each run.
//
// The previous implementation corrupted real accounts. Three defects:
//
//   1. It snapshotted "whatever is currently in the slot" as the primary
//      backup. Any secondary run could overwrite the backup with a secondary's
//      credential, and the next restore then installed that secondary as the
//      system-wide login ("refreshing an account replaced my main account").
//
//   2. After a run it wrote the slot's content back into the account's token
//      file whenever it differed. While another account owned the slot, that
//      copied a FOREIGN credential into the account file. Observed end state:
//      all four accounts held the primary's refresh token and every quota row
//      reported the same identity.
//
//   3. Nothing serialized slot ownership. Interactive runs, background quota
//      polls and manual refreshes raced on the single slot.
//
// INVARIANTS ENFORCED HERE
// ------------------------
//   * The primary credential is resolved from a durable, identity-VERIFIED
//     store; it is never inferred from "whatever happens to be in the slot".
//   * Slot ownership is serialized by one process-wide mutex spanning the
//     whole run, so two accounts can never interleave.
//   * A run may only take the slot when the slot can be handed back afterwards.
//   * Writes into an account's own token file require that the slot still
//     carries THAT account's refresh token. Otherwise nothing is written.
//   * A secondary whose credential has been clobbered by another account's is
//     detected and refused, so it can never silently spend the primary's quota.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ManagedAccount } from '../common/pool-types.ts'
import type { AccountPoolManager } from './pool.ts'
import { defaultPoolDir } from './pool.ts'
import { readWindowsCredentialRaw, writeWindowsCredentialRaw } from './wincred.ts'
import { refreshTokens } from './oauth.ts'
import { agyFetch } from './net.ts'

const SLOT_TARGET = 'gemini:antigravity'
const PRIMARY_STORE_FILE = '.primary-credential.json'

// ---- token document helpers ----------------------------------------------

export interface CredentialDoc {
  accessToken?: string
  refreshToken?: string
  expiryMs?: number
}

/** Parse either agy's nested `{token:{…}}` shape or a flat `{access_token}` doc. */
export function parseCredentialDoc(raw: string | null | undefined): CredentialDoc | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const outer = parsed as Record<string, unknown>
  const inner =
    typeof outer.token === 'object' && outer.token !== null
      ? (outer.token as Record<string, unknown>)
      : outer
  const str = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = inner[k]
      if (typeof v === 'string' && v) return v
    }
    return undefined
  }
  const rawExpiry = inner.expiry ?? inner.expiryMs
  let expiryMs: number | undefined
  if (typeof rawExpiry === 'number' && Number.isFinite(rawExpiry)) {
    expiryMs = rawExpiry < 1e11 ? rawExpiry * 1000 : rawExpiry
  } else if (typeof rawExpiry === 'string') {
    const parsedMs = Date.parse(rawExpiry)
    if (!Number.isNaN(parsedMs)) expiryMs = parsedMs
  }
  return {
    accessToken: str('access_token', 'accessToken'),
    refreshToken: str('refresh_token', 'refreshToken'),
    expiryMs,
  }
}

/**
 * Identity anchor for a credential blob. A Google OAuth refresh token is
 * unique per account grant and stays the same across access-token refreshes,
 * so it is the right thing to compare. Falls back to the access token when a
 * refresh token is unavailable.
 */
export function credentialFingerprint(raw: string | null | undefined): string | null {
  const doc = parseCredentialDoc(raw)
  if (!doc) return null
  if (doc.refreshToken) return 'r:' + doc.refreshToken
  if (doc.accessToken) return 'a:' + doc.accessToken
  return null
}

/**
 * True only when both blobs provably belong to the SAME OAuth grant.
 *
 * A refresh token is required on both sides. Falling back to the access token
 * would be unsound here: it rotates on every refresh, so two snapshots of one
 * account would compare unequal and two accounts could compare equal. This
 * predicate gates every destructive decision (refusing to run, writing a token
 * back into an account file, re-asserting the primary), so "cannot prove it"
 * must mean "not the same".
 */
export function sameCredentialGrant(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const docA = parseCredentialDoc(a)
  const docB = parseCredentialDoc(b)
  if (!docA?.refreshToken || !docB?.refreshToken) return false
  return docA.refreshToken === docB.refreshToken
}

function readTokenFileRaw(file: string): string | null {
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf8')
    return raw.trim() ? raw : null
  } catch {
    return null
  }
}

/** Atomic-ish replace: write a sibling temp file then rename over the target. */
function writeFileAtomic(file: string, data: string): boolean {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, data, { encoding: 'utf8' })
    renameSync(tmp, file)
    return true
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      // ignore
    }
    return false
  }
}

export function accountTokenFilePath(account: ManagedAccount, homeDir: string): string {
  const home = account.dir ? account.dir : homeDir
  return join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
}

// ---- process-wide serialization ------------------------------------------

/**
 * FIFO async mutex. One instance guards the single Windows credential slot;
 * holding it across an entire agy run is what makes the handoff safe.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve()
  private depth = 0

  /** Number of holders plus waiters; 0 means the mutex is free. */
  get pending(): number {
    return this.depth
  }

  async acquire(): Promise<() => void> {
    this.depth += 1
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = this.tail
    this.tail = previous.then(
      () => gate,
      () => gate,
    )
    await previous
    let released = false
    return () => {
      if (released) return
      released = true
      this.depth -= 1
      release()
    }
  }
}

export const credentialSlotMutex = new AsyncMutex()

// ---- platform seam ---------------------------------------------------------

/**
 * The platform-specific operations the slot manager needs. Injectable so the
 * handoff guards can be tested without touching the real Windows Credential
 * Manager.
 */
export interface SlotIo {
  platform: NodeJS.Platform
  readSlot(): string | null
  writeSlot(raw: string): boolean
  identify(raw: string | null | undefined, proxyUrl?: string): Promise<string | undefined>
}

export function defaultSlotIo(): SlotIo {
  return {
    platform: process.platform,
    readSlot: () => readWindowsCredentialRaw(SLOT_TARGET),
    writeSlot: (raw) => writeWindowsCredentialRaw(raw, SLOT_TARGET),
    identify: identifyCredential,
  }
}

// ---- durable primary credential ------------------------------------------

export interface PrimaryCredential {
  raw: string
  email?: string
  savedAt: number
}

export function primaryStorePath(baseDir: string): string {
  return join(baseDir, PRIMARY_STORE_FILE)
}

export function readPrimaryCredential(baseDir = defaultPoolDir()): PrimaryCredential | null {
  const file = primaryStorePath(baseDir)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PrimaryCredential>
    if (typeof parsed.raw === 'string' && parsed.raw.trim() && credentialFingerprint(parsed.raw)) {
      return {
        raw: parsed.raw,
        email: typeof parsed.email === 'string' ? parsed.email : undefined,
        savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      }
    }
  } catch {
    // corrupted store — treat as absent rather than guessing
  }
  return null
}

export function writePrimaryCredential(cred: PrimaryCredential, baseDir = defaultPoolDir()): boolean {
  try {
    mkdirSync(baseDir, { recursive: true })
  } catch {
    // ignore
  }
  return writeFileAtomic(primaryStorePath(baseDir), JSON.stringify(cred, null, 2))
}

// ---- identity probing ------------------------------------------------------

/** Resolve the Google email a credential blob belongs to (refresh if needed). */
export async function identifyCredential(
  raw: string | null | undefined,
  proxyUrl?: string,
): Promise<string | undefined> {
  const doc = parseCredentialDoc(raw)
  if (!doc) return undefined
  const probe = async (accessToken: string): Promise<string | undefined> => {
    try {
      const res = await agyFetch(
        'https://www.googleapis.com/oauth2/v1/userinfo',
        { headers: { Authorization: 'Bearer ' + accessToken } },
        proxyUrl,
      )
      if (!res.ok) return undefined
      const body = (await res.json()) as { email?: string }
      return body.email
    } catch {
      return undefined
    }
  }
  if (doc.accessToken && (!doc.expiryMs || doc.expiryMs > Date.now() + 60_000)) {
    const email = await probe(doc.accessToken)
    if (email) return email
  }
  if (doc.refreshToken) {
    try {
      const refreshed = await refreshTokens(doc.refreshToken, proxyUrl)
      if (refreshed?.access_token) return await probe(refreshed.access_token)
    } catch {
      return undefined
    }
  }
  return undefined
}

// ---- primary credential resolution ---------------------------------------

export interface ResolveOptions {
  baseDir?: string
  homeDir?: string
  proxyUrl?: string
  log?: (message: string) => void
  io?: Partial<SlotIo>
  /**
   * Re-derive the primary credential from live sources instead of trusting the
   * durable store. Used by the repair tool when the store itself may hold a
   * degraded (refresh-token-less) document.
   */
  force?: boolean
}

function resolveIo(options: ResolveOptions): SlotIo {
  const base = defaultSlotIo()
  const overrides = options.io
  if (!overrides) return base
  return {
    platform: overrides.platform ?? base.platform,
    readSlot: overrides.readSlot ?? base.readSlot,
    writeSlot: overrides.writeSlot ?? base.writeSlot,
    identify: overrides.identify ?? base.identify,
  }
}

/**
 * Produce a primary credential we can PROVE belongs to the primary account.
 *
 * Order of trust:
 *   1. the durable store (written only from verified-primary sources)
 *   2. the primary's own on-disk token file
 *   3. the live credential slot
 * Candidates 2 and 3 are adopted only after a successful Google identity probe
 * that matches the pool's recorded primary email.
 *
 * Returns null when nothing can be proven — callers must then refuse to swap
 * the slot rather than guess.
 */
export async function resolvePrimaryCredential(
  pool: AccountPoolManager | undefined,
  options: ResolveOptions = {},
): Promise<PrimaryCredential | null> {
  const io = resolveIo(options)
  const baseDir = options.baseDir ?? defaultPoolDir()
  const homeDir = options.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? ''
  const log = options.log ?? ((): void => {})

  const stored = readPrimaryCredential(baseDir)
  if (stored && options.force !== true) return stored

  const accounts = pool?.getAccounts() ?? []
  const primary =
    accounts.find((a) => a.systemHome) ?? accounts.find((a) => a.id === 'acc_primary') ?? accounts[0]
  const expectedEmail = primary?.email

  const candidates: Array<{ where: string; raw: string | null }> = []
  if (primary) {
    candidates.push({
      where: 'primary token file',
      raw: readTokenFileRaw(accountTokenFilePath(primary, homeDir)),
    })
  }
  if (io.platform === 'win32') candidates.push({ where: 'credential slot', raw: io.readSlot() })

  for (const candidate of candidates) {
    if (!candidate.raw) continue
    // A credential without a refresh token cannot be identified across access
    // token rotations, and would degrade the durable store back to an
    // unidentifiable document. Never adopt one.
    if (!parseCredentialDoc(candidate.raw)?.refreshToken) {
      log(`[agy-link] primary credential candidate "${candidate.where}" has no refresh token — skipped`)
      continue
    }
    const email = await io.identify(candidate.raw, options.proxyUrl)
    if (!email) continue
    if (expectedEmail && email !== expectedEmail) {
      log(
        `[agy-link] primary credential candidate "${candidate.where}" belongs to ${email}, ` +
          `expected ${expectedEmail} — skipped`,
      )
      continue
    }
    const cred: PrimaryCredential = { raw: candidate.raw, email, savedAt: Date.now() }
    writePrimaryCredential(cred, baseDir)
    log(`[agy-link] adopted primary credential from ${candidate.where} <${email}>`)
    return cred
  }

  log('[agy-link] could not verify a primary credential; slot handoff disabled to protect the system login')
  return null
}

// ---- slot lease ------------------------------------------------------------

export interface SlotLease {
  release(): void
  /** Identity the slot was verified to hold while this lease was active. */
  identity?: string
}

export class SlotUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SlotUnavailableError'
  }
}

/**
 * Take exclusive ownership of the credential slot for a run and arrange its
 * guaranteed restoration.
 *
 * Non-Windows platforms have no shared slot (per-account Keychain isolation
 * works), so this is a no-op there.
 *
 * @throws SlotUnavailableError when the slot cannot be handed over safely.
 * The caller must abort the run instead of silently signing in as the wrong
 * account (which would spend that account's quota).
 */
export async function acquireCredentialSlot(
  account: ManagedAccount | undefined,
  pool: AccountPoolManager | undefined,
  options: ResolveOptions = {},
): Promise<SlotLease | undefined> {
  const io = resolveIo(options)
  if (io.platform !== 'win32' || !account) return undefined

  const baseDir = options.baseDir ?? defaultPoolDir()
  const homeDir = options.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? ''
  const log = options.log ?? ((): void => {})
  const releaseMutex = await credentialSlotMutex.acquire()

  let released = false
  const done = (): void => {
    if (released) return
    released = true
    releaseMutex()
  }

  try {
    const primary = await resolvePrimaryCredential(pool, { ...options, baseDir, homeDir })
    const accountFile = accountTokenFilePath(account, homeDir)
    const accountRaw = readTokenFileRaw(accountFile)
    const isPrimarySlot = Boolean(account.systemHome) || !account.dir

    if (!primary) {
      done()
      throw new SlotUnavailableError(
        'Cannot verify the primary Antigravity credential, so the Windows credential slot cannot be ' +
          'handed over safely. Sign the primary account in again, then retry.',
      )
    }

    // -- Primary run ------------------------------------------------------
    if (isPrimarySlot) {
      if (!sameCredentialGrant(io.readSlot(), primary.raw)) {
        log('[agy-link] re-asserting the primary credential into the Windows credential slot')
        io.writeSlot(primary.raw)
      }
      return {
        identity: primary.email,
        release: (): void => {
          try {
            const afterRaw = io.readSlot()
            if (sameCredentialGrant(afterRaw, primary.raw)) {
              // agy may have refreshed the access token in place — keep the
              // durable copy current. The identity is unchanged.
              if (afterRaw && afterRaw !== primary.raw) {
                writePrimaryCredential({ raw: afterRaw, email: primary.email, savedAt: Date.now() }, baseDir)
              }
            } else if (afterRaw) {
              // Something replaced the primary mid-run. Put it back.
              log('[agy-link] credential slot changed during a primary run — restoring the primary credential')
              io.writeSlot(primary.raw)
              writePrimaryCredential(primary, baseDir)
            }
          } finally {
            done()
          }
        },
      }
    }

    // -- Secondary run ----------------------------------------------------
    if (!accountRaw) {
      done()
      throw new SlotUnavailableError(
        `Account ${account.alias || account.id} has no stored credential. Sign it in again before using it.`,
      )
    }

    const accountFingerprint = credentialFingerprint(accountRaw)
    if (!accountFingerprint) {
      done()
      throw new SlotUnavailableError(
        `Account ${account.alias || account.id} has an unreadable credential file. Sign it in again.`,
      )
    }

    // Guard against the historical corruption: a secondary whose file was
    // overwritten with the primary's credential would otherwise run as the
    // primary and quietly spend the primary's quota.
    if (sameCredentialGrant(accountRaw, primary.raw)) {
      done()
      throw new SlotUnavailableError(
        `Account ${account.alias || account.id} holds the SAME credential as the primary account — ` +
          'its login was overwritten. Sign this account in again to restore its own token.',
      )
    }

    io.writeSlot(accountRaw)

    return {
      identity: account.email,
      release: (): void => {
        try {
          const afterRaw = io.readSlot()
          const afterFingerprint = credentialFingerprint(afterRaw)
          if (sameCredentialGrant(afterRaw, accountRaw)) {
            // Slot still belongs to this account: agy may have refreshed the
            // access token, so persist it back into the account's own file.
            if (afterRaw && afterRaw !== accountRaw) {
              writeFileAtomic(accountFile, afterRaw)
            }
          } else if (afterFingerprint !== null) {
            // The slot was taken over while this run was live. Writing it back
            // would copy a FOREIGN credential into this account's file — the
            // exact bug that destroyed this pool. Leave the file untouched.
            log(
              `[agy-link] credential slot was replaced during ${account.alias || account.id}'s run — ` +
                'refusing to write a foreign credential into the account file',
            )
          }
        } finally {
          try {
            io.writeSlot(primary.raw)
          } finally {
            done()
          }
        }
      },
    }
  } catch (err) {
    done()
    throw err
  }
}

// ---- corruption detection --------------------------------------------------

export interface DuplicateIdentityReport {
  fingerprint: string
  locations: string[]
}

/**
 * Detect several accounts sharing one credential identity — the signature of
 * the historical slot-corruption bug. Read-only.
 */
export function findDuplicateCredentialIdentities(
  accounts: readonly ManagedAccount[],
  homeDir: string,
): DuplicateIdentityReport[] {
  const byFingerprint = new Map<string, string[]>()
  for (const account of accounts) {
    const raw = readTokenFileRaw(accountTokenFilePath(account, homeDir))
    const fp = credentialFingerprint(raw)
    if (!fp) continue
    const list = byFingerprint.get(fp) ?? []
    list.push(account.alias || account.id)
    byFingerprint.set(fp, list)
  }
  const reports: DuplicateIdentityReport[] = []
  for (const [fingerprint, locations] of byFingerprint) {
    if (locations.length > 1) reports.push({ fingerprint, locations })
  }
  return reports
}
