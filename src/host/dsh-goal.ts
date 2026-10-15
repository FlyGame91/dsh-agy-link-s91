// DSH Goal & Plan Protocol Bridge (ADR-14)
// Translates Google Antigravity (agy CLI) agent completions into DSH
// goal-state lifecycle transitions (update_goal / exit_plan_mode).
//
// In DSH, /goal runs a multi-round state machine (up to 256 rounds).
// The harness continues driving <goal_round> until the agent explicitly
// marks the goal complete via the `update_goal` tool. Because agy is an
// isolated agent with its own native tools (run_command, view_file, etc.),
// it never calls DSH's external host tools directly. Without this bridge,
// agy would report "Goal achieved" and exit, but DSH would consider the goal
// still active and drive Round 2, Round 3... in an infinite loop.
import type { Message, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import * as dshLlm from '@deepseek-ai/dsh-llm'

export const toToolCallId: (id: string) => ToolCallId =
  (dshLlm as { ToolCallId?: (id: string) => ToolCallId; CallId?: (id: string) => ToolCallId }).ToolCallId ??
  (dshLlm as { ToolCallId?: (id: string) => ToolCallId; CallId?: (id: string) => ToolCallId }).CallId ??
  ((id: string) => id as unknown as ToolCallId)

export interface GoalContext {
  goalId?: string
  revision?: number
  round?: number
  maxRounds?: number
  objective?: string
}

function extractText(m: Message): string {
  const content = m.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content) {
      if (b && typeof b === 'object') {
        const blk = b as { type?: string; text?: unknown }
        if (blk.type === 'text' && typeof blk.text === 'string') parts.push(blk.text)
      }
    }
    return parts.join('\n')
  }
  return ''
}

function parseGoalRoundText(text: string): { goalId?: string; revision?: number; round?: number; maxRounds?: number; objective?: string } | null {
  if (!text.includes('<goal_round>')) return null
  const roundMatch = text.match(/Round:\s*(\d+)(?:\/(\d+))?/)
  const round = roundMatch ? parseInt(roundMatch[1]!, 10) : undefined
  const maxRounds = roundMatch && roundMatch[2] ? parseInt(roundMatch[2]!, 10) : undefined
  const objMatch = text.match(/Objective:\s*(?:"([^"]*)"|'([^']*)'|([^\n]+))/)
  const objective = objMatch ? (objMatch[1] || objMatch[2] || objMatch[3])?.trim() : undefined
  const idMatch = text.match(/goal-[a-zA-Z0-9_-]+/)
  const goalId = idMatch ? idMatch[0] : undefined
  return { goalId, round, maxRounds, objective }
}

/**
 * Detect whether the incoming request is part of a DSH <goal_round> continuation.
 * Extracts goalId, revision, round, and objective if available.
 */
export function detectGoalContext(messages: readonly Message[]): GoalContext | null {
  let goalId: string | undefined
  let revision: number | undefined
  let round: number | undefined
  let maxRounds: number | undefined
  let objective: string | undefined
  let isGoal = false

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    const src = (m as unknown as { source?: { kind?: string; goalId?: unknown; revision?: unknown; round?: unknown } }).source
    if (src && typeof src === 'object' && src.kind === 'goal') {
      isGoal = true
      if (!goalId && typeof src.goalId === 'string') goalId = src.goalId
      if (revision === undefined && typeof src.revision === 'number') revision = src.revision
      if (round === undefined && typeof src.round === 'number') round = src.round
    }
    const text = extractText(m)
    if (text.includes('<goal_round>')) {
      isGoal = true
      const parsed = parseGoalRoundText(text)
      if (parsed) {
        if (!goalId && parsed.goalId) goalId = parsed.goalId
        if (revision === undefined && parsed.revision !== undefined) revision = parsed.revision
        if (round === undefined && parsed.round !== undefined) round = parsed.round
        if (maxRounds === undefined && parsed.maxRounds !== undefined) maxRounds = parsed.maxRounds
        if (!objective && parsed.objective) objective = parsed.objective
      }
    }
  }

  if (isGoal) {
    return {
      goalId,
      revision: revision ?? 1,
      round,
      maxRounds,
      objective,
    }
  }
  return null
}

/**
 * Detect whether DSH is in Plan Mode.
 * DSH plan-mode injects "You are in plan mode" into the runtime context prompt.
 */
export function isPlanMode(messages: readonly Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    const text = extractText(m)
    if (text.includes('You are in plan mode')) return true
  }
  return false
}

/**
 * Check if the trailing message is the tool result of a bridge-emitted `update_goal` call.
 */
export function isGoalToolContinuation(messages: readonly Message[]): boolean {
  if (messages.length === 0) return false
  const last = messages[messages.length - 1]
  if (!last) return false
  const callId = (last as unknown as { toolCallId?: unknown; source?: { callId?: unknown } }).toolCallId
    ?? (last as unknown as { source?: { callId?: unknown } }).source?.callId
  if (typeof callId === 'string' && callId.startsWith('agytc-bridge-goal-')) {
    return true
  }
  return false
}

/**
 * Check if the trailing message is the tool result of a bridge-emitted `exit_plan_mode` call.
 */
export function isPlanToolContinuation(messages: readonly Message[]): boolean {
  if (messages.length === 0) return false
  const last = messages[messages.length - 1]
  if (!last) return false
  const callId = (last as unknown as { toolCallId?: unknown; source?: { callId?: unknown } }).toolCallId
    ?? (last as unknown as { source?: { callId?: unknown } }).source?.callId
  if (typeof callId === 'string' && callId.startsWith('agytc-bridge-plan-')) {
    return true
  }
  return false
}

/**
 * Build the synthetic `update_goal` tool-call chunk that marks the goal complete on DSH.
 */
export function buildGoalCompleteToolCallBlock(goalContext: GoalContext, blockIdx: number): StreamChunk[] {
  const goalId = goalContext.goalId || 'active-goal'
  const revision = goalContext.revision ?? 1
  return [
    { type: 'block-start', index: blockIdx, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: blockIdx,
      block: {
        type: 'tool-call',
        id: toToolCallId(`agytc-bridge-goal-${goalId}-${revision}`),
        name: 'update_goal',
        arguments: JSON.stringify({
          goal_id: goalId,
          revision,
          action: 'complete',
        }),
      },
    },
  ]
}

/**
 * Build the synthetic `exit_plan_mode` tool-call chunk that presents the generated plan to DSH.
 */
export function buildPlanExitToolCallBlock(planMarkdown: string, blockIdx: number): StreamChunk[] {
  return [
    { type: 'block-start', index: blockIdx, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: blockIdx,
      block: {
        type: 'tool-call',
        id: toToolCallId(`agytc-bridge-plan-${Date.now()}`),
        name: 'exit_plan_mode',
        arguments: JSON.stringify({
          plan: planMarkdown.trim() !== '' ? planMarkdown : '# Plan Completed\n\nPlan generated and ready for review.',
        }),
      },
    },
  ]
}
