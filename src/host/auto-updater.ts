// Issue #49: agy >= 1.4.2 spawns its own `--bg-updater` child, and that child
// then spawns `agy --version` with a fresh pseudo console. Because the chain
// starts inside agy, the parent's `windowsHide` and every quiet env switch
// (`AGY_CLI_DISABLE_AUTO_UPDATE=1`, `CI=1`, …) apply too late — the visible
// Windows Terminal flash has already happened. See issue #49 for the recorded
// PID tree and window events.
//
// The one lever that works *before* the child chain starts is agy's own
// 15-minute fast path:
//
//   auto_updater.go:281  Last check was less than 15 minutes ago, skipping update (fast path)
//
// It only stats `<app data dir>/last_check.timestamp`, so refreshing that mtime
// immediately before every spawn keeps agy on the fast path forever and no
// `--bg-updater` process is ever created (verified against agy 1.4.2).
//
// Tradeoff, documented in README: the agy home the plugin spawns with stops
// doing *automatic* update checks. A manual `agy update` is unaffected — unlike
// the read-only `update.lock` workaround, which makes `agy update` fail with
// "update already in progress".
import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** agy's auto-updater fast-path window (auto_updater.go). */
export const UPDATE_CHECK_FAST_PATH_MS = 15 * 60_000

export interface PreemptFailure {
  path: string
  error: string
}

export interface PreemptResult {
  /** Timestamp files whose mtime now marks a fresh update check. */
  touched: string[]
  /** Per-path failures; pre-emption is best-effort and never throws. */
  failures: PreemptFailure[]
}

function nonBlank(v: string | undefined): string {
  return (v ?? '').trim()
}

/**
 * agy's application data directory for a given spawn environment.
 *
 * The plugin isolates pooled accounts by rewriting HOME / USERPROFILE /
 * GEMINI_CLI_HOME / ANTIGRAVITY_APP_DATA_DIR (see `isolatedHomeEnv`), and agy
 * resolves its data dir from exactly those variables — an isolated spawn was
 * verified to write `<home>/.gemini/antigravity-cli/last_check.timestamp`.
 */
export function agyAppDataDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = nonBlank(env.ANTIGRAVITY_APP_DATA_DIR)
  if (explicit !== '') return explicit
  const geminiDir = nonBlank(env.GEMINI_CLI_HOME)
  if (geminiDir !== '') return join(geminiDir, 'antigravity-cli')
  let home = nonBlank(env.HOME)
  if (home === '') home = nonBlank(env.USERPROFILE)
  if (home === '') {
    try {
      home = homedir()
    } catch {
      home = ''
    }
  }
  if (home === '') return null
  return join(home, '.gemini', 'antigravity-cli')
}

/**
 * Candidate `last_check.timestamp` locations for one spawn environment.
 *
 * The issue reporter observed `<appData>/updater/last_check.timestamp` on
 * Windows while macOS uses `<appData>/last_check.timestamp`. Refreshing both is
 * cheap and keeps the fix independent of agy's per-platform path choice.
 */
export function agyUpdateCheckPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const appData = agyAppDataDir(env)
  if (appData === null) return []
  return [join(appData, 'last_check.timestamp'), join(appData, 'updater', 'last_check.timestamp')]
}

/**
 * Refresh agy's update-check timestamp so the next spawn takes the fast path.
 * Best-effort: a read-only or missing profile must never fail a run.
 */
export function preemptAgyAutoUpdate(env: NodeJS.ProcessEnv = process.env, now = Date.now()): PreemptResult {
  const result: PreemptResult = { touched: [], failures: [] }
  const seconds = Math.floor(now / 1000)
  for (const path of agyUpdateCheckPaths(env)) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      if (!existsSync(path)) writeFileSync(path, '')
      utimesSync(path, seconds, seconds)
      result.touched.push(path)
    } catch (err) {
      result.failures.push({ path, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return result
}

/** Age (ms) of the most recent recorded update check, or null when none exists. */
export function agyUpdateCheckAgeMs(env: NodeJS.ProcessEnv = process.env, now = Date.now()): number | null {
  let freshest: number | null = null
  for (const path of agyUpdateCheckPaths(env)) {
    try {
      const age = now - statSync(path).mtimeMs
      if (freshest === null || age < freshest) freshest = age
    } catch {
      // missing file — try the next candidate
    }
  }
  return freshest
}

/** One-line `/agy doctor` summary of the auto-update suppression state. */
export function describeAgyAutoUpdate(env: NodeJS.ProcessEnv = process.env, now = Date.now()): string {
  if (agyUpdateCheckPaths(env).length === 0) return 'unknown — no agy home directory in the spawn env'
  const age = agyUpdateCheckAgeMs(env, now)
  if (age === null) return 'armed — no agy update check recorded yet; the next spawn pre-empts it'
  const minutes = Math.max(0, Math.round(age / 60_000))
  if (age < UPDATE_CHECK_FAST_PATH_MS) return 'suppressed — last check ' + minutes + 'm ago (agy fast path < 15m)'
  return 'stale — last check ' + minutes + 'm ago; the next spawn pre-empts it'
}
