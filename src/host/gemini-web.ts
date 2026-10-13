// Gemini Web Client: Reverse-engineered client for gemini.google.com web models.
// Supports browser cookie authentication, SNlM0e token extraction,
// streaming response decoding (with thoughts/reasoning), prompt-based tool calls,
// proxy awareness, and model mapping with automatic fallback to flagship tier.

import { agyFetch } from './net.ts'
import type { GeminiWebAuth } from '../common/pool-types.ts'

export const DEFAULT_GEMINI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'

export interface GeminiModelMapping {
  targetModel: string
  displayName: string
  isFlagship: boolean
  enableThinking: boolean
}

/**
 * Maps requested model to the direct model for Gemini Web.
 * Maps directly to the user's selected model without falling back to fictional models.
 */
export function resolveGeminiWebModel(requestedModel?: string, effort?: string): GeminiModelMapping {
  const raw = (requestedModel || '').trim()
  const clean = raw.replace(/^(?:antigravity|agy)\//i, '').replace(/^agy:/i, '')
  const target = clean || 'gemini-2.5-pro'
  const s = target.toLowerCase()
  const isFlash = s.includes('flash')
  const isPro = s.includes('pro')
  const enableThinking = s.includes('thinking') || effort === 'high' || isPro

  // Prettify display name if recognized, or format nicely from slug
  let displayName = clean
  if (s.includes('3.8-flash')) displayName = 'Gemini 3.8 Flash'
  else if (s.includes('3.7-flash')) displayName = 'Gemini 3.7 Flash'
  else if (s.includes('3.6-flash')) displayName = 'Gemini 3.6 Flash'
  else if (s.includes('3.5-flash')) displayName = 'Gemini 3.5 Flash'
  else if (s.includes('2.5-pro')) displayName = 'Gemini 2.5 Pro'
  else if (s.includes('2.5-flash')) displayName = 'Gemini 2.5 Flash'
  else if (!displayName) displayName = 'Gemini 2.5 Pro'

  return {
    targetModel: target,
    displayName,
    isFlagship: isPro,
    enableThinking,
  }
}

export interface Snlm0eResult {
  ok: boolean
  snlm0e?: string
  email?: string
  bl?: string
  error?: string
}

export const DEFAULT_GEMINI_BL = 'boq_assistant-bard-web-server_20261001.08_p0'
let latestGeminiBl = DEFAULT_GEMINI_BL

/**
 * Extract SNlM0e session token, user email, and frontend build version (bl) from gemini.google.com/app
 */
export async function extractSnlm0e(
  cookies: string,
  proxyUrl?: string,
  userAgent = DEFAULT_GEMINI_UA,
  signal?: AbortSignal,
): Promise<Snlm0eResult> {
  const cleanedCookies = cookies.trim()
  if (!cleanedCookies) {
    return { ok: false, error: 'Empty cookies provided' }
  }

  try {
    const res = await agyFetch(
      'https://gemini.google.com/app',
      {
        headers: {
          Cookie: cleanedCookies,
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
        },
        signal,
        redirect: 'follow',
      },
      proxyUrl,
    )

    if (res.status === 401 || res.status === 403 || res.url.includes('accounts.google.com/v3/signin')) {
      return { ok: false, error: 'Google session cookies expired or invalid (redirected to signin)' }
    }

    const html = await res.text()

    // 1. Extract SNlM0e token
    const snMatch = html.match(/"SNlM0e":"([^"]+)"/) || html.match(/\["SNlM0e",null,"([^"]+)"\]/)
    const snlm0e = snMatch ? snMatch[1] : undefined

    // 2. Extract Google Email from profile snippet in HTML if present
    const emailMatch =
      html.match(/aria-label="[^"]*(?:Google\s*(?:Account|账号|帐号)|账号|帐号)[^"]*[（(]([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})[)）]/i) ||
      html.match(/(?:Google\s*(?:Account|账号|帐号)|账号|帐号)[^()（）\n]*[（(]([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})[)）]/i) ||
      html.match(/data-email="([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})"/i) ||
      html.match(/aria-label="[^"]*?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})[^"]*?"/i) ||
      html.match(/"([a-zA-Z0-9._%+-]+@(gmail|googlemail)\.com)"/i) ||
      html.match(/\["([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})"/i)

    const email = emailMatch ? (emailMatch[1] && emailMatch[1].includes('@') ? emailMatch[1] : undefined) : undefined

    // 3. Extract build label (bl) to track Google Web frontend deployments
    const blMatch =
      html.match(/"cfb2h":"(boq_assistant-bard-web-server_[^"]+)"/) ||
      html.match(/"bl":"(boq_assistant-bard-web-server_[^"]+)"/) ||
      html.match(/data-version="(boq_assistant-bard-web-server_[^"]+)"/)
    const bl = blMatch ? blMatch[1] : undefined
    if (bl) {
      latestGeminiBl = bl
    }

    if (!snlm0e) {
      if (html.includes('Sign in') || html.includes('identifier')) {
        return { ok: false, error: 'Google account not logged in (cookies missing __Secure-1PSID)' }
      }
      return { ok: false, error: 'SNlM0e token not found in Gemini web page' }
    }

    return { ok: true, snlm0e, email, bl }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface GeminiWebContext {
  conversationId?: string
  responseId?: string
  choiceId?: string
}

export interface GeminiWebChunk {
  type: 'content' | 'reasoning' | 'tool-call'
  text?: string
  toolCall?: {
    id: string
    name: string
    arguments: Record<string, unknown>
  }
}

export interface GeminiWebStreamOptions {
  auth: GeminiWebAuth
  prompt: string
  system?: string
  tools?: Array<{
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }>
  model?: string
  reasoningEffort?: string
  context?: GeminiWebContext
  proxyUrl?: string
  signal?: AbortSignal
  onContextUpdate?: (ctx: GeminiWebContext) => void
}

/**
 * Synthesizes prompt-based tool calling prompt instructions.
 */
function buildPromptWithTools(
  userPrompt: string,
  systemPrompt?: string,
  tools?: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>,
): string {
  let fullPrompt = ''
  if (systemPrompt && systemPrompt.trim()) {
    fullPrompt += `[System Instructions]\n${systemPrompt.trim()}\n\n`
  }

  if (tools && tools.length > 0) {
    fullPrompt += `[Tools Available]\nYou have access to the following tools to accomplish the task:\n`
    for (const t of tools) {
      fullPrompt += `- ${t.name}: ${t.description || ''}\n  Parameters: ${JSON.stringify(t.parameters || {})}\n`
    }
    fullPrompt += `\nTo call a tool, you MUST emit ONLY a block in this exact format:\n<tool_call>\n{"name": "tool_name", "arguments": { ... }}\n</tool_call>\nDo not guess arguments. If you do not need to call a tool, reply normally with plain text.\n\n`
  }

  fullPrompt += `[User Request]\n${userPrompt}`
  return fullPrompt
}

/**
 * Streams response chunks from gemini.google.com private endpoint.
 */
export async function* streamGeminiWeb(
  options: GeminiWebStreamOptions,
): AsyncGenerator<GeminiWebChunk, void, unknown> {
  let { snlm0e } = options.auth
  const cookies = options.auth.cookies
  const userAgent = options.auth.userAgent || DEFAULT_GEMINI_UA
  const proxyUrl = options.proxyUrl

  // 1. If SNlM0e is missing, fetch it first
  if (!snlm0e) {
    const snRes = await extractSnlm0e(cookies, proxyUrl, userAgent, options.signal)
    if (!snRes.ok || !snRes.snlm0e) {
      throw new Error(`Failed to extract SNlM0e token: ${snRes.error || 'unknown error'}`)
    }
    snlm0e = snRes.snlm0e
    options.auth.snlm0e = snlm0e
  }

  const modelMapping = resolveGeminiWebModel(options.model, options.reasoningEffort)
  const prompt = buildPromptWithTools(options.prompt, options.system, options.tools)

  // 2. Build Google RPC payload (assistant.lamda.BardFrontendService/StreamGenerate)
  const convId = options.context?.conversationId || null
  const respId = options.context?.responseId || null
  const choiceId = options.context?.choiceId || null

  const innerReq = [
    [prompt, 0, null, null, null, null, 0],
    ['zh-CN'],
    [convId, respId, choiceId, null, null, []],
    null,
    null,
    null,
    [1],
    0,
    [],
    [],
    null,
    null,
    null,
    null,
    null,
    modelMapping.targetModel,
  ]

  const reqPayload = JSON.stringify([
    null,
    JSON.stringify(innerReq),
  ])

  const fReq = JSON.stringify([
    [
      ['assistant.lamda.BardFrontendService/StreamGenerate', reqPayload, null, 'generic'],
    ],
  ])

  const params = new URLSearchParams()
  params.append('f.req', fReq)
  params.append('at', snlm0e)

  const reqId = Math.floor(Math.random() * 900000) + 100000
  const effectiveBl = options.auth.bl || latestGeminiBl || DEFAULT_GEMINI_BL
  const endpoint = `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${encodeURIComponent(effectiveBl)}&_reqid=${reqId}&rt=c`

  let response: Response
  try {
    response = await agyFetch(
      endpoint,
      {
        method: 'POST',
        headers: {
          Cookie: cookies,
          'User-Agent': userAgent,
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Referer: 'https://gemini.google.com/',
          Origin: 'https://gemini.google.com',
          Accept: '*/*',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
        },
        body: params.toString(),
        signal: options.signal,
      },
      proxyUrl,
    )
  } catch (err) {
    throw new Error(`Gemini Web network error (proxy=${proxyUrl || 'system'}): ${err instanceof Error ? err.message : String(err)}`)
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Gemini Web session unauthorized (401/403) — re-login required')
  }

  if (response.status === 429) {
    throw new Error('Gemini Web rate limited (429 Too Many Requests)')
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    throw new Error(`Gemini Web upstream HTTP ${response.status}: ${errText.slice(0, 300)}`)
  }

  // 3. Parse Google RPC Streaming Chunks
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Gemini Web response body is not readable')
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let emittedTextLength = 0
  let emittedThoughtsLength = 0
  let accumulatedFullText = ''
  let toolCallEmitted = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith(")]}'")) continue

      let parsedLine: unknown
      try {
        const len = Number(trimmed)
        if (!Number.isNaN(len)) continue // Skip chunk length line
        parsedLine = JSON.parse(trimmed)
      } catch {
        continue
      }

      if (!Array.isArray(parsedLine)) continue

      for (const item of parsedLine) {
        if (!Array.isArray(item) || item[0] !== 'wrb.fr') continue
        const rawJson = item[2]
        if (typeof rawJson !== 'string') continue

        let data: unknown
        try {
          data = JSON.parse(rawJson)
        } catch {
          continue
        }

        if (!Array.isArray(data)) continue

        // Extract context IDs: [convId, respId, choiceId]
        const convMetadata = data[1]
        if (Array.isArray(convMetadata) && options.onContextUpdate) {
          options.onContextUpdate({
            conversationId: typeof convMetadata[0] === 'string' ? convMetadata[0] : undefined,
            responseId: typeof convMetadata[1] === 'string' ? convMetadata[1] : undefined,
            choiceId: Array.isArray(data[4]?.[0]) && typeof data[4][0][0] === 'string' ? data[4][0][0] : undefined,
          })
        }

        // Extract content / thoughts
        const candidates = data[4]
        if (Array.isArray(candidates) && candidates.length > 0) {
          const choice = candidates[0]
          if (Array.isArray(choice)) {
            // Text answer
            const textPart = choice[1]
            if (Array.isArray(textPart) && typeof textPart[0] === 'string') {
              const fullCandidateText = textPart[0]
              accumulatedFullText = fullCandidateText
              if (fullCandidateText.length > emittedTextLength) {
                const delta = fullCandidateText.slice(emittedTextLength)
                emittedTextLength = fullCandidateText.length

                // Check for tool call tags
                if (!toolCallEmitted && (delta.includes('<tool_call>') || accumulatedFullText.includes('<tool_call>'))) {
                  const match = accumulatedFullText.match(/<tool_call>([\s\S]*?)<\/tool_call>/)
                  if (match && typeof match[1] === 'string') {
                    try {
                      const parsedCall = JSON.parse(match[1].trim()) as { name?: string; arguments?: Record<string, unknown> }
                      if (parsedCall.name) {
                        toolCallEmitted = true
                        yield {
                          type: 'tool-call',
                          toolCall: {
                            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                            name: parsedCall.name,
                            arguments: parsedCall.arguments || {},
                          },
                        }
                      }
                    } catch {
                      // Pass through text if not valid JSON
                    }
                  }
                }

                if (!toolCallEmitted) {
                  yield { type: 'content', text: delta }
                }
              }
            }

            // Reasoning / Thoughts
            const thoughtsPart = choice[2]
            if (Array.isArray(thoughtsPart) && typeof thoughtsPart[0] === 'string') {
              const fullThoughts = thoughtsPart[0]
              if (fullThoughts.length > emittedThoughtsLength) {
                const deltaThoughts = fullThoughts.slice(emittedThoughtsLength)
                emittedThoughtsLength = fullThoughts.length
                yield { type: 'reasoning', text: deltaThoughts }
              }
            }
          }
        }
      }
    }
  }
}
