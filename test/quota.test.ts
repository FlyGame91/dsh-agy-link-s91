import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPoolManager } from '../src/host/pool.ts'
import { QuotaService, detectEmailFromAgyLogs, mergeFallbackFamilyQuota, normalizeStoredToken } from '../src/host/quota.ts'
import { shouldPollAccount } from '../src/common/pool-types.ts'
import { writeAgyTokenFile, parsePastedCode, generatePkce } from '../src/host/oauth.ts'
import { parseCredentialDoc } from '../src/host/credential-slot.ts'

test('persistRefreshedToken keeps the refresh token and writes agy nested shape', () => {
  // Regression: the writer used to emit a flat `{access_token,expiry}` document
  // when the file did not exist yet, DROPPING the refresh token. A credential
  // without a refresh token has no stable identity, so the corruption guards
  // (which compare grants) could never fire.
  const dir = mkdtempSync(join(tmpdir(), 'agy-persist-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('persist-test')
  const quota = new QuotaService(pool)
  const persist = (
    quota as unknown as {
      persistRefreshedToken: (a: unknown, t: Record<string, unknown>) => void
    }
  ).persistRefreshedToken.bind(quota)

  const file = join(acc.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')

  persist(acc, { access_token: 'A1', expiryMs: Date.now() + 3600_000, refresh_token: 'R-KEEP' })
  const first = parseCredentialDoc(readFileSync(file, 'utf8'))
  assert.equal(first?.refreshToken, 'R-KEEP', 'the refresh token must be written')
  assert.equal(first?.accessToken, 'A1')
  assert.ok(first?.expiryMs, 'expiry must survive as a parseable timestamp')

  // A later refresh that does not re-supply the refresh token must not lose it.
  persist(acc, { access_token: 'A2', expiryMs: Date.now() + 3600_000 })
  const second = parseCredentialDoc(readFileSync(file, 'utf8'))
  assert.equal(second?.refreshToken, 'R-KEEP', 'the refresh token must be preserved')
  assert.equal(second?.accessToken, 'A2')
})

test('QuotaService parses stored tokens and saves token refresh updates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-test-'))
  const pool = new AccountPoolManager(dir)
  // Primary rides the system HOME (Keychain); token files only exist for
  // isolated secondary accounts — exercise those.
  const acc = pool.createAccountSlot('quota-test')

  const tokenDir = join(acc.dir, '.gemini', 'antigravity-cli')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(
    join(tokenDir, 'antigravity-oauth-token'),
    JSON.stringify({
      access_token: 'fake_access_token_123',
      refresh_token: 'fake_refresh_token_456',
      expiry: Date.now() + 3600_000,
    }),
    'utf8',
  )

  const quota = new QuotaService(pool)
  const stored = await quota.getStoredToken(acc)
  assert.equal(stored?.accessToken, 'fake_access_token_123')
  assert.equal(stored?.refreshToken, 'fake_refresh_token_456')

  const validToken = await quota.getValidAccessToken(acc)
  assert.equal(validToken, 'fake_access_token_123')
})

test('normalizeStoredToken reads agy 1.1.16 nested shape with ISO expiry', () => {
  // Real on-disk format: {"token": {...}, "auth_method": "consumer"} with
  // expiry as a local ISO-8601 string. The old flat read returned the
  // nested object as the access token ("Bearer [object Object]").
  const nested = normalizeStoredToken({
    token: {
      access_token: 'ya29.nested',
      token_type: 'Bearer',
      refresh_token: '1//nested-refresh',
      expiry: '2026-08-20T16:44:43.782922+08:00',
    },
    auth_method: 'consumer',
  })
  assert.equal(nested?.accessToken, 'ya29.nested')
  assert.equal(nested?.refreshToken, '1//nested-refresh')
  assert.equal(nested?.expiryMs, Date.parse('2026-08-20T16:44:43.782922+08:00'))

  // A bare-object "token" must never be mistaken for the token string.
  assert.equal(normalizeStoredToken({ token: { nope: 1 } }), null)
  assert.equal(normalizeStoredToken({}), null)

  // Epoch seconds and millis both parse.
  const secs = normalizeStoredToken({ access_token: 'a', expiry: 1_800_000_000 })
  assert.equal(secs?.expiryMs, 1_800_000_000_000)
  const millis = normalizeStoredToken({ access_token: 'a', expiry: 1_800_000_000_000 })
  assert.equal(millis?.expiryMs, 1_800_000_000_000)
})

test('normalizeStoredToken parses go-keyring-base64 JSON payloads from Keychain', () => {
  const payload = {
    token: {
      access_token: 'ya29.keychain_access',
      token_type: 'Bearer',
      refresh_token: '1//keychain_refresh',
      expiry: '2026-08-21T15:34:29.273+08:00',
    },
    auth_method: 'consumer',
  }
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64')
  const rawKeychainString = `go-keyring-base64:${b64}`
  assert.ok(rawKeychainString.startsWith('go-keyring-base64:'))
  const decoded = JSON.parse(Buffer.from(rawKeychainString.slice('go-keyring-base64:'.length), 'base64').toString('utf8'))
  const token = normalizeStoredToken(decoded)
  assert.equal(token?.accessToken, 'ya29.keychain_access')
  assert.equal(token?.refreshToken, '1//keychain_refresh')
  assert.equal(token?.expiryMs, Date.parse('2026-08-21T15:34:29.273+08:00'))
})

test('writeAgyTokenFile emits the agy on-disk format and round-trips', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-oauth-write-'))
  const home = join(dir, 'home')
  const file = writeAgyTokenFile(home, {
    access_token: 'ya29.fresh',
    refresh_token: '1//fresh-refresh',
    expiryMs: Date.parse('2026-08-21T00:00:00Z'),
  })
  assert.ok(file.endsWith(join('.gemini', 'antigravity-cli', 'antigravity-oauth-token')))

  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('roundtrip')
  // Point the account at the HOME we just wrote.
  acc.dir = home
  const quota = new QuotaService(pool)
  const stored = await quota.getStoredToken(acc)
  assert.equal(stored?.accessToken, 'ya29.fresh')
  assert.equal(stored?.refreshToken, '1//fresh-refresh')
  assert.equal(stored?.expiryMs, Date.parse('2026-08-21T00:00:00Z'))
})

test('parsePastedCode accepts bare codes and full redirect URLs', () => {
  assert.deepEqual(parsePastedCode('4/1AfJohXyZ'), { code: '4/1AfJohXyZ' })
  assert.deepEqual(
    parsePastedCode('http://localhost:51121/oauth-callback?code=4/1AfCde&state=xyz123'),
    { code: '4/1AfCde', state: 'xyz123' },
  )
  assert.equal(parsePastedCode('http://localhost:51121/oauth-callback?state=xyz'), null)
  assert.equal(parsePastedCode('short'), null)
  assert.equal(parsePastedCode(''), null)
})

test('generatePkce produces a valid S256 pair', () => {
  const { verifier, challenge } = generatePkce()
  assert.ok(verifier.length >= 43)
  assert.ok(/^[A-Za-z0-9_-]+$/.test(verifier))
  assert.ok(/^[A-Za-z0-9_-]+$/.test(challenge))
  assert.notEqual(verifier, challenge)
})

test('Quota aggregation extracts bottleneck model fraction and earliest reset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-agg-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.getAccounts()[0]!

  pool.updateAccountQuotas(
    acc.id,
    {
      google: {
        remainingFraction: 0.85,
        resetTime: '2026-08-20T16:00:00Z',
        weeklyFraction: 0.95,
        weeklyResetTime: '2026-08-27T08:00:00Z',
        models: [
          { modelId: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)', remainingFraction: 0.85, resetTime: '2026-08-20T16:00:00Z' },
          { modelId: 'gemini-3.1-pro-high', displayName: 'Gemini 3.1 Pro (High)', remainingFraction: 0.9, resetTime: '2026-08-20T16:00:00Z' },
        ],
      },
      anthropic: {
        remainingFraction: 0.4,
        resetTime: '2026-08-20T18:30:00Z',
        weeklyFraction: 0.8,
        weeklyResetTime: '2026-08-27T12:00:00Z',
        models: [
          { modelId: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', remainingFraction: 0.4, resetTime: '2026-08-20T18:30:00Z' },
        ],
      },
      openai: {
        remainingFraction: 1.0,
        weeklyFraction: 1.0,
      },
    },
    'test@gmail.com',
  )

  const updated = pool.getAccount(acc.id)!
  assert.equal(updated.email, 'test@gmail.com')
  assert.equal(updated.quotas.google?.remainingFraction, 0.85)
  assert.equal(updated.quotas.google?.weeklyFraction, 0.95)
  assert.equal(updated.quotas.google?.weeklyResetTime, '2026-08-27T08:00:00Z')
  assert.equal(updated.quotas.google?.models?.length, 2)
  assert.equal(updated.quotas.anthropic?.remainingFraction, 0.4)
  assert.equal(updated.quotas.anthropic?.weeklyFraction, 0.8)
  assert.equal(updated.quotas.anthropic?.models?.length, 1)
  assert.equal(updated.quotas.openai?.remainingFraction, 1.0)
  assert.equal(updated.quotas.openai?.weeklyFraction, 1.0)
})

test('manual force refresh re-anchors slot identity from the token, not the label (primary showed another account\'s quota)', async () => {
  // Real incident: the system token belonged to elegantmanco@gmail.com but
  // the slot still said q986465568@gmail.com (log scraping returned the
  // stale label), so 刷新/同步 fetched elegantmanco's quota and displayed
  // it as the primary's values. Manual refresh must trust the TOKEN (via
  // userinfo) over both the stored label and log detection.
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-force-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('force-sync')
  // Slot currently labeled with the OLD account.
  pool.updateAccountQuotas(acc.id, { google: { remainingFraction: 0.5, weeklyFraction: 0.5 } }, 'q986465568@gmail.com')

  // Token on disk is valid, so no refresh-token flow kicks in.
  const tokenDir = join(acc.dir!, '.gemini', 'antigravity-cli')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(
    join(tokenDir, 'antigravity-oauth-token'),
    JSON.stringify({ access_token: 'ya29.tok_of_elegantmanco', expiry: Date.now() + 3600_000 }),
    'utf8',
  )

  let userinfoCalls = 0
  class ForceSyncService extends QuotaService {
    override async fetchUserInfo(): Promise<{ email?: string; name?: string } | null> {
      userinfoCalls++
      return { email: 'elegantmanco@gmail.com' }
    }
    override async fetchQuotaSummary() {
      // Wire shape captured live from v1internal:retrieveUserQuotaSummary:
      // groups use `name` and buckets use snake_case `remaining_fraction` / `reset_time`.
      return {
        groups: [
          {
            name: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: [
              { id: 'gemini-5h', window: '5h', remaining_fraction: 0.7, reset_time: '2026-08-27T12:00:00Z' },
              { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.42, reset_time: '2026-08-29T12:00:00Z' },
            ],
          },
        ],
      } as never
    }
    override async fetchAvailableModels() {
      return { models: {} } as never
    }
  }

  const svc = new ForceSyncService(pool)
  await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)

  assert.ok(userinfoCalls >= 1, 'manual refresh verifies the token identity via userinfo')
  const healed = pool.getAccount(acc.id)!
  assert.equal(healed.email, 'elegantmanco@gmail.com', 'slot re-labeled to the token owner')
  assert.equal(healed.quotas.google?.remainingFraction, 0.7, 'quota stored under the healed identity')
  assert.equal(healed.quotas.google?.weeklyFraction, 0.42)
})

test('background refresh keeps the zero-network identity path (no userinfo when email known)', async () => {
  // 0.4.15 risk posture: background polls never call userinfo just to detect
  // account switching — only manual force refreshes pay that network cost.
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-bg-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('bg-poll')
  pool.updateAccountQuotas(acc.id, { google: { remainingFraction: 0.5 } }, 'stable@gmail.com')

  const tokenDir = join(acc.dir!, '.gemini', 'antigravity-cli')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(
    join(tokenDir, 'antigravity-oauth-token'),
    JSON.stringify({ access_token: 'ya29.stable', expiry: Date.now() + 3600_000 }),
    'utf8',
  )

  let userinfoCalls = 0
  class BgService extends QuotaService {
    override async fetchUserInfo(): Promise<{ email?: string; name?: string } | null> {
      userinfoCalls++
      return null
    }
    override async fetchQuotaSummary() {
      // Real wire shape (snake_case) — see the note in the force-refresh test above.
      return { groups: [{ name: 'Gemini Models', buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: 0.9, reset_time: '2026-08-27T12:00:00Z' }] }] } as never
    }
    override async fetchAvailableModels() {
      return { models: {} } as never
    }
  }

  const svc = new BgService(pool)
  const out = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, false)
  assert.equal(userinfoCalls, 0, 'background refresh must not call userinfo')
  assert.equal(out?.google?.remainingFraction, 0.9)
  assert.equal(pool.getAccount(acc.id)!.email, 'stable@gmail.com')
})

test('getStoredToken prefers the macOS Keychain credential over a stale disk token for the primary account', async () => {
  // Real incident (verified live): agy 1.1.15+ keeps the CURRENT credential
  // in the macOS Keychain; the on-disk antigravity-oauth-token was a stale
  // leftover from a PREVIOUS account's login. Disk-first precedence made
  // every quota refresh fetch the WRONG account's numbers while agy itself
  // was happily authenticated as the right one.
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-kc-'))
  const pool = new AccountPoolManager(dir)
  const primary = pool.getAccounts().find((a) => a.systemHome)!
  assert.ok(primary, 'bootstrap default primary exists')

  const keychainToken = {
    accessToken: 'ya29.keychain_current_login',
    refreshToken: '1//keychain_refresh',
    expiryMs: Date.now() + 3_600_000,
  }
  let keychainReads = 0
  class KeychainFirstService extends QuotaService {
    override async readSystemKeychainToken() {
      keychainReads++
      return keychainToken
    }
  }

  const svc = new KeychainFirstService(pool)
  const stored = await svc.getStoredToken(primary)
  assert.ok(keychainReads >= 1, 'primary token resolution consults the Keychain')
  assert.equal(stored?.accessToken, 'ya29.keychain_current_login', 'Keychain credential wins over any disk file')
  assert.equal(stored?.refreshToken, '1//keychain_refresh')
})

test('getStoredToken never reads the shared Keychain for isolated pool accounts', async () => {
  // The Keychain is ONE shared slot owned by the system-HOME login; isolated
  // account slots must only ever see their own directory's token file.
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-iso-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('isolated')
  const tokenDir = join(acc.dir!, '.gemini', 'antigravity-cli')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(
    join(tokenDir, 'antigravity-oauth-token'),
    JSON.stringify({ access_token: 'ya29.isolated_own', expiry: Date.now() + 3600_000 }),
    'utf8',
  )
  let keychainReads = 0
  class IsoService extends QuotaService {
    override async readSystemKeychainToken() {
      keychainReads++
      return null
    }
  }
  const svc = new IsoService(pool)
  assert.equal((await svc.getStoredToken(acc))?.accessToken, 'ya29.isolated_own')
  assert.equal(keychainReads, 0, 'isolated accounts must not touch the shared Keychain')
})

test('detectEmailFromAgyLogs returns the latest email in a log file, not the first', () => {
  // Logs are append-ordered: an old login can appear ABOVE a newer one.
  // First-match returned the OLD account; the last match is the current one.
  const dir = mkdtempSync(join(tmpdir(), 'agy-log-last-'))
  const logDir = join(dir, '.gemini', 'antigravity-cli', 'log')
  mkdirSync(logDir, { recursive: true })
  writeFileSync(
    join(logDir, 'cli-20260827_100000.log'),
    'OAuth: authenticated successfully as old.account@google.com\n' +
      '...hours pass...\n' +
      'OAuth: authenticated successfully as new.account@google.com\n',
    'utf8',
  )
  assert.equal(detectEmailFromAgyLogs(dir), 'new.account@google.com')
})

test('detectEmailFromAgyLogs extracts user email from agy log files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-log-test-'))
  const logDir = join(dir, '.gemini', 'antigravity-cli', 'log')
  mkdirSync(logDir, { recursive: true })
  writeFileSync(
    join(logDir, 'cli-20260820_120000.log'),
    'ERROR: logging before google.Init: OAuth: authenticated successfully as dev.user@google.com\n',
    'utf8',
  )
  const email = detectEmailFromAgyLogs(dir)
  assert.equal(email, 'dev.user@google.com')
})

test('shouldPollAccount skips restricted accounts in background polling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-poll-gate-'))
  const pool = new AccountPoolManager(dir)
  const healthy = pool.createAccountSlot('healthy')
  const cooling = pool.createAccountSlot('cooling')
  const quarantined = pool.createAccountSlot('quarantined')
  const disabled = pool.createAccountSlot('disabled')

  // healthy: pollable as-is
  assert.equal(shouldPollAccount(pool.getAccount(healthy.id)!), true)

  // cooling: 429 cooldown active -> skipped until it expires
  pool.recordFailure(cooling.id, 'google', 'RESOURCE_EXHAUSTED (code 429): quota reached. Resets in 21m25s.')
  assert.equal(shouldPollAccount(pool.getAccount(cooling.id)!), false)

  // quarantined: invalid_grant -> skipped until re-auth
  pool.markAuthRequired(quarantined.id, 'invalid_grant')
  assert.equal(shouldPollAccount(pool.getAccount(quarantined.id)!), false)

  // disabled: skipped
  const dis = pool.getAccount(disabled.id)!
  dis.enabled = false
  assert.equal(shouldPollAccount(dis), false)

  // expired cooldown becomes pollable again
  const cd = pool.getAccount(cooling.id)!.cooldowns.google!
  cd.cooldownUntil = Date.now() - 1
  assert.equal(shouldPollAccount(pool.getAccount(cooling.id)!), true)
})

test('mergeFallbackFamilyQuota keeps last-known-good data over partial fallback', () => {
  // Real incident shape: complete entry (5h + weekly) existed, then the
  // summary endpoint blipped and per-model fallback arrived carrying a
  // single window (fraction 1, weekly-window reset a week out, no weekly).
  const good: import('../src/common/pool-types.ts').FamilyQuotaInfo = {
    remainingFraction: 0.84,
    resetTime: '2026-08-25T14:01:28Z',
    weeklyFraction: 0.47,
    weeklyResetTime: '2026-08-27T08:13:04Z',
    updatedAt: 1_000,
  }
  const partial = {
    remainingFraction: 1,
    resetTime: '2026-09-01T09:53:06Z',
    updatedAt: 2_000,
  }
  // Complete previous data wins — never clobbered by the partial shape.
  assert.equal(mergeFallbackFamilyQuota(good, partial), good)
  assert.equal(mergeFallbackFamilyQuota(good, partial).weeklyFraction, 0.47)
  // No previous data (first-ever refresh) → fallback fills in.
  assert.equal(mergeFallbackFamilyQuota(undefined, partial), partial)
  // Degenerate previous entry without a fraction → fallback fills in.
  assert.equal(mergeFallbackFamilyQuota({ weeklyFraction: 0.5 }, partial), partial)
})

test('UI_PATHS contains all expected clean SVG paths', async () => {
  const { UI_PATHS } = await import('../src/client/brand-icons.ts')
  assert.ok(UI_PATHS.trash.length > 10)
  assert.ok(UI_PATHS.plus.length > 5)
  assert.ok(UI_PATHS.refresh.length > 10)
  assert.ok(UI_PATHS.star.length > 10)
  assert.ok(UI_PATHS.mail.length > 10)
  assert.ok(UI_PATHS.globe.length > 10)
  assert.ok(UI_PATHS.zap.length > 5)
  assert.ok(UI_PATHS.x.length > 5)
  assert.ok(UI_PATHS.check.length > 5)
})


test('readSystemKeychainToken dispatches per platform (GH #8 / GH #30)', async () => {
  const { readLinuxSecretToken, readMacKeychainToken, readWindowsCredentialToken } = await import('../src/host/quota.ts')
  // Both readers are hard platform gates - safe to call anywhere.
  if (process.platform !== 'darwin') assert.equal(await readMacKeychainToken(), null, 'mac reader no-ops off darwin')
  if (process.platform !== 'linux') assert.equal(await readLinuxSecretToken(), null, 'linux reader no-ops off linux')
  if (process.platform !== 'win32') assert.equal(await readWindowsCredentialToken(), null, 'windows reader no-ops off win32')
  // A subclass mirroring the production dispatch resolves without throwing.
  // (Result is environment-dependent: a real keyring entry may exist.)
  class DispatchProbe extends QuotaService {
    override async readSystemKeychainToken() {
      if (process.platform === 'linux') return readLinuxSecretToken()
      if (process.platform === 'darwin') return readMacKeychainToken()
      if (process.platform === 'win32') return readWindowsCredentialToken()
      return null
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-dispatch-'))
  const pool = new AccountPoolManager(dir)
  const primary = pool.createAccountSlot('primary')
  primary.systemHome = true
  const svc = new DispatchProbe(pool)
  const tok = await svc.getStoredToken(primary)
  assert.ok(tok === null || typeof tok.accessToken === 'string', 'dispatch resolves without throwing')
})

/**
 * REGRESSION: the dashboard showed a permanent 100% for every quota family.
 *
 * Root cause: the parser read camelCase `remainingFraction` / `resetTime` and
 * `group.displayName`, while the live wire format of
 * v1internal:retrieveUserQuotaSummary is snake_case (`remaining_fraction` /
 * `reset_time`) with `group.name`. Every bucket resolved to undefined, and the
 * UI's `?? 1` fallback then rendered undefined as a confident 100%.
 *
 * Why the suite missed it: the old mocks returned camelCase, i.e. they encoded
 * the same wrong assumption as the code. This test pins the REAL wire shape
 * (captured live from agy 1.3.x) and asserts the camelCase shape keeps working.
 */
test('refreshAccountQuota normalizes snake_case AND camelCase quota buckets (regression: permanent 100%)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-casing-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('casing-test')

  const tokenDir = join(acc.dir!, '.gemini', 'antigravity-cli')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(
    join(tokenDir, 'antigravity-oauth-token'),
    JSON.stringify({ access_token: 'ya29.casing', expiry: Date.now() + 3600_000 }),
    'utf8',
  )

  const shapeFor = (snake: boolean) => ({
    groups: [
      {
        ...(snake ? { name: 'Gemini Models' } : { displayName: 'Gemini Models' }),
        description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: [
          snake
            ? { id: 'gemini-5h', window: '5h', remaining_fraction: 0.55, reset_time: '2026-09-21T15:29:00Z' }
            : { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.55, resetTime: '2026-09-21T15:29:00Z' },
          snake
            ? { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.9, reset_time: '2026-09-23T17:03:40Z' }
            : { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9, resetTime: '2026-09-23T17:03:40Z' },
        ],
      },
      {
        ...(snake ? { name: 'Claude and GPT models' } : { displayName: 'Claude and GPT models' }),
        description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
        buckets: [
          snake
            ? { id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '2026-09-28T13:15:12Z' }
            : { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-09-28T13:15:12Z' },
        ],
      },
    ],
  })

  for (const snake of [true, false]) {
    const label = snake ? 'snake_case (live wire format)' : 'camelCase (legacy)'
    class CasingService extends QuotaService {
      override async fetchQuotaSummary() {
        return shapeFor(snake) as never
      }
      override async fetchAvailableModels() {
        return { models: {} } as never
      }
    }
    const svc = new CasingService(pool)
    await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)
    const q = pool.getAccount(acc.id)!.quotas

    assert.equal(q.google?.remainingFraction, 0.55, label + ': 5h fraction must parse (undefined renders as 100%)')
    assert.equal(q.google?.resetTime, '2026-09-21T15:29:00Z', label + ': 5h reset time')
    assert.equal(q.google?.weeklyFraction, 0.9, label + ': weekly fraction must parse')
    assert.equal(q.google?.weeklyResetTime, '2026-09-23T17:03:40Z', label + ': weekly reset time')
    assert.equal(q.anthropic?.weeklyFraction, 1, label + ': 3P group recognized via name/displayName')
    assert.equal(q.openai?.weeklyFraction, 1, label + ': 3P group maps to both anthropic and openai')
  }
})
