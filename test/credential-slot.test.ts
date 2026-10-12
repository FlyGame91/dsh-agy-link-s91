// Regression tests for the Windows credential-slot handoff.
//
// These encode the exact failure that destroyed a real pool (2026-10-03):
// every account ended up holding the primary's refresh token and each quota
// row reported the same identity. The guards below make that impossible.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AsyncMutex,
  SlotUnavailableError,
  acquireCredentialSlot,
  credentialFingerprint,
  credentialSlotMutex,
  findDuplicateCredentialIdentities,
  parseCredentialDoc,
  readPrimaryCredential,
  resolvePrimaryCredential,
  writePrimaryCredential,
  type SlotIo,
} from '../src/host/credential-slot.ts'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function tokenDoc(refreshToken: string, accessToken = 'access-' + refreshToken, expiryMs = Date.now() + 3600_000): string {
  return JSON.stringify({
    token: {
      access_token: accessToken,
      token_type: 'Bearer',
      refresh_token: refreshToken,
      expiry: new Date(expiryMs).toISOString(),
    },
    auth_method: 'consumer',
  })
}

function writeAccountToken(dir: string, raw: string): string {
  const file = join(dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  mkdirSync(join(dir, '.gemini', 'antigravity-cli'), { recursive: true })
  writeFileSync(file, raw, 'utf8')
  return file
}

function account(id: string, dir?: string, extra: Record<string, unknown> = {}): never {
  return {
    id,
    alias: id,
    dir,
    enabled: true,
    createdAt: 1,
    cooldowns: {},
    quotas: {},
    ...extra,
  } as never
}

function fakePool(accounts: unknown[]): never {
  return { getAccounts: () => accounts } as never
}

/** In-memory credential slot standing in for Windows Credential Manager. */
function memoryIo(initial?: string, overrides: Partial<SlotIo> = {}): SlotIo & { current: string | undefined } {
  const state = {
    current: initial,
    platform: 'win32' as NodeJS.Platform,
    readSlot: (): string | null => state.current ?? null,
    writeSlot: (raw: string): boolean => {
      state.current = raw
      return true
    },
    identify: async (): Promise<string | undefined> => 'primary@example.com',
    ...overrides,
  }
  return state as SlotIo & { current: string | undefined }
}

// ---- document helpers ------------------------------------------------------

test('parseCredentialDoc reads agy nested shape, flat shape, and rejects garbage', () => {
  const nested = parseCredentialDoc(tokenDoc('R1', 'A1'))
  assert.equal(nested?.refreshToken, 'R1')
  assert.equal(nested?.accessToken, 'A1')
  assert.ok(nested?.expiryMs)

  const flat = parseCredentialDoc(JSON.stringify({ access_token: 'A2', refresh_token: 'R2', expiry: 1_800_000_000_000 }))
  assert.equal(flat?.refreshToken, 'R2')
  assert.equal(flat?.expiryMs, 1_800_000_000_000)

  assert.equal(parseCredentialDoc('not json'), null)
  assert.equal(parseCredentialDoc(''), null)
  assert.equal(parseCredentialDoc(null), null)
  assert.equal(parseCredentialDoc('[]'), null)
})

test('credentialFingerprint is anchored on the refresh token, not the access token', () => {
  // agy rotates the access token on every refresh; the grant identity does not.
  const before = tokenDoc('STABLE-REFRESH', 'access-old')
  const after = tokenDoc('STABLE-REFRESH', 'access-new')
  assert.equal(credentialFingerprint(before), credentialFingerprint(after))
  assert.notEqual(credentialFingerprint(before), credentialFingerprint(tokenDoc('OTHER-REFRESH', 'access-old')))
  assert.equal(credentialFingerprint('garbage'), null)
})

test('AsyncMutex serializes holders and returns to zero', async () => {
  const mutex = new AsyncMutex()
  const events: string[] = []
  const first = await mutex.acquire()
  assert.equal(mutex.pending, 1)

  const second = mutex.acquire().then((release) => {
    events.push('second-acquired')
    release()
  })

  let secondRan = false
  void second.then(() => {
    secondRan = true
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(secondRan, false, 'second holder must wait for the first release')
  events.push('first-done')
  first()
  await second
  assert.deepEqual(events, ['first-done', 'second-acquired'])
  assert.equal(mutex.pending, 0)
})

// ---- durable primary store -------------------------------------------------

test('primary credential store round-trips and rejects corrupted content', () => {
  const baseDir = tmp('agy-primary-')
  try {
    assert.equal(readPrimaryCredential(baseDir), null)
    assert.equal(writePrimaryCredential({ raw: tokenDoc('PRIMARY'), email: 'p@x.com', savedAt: 7 }, baseDir), true)

    const read = readPrimaryCredential(baseDir)
    assert.equal(read?.email, 'p@x.com')
    assert.equal(credentialFingerprint(read?.raw), 'r:PRIMARY')

    writeFileSync(join(baseDir, '.primary-credential.json'), 'not json', 'utf8')
    assert.equal(readPrimaryCredential(baseDir), null)
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
})

test('resolvePrimaryCredential refuses a slot that provably belongs to another account', async () => {
  const baseDir = tmp('agy-resolve-')
  try {
    const io = memoryIo(tokenDoc('SOMEONE-ELSE'), {
      identify: async () => 'someone-else@example.com',
    })
    const pool = fakePool([account('acc_primary', undefined, { systemHome: true, email: 'me@example.com' })])
    const resolved = await resolvePrimaryCredential(pool, {
      baseDir,
      homeDir: baseDir,
      io,
      log: () => {},
    })
    assert.equal(resolved, null, 'an unverifiable primary must never be adopted')
    assert.equal(readPrimaryCredential(baseDir), null, 'nothing may be persisted from an unverified slot')
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
})

test('resolvePrimaryCredential adopts a matching slot and persists it durably', async () => {
  const baseDir = tmp('agy-resolve-ok-')
  try {
    const io = memoryIo(tokenDoc('PRIMARY'), { identify: async () => 'me@example.com' })
    const pool = fakePool([account('acc_primary', undefined, { systemHome: true, email: 'me@example.com' })])
    const resolved = await resolvePrimaryCredential(pool, { baseDir, homeDir: baseDir, io, log: () => {} })
    assert.equal(resolved?.email, 'me@example.com')
    assert.equal(credentialFingerprint(readPrimaryCredential(baseDir)?.raw), 'r:PRIMARY')
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
})

// ---- the corruption guards -------------------------------------------------

test('a secondary whose credential was overwritten is refused, not run', async () => {
  const baseDir = tmp('agy-dup-')
  const homeDir = tmp('agy-dup-home-')
  try {
    writePrimaryCredential({ raw: tokenDoc('PRIMARY'), email: 'me@example.com', savedAt: 1 }, baseDir)
    // The historical corruption: the secondary's file holds the PRIMARY token.
    const accDir = tmp('agy-dup-acc-')
    const file = writeAccountToken(accDir, tokenDoc('PRIMARY'))
    const before = readFileSync(file, 'utf8')

    const io = memoryIo(tokenDoc('PRIMARY'))
    const pool = fakePool([account('acc_primary', undefined, { systemHome: true, email: 'me@example.com' })])

    await assert.rejects(
      () =>
        acquireCredentialSlot(account('q98', accDir, { email: 'q98@example.com' }), pool, {
          baseDir,
          homeDir,
          io,
          log: () => {},
        }),
      (err: unknown) => err instanceof SlotUnavailableError && /SAME credential as the primary/.test(String(err)),
    )

    assert.equal(readFileSync(file, 'utf8'), before, 'the account file must be left untouched')
    assert.equal(credentialFingerprint(io.current), 'r:PRIMARY', 'the primary must still own the slot')
    assert.equal(credentialSlotMutex.pending, 0, 'a refused handoff must not leak the mutex')
  } finally {
    for (const d of [baseDir, homeDir]) rmSync(d, { recursive: true, force: true })
  }
})

test('a foreign slot takeover is never written back into the account file', async () => {
  const baseDir = tmp('agy-takeover-')
  const homeDir = tmp('agy-takeover-home-')
  try {
    writePrimaryCredential({ raw: tokenDoc('PRIMARY'), email: 'me@example.com', savedAt: 1 }, baseDir)
    const accDir = tmp('agy-takeover-acc-')
    const file = writeAccountToken(accDir, tokenDoc('SECOND', 'access-second'))
    const before = readFileSync(file, 'utf8')

    const io = memoryIo(tokenDoc('PRIMARY'))
    const pool = fakePool([account('acc_primary', undefined, { systemHome: true, email: 'me@example.com' })])

    const lease = await acquireCredentialSlot(account('q98', accDir, { email: 'q98@example.com' }), pool, {
      baseDir,
      homeDir,
      io,
      log: () => {},
    })
    assert.ok(lease)
    assert.equal(credentialFingerprint(io.current), 'r:SECOND', 'the secondary owns the slot during its run')

    // Another account grabs the slot while this run is still live.
    io.writeSlot(tokenDoc('INTRUDER'))
    lease.release()

    assert.equal(
      readFileSync(file, 'utf8'),
      before,
      'a foreign credential must never be copied into the account file',
    )
    assert.equal(credentialFingerprint(io.current), 'r:PRIMARY', 'the primary is restored afterwards')
    assert.equal(credentialSlotMutex.pending, 0)
  } finally {
    for (const d of [baseDir, homeDir]) rmSync(d, { recursive: true, force: true })
  }
})

test('a refreshed token from the same grant is persisted back and the primary restored', async () => {
  const baseDir = tmp('agy-refresh-')
  const homeDir = tmp('agy-refresh-home-')
  try {
    writePrimaryCredential({ raw: tokenDoc('PRIMARY'), email: 'me@example.com', savedAt: 1 }, baseDir)
    const accDir = tmp('agy-refresh-acc-')
    const file = writeAccountToken(accDir, tokenDoc('SECOND', 'access-old'))

    const io = memoryIo(tokenDoc('PRIMARY'))
    const pool = fakePool([account('acc_primary', undefined, { systemHome: true, email: 'me@example.com' })])

    const lease = await acquireCredentialSlot(account('q98', accDir, { email: 'q98@example.com' }), pool, {
      baseDir,
      homeDir,
      io,
      log: () => {},
    })
    assert.ok(lease)
    // agy rotated the access token in place; the grant identity is unchanged.
    io.writeSlot(tokenDoc('SECOND', 'access-new'))
    lease.release()

    const persisted = parseCredentialDoc(readFileSync(file, 'utf8'))
    assert.equal(persisted?.refreshToken, 'SECOND')
    assert.equal(persisted?.accessToken, 'access-new', 'the refreshed access token is written back')
    assert.equal(credentialFingerprint(io.current), 'r:PRIMARY', 'the primary is restored afterwards')
    assert.equal(credentialSlotMutex.pending, 0)
  } finally {
    for (const d of [baseDir, homeDir]) rmSync(d, { recursive: true, force: true })
  }
})

test('a secondary with no credential file is refused instead of running as the primary', async () => {
  const baseDir = tmp('agy-nocred-')
  const homeDir = tmp('agy-nocred-home-')
  try {
    writePrimaryCredential({ raw: tokenDoc('PRIMARY'), email: 'me@example.com', savedAt: 1 }, baseDir)
    const accDir = tmp('agy-nocred-acc-')
    const io = memoryIo(tokenDoc('PRIMARY'))
    const pool = fakePool([account('acc_primary', undefined, { systemHome: true, email: 'me@example.com' })])

    await assert.rejects(
      () =>
        acquireCredentialSlot(account('dao', accDir, { email: 'dao@example.com' }), pool, {
          baseDir,
          homeDir,
          io,
          log: () => {},
        }),
      (err: unknown) => err instanceof SlotUnavailableError && /no stored credential/.test(String(err)),
    )
    assert.equal(credentialFingerprint(io.current), 'r:PRIMARY')
    assert.equal(credentialSlotMutex.pending, 0)
  } finally {
    for (const d of [baseDir, homeDir]) rmSync(d, { recursive: true, force: true })
  }
})

test('findDuplicateCredentialIdentities reports accounts sharing one login', () => {
  const homeDir = tmp('agy-finddup-home-')
  try {
    const a = tmp('agy-finddup-a-')
    const b = tmp('agy-finddup-b-')
    const c = tmp('agy-finddup-c-')
    writeAccountToken(a, tokenDoc('SHARED'))
    writeAccountToken(b, tokenDoc('SHARED'))
    writeAccountToken(c, tokenDoc('UNIQUE'))

    const reports = findDuplicateCredentialIdentities(
      [account('q98', a), account('ele', b), account('dao', c)],
      homeDir,
    )
    assert.equal(reports.length, 1)
    assert.deepEqual(reports[0]?.locations.sort(), ['ele', 'q98'])
    assert.equal(reports[0]?.fingerprint, 'r:SHARED')
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('non-Windows platforms do not take the slot mutex', async () => {
  const io = { platform: 'darwin' as NodeJS.Platform }
  const lease = await acquireCredentialSlot(account('q98', '/tmp/x'), undefined, { io })
  assert.equal(lease, undefined)
  assert.equal(credentialSlotMutex.pending, 0)
})
