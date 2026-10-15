import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '@deepseek-ai/dsh-llm'
import {
  detectGoalContext,
  isPlanMode,
  isGoalToolContinuation,
  isPlanToolContinuation,
  buildGoalCompleteToolCallBlock,
  buildPlanExitToolCallBlock,
} from '../src/host/dsh-goal.ts'

test('detectGoalContext extracts goal context from source.kind === "goal"', () => {
  const messages: Message[] = [
    {
      role: 'user',
      content: 'Regular prompt',
    } as unknown as Message,
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<goal_round>\nObjective: "Complete feature X and verify"\nRound: 2/256\n\nContinue working...\n</goal_round>',
        },
      ],
      source: {
        kind: 'goal',
        goalId: 'goal-uuid-123',
        revision: 2,
        round: 2,
      },
    } as unknown as Message,
  ]

  const ctx = detectGoalContext(messages)
  assert.ok(ctx, 'Should detect goal context')
  assert.equal(ctx.goalId, 'goal-uuid-123')
  assert.equal(ctx.revision, 2)
  assert.equal(ctx.round, 2)
  assert.equal(ctx.maxRounds, 256)
  assert.equal(ctx.objective, 'Complete feature X and verify')
})

test('detectGoalContext extracts goal context from bare text <goal_round>', () => {
  const messages: Message[] = [
    {
      role: 'user',
      content: '<goal_round>\nObjective: "Fix the bug in parser"\nRound: 5/100\n</goal_round>',
    } as unknown as Message,
  ]

  const ctx = detectGoalContext(messages)
  assert.ok(ctx, 'Should detect goal context from text')
  assert.equal(ctx.round, 5)
  assert.equal(ctx.maxRounds, 100)
  assert.equal(ctx.objective, 'Fix the bug in parser')
  assert.equal(ctx.revision, 1)
})

test('detectGoalContext returns null for non-goal conversations', () => {
  const messages: Message[] = [
    {
      role: 'user',
      content: 'Hello, please help me with code',
    } as unknown as Message,
    {
      role: 'assistant',
      content: 'Sure! What do you need?',
    } as unknown as Message,
  ]

  const ctx = detectGoalContext(messages)
  assert.equal(ctx, null)
})

test('isPlanMode detects plan mode prompt context', () => {
  const nonPlanMessages: Message[] = [
    {
      role: 'user',
      content: 'Just write some code',
    } as unknown as Message,
  ]
  assert.equal(isPlanMode(nonPlanMessages), false)

  const planMessages: Message[] = [
    {
      role: 'user',
      content: 'You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches mode.',
    } as unknown as Message,
  ]
  assert.equal(isPlanMode(planMessages), true)
})

test('isGoalToolContinuation recognizes agytc-bridge-goal callId', () => {
  const normalTool: Message[] = [
    {
      role: 'tool',
      toolCallId: 'agytc-run-1-step-2',
      content: 'output',
    } as unknown as Message,
  ]
  assert.equal(isGoalToolContinuation(normalTool), false)

  const goalBridgeTool: Message[] = [
    {
      role: 'tool',
      toolCallId: 'agytc-bridge-goal-123-1',
      content: '{"ok":true}',
    } as unknown as Message,
  ]
  assert.equal(isGoalToolContinuation(goalBridgeTool), true)
})

test('isPlanToolContinuation recognizes agytc-bridge-plan callId', () => {
  const planBridgeTool: Message[] = [
    {
      role: 'tool',
      toolCallId: 'agytc-bridge-plan-179204000',
      content: '{"ok":true}',
    } as unknown as Message,
  ]
  assert.equal(isPlanToolContinuation(planBridgeTool), true)
})

test('buildGoalCompleteToolCallBlock produces valid update_goal chunk sequence', () => {
  const chunks = buildGoalCompleteToolCallBlock(
    {
      goalId: 'goal-abc',
      revision: 3,
    },
    2,
  )

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0]!.type, 'block-start')
  assert.equal(chunks[0]!.index, 2)
  assert.equal((chunks[0] as { blockType?: string }).blockType, 'tool-call')

  assert.equal(chunks[1]!.type, 'block-end')
  assert.equal(chunks[1]!.index, 2)
  const block = (chunks[1] as { block?: { type: string; name: string; arguments: string } }).block
  assert.ok(block)
  assert.equal(block.type, 'tool-call')
  assert.equal(block.name, 'update_goal')

  const parsedArgs = JSON.parse(block.arguments)
  assert.equal(parsedArgs.goal_id, 'goal-abc')
  assert.equal(parsedArgs.revision, 3)
  assert.equal(parsedArgs.action, 'complete')
})

test('buildPlanExitToolCallBlock produces valid exit_plan_mode chunk sequence', () => {
  const chunks = buildPlanExitToolCallBlock('# Implementation Plan\n\n1. Do this\n2. Do that', 0)

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0]!.type, 'block-start')
  assert.equal((chunks[0] as { blockType?: string }).blockType, 'tool-call')

  assert.equal(chunks[1]!.type, 'block-end')
  const block = (chunks[1] as { block?: { type: string; name: string; arguments: string } }).block
  assert.ok(block)
  assert.equal(block.type, 'tool-call')
  assert.equal(block.name, 'exit_plan_mode')

  const parsedArgs = JSON.parse(block.arguments)
  assert.match(parsedArgs.plan, /# Implementation Plan/)
})
