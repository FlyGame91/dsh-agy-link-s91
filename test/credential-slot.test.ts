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
  AbortedWaitError,
  AsyncMutex,
  SlotUnavailableError,
  WaitTimeoutError,
  acquireCredentialSlot,
  credentialFingerprint,
  credentialSlotMutex,
  fastPathRunCount,
  findDuplicateCredentialIdentities,
  isSlotSwitchPending,
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

// ---- cancellation & lost-wakeup defenses (2026-10-16 zombie-turn incident) --
//
// A turn queued on the credential slot while another session's run held it.
// The old promise-chain mutex could neither remove an abandoned waiter nor
// observe an abort, so the turn pended forever and Stop did nothing. These
// tests pin the three defenses: cancel-removes-and-wakes-next, bounded wait,
// and the liveness poll that heals a lost wake-up.

test('AsyncMutex removes an aborted waiter and wakes the next one in its place', async () => {
  const mutex = new AsyncMutex()
  const releaseFirst = await mutex.acquire()

  const abort = new AbortController()
  const queued = mutex.acquire({ signal: abort.signal })
  const behind = mutex.acquire().then((release) => {
    release()
    return 'behind-granted'
  })

  await new Promise((r) => setTimeout(r, 10))
  assert.equal(mutex.waiting, 2, 'both waiters must be queued')

  abort.abort()
  await assert.rejects(() => queued, (err: unknown) => err instanceof AbortedWaitError)
  assert.equal(mutex.waiting, 1, 'the aborted waiter must leave the queue')

  releaseFirst()
  assert.equal(await behind, 'behind-granted', 'the waiter behind the aborted one must NOT be swallowed')
  assert.equal(mutex.pending, 0)
})

test('AsyncMutex keeps the queue flowing when a bounded wait times out', async () => {
  const mutex = new AsyncMutex()
  const releaseFirst = await mutex.acquire()

  const timedOut = mutex.acquire({ timeoutMs: 25 })
  const behind = mutex.acquire().then((release) => {
    release()
    return 'behind-granted'
  })

  await assert.rejects(() => timedOut, (err: unknown) => err instanceof WaitTimeoutError)
  releaseFirst()
  assert.equal(await behind, 'behind-granted')
  assert.equal(mutex.pending, 0)
})

test('AsyncMutex poll grants a queued waiter when a wake-up is lost', async () => {
  const mutex = new AsyncMutex()
  const releaseFirst = await mutex.acquire()
  void releaseFirst

  const healed = mutex.acquire({ pollMs: 15, shouldProceed: () => true })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(mutex.waiting, 1)

  // Simulate the historical defect: the slot became free but the wake-up call
  // never reached the waiter (holders bookkeeping says free, queue stuck).
  ;(mutex as unknown as { holders: number }).holders = 0

  const granted = await healed
  assert.equal(typeof granted, 'function', 'the poll must take the mutex directly on a lost wake-up')
  granted()
  assert.equal(mutex.pending, 0)
})

test('acquireCredentialSlot rejects immediately when the signal is already aborted', async () => {
  const baseDir = tmp('agy-abort-pre-')
  try {
    writePrimaryCredential({ raw: tokenDoc('PRIMARY'), email: 'me@example.com', savedAt: 1 }, baseDir)
    const accDir = tmp('agy-abort-pre-acc-')
    const io = memoryIo(tokenDoc('PRIMARY'))
    const pool = fakePool([account('acc_primary', undefined, { systemHome: true, email: 'me@example.com' })])
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () =>
        acquireCredentialSlot(account('q98', accDir, { email: 'q98@example.com' }), pool, {
          baseDir,
          homeDir: baseDir,
          io,
          log: () => {},
          signal: controller.signal,
        }),
      (err: unknown) => err instanceof AbortedWaitError,
    )
    assert.equal(credentialSlotMutex.pending, 0)
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
})

test('acquireCredentialSlot honors Stop while queued on the slot', async () => {
  const baseDir = tmp('agy-abort-queued-')
  try {
    writePrimaryCredential({ raw: tokenDoc('PRIMARY'), email: 'me@example.com', savedAt: 1 }, baseDir)
    const accDir = tmp('agy-abort-queued-acc-')
    const io = memoryIo(tokenDoc('PRIMARY'))
    const pool = fakePool([account('acc_primary', undefined, { systemHome: true, email: 'me@example.com' })])

    // Someone else holds the slot for a long run.
    const holderRelease = await credentialSlotMutex.acquire()
    const controller = new AbortController()
    const queued = acquireCredentialSlot(account('q98', accDir, { email: 'q98@example.com' }), pool, {
      baseDir,
      homeDir: baseDir,
      io,
      log: () => {},
      signal: controller.signal,
    })
    await new Promise((r) => setTimeout(r, 20))
    assert.ok(credentialSlotMutex.waiting >= 1, 'the dispatch must be queued on the slot')

    // Stop arrives — the wait must end PROMPTLY, not when the holder releases.
    controller.abort()
    await assert.rejects(() => queued, (err: unknown) => err instanceof AbortedWaitError)
    assert.equal(credentialSlotMutex.waiting, 0, 'the cancelled waiter must leave the queue')

    holderRelease()
    assert.equal(credentialSlotMutex.pending, 0)
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
})

test('acquireCredentialSlot bounded wait fails visibly instead of parking forever', async () => {
  const baseDir = tmp('agy-slot-timeout-')
  try {
    writePrimaryCredential({ raw: tokenDoc('PRIMARY'), email: 'me@example.com', savedAt: 1 }, baseDir)
    const accDir = tmp('agy-slot-timeout-acc-')
    const io = memoryIo(tokenDoc('PRIMARY'))
    const pool = fakePool([account('acc_primary', undefined, { systemHome: true, email: 'me@example.com' })])

    const holderRelease = await credentialSlotMutex.acquire()
    try {
      await assert.rejects(
        () =>
          acquireCredentialSlot(account('q98', accDir, { email: 'q98@example.com' }), pool, {
            baseDir,
            homeDir: baseDir,
            io,
            log: () => {},
            dispatchTimeoutMs: 25,
          }),
        (err: unknown) => err instanceof WaitTimeoutError,
      )
    } finally {
      holderRelease()
    }
    assert.equal(credentialSlotMutex.pending, 0)
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
})

// ---- same-account concurrency (native agy parallelism) ----------------------
//
// agy is a stateless CLI and runs concurrent processes natively. The slot must
// only serialize IDENTITY SWITCHES, not same-account runs.

function primaryPool(): never {
  return fakePool([account('acc_primary', undefined, { systemHome: true, email: 'me@example.com' })])
}

test('same-account primary runs bypass the mutex and run truly in parallel', async () => {
  const baseDir = tmp('agy-fastpath-')
  try {
    writePrimaryCredential({ raw: tokenDoc('PRIMARY'), email: 'me@example.com', savedAt: 1 }, baseDir)
    const io = memoryIo(tokenDoc('PRIMARY'))

    // Someone else holds the mutex — the fast path must NOT care.
    const holderRelease = await credentialSlotMutex.acquire()
    try {
      const lease1 = await acquireCredentialSlot(
        account('acc_primary', undefined, { systemHome: true, email: 'me@example.com' }),
        primaryPool(),
        { baseDir, homeDir: baseDir, io, log: () => {} },
      )
      assert.ok(lease1, 'fast path grants immediately even while the mutex is held elsewhere')
      const lease2 = await acquireCredentialSlot(
        account('acc_primary', undefined, { systemHome: true, email: 'me@example.com' }),
        primaryPool(),
        { baseDir, homeDir: baseDir, io, log: () => {} },
      )
      assert.ok(lease2, 'a second same-account run is granted concurrently')
      assert.equal(fastPathRunCount(), 2, 'both fast-path runs are tracked as active')

      lease1.release()
      lease2.release()
      assert.equal(fastPathRunCount(), 0)
      assert.equal(credentialSlotMutex.pending, 1, 'the unrelated mutex holder is untouched')
    } finally {
      holderRelease()
    }
    assert.equal(credentialSlotMutex.pending, 0)
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
})

test('a secondary account waits for same-account runs to drain before switching the slot', async () => {
  const baseDir = tmp('agy-drain-')
  const accDir = tmp('agy-drain-acc-')
  try {
    writePrimaryCredential({ raw: tokenDoc('PRIMARY'), email: 'me@example.com', savedAt: 1 }, baseDir)
    writeAccountToken(accDir, tokenDoc('SECOND'))
    const io = memoryIo(tokenDoc('PRIMARY'))

    // Live same-account primary run (fast path).
    const primaryLease = await acquireCredentialSlot(
      account('acc_primary', undefined, { systemHome: true, email: 'me@example.com' }),
      primaryPool(),
      { baseDir, homeDir: baseDir, io, log: () => {} },
    )
    assert.ok(primaryLease)

    // A secondary account must NOT swap the slot under the live primary run.
    const secondary = acquireCredentialSlot(
      account('q98', accDir, { email: 'q98@example.com' }),
      primaryPool(),
      { baseDir, homeDir: baseDir, io, log: () => {} },
    )
    await new Promise((r) => setTimeout(r, 80))
    let settled = false
    void secondary.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    assert.equal(settled, false, 'the identity switch must wait for the live same-account run')
    assert.equal(io.readSlot() && credentialFingerprint(io.readSlot()), 'r:PRIMARY', 'slot still holds the primary while waiting')

    // The primary run exits — the switch proceeds.
    primaryLease.release()
    const lease = await Promise.race([
      secondary,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('drain deadline passed')), 2_000)),
    ])
    assert.ok(lease)
    assert.equal(credentialFingerprint(io.readSlot()), 'r:SECOND', 'the secondary owns the slot after the drain')

    lease.release()
    assert.equal(credentialFingerprint(io.readSlot()), 'r:PRIMARY', 'the primary is restored after the switch')
    assert.equal(fastPathRunCount(), 0)
    assert.equal(credentialSlotMutex.pending, 0)
  } finally {
    for (const d of [baseDir, accDir]) rmSync(d, { recursive: true, force: true })
  }
})

test('new same-account runs queue behind a pending slot switch instead of starving it', async () => {
  const baseDir = tmp('agy-starve-')
  const accDir = tmp('agy-starve-acc-')
  try {
    writePrimaryCredential({ raw: tokenDoc('PRIMARY'), email: 'me@example.com', savedAt: 1 }, baseDir)
    writeAccountToken(accDir, tokenDoc('SECOND'))
    const io = memoryIo(tokenDoc('PRIMARY'))

    const primaryLease = await acquireCredentialSlot(
      account('acc_primary', undefined, { systemHome: true, email: 'me@example.com' }),
      primaryPool(),
      { baseDir, homeDir: baseDir, io, log: () => {} },
    )
    assert.ok(primaryLease)

    // The switcher registers its intent (fast paths now refused).
    const secondary = acquireCredentialSlot(
      account('q98', accDir, { email: 'q98@example.com' }),
      primaryPool(),
      { baseDir, homeDir: baseDir, io, log: () => {} },
    )
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(isSlotSwitchPending(), true, 'the pending switch must be visible')

    // A NEW same-account run arrives while the switch pends: it must NOT take
    // the fast path (which would postpone the switch forever). The switcher
    // holds the mutex while draining, so the latecomer queues behind it.
    let latecomerSettled = false
    const latecomerP = acquireCredentialSlot(
      account('acc_primary', undefined, { systemHome: true, email: 'me@example.com' }),
      primaryPool(),
      { baseDir, homeDir: baseDir, io, log: () => {} },
    ).then((l) => {
      latecomerSettled = true
      return l
    })
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(latecomerSettled, false, 'the latecomer must queue behind the pending switch, not fast-path past it')

    // Drain: the switcher proceeds once the ORIGINAL fast run exits. The
    // latecomer holds the mutex queue position, so the switcher's OWN lease
    // resolves first, but the slot stays swapped until the switcher releases.
    let switchDone = false
    void secondary.then((l) => {
      switchDone = true
      return l
    })
    primaryLease.release()
    const secLease = await Promise.race([
      secondary,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('drain deadline passed')), 2_000)),
    ])
    assert.ok(secLease)
    assert.equal(switchDone, true)
    assert.equal(credentialFingerprint(io.readSlot()), 'r:SECOND', 'the secondary owns the slot after the drain')

    // The latecomer is still behind the switcher's held mutex.
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(latecomerSettled, false, 'the latecomer waits for the switcher to release the mutex')

    secLease.release()
    assert.equal(credentialFingerprint(io.readSlot()), 'r:PRIMARY', 'the primary is restored after the switch')

    const lateLease = await Promise.race([
      latecomerP,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('latecomer deadline passed')), 2_000)),
    ])
    assert.ok(lateLease)
    lateLease.release()
    assert.equal(isSlotSwitchPending(), false)
    assert.equal(credentialSlotMutex.pending, 0)
  } finally {
    for (const d of [baseDir, accDir]) rmSync(d, { recursive: true, force: true })
  }
})

test('parallel: false restores full-run exclusivity (one agy process at a time)', async () => {
  const baseDir = tmp('agy-noparallel-')
  try {
    writePrimaryCredential({ raw: tokenDoc('PRIMARY'), email: 'me@example.com', savedAt: 1 }, baseDir)
    const io = memoryIo(tokenDoc('PRIMARY'))

    const holderRelease = await credentialSlotMutex.acquire()
    let holderDone = false
    const releaseHolder = (): void => {
      if (holderDone) return
      holderDone = true
      holderRelease()
    }
    try {
      let settled = false
      const queued = acquireCredentialSlot(
        account('acc_primary', undefined, { systemHome: true, email: 'me@example.com' }),
        primaryPool(),
        { baseDir, homeDir: baseDir, io, log: () => {}, parallel: false },
      ).then((l) => {
        settled = true
        return l
      })
      await new Promise((r) => setTimeout(r, 60))
      assert.equal(settled, false, 'without the fast path the run queues on the mutex like before')
      releaseHolder()
      const lease = await queued
      assert.ok(lease)
      lease.release()
    } finally {
      releaseHolder()
    }
    assert.equal(credentialSlotMutex.pending, 0)
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
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
