# Known gaps

Deliberate v1 boundaries and upstream-behavior notes.

## Platform limits

- **Windows: pool credential isolation is implemented by handing the shared
  slot over (issue #45)** — agy on Windows resolves its Google credential from
  ONE process-global Credential Manager slot `gemini:antigravity`
  (go-keyring); `HOME`/`USERPROFILE`/`GEMINI_CLI_HOME` move files only. Rather
  than pretending the pool is isolated, the plugin owns the slot: the primary
  credential is kept in a durable, identity-verified store
  (`agy-accounts/.primary-credential.json`), and every run acquires the slot
  through `acquireCredentialSlot`.
  - **Same-identity runs are parallel (v0.4.60).** The installed identity is
    reference-counted: the first run on an account performs the handoff and
    keeps the mutex, later runs on the same grant join as fast leases (each
    verifies the slot still carries that grant), and runs already QUEUED for
    the slot join too — they poll every 100ms and take a lease as soon as their
    own grant is installed, so a backlog drains in parallel. The LAST holder
    persists a rotated access token and restores the primary. Only identity
    SWITCHES serialize — a switcher registers its claim BEFORE queueing, and
    new same-identity joins are refused while a different identity waits.
  - `SlotUnavailableError` aborts a run instead of letting it silently spend
    the wrong account when the primary cannot be verified.
  - Remaining boundary: the mutex is **per process**, so two DSH hosts (web +
    headless) running agy at the same moment can still interleave slot writes;
    avoid driving two hosts at once.

## Credential injection: what agy actually supports (verified 2026-10-17)

The clean fix for the Windows boundary above would be per-process credential
injection (each account's HOME carries its own credential, no global slot, no
mutex, identical on macOS/Linux/Windows). It is NOT available in the current
agy build — measured, not assumed:

- **The per-HOME token file is a BACKUP, not the source.** A fresh isolated
  HOME containing a deliberately bogus
  `.gemini/antigravity-cli/antigravity-oauth-token` still authenticated from the
  machine keyring and completed a prompt (exit 0, `OK`), and the bogus file was
  left untouched. With the keyring present, writing per-account token files
  does not isolate identities. (`fileTokenStorage` exists but is only a
  fallback when keyring save/load times out or is unavailable.)
- **No credential CLI flag**: `agy --help` exposes no `--api-key` /
  `--credential*` / `--token*` option.
- **Documented env routes are different auth products**: `AGY_ADC_AUTH`
  (Application Default Credentials / Agent Platform), and
  `GEMINI_API_KEY` + `"modelProvider": "gemini"` in `settings.json` (the Gemini
  API, not Antigravity subscription quota).
- `AGY_ACCOUNT` selects among *plugin/manager* accounts, not CLI sign-ins.

Therefore a true fix must come from agy itself, either of:

1. **Namespace the keyring entry by HOME** — derive the go-keyring
   service/user from the resolved home (e.g. `gemini:antigravity:<hash>`), so
   an isolated HOME really is an isolated credential space. Needs a migration
   path for the existing single entry.
2. **Accept a per-process credential** — a `--credential-file` flag (or a
   documented env var) that points at the account's token document, bypassing
   the keyring entirely.

Either one retires `credential-slot.ts` and the dispatch queue; until then the
reference-counted slot is the strongest isolation the plugin can provide.

## Not forwarded to agy

- **Images as true multimodal blocks** - agy print mode (`-p`) has no image
  input flag. Since v0.2 the bridge stages DSH image attachments to a local
  media directory (`mediaDir`, TTL-swept) and references them by absolute
  path in the prompt, granting `--add-dir` so agy can view them with its own
  file/vision tools. Same approach as the pi extension.
- **DSH tools to agy (reverse MCP bridge)** - available since v0.2 behind the
  `mcpBridge` config flag (experimental): the plugin runs a loopback-only,
  token-guarded HTTP endpoint and registers a zero-dependency stdio MCP
  server (`dsh-tools`) in the workspace `.mcp.json` (merged in, restored on
  disable). `run_code` and `agy_ask` are never bridged; `mcpToolAllowlist`
  restricts the set further.
- **Full tool args / diff cards (v0.4.28+)** - the bridge reads agy's
  conversation SQLite DB via the `sqlite3` CLI to recover arguments that
  `filterToolParameters` strips from stream-json. When `sqlite3` is missing
  or the DB is unreadable, cards fall back to stream-carried metadata only
  (no path traversal: conversation ids are whitelist-validated).
- **Structured outputs** - `agy_ask` accepts a `schema` parameter (JSON
  Schema as a JSON string) enforced via `--json-schema` since v0.2. Wiring
  schema enforcement into DSH-native tool-call generation remains future
  work: DSH `GenerateOptions` has no schema field to map onto.

## Mapping choices

- agy tool activity becomes **reasoning-block annotations**
  (`[agy tool: name] ... -> output`), not DSH tool-call blocks — there is no
  DSH-side tool round-trip to honor.
- Gemini effort suffixes fold into one base model with selectable efforts
  (`gemini-3-6-flash` + `--effort`); Claude / GPT-OSS slugs stay verbatim
  (agy rejects `--effort` for them).
- Compaction / session-title auxiliary calls run as one-shot agy turns in
  forced `plan` mode, capped at 800K chars of history.

## Upstream behaviors observed

- Permission prompts hang print mode (upstream issue #318) — hence the
  permission-mode design.
- `--sandbox` must not combine with `--dangerously-skip-permissions`
  (upstream issue #36).
- First unauthenticated call takes ~60-70s to fail (agy waits for a pasted
  code); later failures are faster.

## Fallbacks

- If `agy models` fails (signed out, old CLI), a bundled fallback catalog is
  served so the model picker is never empty; unknown ids are still accepted.
- Conversation-id discovery prefers stream-embedded ids and falls back to a
  conversations-directory snapshot diff (newest file wins; ambiguity is
  tolerated).
