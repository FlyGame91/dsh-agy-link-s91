// Proxy-aware fetch for Google endpoints.
//
// Node's built-in fetch ignores HTTP_PROXY/HTTPS_PROXY env vars, which
// silently broke every quota/OAuth call behind a proxy ("fetch failed"
// while curl worked). We use undici's OWN fetch with EnvHttpProxyAgent:
// mixing an external undici dispatcher into Node's built-in fetch throws
// UND_ERR_INVALID_ARG (bundled-undici version skew), so the dispatcher and
// the fetch must come from the same undici copy. An explicit per-account
// proxyUrl wins over the environment. Everything is per-request — the host
// process's global dispatcher stays untouched.
import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from 'undici'
import { detectSystemProxy } from './wincred.ts'

const envAgent = new EnvHttpProxyAgent()
const perProxyAgents = new Map<string, ProxyAgent>()

function agentFor(proxyUrl?: string): EnvHttpProxyAgent | ProxyAgent {
  const effective = proxyUrl || detectSystemProxy()
  if (effective) {
    let agent = perProxyAgents.get(effective)
    if (!agent) {
      agent = new ProxyAgent(effective)
      perProxyAgents.set(effective, agent)
    }
    return agent
  }
  return envAgent
}

/**
 * Default timeout for one Google endpoint call. undici's own default
 * headers timeout is 300s, so a hung refresh-token / quota endpoint used to
 * park the whole chain (token refresh → two endpoints → userinfo) for many
 * minutes — enough for `/agy refresh-quota` to look dead. Callers may pass
 * their own `signal`; it is combined with the timeout.
 */
export const AGY_FETCH_TIMEOUT_MS = 10_000

/** fetch() honoring env proxies, or an explicit per-account proxy URL. */
export function agyFetch(url: string, init: RequestInit = {}, proxyUrl?: string): Promise<Response> {
  // AbortSignal.any keeps the caller's signal AND applies the default timeout;
  // falling back to the caller's signal alone would silently drop the timeout.
  const callerSignal = (init as { signal?: AbortSignal | null }).signal ?? undefined
  const signal = callerSignal !== undefined
    ? AbortSignal.any([AbortSignal.timeout(AGY_FETCH_TIMEOUT_MS), callerSignal])
    : AbortSignal.timeout(AGY_FETCH_TIMEOUT_MS)
  return undiciFetch(url, {
    ...(init as object),
    signal,
    dispatcher: agentFor(proxyUrl),
  }) as unknown as Promise<Response>
}
