// System browser launcher + CDP capture for gemini.google.com authentication.
// Launches Chrome or Edge with user profile synchronization, dedicated debugging port,
// passes proxy settings (--proxy-server), and reads cookies & SNlM0e over CDP.

import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import os, { homedir } from 'node:os'
import { join } from 'node:path'
import type { GeminiWebAuth } from '../common/pool-types.ts'
import { DEFAULT_GEMINI_UA } from './gemini-web.ts'

export type BrowserType = 'chrome' | 'edge'

export interface SystemBrowser {
  id: BrowserType
  name: string
  path: string
  userDataDir: string
}

/**
 * Returns the real user home directory, resilient to DSH/agy process.env.HOME overrides.
 */
export function getRealUserHome(): string {
  try {
    const info = os.userInfo()
    if (info.homedir) return info.homedir
  } catch {
    // ignore
  }
  return process.env.USERPROFILE || process.env.HOME || homedir()
}

/**
 * Detects all installed Chrome and Edge browsers on the system with their default User Data directories.
 */
export function findInstalledBrowsers(): SystemBrowser[] {
  const home = getRealUserHome()
  const results: SystemBrowser[] = []

  if (process.platform === 'darwin') {
    const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    const chromeUserData = join(home, 'Library', 'Application Support', 'Google', 'Chrome')
    if (existsSync(chromePath)) {
      results.push({ id: 'chrome', name: 'Google Chrome', path: chromePath, userDataDir: chromeUserData })
    }

    const edgePath = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    const edgeUserData = join(home, 'Library', 'Application Support', 'Microsoft Edge')
    if (existsSync(edgePath)) {
      results.push({ id: 'edge', name: 'Microsoft Edge', path: edgePath, userDataDir: edgeUserData })
    }
  } else if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')

    const chromeCandidates = [
      join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]
    const chromePath = chromeCandidates.find((p) => existsSync(p))
    if (chromePath) {
      results.push({
        id: 'chrome',
        name: 'Google Chrome',
        path: chromePath,
        userDataDir: join(local, 'Google', 'Chrome', 'User Data'),
      })
    }

    const edgeCandidates = [
      join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]
    const edgePath = edgeCandidates.find((p) => existsSync(p))
    if (edgePath) {
      results.push({
        id: 'edge',
        name: 'Microsoft Edge',
        path: edgePath,
        userDataDir: join(local, 'Microsoft', 'Edge', 'User Data'),
      })
    }
  } else {
    // Linux
    const chromeCandidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ]
    const chromePath = chromeCandidates.find((p) => existsSync(p))
    if (chromePath) {
      results.push({
        id: 'chrome',
        name: 'Google Chrome',
        path: chromePath,
        userDataDir: join(home, '.config', 'google-chrome'),
      })
    }

    const edgeCandidates = [
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
    ]
    const edgePath = edgeCandidates.find((p) => existsSync(p))
    if (edgePath) {
      results.push({
        id: 'edge',
        name: 'Microsoft Edge',
        path: edgePath,
        userDataDir: join(home, '.config', 'microsoft-edge'),
      })
    }
  }

  return results
}

/**
 * Finds system browser matching preferredType (if specified and installed),
 * otherwise returns first installed Chrome or Edge.
 */
export function findSystemBrowser(preferredType?: BrowserType): SystemBrowser | null {
  const installed = findInstalledBrowsers()
  if (installed.length === 0) return null
  if (preferredType) {
    const match = installed.find((b) => b.id === preferredType)
    if (match) return match
  }
  return installed[0] || null
}

/**
 * Pre-populates the capture profile from the user's real browser profile.
 * Copies authentication cookies, saved accounts, and Local State (keychain/crypto config)
 * while excluding sessions and lock files so it never conflicts with a running browser.
 */
export function syncUserProfile(
  sourceUserDataDir: string,
  targetProfileDir: string,
  options?: { inheritCookies?: boolean },
): void {
  mkdirSync(targetProfileDir, { recursive: true })

  // Clean old active port file and any lock files in target
  const lockFiles = ['DevToolsActivePort', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']
  for (const f of lockFiles) {
    const p = join(targetProfileDir, f)
    if (existsSync(p)) {
      try {
        rmSync(p, { force: true, recursive: true })
      } catch {
        // ignore
      }
    }
  }

  // If this target profile already has an initialized Default profile,
  // DO NOT overwrite it. Preserve this account's independent profile and login state completely!
  const dstProfileDir = join(targetProfileDir, 'Default')
  if (existsSync(dstProfileDir)) {
    return
  }

  if (!existsSync(sourceUserDataDir)) {
    return
  }

  // 1. Copy root files like Local State (crucial for cookie decryption keys on macOS/Win/Linux)
  const rootFiles = ['Local State']
  for (const f of rootFiles) {
    const src = join(sourceUserDataDir, f)
    const dst = join(targetProfileDir, f)
    if (existsSync(src) && !existsSync(dst)) {
      try {
        copyFileSync(src, dst)
      } catch {
        // ignore busy files
      }
    }
  }

  // 2. If inheritCookies is explicitly false, do not copy cookies from the source browser.
  // Instead, start with a fresh Default profile directory so the user can log into an independent account.
  if (options?.inheritCookies === false) {
    mkdirSync(dstProfileDir, { recursive: true })
    return
  }

  // 3. Otherwise, inherit the default profile from source for 1-click capture
  let srcProfileDir = join(sourceUserDataDir, 'Default')
  if (!existsSync(srcProfileDir) && existsSync(join(sourceUserDataDir, 'Profile 1'))) {
    srcProfileDir = join(sourceUserDataDir, 'Profile 1')
  }

  if (existsSync(srcProfileDir)) {
    mkdirSync(dstProfileDir, { recursive: true })

    const essentialItems = [
      'Cookies',
      'Cookies-journal',
      'Login Data',
      'Login Data-journal',
      'Login Data For Account',
      'Login Data For Account-journal',
      'Preferences',
      'Secure Preferences',
      'Web Data',
      'Network Persistent State',
      'Accounts',
      'Device Bound Sessions',
      'Device Bound Sessions-journal',
    ]

    for (const item of essentialItems) {
      const src = join(srcProfileDir, item)
      const dst = join(dstProfileDir, item)
      if (existsSync(src) && !existsSync(dst)) {
        try {
          const stat = statSync(src)
          if (stat.isDirectory()) {
            cpSync(src, dst, { recursive: true })
          } else if (stat.isFile()) {
            copyFileSync(src, dst)
          }
        } catch {
          // ignore busy/locked files
        }
      }
    }

    // Also copy Network/Cookies if present in newer Chromium
    const srcNetCookies = join(srcProfileDir, 'Network', 'Cookies')
    const dstNetCookies = join(dstProfileDir, 'Network', 'Cookies')
    if (existsSync(srcNetCookies) && !existsSync(dstNetCookies)) {
      try {
        const dstNetDir = join(dstProfileDir, 'Network')
        mkdirSync(dstNetDir, { recursive: true })
        copyFileSync(srcNetCookies, dstNetCookies)
      } catch {
        // ignore
      }
    }
  }
}

export interface CdpCookie {
  name: string
  value: string
  domain: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
}

/**
 * Minimal lightweight CDP client using native globalThis.WebSocket
 */
export class SimpleCdpClient {
  private wsUrl: string
  private socket?: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (val: unknown) => void; reject: (err: Error) => void }>()
  private closed = false

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl
  }

  async connect(timeoutMs = 10_000): Promise<void> {
    const WebSocketCtor = globalThis.WebSocket
    if (!WebSocketCtor) {
      throw new Error('global WebSocket is not available in current Node runtime')
    }

    const ws = new WebSocketCtor(this.wsUrl)
    this.socket = ws

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          this.close()
          reject(new Error(`CDP connection to ${this.wsUrl} timed out after ${timeoutMs}ms`))
        }
      }, timeoutMs)

      ws.addEventListener('open', () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve()
        }
      })
      ws.addEventListener('error', (e) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          this.close()
          reject(new Error(`CDP connection error: ${String(e)}`))
        }
      })
      ws.addEventListener('close', () => {
        this.close()
      })
      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } }
          if (typeof msg.id === 'number') {
            const p = this.pending.get(msg.id)
            if (p) {
              this.pending.delete(msg.id)
              if (msg.error) {
                p.reject(new Error(msg.error.message || 'CDP error'))
              } else {
                p.resolve(msg.result)
              }
            }
          }
        } catch {
          // ignore parse errors
        }
      })
    })
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = 8000): Promise<T> {
    if (this.closed || !this.socket || this.socket.readyState !== 1) {
      throw new Error('CDP socket is closed')
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP request ${method} timed out`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer)
          resolve(val as T)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })

      this.socket?.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    this.closed = true
    try {
      this.socket?.close()
    } catch {
      // ignore
    }
    this.pending.clear()
  }
}

export interface CaptureProgress {
  status: 'launching' | 'waiting_user_login' | 'capturing' | 'success' | 'failed'
  message?: string
  browserName?: string
}

export interface CaptureSessionOptions {
  browserType?: BrowserType
  profileDir: string
  inheritCookies?: boolean
  proxyUrl?: string
  timeoutMs?: number
  onProgress?: (progress: CaptureProgress) => void
  signal?: AbortSignal
}

/**
 * Launches system browser (Chrome or Edge) inheriting the user's logged-in profile,
 * guides user to gemini.google.com, and extracts cookies and SNlM0e token through CDP.
 */
export async function captureGeminiWebLogin(
  options: CaptureSessionOptions,
): Promise<GeminiWebAuth> {
  const browser = findSystemBrowser(options.browserType)
  if (!browser) {
    const requested = options.browserType === 'edge' ? 'Microsoft Edge' : options.browserType === 'chrome' ? 'Google Chrome' : 'Chrome / Edge'
    throw new Error(`未检测到可用的 ${requested} 浏览器，请确认已安装`)
  }

  const { profileDir, proxyUrl, timeoutMs = 180_000 } = options

  options.onProgress?.({
    status: 'launching',
    browserName: browser.name,
    message: `正在准备 ${browser.name} 独立 profile 运行环境...`,
  })

  // Synchronize user profile if needed (Local State, and optionally cookies if inheritCookies is true)
  syncUserProfile(browser.userDataDir, profileDir, { inheritCookies: options.inheritCookies })

  // Clean old active port file
  const activePortFile = join(profileDir, 'DevToolsActivePort')
  if (existsSync(activePortFile)) {
    try {
      rmSync(activePortFile, { force: true })
    } catch {
      // ignore
    }
  }

  const targetUrl = 'https://gemini.google.com/'

  const args = [
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--no-service-autorun',
    '--disable-background-mode',
  ]

  // Crucial for China users: Pass proxy to browser
  const effectiveProxy = proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY
  if (effectiveProxy) {
    args.push(`--proxy-server=${effectiveProxy}`)
  }

  args.push(targetUrl)

  options.onProgress?.({
    status: 'launching',
    browserName: browser.name,
    message: `正在启动 ${browser.name}（已继承用户 Profile，代理: ${effectiveProxy || '直连'}）...`,
  })

  let child: ChildProcess | undefined
  try {
    child = spawn(browser.path, args, {
      detached: false,
      stdio: 'ignore',
    })
  } catch (err) {
    throw new Error(`Failed to launch browser ${browser.name}: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Wait for DevToolsActivePort to be written
  let port: number | undefined
  let wsPath = ''
  const startWait = Date.now()
  while (Date.now() - startWait < 25_000) {
    if (options.signal?.aborted) {
      child.kill('SIGTERM')
      throw new Error('Login capture aborted')
    }
    if (existsSync(activePortFile)) {
      try {
        const content = readFileSync(activePortFile, 'utf8')
        const lines = content.split(/\r?\n/)
        const parsedPort = Number(lines[0]?.trim())
        if (Number.isInteger(parsedPort) && parsedPort > 0) {
          port = parsedPort
          wsPath = lines[1]?.trim() || ''
          break
        }
      } catch {
        // retry next tick
      }
    }
    await new Promise((r) => setTimeout(r, 400))
  }

  if (!port) {
    child.kill('SIGTERM')
    throw new Error('Browser started but DevTools debugging port file was not created')
  }

  options.onProgress?.({
    status: 'waiting_user_login',
    browserName: browser.name,
    message: `${browser.name} 已打开，正在检查 Google 登录态（已登录将秒级自动捕获）...`,
  })

  // Poll HTTP /json/list to find page target
  let cdpClient: SimpleCdpClient | undefined
  let capturedAuth: GeminiWebAuth | undefined

  const deadline = Date.now() + timeoutMs

  try {
    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        throw new Error('Login capture cancelled by user')
      }

      // Check if browser was closed by user
      if (child.exitCode !== null) {
        throw new Error('登录窗口已关闭')
      }

      // Query targets
      try {
        const listRes = await fetch(`http://127.0.0.1:${port}/json/list`)
        if (listRes.ok) {
          const targets = (await listRes.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>
          // Prioritize google/gemini pages, then any real page
          const pageTarget =
            targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && (t.url.includes('google.com') || t.url.includes('gemini'))) ||
            targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('edge-extension://')) ||
            targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)

          if (pageTarget && pageTarget.webSocketDebuggerUrl) {
            if (!cdpClient) {
              cdpClient = new SimpleCdpClient(pageTarget.webSocketDebuggerUrl)
              await cdpClient.connect()
              await cdpClient.send('Network.enable')
              await cdpClient.send('Page.enable')

              // If tab opened to newtab or blank, navigate to gemini
              if (!pageTarget.url.includes('google.com') && !pageTarget.url.includes('gemini')) {
                void cdpClient.send('Page.navigate', { url: 'https://gemini.google.com/' }).catch(() => {})
              }
            }

            // Inspect cookies: try Network.getAllCookies first, then Storage.getCookies
            let cookies: CdpCookie[] = []
            try {
              const netResult = await cdpClient.send<{ cookies?: CdpCookie[] }>('Network.getAllCookies')
              if (Array.isArray(netResult.cookies) && netResult.cookies.length > 0) {
                cookies = netResult.cookies
              }
            } catch {
              // fallback
            }
            if (cookies.length === 0) {
              try {
                const cookieResult = await cdpClient.send<{ cookies?: CdpCookie[] }>('Storage.getCookies')
                cookies = cookieResult.cookies || []
              } catch {
                // ignore
              }
            }

            const googleCookies = cookies.filter((c) => c.domain && c.domain.includes('google.com'))
            const hasSecure1PSID = googleCookies.some((c) => c.name === '__Secure-1PSID' && c.value.length > 5)

            if (hasSecure1PSID) {
              options.onProgress?.({
                status: 'capturing',
                message: '检测到 Google 登录成功，正在提取凭据与 SNlM0e...',
              })

              const cookieStr = googleCookies.map((c) => `${c.name}=${c.value}`).join('; ')

              // Get User-Agent
              let ua = ''
              try {
                const evalUa = await cdpClient.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
                  expression: 'navigator.userAgent',
                  returnByValue: true,
                })
                ua = String(evalUa.result?.value || '')
              } catch {
                // ignore
              }

              // Extract SNlM0e from page if loaded
              let snlm0e: string | undefined
              for (let snRetry = 0; snRetry < 4; snRetry++) {
                try {
                  const evalSn = await cdpClient.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
                    expression: 'window.WIZ_global_data?.SNlM0e || document.documentElement.innerHTML.match(/"SNlM0e":"([^"]+)"/)?.[1] || null',
                    returnByValue: true,
                  })
                  const snVal = evalSn.result?.value
                  if (typeof snVal === 'string' && snVal.length > 5) {
                    snlm0e = snVal
                    break
                  }
                } catch {
                  // ignore
                }
                if (!snlm0e) {
                  await new Promise((r) => setTimeout(r, 600))
                }
              }

              // Extract email
              let accountEmail: string | undefined
              try {
                const evalEmail = await cdpClient.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
                  expression: `(() => {
                    const wiz = window.WIZ_global_data;
                    if (wiz && typeof wiz.oGbda === 'string' && wiz.oGbda.includes('@')) return wiz.oGbda;
                    const selectors = [
                      '[data-email]',
                      '[data-identifier]',
                      'a[href*="SignOutOptions"]',
                      'button[aria-label*="@"]',
                      'a[aria-label*="@"]',
                      'img[alt*="@"]',
                    ];
                    for (const s of selectors) {
                      const el = document.querySelector(s);
                      if (!el) continue;
                      const val = el.getAttribute('data-email') || el.getAttribute('data-identifier') || el.getAttribute('aria-label') || el.getAttribute('alt') || '';
                      const m = val.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,})/);
                      if (m) return m[1];
                    }
                    const html = document.documentElement.innerHTML;
                    const gm = html.match(/(?:Google\\s*(?:Account|账号|帐号)|账号|帐号)[^()（）\\n]*[（(]([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,})[)）]/i);
                    if (gm) return gm[1];
                    const em = html.match(/"([a-zA-Z0-9._%+-]+@(gmail|googlemail)\\.com)"/i);
                    if (em) return em[1];
                    return null;
                  })()`,
                  returnByValue: true,
                })
                const emVal = evalEmail.result?.value
                if (typeof emVal === 'string' && emVal.includes('@')) {
                  accountEmail = emVal
                }
              } catch {
                // ignore
              }

              capturedAuth = {
                cookies: cookieStr,
                snlm0e,
                userAgent: ua || DEFAULT_GEMINI_UA,
                accountEmail,
                capturedAt: Date.now(),
              }

              options.onProgress?.({
                status: 'success',
                message: '成功捕获 Gemini 网页端凭据！',
              })
              break
            }
          }
        }
      } catch {
        // target poll retry
      }

      await new Promise((r) => setTimeout(r, 1000))
    }
  } finally {
    cdpClient?.close()
    try {
      child.kill('SIGTERM')
    } catch {
      // ignore
    }
  }

  if (!capturedAuth) {
    throw new Error('未能在限定时间内完成登录捕获或超时')
  }

  return capturedAuth
}

