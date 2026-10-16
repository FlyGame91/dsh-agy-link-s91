// agy per-run log access (dsh-agy-link).
//
// agy writes one log per invocation under
//   <home>/.gemini/antigravity-cli/log/cli-<YYYYMMDD_HHMMSS>.log
// where <home> is the account's isolated HOME (secondary accounts) or the real
// system HOME (primary / systemHome account) — the same resolution
// `isolatedHomeEnv` applies at spawn time.
//
// Why the adapter needs this: when agy's silent auth fails it prints a stderr
// banner that is byte-identical for a genuine sign-out and for a stored
// credential that could not be validated over the network (keyring auth missed
// its hard 10s window). Classifying both as AUTH sticky-quarantined three
// healthy accounts during one afternoon of proxy jitter (2026-10-16). The log
// is the only per-run signal that separates the two — see
// `looksLikeAuthVerificationJitter` in common/types.ts for the marker set.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { ManagedAccount } from '../common/pool-types.ts'

/** Same home resolution quota.ts uses for per-account credential access. */
export function agyHomeDirFor(account: ManagedAccount | undefined): string {
  return account?.systemHome || !account?.dir ? homedir() : account.dir
}

export function agyLogDir(homeDir: string): string {
  return join(homeDir, '.gemini', 'antigravity-cli', 'log')
}

/** Names of the cli-*.log files present right now (cheap readdir). */
export function snapshotAgyLogs(homeDir: string): Set<string> {
  const dir = agyLogDir(homeDir)
  try {
    return new Set(readdirSync(dir).filter((f) => f.startsWith('cli-') && f.endsWith('.log')))
  } catch {
    return new Set()
  }
}

/** Upper bound so one pathological log cannot balloon the failure path. */
const MAX_LOG_BYTES = 256 * 1024
const MAX_LOG_FILES = 3

/**
 * Concatenated text of the log files THIS run created (present now, absent
 * from the pre-spawn snapshot), newest first. Returns '' when the run wrote no
 * readable log — callers must treat that as "no evidence", never as proof
 * either way.
 */
export function readAgyRunLogText(homeDir: string, before: ReadonlySet<string>): string {
  const dir = agyLogDir(homeDir)
  let names: string[]
  try {
    if (!existsSync(dir)) return ''
    names = readdirSync(dir)
      .filter((f) => f.startsWith('cli-') && f.endsWith('.log') && !before.has(f))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, MAX_LOG_FILES)
      .map((e) => e.f)
  } catch {
    return ''
  }
  const parts: string[] = []
  let budget = MAX_LOG_BYTES
  for (const name of names) {
    if (budget <= 0) break
    try {
      const text = readFileSync(join(dir, name), 'utf8')
      const slice = text.length > budget ? text.slice(-budget) : text
      parts.push(slice)
      budget -= slice.length
    } catch {
      // A log that vanished mid-read contributes nothing.
    }
  }
  return parts.join('\n')
}
