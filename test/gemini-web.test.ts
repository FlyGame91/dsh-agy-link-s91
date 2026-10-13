import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveGeminiWebModel } from '../src/host/gemini-web.ts'
import { AccountPoolManager } from '../src/host/pool.ts'

test('resolveGeminiWebModel: maps models directly to user selected model without fictional fallbacks', () => {
  // Flash models map directly
  const flash = resolveGeminiWebModel('gemini-3.8-flash')
  assert.equal(flash.targetModel, 'gemini-3.8-flash')
  assert.equal(flash.isFlagship, false)

  const flash37 = resolveGeminiWebModel('gemini-3.7-flash')
  assert.equal(flash37.targetModel, 'gemini-3.7-flash')
  assert.equal(flash37.isFlagship, false)

  const genericFlash = resolveGeminiWebModel('gemini-2.5-flash')
  assert.equal(genericFlash.targetModel, 'gemini-2.5-flash')
  assert.equal(genericFlash.isFlagship, false)

  const flashThinking = resolveGeminiWebModel('gemini-3.8-flash-thinking')
  assert.equal(flashThinking.targetModel, 'gemini-3.8-flash-thinking')
  assert.equal(flashThinking.enableThinking, true)

  // Pro model maps directly to user-requested pro model
  const pro25 = resolveGeminiWebModel('gemini-2.5-pro')
  assert.equal(pro25.targetModel, 'gemini-2.5-pro')
  assert.equal(pro25.isFlagship, true)

  // Provider prefix stripped cleanly
  const prefixed = resolveGeminiWebModel('antigravity/gemini-2.5-flash')
  assert.equal(prefixed.targetModel, 'gemini-2.5-flash')

  // Empty model falls back to default 2.5-pro
  const empty = resolveGeminiWebModel(undefined)
  assert.equal(empty.targetModel, 'gemini-2.5-pro')
  assert.equal(empty.isFlagship, true)
})

test('pool: gemini-web accounts only serve google family and skip non-google requests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-gemini-web-'))
  const pool = new AccountPoolManager(dir)

  const webAuth = {
    cookies: '__Secure-1PSID=fake_cookie_123',
    snlm0e: 'fake_snlm0e_token',
    accountEmail: 'user@example.com',
    capturedAt: Date.now(),
  }

  const webAcc = pool.addGeminiWebAccount('Gemini Web 1', webAuth)
  assert.equal(webAcc.type, 'gemini-web')
  assert.equal(webAcc.email, 'user@example.com')

  // Google family is eligible
  assert.equal(pool.isAccountEligible(webAcc, 'google'), true)
  // Non-Google families (Claude, GPT-OSS) are NOT eligible for gemini-web
  assert.equal(pool.isAccountEligible(webAcc, 'anthropic'), false)
  assert.equal(pool.isAccountEligible(webAcc, 'openai'), false)
})

test('pool: drag-reorder sets priority, putting gemini-web as #1 without breaking non-google routing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-gemini-reorder-'))
  const pool = new AccountPoolManager(dir)

  const agyAcc = pool.getAccounts()[0]! // default agy account
  const webAuth = {
    cookies: '__Secure-1PSID=fake_cookie_456',
    snlm0e: 'fake_snlm0e_token',
    accountEmail: 'webuser@example.com',
    capturedAt: Date.now(),
  }
  const webAcc = pool.addGeminiWebAccount('Web Priority #1', webAuth)

  // Reorder accounts so webAcc is placed at index 0 (#1 priority)
  pool.reorderAccounts([webAcc.id, agyAcc.id])

  // Verify accounts array order
  const accounts = pool.getAccounts()
  assert.equal(accounts[0]!.id, webAcc.id)
  assert.equal(accounts[1]!.id, agyAcc.id)

  // Google requests pick the #1 Gemini Web account
  const selectedGoogle = pool.selectAccount('google')
  assert.equal(selectedGoogle?.id, webAcc.id)

  // Claude requests automatically skip Gemini Web and route to the agy account
  const selectedAnthropic = pool.selectAccount('anthropic')
  assert.equal(selectedAnthropic?.id, agyAcc.id)

  // GPT-OSS requests also skip Gemini Web and route to the agy account
  const selectedOpenai = pool.selectAccount('openai')
  assert.equal(selectedOpenai?.id, agyAcc.id)
})

import { findInstalledBrowsers, findSystemBrowser, syncUserProfile, getRealUserHome } from '../src/host/web-login-browser.ts'
import { writeFileSync, readFileSync, existsSync, mkdirSync as fsMkdirSync } from 'node:fs'

test('web-login-browser: detect installed browsers and support chrome / edge', () => {
  const home = getRealUserHome()
  assert.ok(home && home.length > 0)

  const installed = findInstalledBrowsers()
  assert.ok(Array.isArray(installed))
  for (const b of installed) {
    assert.ok(b.id === 'chrome' || b.id === 'edge')
    assert.ok(b.name.length > 0)
    assert.ok(b.path.length > 0)
    assert.ok(b.userDataDir.length > 0)
  }

  const sys = findSystemBrowser()
  if (installed.length > 0) {
    assert.ok(sys !== null)
    assert.ok(sys.id === 'chrome' || sys.id === 'edge')
  }

  const prefEdge = findSystemBrowser('edge')
  if (installed.some((b) => b.id === 'edge')) {
    assert.equal(prefEdge?.id, 'edge')
  }

  const prefChrome = findSystemBrowser('chrome')
  if (installed.some((b) => b.id === 'chrome')) {
    assert.equal(prefChrome?.id, 'chrome')
  }
})

test('web-login-browser: syncUserProfile synchronizes user profile files and strips locks', () => {
  const srcDir = mkdtempSync(join(tmpdir(), 'agy-src-profile-'))
  const dstDir = mkdtempSync(join(tmpdir(), 'agy-dst-profile-'))

  // Create dummy source profile
  writeFileSync(join(srcDir, 'Local State'), '{"os_crypt":"fake_key"}')
  const srcDefault = join(srcDir, 'Default')
  fsMkdirSync(srcDefault, { recursive: true })
  writeFileSync(join(srcDefault, 'Cookies'), 'dummy-cookies-data')
  writeFileSync(join(srcDefault, 'Preferences'), '{"profile":{"name":"User"}}')

  // Create an old lock file in destination
  writeFileSync(join(dstDir, 'DevToolsActivePort'), '1234\n/path')
  writeFileSync(join(dstDir, 'SingletonLock'), 'lock')

  syncUserProfile(srcDir, dstDir)

  // Locks should be removed
  assert.equal(existsSync(join(dstDir, 'DevToolsActivePort')), false)
  assert.equal(existsSync(join(dstDir, 'SingletonLock')), false)

  // Essential files should be copied
  assert.equal(readFileSync(join(dstDir, 'Local State'), 'utf8'), '{"os_crypt":"fake_key"}')
  assert.equal(readFileSync(join(dstDir, 'Default', 'Cookies'), 'utf8'), 'dummy-cookies-data')
  assert.equal(readFileSync(join(dstDir, 'Default', 'Preferences'), 'utf8'), '{"profile":{"name":"User"}}')
})

test('web-login-browser: syncUserProfile preserves existing account profile and supports inheritCookies=false', () => {
  const srcDir = mkdtempSync(join(tmpdir(), 'agy-src-profile-2-'))
  const dstDir = mkdtempSync(join(tmpdir(), 'agy-dst-profile-2-'))

  writeFileSync(join(srcDir, 'Local State'), '{"os_crypt":"source_key"}')
  const srcDefault = join(srcDir, 'Default')
  fsMkdirSync(srcDefault, { recursive: true })
  writeFileSync(join(srcDefault, 'Cookies'), 'source-cookies')

  // Case 1: inheritCookies: false creates clean Default without source cookies
  syncUserProfile(srcDir, dstDir, { inheritCookies: false })
  assert.equal(readFileSync(join(dstDir, 'Local State'), 'utf8'), '{"os_crypt":"source_key"}')
  assert.equal(existsSync(join(dstDir, 'Default')), true)
  assert.equal(existsSync(join(dstDir, 'Default', 'Cookies')), false)

  // Case 2: If destination profile already exists, it is NEVER overwritten
  writeFileSync(join(dstDir, 'Default', 'Cookies'), 'isolated-account-cookies')
  syncUserProfile(srcDir, dstDir, { inheritCookies: true })
  assert.equal(readFileSync(join(dstDir, 'Default', 'Cookies'), 'utf8'), 'isolated-account-cookies')
})

test('pool: addGeminiWebAccount supports customId for per-account isolated directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-custom-id-'))
  const pool = new AccountPoolManager(dir)

  const customId = 'acc_web_dedicated_123'
  const acc = pool.addGeminiWebAccount('Dedicated Account', {
    cookies: 'cookie=test',
    snlm0e: 'token123',
    accountEmail: 'user@gmail.com',
    capturedAt: Date.now(),
  }, undefined, customId)

  assert.equal(acc.id, customId)
  assert.equal(acc.dir, join(dir, customId))
  assert.equal(existsSync(acc.dir), true)
})


