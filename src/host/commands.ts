// /agy command family (spec section 6). One registered command dispatches
// on its first token; every handler answers with GUI-renderable markdown.
import { isAbsolute } from 'node:path'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { PluginConfig } from '../common/types.ts'
import type { AuthHelper } from './auth.ts'
import type { ModelCatalog } from './models.ts'
import type { SessionStore } from './sessions.ts'
import type { AccountPoolManager } from './pool.ts'
import type { PoolAuthFlow } from './pool-auth.ts'
import type { QuotaService } from './quota.ts'
import { classifyToolError } from './recording.ts'
import { redactProxyUrl } from './diagnostics.ts'

export interface CommandDeps {
  cfg: () => PluginConfig
  bin: () => string | null
  version: () => string | null
  auth: () => AuthHelper | null
  catalog: () => ModelCatalog
  store: () => SessionStore
  pool?: () => AccountPoolManager
  poolAuth?: () => PoolAuthFlow
  quota?: () => QuotaService
  lastRun: () => {
    processOk: boolean
    processCode: string
    toolErrors: readonly string[]
    durationMs: number
    model: string
    tokenSpeed?: { lastTps: number | null; avgTps: number | null; outputTokens: number; measuredSteps: number; generatingMs: number }
  } | null
  setOverride: (key: string, value: unknown) => void
  runDoctor: () => Promise<string>
  sessions?: () => { get(id: unknown): unknown } | undefined
}

const HELP = [
  '**/agy** — Antigravity (agy CLI) bridge',
  '- `/agy status` — binary, version, auth, mode, catalog, bindings',
  '- `/agy pool` / `/agy accounts` — account pool, live quota %, cooldowns',
  '- `/agy goal [status|complete|clear|pause]` — inspect or control the current DSH goal',
  '- `/agy session [info|clear]` — view or drop the current session agy binding',
  '- `/agy add-account [alias]` — start OAuth login for a new account slot',
  '- `/agy enable-account <id>` — enable an account slot',
  '- `/agy disable-account <id>` — disable an account slot (skips in rotation)',
  '- `/agy refresh-quota` — query Google backend for fresh quota %',
  '- `/agy clear-cooldown` — reset cooldown timers across all accounts',
  '- `/agy remove-account <id>` — delete an account slot',
  '- `/agy auth` — Google login for the primary account (opens the browser)',
  '- `/agy auth-code <code>` — finish login by pasting the code (fallback)',
  '- `/agy models` — refresh and list discovered models',
  '- `/agy mode <skip|plan|accept-edits>` — permission mode (next turn)',
  '- `/agy effort <low|medium|high|default>` — default reasoning effort',
  '- `/agy workspace [path]` — set the agy working directory (absolute path; omit to show)',
  '- `/agy clear` — drop the most recent conversation binding',
  '- `/agy doctor` — write a diagnostic report and return its path',
  '- `/agy help` — this text',
].join('\n')

export function agyCommandDefinition(deps: CommandDeps): CommandDefinition {
  return {
    name: 'agy',
    description: 'Antigravity (agy CLI) bridge: status, login, models, mode, diagnostics, goal',
    // Without `input`, DSH's composer treats `/agy <sub>` as an illegal bare
    // command and silently falls back to a normal chat message (issue #27).
    input: { hint: '<status|pool|goal|session|enable-account|disable-account|models|mode|effort|workspace|clear|doctor|help>' },
    handler: (invocation) => handle(deps, invocation.rawInput, invocation),
  }
}

async function handle(deps: CommandDeps, raw: string, invocation?: CommandInvocation): Promise<CommandResult> {
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  const sub = parts[0] ?? 'help'
  const arg = parts[1] ?? ''
  try {
    if (sub === 'status') return ok(await renderStatus(deps))
    if (sub === 'pool' || sub === 'accounts') {
      const pool = deps.pool?.()
      if (!pool) return ok('Account pool not enabled.')
      const accounts = pool.getAccounts()
      const data = pool.getPoolData()
      const lines = [
        `**Antigravity Account Pool (${accounts.length} accounts, mode: ${data.mode})**`,
      ]
      for (let i = 0; i < accounts.length; i++) {
        const a = accounts[i]
        if (!a) continue
        const isPrimary = a.id === data.primaryAccountId
        const qG = a.quotas.google?.remainingFraction !== undefined ? `${Math.round(a.quotas.google.remainingFraction * 100)}%` : 'unknown'
        const qC = a.quotas.anthropic?.remainingFraction !== undefined ? `${Math.round(a.quotas.anthropic.remainingFraction * 100)}%` : 'unknown'
        const qO = a.quotas.openai?.remainingFraction !== undefined ? `${Math.round(a.quotas.openai.remainingFraction * 100)}%` : 'unknown'
        const cds: string[] = []
        for (const [fam, cd] of Object.entries(a.cooldowns)) {
          if (cd && cd.cooldownUntil > Date.now()) {
            const sec = Math.ceil((cd.cooldownUntil - Date.now()) / 1000)
            cds.push(`${fam} cooldown: ${sec}s left (${cd.reason})`)
          }
        }
          let statusText = '   - Status: 🟢 Ready'
          if (!a.enabled) {
            statusText = '   - Status: ⏸️ Disabled'
          } else if (a.authRequired) {
            statusText = `   - Status: 🔴 Auth required (${a.authError || 'sign in again'})`
          } else if (cds.length > 0) {
            statusText = `   - ⚠️ ${cds.join('; ')}`
          }
          lines.push(
            `${i + 1}. **${a.alias}** (${a.email || a.id})${isPrimary ? ' ⭐ primary' : ''}`,
            // Proxy URLs can embed user:pass — never print them raw into the GUI.
            `   - Proxy: ${a.proxyUrl ? redactProxyUrl(a.proxyUrl) : deps.cfg().proxyUrl ? redactProxyUrl(deps.cfg().proxyUrl) : 'system default'}`,
            `   - Quota: Gemini ${qG} | Claude ${qC} | GPT-OSS ${qO}`,
            statusText,
          )
        }
        return ok(lines.join('\n'))
      }
      if (sub === 'enable-account' || sub === 'disable-account') {
        if (!arg) return err(`usage: /agy ${sub} <id>`)
        const pool = deps.pool?.()
        if (!pool) return err('Account pool not available')
        const enabled = sub === 'enable-account'
        const success = pool.setAccountEnabled(arg, enabled)
        return success ? ok(`${enabled ? 'Enabled' : 'Disabled'} account ${arg}`) : err(`Account ${arg} not found`)
      }
      if (sub === 'add-account') {
        const pool = deps.pool?.()
        if (!pool) return err('Account pool not available')
        const acc = pool.createAccountSlot(arg || undefined)
        // Quarantine until the terminal login completes: without the flag the
        // scheduler immediately routed real runs to the empty slot — a
        // guaranteed failure plus cooldown noise. The first successful run or
        // quota refresh clears it (recordSuccess / clearAuthRequired).
        pool.markAuthRequired(acc.id, 'not signed in yet — complete the terminal login')
        return ok([
          `**Account slot created: [${acc.alias}]** (id: \`${acc.id}\`)`,
          `- Isolated directory: \`${acc.dir}\``,
          `- Run in terminal: \`HOME="${acc.dir}" agy\` to authenticate this Google account.`,
          `- The slot stays OUT of rotation (authRequired) until the login completes and a quota refresh verifies it.`,
          `- Once logged in, run: \`/agy pool\` or click 🔄 刷新额度 in WebUI.`,
        ].join('\n'))
      }
      if (sub === 'refresh-quota') {
        const quota = deps.quota?.()
        if (!quota) return err('Quota service not available')
        await quota.refreshAllQuotas()
        return ok('Refreshed quota statistics for all accounts in pool.')
      }
      if (sub === 'clear-cooldown') {
        const pool = deps.pool?.()
        if (!pool) return err('Account pool not available')
        pool.clearCooldown(arg || undefined)
        return ok('Cleared cooldown timers.')
      }
      if (sub === 'remove-account') {
        if (!arg) return err('usage: /agy remove-account <id>')
        const pool = deps.pool?.()
        if (!pool) return err('Account pool not available')
        const success = pool.deleteAccount(arg)
        return success ? ok(`Removed account ${arg}`) : err(`Account ${arg} not found`)
      }

      if (sub === 'goal') {
        const action = arg || 'status'
        const session = (invocation?.agent?.session as { events?: readonly { type: string; data?: unknown }[]; append?: (t: string, d: unknown) => unknown } | undefined)
          ?? (deps.sessions?.() && invocation?.agent?.id ? (deps.sessions()!.get(invocation.agent.id) as { events?: readonly { type: string; data?: unknown }[]; append?: (t: string, d: unknown) => unknown }) : undefined)

        if (!session) {
          return err('No active DSH session available for goal command.')
        }

        const events = session.events
        type GoalChangeData = {
          operation?: string
          goal?: { id: string; revision: number; objective: string; phase: string; maxGoalRounds?: number; blockedReason?: { message: string } }
          roundsStarted?: number
          createdAt?: number
        }
        let latestGoalChange: GoalChangeData | null = null

        if (events) {
          for (let i = events.length - 1; i >= 0; i--) {
            const ev = events[i]
            if (ev?.type === 'goal/change' && ev.data && typeof ev.data === 'object') {
              const d = ev.data as { kind?: string; operation?: string; goal?: unknown; roundsStarted?: number; createdAt?: number }
              if (d.kind === 'goal/change') {
                latestGoalChange = d as GoalChangeData
                break
              }
            }
          }
        }

        const activeGoal = latestGoalChange && latestGoalChange.operation !== 'clear' ? latestGoalChange.goal : null

        if (action === 'status') {
          if (!activeGoal || !latestGoalChange) {
            return ok('**DSH Goal Status**: No active goal in this session.')
          }
          const phaseEmoji: Record<string, string> = {
            active: '🟢',
            paused: '⏸️',
            blocked: '🚫',
            complete: '✅',
          }
          return ok([
            `**DSH Goal Status** (${phaseEmoji[activeGoal.phase] ?? '⚪'} \`${activeGoal.phase}\`)`,
            `- **Goal ID**: \`${activeGoal.id}\` (rev ${activeGoal.revision})`,
            `- **Objective**: ${activeGoal.objective}`,
            `- **Rounds**: ${latestGoalChange.roundsStarted ?? 1} / ${activeGoal.maxGoalRounds ?? 256}`,
            ...(activeGoal.blockedReason ? [`- **Blocked Reason**: ${activeGoal.blockedReason.message}`] : []),
          ].join('\n'))
        }

        if (action === 'complete') {
          if (!activeGoal || !latestGoalChange) return err('No active goal to complete.')
          if (typeof session.append === 'function') {
            session.append('goal/change', {
              kind: 'goal/change',
              version: 1,
              operation: 'complete',
              goal: {
                id: activeGoal.id,
                revision: activeGoal.revision + 1,
                objective: activeGoal.objective,
                phase: 'complete',
                maxGoalRounds: activeGoal.maxGoalRounds,
              },
              roundsStarted: latestGoalChange.roundsStarted ?? 1,
              createdAt: latestGoalChange.createdAt ?? Date.now(),
              updatedAt: Date.now(),
            })
            return ok(`✅ Marked goal \`${activeGoal.id}\` as complete. Automatic continuation rounds stopped.`)
          }
          return err('Session cannot append events.')
        }

        if (action === 'pause') {
          if (!activeGoal || !latestGoalChange) return err('No active goal to pause.')
          if (typeof session.append === 'function') {
            session.append('goal/change', {
              kind: 'goal/change',
              version: 1,
              operation: 'pause',
              goal: {
                id: activeGoal.id,
                revision: activeGoal.revision + 1,
                objective: activeGoal.objective,
                phase: 'paused',
                maxGoalRounds: activeGoal.maxGoalRounds,
              },
              roundsStarted: latestGoalChange.roundsStarted ?? 1,
              createdAt: latestGoalChange.createdAt ?? Date.now(),
              updatedAt: Date.now(),
            })
            return ok(`⏸️ Paused goal \`${activeGoal.id}\`.`)
          }
          return err('Session cannot append events.')
        }

        if (action === 'resume') {
          if (!activeGoal || !latestGoalChange) return err('No active goal to resume.')
          if (typeof session.append === 'function') {
            session.append('goal/change', {
              kind: 'goal/change',
              version: 1,
              operation: 'resume',
              goal: {
                id: activeGoal.id,
                revision: activeGoal.revision + 1,
                objective: activeGoal.objective,
                phase: 'active',
                maxGoalRounds: activeGoal.maxGoalRounds,
              },
              roundsStarted: latestGoalChange.roundsStarted ?? 1,
              createdAt: latestGoalChange.createdAt ?? Date.now(),
              updatedAt: Date.now(),
            })
            return ok(`▶️ Resumed goal \`${activeGoal.id}\`.`)
          }
          return err('Session cannot append events.')
        }

        if (action === 'clear') {
          if (!activeGoal) return ok('No active goal to clear.')
          if (typeof session.append === 'function') {
            session.append('goal/change', {
              kind: 'goal/change',
              version: 1,
              operation: 'clear',
              cleared: {
                id: activeGoal.id,
                revision: activeGoal.revision + 1,
              },
              clearedAt: Date.now(),
            })
            return ok(`Cleared goal \`${activeGoal.id}\`.`)
          }
          return err('Session cannot append events.')
        }

        return err(`Unknown goal action \`${action}\`. Usage: /agy goal [status|complete|pause|resume|clear]`)
      }

      if (sub === 'session') {
        const action = arg || 'info'
        const sessionId = invocation?.agent?.id ? String(invocation.agent.id) : undefined
        const session = (invocation?.agent?.session as { header?: { cwd?: string }; events?: readonly unknown[] } | undefined)
          ?? (deps.sessions?.() && sessionId ? (deps.sessions()!.get(sessionId) as { header?: { cwd?: string }; events?: readonly unknown[] }) : undefined)

        if (action === 'info') {
          const lines: string[] = ['**DSH Session & agy Bridge Info**']
          if (sessionId) {
            lines.push(`- **Session ID**: \`${sessionId}\``)
            const cwd = session?.header?.cwd
            if (cwd) lines.push(`- **Workspace CWD**: \`${cwd}\``)
            const bindings = deps.store().all()
            const matchedKey = Object.keys(bindings).find((k) => k === sessionId || k.startsWith(`${sessionId}:`))
            if (matchedKey && bindings[matchedKey]) {
              const b = bindings[matchedKey]
              lines.push(
                `- **Bound agy Conversation**: \`${b.conversationId}\``,
                `- **Bound Model**: \`${b.model || 'default'}\``,
                `- **Last Message Count**: ${b.lastMessageCount}`,
                `- **Last Updated**: ${new Date(b.updatedAt).toLocaleTimeString()}`,
              )
            } else {
              lines.push('- **Bound agy Conversation**: *(none - next turn starts fresh)*')
            }
            if (session?.events) {
              lines.push(`- **Total Session Events**: ${session.events.length}`)
            }
          } else {
            lines.push('- Current session ID could not be identified from invocation context.')
          }
          return ok(lines.join('\n'))
        }

        if (action === 'clear') {
          if (!sessionId) {
            const all = deps.store().all()
            const keys = Object.keys(all)
            if (keys.length === 0) return ok('No conversation bindings yet.')
            const key = keys.reduce((a, b) => ((all[a]?.updatedAt ?? 0) >= (all[b]?.updatedAt ?? 0) ? a : b))
            const dropped = all[key]
            if (dropped === undefined) return ok('No conversation bindings yet.')
            deps.store().delete(key)
            return ok(`Dropped binding for session \`${key}\` (agy conversation \`${dropped.conversationId}\`). Next turn starts fresh.`)
          }

          const bindings = deps.store().all()
          let count = 0
          for (const k of Object.keys(bindings)) {
            if (k === sessionId || k.startsWith(`${sessionId}:`)) {
              deps.store().delete(k)
              count++
            }
          }
          return ok(`Dropped ${count > 0 ? count : 'any'} agy conversation binding(s) for session \`${sessionId}\`. Next turn will start a fresh agy conversation.`)
        }

        return err(`Unknown session action \`${action}\`. Usage: /agy session [info|clear]`)
      }

    if (sub === 'auth') {
      const flow = deps.poolAuth?.()
      if (!flow) return err('auth flow not available')
      const st = await flow.beginPrimary()
      if (st.ok && st.url) {
        return ok([
          st.browserOpened
            ? '**浏览器已打开 Google 授权页** — 批准访问后自动完成登录。'
            : '**请手动打开下面的 URL 完成 Google 授权：**',
          '',
          st.url,
          '',
          '备用：授权完成后运行 `/agy auth-code <授权码或完整回调URL>`。',
        ].join('\n'))
      }
      return err(`failed to start the login flow (${st.code ?? 'request_failed'})`)
    }
    if (sub === 'auth-code') {
      if (arg === '') return err('usage: /agy auth-code <code-or-callback-url>')
      const flow = deps.poolAuth?.()
      if (!flow) return err('auth flow not available')
      const st = await flow.submitCode(arg)
      if (st.ok) {
        deps.store().clear()
        return ok('Logged in to Antigravity.')
      }
      return err(`login failed (${st.code ?? 'request_failed'})`)
    }
    if (sub === 'models') {
      const cat = await deps.catalog().forceRefresh()
      const lines = [
        '**Antigravity models** — source: ' + cat.source + (cat.lastError === undefined ? '' : ' — ' + cat.lastError) + ':',
      ]
      for (const m of cat.models) {
        lines.push('- `' + m.id + '` — ' + m.name + (m.efforts ? ' — efforts: ' + m.efforts.join(' / ') : ''))
      }
      return ok(lines.join('\n'))
    }
    if (sub === 'mode') {
      if (!['skip', 'plan', 'accept-edits'].includes(arg)) {
        return err('usage: /agy mode <skip|plan|accept-edits>')
      }
      deps.setOverride('permissionMode', arg)
      return ok('Permission mode set to **' + arg + '** — effective next turn.')
    }
    if (sub === 'effort') {
      if (!['low', 'medium', 'high', 'default'].includes(arg)) {
        return err('usage: /agy effort <low|medium|high|default>')
      }
      deps.setOverride('defaultEffort', arg === 'default' ? '' : arg)
      return ok('Default effort set to **' + (arg === 'default' ? 'model default' : arg) + '**.')
    }
    if (sub === 'workspace') {
      if (arg === '') return ok('Current workspace: ' + (deps.cfg().workspaceRoot !== '' ? deps.cfg().workspaceRoot : '(session cwd / process cwd)'))
      if (arg === 'default' || arg === 'clear') {
        deps.setOverride('workspaceRoot', '')
        return ok('Workspace reset to session cwd / process cwd.')
      }
      if (!isAbsolute(arg)) return err('workspace must be an absolute path (or `default` to clear)')
      deps.setOverride('workspaceRoot', arg)
      return ok('Workspace set to **' + arg + '** — effective next turn.')
    }
    if (sub === 'clear') {
      const sessionId = invocation?.agent?.id ? String(invocation.agent.id) : undefined
      if (sessionId) {
        const bindings = deps.store().all()
        const keys = Object.keys(bindings).filter((k) => k === sessionId || k.startsWith(`${sessionId}:`))
        if (keys.length > 0) {
          for (const k of keys) deps.store().delete(k)
          return ok(`Dropped binding for session \`${sessionId}\`. The next turn starts a fresh agy conversation.`)
        }
      }
      const all = deps.store().all()
      const keys = Object.keys(all)
      if (keys.length === 0) return ok('No conversation bindings yet.')
      const key = keys.reduce((a, b) => ((all[a]?.updatedAt ?? 0) >= (all[b]?.updatedAt ?? 0) ? a : b))
      const dropped = all[key]
      if (dropped === undefined) return ok('No conversation bindings yet.')
      deps.store().delete(key)
      return ok('Dropped binding for session `' + key + '` — agy conversation ' + dropped.conversationId + '. The next turn starts a fresh agy conversation.')
    }
    if (sub === 'doctor') {
      const path = await deps.runDoctor()
      return ok('Diagnostic report written to `' + path + '` — attach it when opening an issue.')
    }
    return ok(HELP)
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
}

async function renderStatus(deps: CommandDeps): Promise<string> {
  const cfg = deps.cfg()
  const bin = deps.bin()
  const authHelper = deps.auth()
  // Bound the auth probe so /agy status never hangs the command UI (issue #29).
  // Keep the timer handle so a fast answer doesn't leave a pending timeout.
  let probeTimer: NodeJS.Timeout | null = null
  const auth = authHelper
    ? await Promise.race([
        authHelper.resolvedStatus(),
        new Promise<undefined>((r) => {
          probeTimer = setTimeout(() => r(undefined), 8_000)
        }),
      ]).finally(() => {
        if (probeTimer !== null) clearTimeout(probeTimer)
      })
    : undefined
  const cat = deps.catalog().get()
  const bindings = Object.keys(deps.store().all()).length
  const last = deps.lastRun()
  const errorKinds = last?.toolErrors.map(classifyToolError) ?? []
  const hasHeadlessPermissionDenial = errorKinds.includes('approval')
  const lines = [
    '**dsh-agy-link status**',
    '- agy binary: ' + (bin ?? 'not found — install via https://antigravity.google/docs/cli/install'),
    '- version: ' + (deps.version() ?? 'unknown'),
    '- auth: ' + (auth ? auth.phase + (auth.message ? ' — ' + auth.message : '') : 'unknown'),
    '- permission mode: ' + cfg.permissionMode + (cfg.permissionMode === 'skip' ? ' — WARNING: agy runs tools without approval' : ''),
    '- workspace: ' + (cfg.workspaceRoot !== '' ? cfg.workspaceRoot : '(session cwd / process cwd)'),
    '- default model: ' + (cfg.defaultModel === '' ? '(agy default)' : cfg.defaultModel),
    '- default effort: ' + (cfg.defaultEffort === '' ? '(model default)' : cfg.defaultEffort),
    '- catalog: ' + cat.models.length + ' models — ' + cat.source + (cat.lastError === undefined ? '' : ' — last error: ' + cat.lastError),
    '- conversation bindings: ' + bindings,
    '- last run process: ' + (last ? (last.processOk ? 'ok' : last.processCode) + ' — ' + last.model + ' in ' + Math.round(last.durationMs / 100) / 10 + 's' : 'none yet'),
    ...(last?.tokenSpeed !== undefined && (last.tokenSpeed.measuredSteps > 0 || last.tokenSpeed.outputTokens > 0)
      ? [
          '- last run tokens: ' + last.tokenSpeed.outputTokens + ' output tokens' +
            (last.tokenSpeed.avgTps !== null ? ' — avg ' + last.tokenSpeed.avgTps.toFixed(1) + ' tok/s' : '') +
            (last.tokenSpeed.lastTps !== null ? ' (last generation step: ' + last.tokenSpeed.lastTps.toFixed(1) + ' tok/s)' : ''),
        ]
      : []),
    ...(last && last.toolErrors.length > 0
      ? [
          '- last run tool errors (' + last.toolErrors.length + '): ' + last.toolErrors.join(' | '),
          ...(errorKinds.includes('missing_file')
            ? ['- Guidance: `missing_file` — verify the expected workspace/artifact path for this conversation; do not invent paths or bypass protections.']
            : []),
          ...(errorKinds.includes('system_protection')
            ? ['- Guidance: `system_protection` — AGY hardcoded system protection remains enforced; do not attempt a bypass.']
            : []),
          ...(hasHeadlessPermissionDenial && (cfg.permissionMode === 'plan' || cfg.permissionMode === 'accept-edits')
            ? ['- Note: in headless operation, agy can automatically deny a tool under this mode; the raw denial above is not evidence of a human approval or denial.']
            : []),
        ]
      : []),
  ]
  return lines.join('\n')
}

function ok(text: string): CommandResult {
  return { kind: 'success', text }
}

function err(text: string): CommandResult {
  return { kind: 'error', text }
}
