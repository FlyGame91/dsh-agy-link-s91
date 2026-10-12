// Windows Credential Manager primitives & System Proxy auto-detection.
//
// On Windows, `agy.exe` resolves its Google credential from the single
// process-global store `gemini:antigravity` (via `zalando/go-keyring` ->
// CredRead/CredWrite). HOME/USERPROFILE are ignored there, so per-account
// directory isolation does NOT isolate credentials.
//
// The safe handoff of that shared slot — serialization, identity verification
// and guaranteed restoration — lives in ./credential-slot.ts. This module only
// exposes the raw read/write/delete primitives plus proxy detection; it holds
// no policy, so it can never pick an account on its own.
//
// System Proxy Auto-Detection:
// On Windows GUI hosts (Electron / DSH Desktop), process.env lacks terminal
// HTTP_PROXY/HTTPS_PROXY. We detect proxy settings from the Windows Registry
// (`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`).
import { execFileSync } from 'node:child_process'

const IS_WIN = process.platform === 'win32'

// Embedded PowerShell script using Win32 advapi32 CredRead/CredWrite/CredDelete.
// Uses base64 encoding for safe binary / JSON payload transfer.
const WIN_CRED_SCRIPT = `
param($target, $user, $action, $payload)

$sig = @'
using System;
using System.Runtime.InteropServices;

public class WinCred {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);

  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);

  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredDelete(string target, int type, int flags);

  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern void CredFree(IntPtr cred);

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public long LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  public static bool Write(string target, string userName, byte[] secret) {
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; // Generic
    c.TargetName = target;
    c.UserName = userName;
    c.Persist = 2; // Local machine
    c.CredentialBlobSize = secret.Length;
    IntPtr p = Marshal.AllocHGlobal(secret.Length);
    Marshal.Copy(secret, 0, p, secret.Length);
    c.CredentialBlob = p;
    try {
      return CredWrite(ref c, 0);
    } finally {
      Marshal.FreeHGlobal(p);
    }
  }

  public static byte[] Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
    byte[] b = new byte[c.CredentialBlobSize];
    Marshal.Copy(c.CredentialBlob, b, 0, c.CredentialBlobSize);
    CredFree(p);
    return b;
  }

  public static bool Delete(string target) {
    return CredDelete(target, 1, 0);
  }
}
'@
Add-Type -TypeDefinition $sig -ErrorAction Stop

if ($action -eq "write") {
  $bytes = [System.Convert]::FromBase64String($payload)
  $ok = [WinCred]::Write($target, $user, $bytes)
  [Console]::Out.Write($ok)
} elseif ($action -eq "read") {
  $bytes = [WinCred]::Read($target)
  if ($bytes -ne $null) {
    [Console]::Out.Write([System.Convert]::ToBase64String($bytes))
  }
} elseif ($action -eq "delete") {
  $ok = [WinCred]::Delete($target)
  [Console]::Out.Write($ok)
}
`

/** Execute an action against Windows Credential Manager. */
function runWinCredPs(target: string, user: string, action: string, payload = ''): string {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& { ${WIN_CRED_SCRIPT} }`, target, user, action, payload],
    { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim()
}

/** Read raw UTF-8 credential blob from Windows Credential Manager. */
export function readWindowsCredentialRaw(target = 'gemini:antigravity'): string | null {
  if (!IS_WIN) return null
  try {
    const out = runWinCredPs(target, 'antigravity', 'read')
    if (!out) return null
    return Buffer.from(out, 'base64').toString('utf8')
  } catch {
    return null
  }
}

/** Write UTF-8 credential blob into Windows Credential Manager. */
export function writeWindowsCredentialRaw(
  secret: string,
  target = 'gemini:antigravity',
  userName = 'antigravity',
): boolean {
  if (!IS_WIN) return false
  try {
    const b64 = Buffer.from(secret, 'utf8').toString('base64')
    const out = runWinCredPs(target, userName, 'write', b64)
    return out.toLowerCase() === 'true'
  } catch {
    return false
  }
}

/** Delete a credential from Windows Credential Manager. */
export function deleteWindowsCredentialRaw(target = 'gemini:antigravity'): boolean {
  if (!IS_WIN) return false
  try {
    const out = runWinCredPs(target, 'antigravity', 'delete')
    return out.toLowerCase() === 'true'
  } catch {
    return false
  }
}

// ---- System Proxy Detection -----------------------------------------------

/** Parse Windows WinINet ProxyServer string (supports single or multi-protocol format). */
export function parseWindowsProxyServer(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  if (s.includes('=') || s.includes(';')) {
    const parts = s.split(';').map((p) => p.trim()).filter(Boolean)
    const map = new Map<string, string>()
    for (const part of parts) {
      const eq = part.indexOf('=')
      if (eq !== -1) {
        map.set(part.slice(0, eq).toLowerCase(), part.slice(eq + 1).trim())
      }
    }
    const target = map.get('https') || map.get('http') || map.get('socks') || parts[0] || ''
    if (!target) return ''
    return /^https?:\/\//i.test(target) ? target : `http://${target}`
  }
  return /^https?:\/\//i.test(s) ? s : `http://${s}`
}

let cachedProxy: { value: string | undefined; expiresAt: number } | null = null

/** Invalidate cached proxy detection (useful in tests). */
export function invalidateProxyCache(): void {
  cachedProxy = null
}

/**
 * Detect system proxy configuration.
 * Priority:
 * 1. Standard environment variables (HTTPS_PROXY, HTTP_PROXY, ALL_PROXY)
 * 2. Windows Registry (HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings)
 * Results are cached for 5 seconds to minimize registry queries.
 */
export function detectSystemProxy(): string | undefined {
  const now = Date.now()
  if (cachedProxy && cachedProxy.expiresAt > now) {
    return cachedProxy.value
  }

  // 1. Environment variables
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy
  if (envProxy?.trim()) {
    const val = envProxy.trim()
    cachedProxy = { value: val, expiresAt: now + 300_000 }
    return val
  }

  // 2. Windows registry
  if (IS_WIN) {
    try {
      const out = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      )
      const enableMatch = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(out)
      const enableHex = enableMatch?.[1]
      if (enableHex && parseInt(enableHex, 16) === 1) {
        const serverMatch = /ProxyServer\s+REG_SZ\s+(.+)/.exec(out)
        const serverRaw = serverMatch?.[1]?.trim()
        if (serverRaw) {
          const val = parseWindowsProxyServer(serverRaw)
          if (val) {
            cachedProxy = { value: val, expiresAt: now + 300_000 }
            return val
          }
        }
      }
    } catch {
      // Best-effort
    }
  }

  cachedProxy = { value: undefined, expiresAt: now + 300_000 }
  return undefined
}
