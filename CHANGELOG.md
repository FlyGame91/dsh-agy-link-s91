# Changelog

## 0.4.46 (unreleased)

### English

- **Fix (review cycle 2026-10-12): concurrency-slot leak in the adapter spawn window.** `stream()` acquired a `maxConcurrent` slot and only released it from the process-outcome closure — a caller that abandoned the generator while it was suspended on the burst-spacing throttle (steer abort, DSH closing the stream) dropped the release closure, and each incident permanently leaked one slot until every future run dead-locked in the queue. The spawn window now owns the slot through try/finally, an already-aborted signal short-circuits before spawn, and an abort that lands during the window kills the process immediately instead of running a full turn nobody reads.
- **Fix (review cycle): a stale pool-auth flow could kill the new login or commit a ghost account.** `finishWithCode` resolved against `this.flow` without checking WHICH flow the callback belonged to: flow A's late `exchangeCode` resolution during flow B either failed B with `invalid_state` (deleting B's staging dir) or, worse, wrote A's token file into A's freshly cleaned dir and committed a one-file ghost account. Settlement is now flow-identity-checked.
- **Fix (review cycle): long agy tools no longer look like a frozen session.** ACTIVE tool envelopes now emit a one-time `[agy tool running: …]` note into the reasoning block, so a ten-minute maven build shows live progress instead of silence (the 5-minute heartbeat only ever reached the logs). Subagent reasoning snapshots also stop duplicating the whole transcript (suffix-delta like the thinking branch), and a tool-cut span forwards the last per-call usage sample instead of a hard 0/0 that reset DSH's token meter on every tool hop.
- **Fix (review cycle): synthetic-message filtering can no longer eat the user's real message.** When the sniffed synthetic-looking text is the ONLY user content of the trailing span (a pasted `<system-reminder>` block being the actual question), the bridge now forwards it instead of failing with "request carries no user text" — while an image-only turn still never digs up an older question.
- **Fix (review cycle): pool/data hardening.** `deleteAccount` only ever `rmSync`s directories under the pool base dir (a hand-edited `dir: "~"` used to be deleted recursively); `pool.json` persists through a known-ids merge so web + headless stop erasing each other's accounts (corrupt files are backed up before defaults overwrite them, and persist failures are surfaced on stderr); `/agy add-account` and `POST /pool/add` quarantine the new slot with `authRequired` until the terminal login is verified, so the scheduler can no longer route real runs to an account nobody signed into; a drained quota window with an UNPARSEABLE reset now counts as exhausted in eligibility and rotation instead of "already reset".
- **Fix (review cycle): quota/OAuth robustness.** All Google endpoint calls carry a 10s default timeout (a hung refresh-token/quota endpoint used to park `/agy refresh-quota` for minutes); keychain/Secret Service/Credential-Manager reads are async (`execFileSync` up to 8s used to freeze the whole DSH event loop on every poll); concurrent `getValidAccessToken` calls for one account share one in-flight refresh; quota fractions are clamped to [0,1] with NaN rejected; refreshed token files are written 0600.
- **Fix (review cycle): auth flow lifecycle.** Cancelling during the URL wait now resolves the pending `begin()` (the `/plugins/agy-link/auth` HTTP route used to hang forever), a superseded `begin()` can no longer overwrite the newer flow's state, and the probe/settle timers are cleaned up.
- **Fix (review cycle): agy conversation DB reads.** A missing `sqlite3` binary or oversized/locked DB used to re-spawn sqlite3 on EVERY step event with the failure silently swallowed (cache still marked loaded, so the storm never converged); failures now back off (ENOENT for the full window, transient for 300ms), log once, and concurrent readers share one in-flight load. The DB copy is taken into a private `mkdtemp` dir with 0600 instead of a predictable /tmp path.
- **Fix (review cycle): misc.** The OAuth callback page HTML-escapes the reflected `error` parameter; Windows `openBrowser` refuses URLs containing quotes/newlines before the cmd string build; doctor redaction covers `1//0…` refresh tokens, `AIza…` keys and credentialed proxy URLs, and the config dump scrubs `proxyUrl` credentials; `/agy pool` prints proxy URLs redacted; fallback-source model discovery re-probes at most once per minute instead of spawning `agy models` on every list; fallback conversation-id discovery watches the pool account's isolated HOME; mermaid's CDN fallback is removed entirely (floating-version unsigned script in the app origin) and the mermaid/reasoning overlay observers are disposed through `ctx.effect`.
- **Add: token-speed statistics.** Every recorded event now carries its arrival time; per-step generation windows (≥500 ms) yield `lastTps`/output-weighted `avgTps`/output-token totals on the recording, surfaced through `/agy status` ("last run tokens: N output tokens — avg X tok/s (last generation step: Y tok/s)") and the `lastRun` status payload.
- **Fix (issue #43): thinking and tool activity are no longer invisible on desktop hosts.** Two compounding causes: (1) thought prose comes from the agy conversation SQLite DB, and the reader required the external `sqlite3` CLI — which GUI/desktop hosts often lack on PATH (macOS GUI apps do not inherit the shell PATH; Windows never ships one). The reader now prefers Node's built-in `node:sqlite` (no external binary) and keeps the CLI as fallback, so reasoning text resolves on desktop hosts. (2) When prose is unavailable, high-effort turns rendered nothing at all; a banner-only `[agy thinking turn · N thinking tokens]` chip now streams before the first visible text (and on thinking-only turns), with the real prose appended seamlessly when the DB resolves later — no duplicate banner, no dropped text, and no clutter on tool-heavy steps after text already streamed.
- **Fix (issue #45): Windows pool-credential isolation is now an explicit, visible limitation.** agy on Windows stores its login in the system-wide Credential Manager slot `gemini:antigravity` (go-keyring); HOME isolation moves files only, so every isolated pool account still authenticates — and bills — as the system login. The plugin now (1) exposes `credentialIsolationLimited` in `/plugins/agy-link/status`, rendered as a warning banner in the settings panel, (2) logs once per isolated account when it is selected on Windows, and (3) documents the boundary (and why per-run `CredWrite` slot-swapping is not safe with `maxConcurrent > 1`) in KNOWN-GAPS.md. Full isolation needs an upstream agy change (per-HOME keyring namespace or file fallback when the keyring slot is empty).


- **Fix: the stuck-run heartbeat no longer lies about how long the run has been silent.** With no tool step open the silence clock was seeded from `Date.now()` over an empty map, so the every-5-minutes log permanently claimed "no new output for 1m" while the run had actually been quiet for hours. It now reports the time since the last stdout line (`lastOutputAt`), which is the number a human needs when deciding whether to press Stop.
- **Fix: `agy_tool` no longer blames a "recycled" output for a cursor that never pointed at one.** An out-of-range step index (or a non-tool event) and a genuinely evicted recording both used to return the "recorded output is no longer resident" notice — telling the model that output was lost when it was never recorded at all. The degraded message now states the actual reason ("outside this recording — not recorded yet / not a completed tool step" vs. "the in-memory recording was recycled").
- **Fix: account failover now actually continues the session — including after a completed tool step (the "quota exhausted, turn lost" bug).** DSH re-issues the failed step, and a step that failed inside a tool continuation carried a trailing tool result, so it was resumed from the SETTLED recording and re-emitted the identical failure: a quota/region/auth refusal after any tool call ended the turn while a healthy account was sitting idle (reproduced offline against `test/fake-agy.mjs`). The continuation branch now refuses to re-drive a settled recording whose failure is account-scoped, forgets it, and re-assembles on the next account — inside the same step, with no visible interruption. The failover is bounded (at most `enabled accounts - 1` re-spawns per session per 2 minutes) and never applies to request-level failures, so a deterministic error cannot loop through the pool re-running the user's tools.
- **Fix: transport-shaped "not logged in" is no longer reported as AUTH (the "API 密钥无效 / API key is invalid" hunt).** agy reports "not logged into Antigravity" both for a real sign-out and for a healthy login whose token it could not VALIDATE (live 2026-10-10 14:17: the retry account's token had expired 9 minutes earlier and its refresh died on `Post https://oauth2.googleapis.com/token: EOF`, next to TLS handshake timeouts). The adapter classified that as `AUTH`, which (a) ended the turn on a healthy account, (b) flagged the account for re-login, and (c) made DSH render its `message.failure.auth` label — "API key is invalid" — for a credential that was never the problem. Transport evidence in the auth-shaped stdout banner, stderr or the result envelope now yields a retryable `NETWORK` failure that rotates to the next account and never quarantines a login.
- **Fix: the retry budget follows the pool, and a sign-out can continue on another account.** `maxRetries` was a flat 1, so a 3-account pool could never reach the third account — and the live incident needed exactly that (primary ELIGIBILITY → second account "not signed in" → turn lost, though the third was healthy). The budget is now `min(enabled accounts - 1, 2)`, and `AUTH` is retryable when at least one other account exists (the failed one is flagged `authRequired` and leaves rotation).
- **Fix: soft capacity refusals rotate instead of dead-ending the turn.** "model overloaded" / "experiencing high traffic" used to be a deterministic `AGY_ERROR` — terminal, no rotation, no retry — so a turn died while another account could serve it. They are now `OVERLOADED`: retryable, pointer rotated, and deliberately WITHOUT a cooldown (nothing was spent). The hard-quota matcher also recognises real phrasings it used to miss (`Resource has been exhausted (e.g. check quota).`, `You have exhausted your quota`, `out of quota`, `check quota`), which previously fell through to a bare "agy exited with code 1" on the SAME account.
- **Fix: the idle watchdog no longer kills a run that is demonstrably working.** 12 of the 37 failures in one week of real logs were exactly `agy run was idle for 600000ms without output`, each costing a turn and a resend. stderr now counts as liveness (agy prints progress there), and once a run has produced ANY output the long budget applies (`longToolIdleMinutes`, default 240m) — before the first event the strict `timeoutMs` stays, which is the genuinely wedged / Google-unreachable shape. The 5-minute heartbeat now also covers a silent-but-alive run instead of only open tool steps, so the user can see it is waiting and press Stop.
- **Fix: prompts no longer re-send tool output the live agy conversation already owns, and synthetic harness telemetry is filtered.** A bound conversation was piping prior tool results back into `-p` (a live command line was captured carrying a 6.4 KB Godot simulation dump) — stale output ahead of the actual question, which is one of the ways the model ends up answering the previous work. Tool payloads are now dropped when the conversation already has them (they still ride the prompt on a fresh conversation, where agy has never seen them). Separately, DSH runtime telemetry messages injected with `role: 'user'` (`time-context`, `runtime-context`, `<system-reminder>`) are filtered so timestamps never overwrite the human prompt, and an image-only (text-less) newest message no longer falls back to older questions.
- **Fix: an interrupted turn can no longer make agy answer the message you interrupted.** DSH persists the partial reply of a Stop/steer as a normal assistant message, so the plugin treated the interrupted user turn as answered agy-native history while agy's server-side turn had no finalized reply — the next prompt was just the new message, and the model answered the interrupted one (live: `session-c65a826e` turns 17→19, the user re-asked verbatim with "这个咋不回答呢"). The binding is now flagged `interrupted` when a run is aborted or times out, the next prompt carries an explicit "do not continue that unfinished work" boundary, and a successful turn clears the flag. Images staged by an interrupted run are no longer marked delivered either (re-sending the same screenshot after a Stop was silently deduped away and an image-only follow-up failed with "request carries no user text or images").
- **Fix: a run that already produced its result is no longer killed by the next call.** Steer preemption aborted a process that had already streamed its answer (recording a false `ABORTED` and cutting agy mid-finalize); it now waits briefly for a natural exit and only preempts a still-running turn. The bounded settle wait reports when it expires, and a superseded run's late write-back can no longer regress `lastMessageCount` / `sentImageIds`.
- **Fix: pool and binding robustness.** A partial `pool.json` (account missing `cooldowns`/`quotas`) threw a `TypeError` inside `selectAccount`, so every turn failed with an opaque internal error and no failover — records are normalized on load. Rate limits no longer delete the `(session, account)` binding, so a resumable native conversation is not thrown away for a 15-minute cooldown (only a real sign-out or an agy-side "conversation not found" invalidates it). Conversation adoption from a live run is scoped to the SAME account (adopting account A's id under account B produced a wasted "conversation not found" turn). `sessions.json` now performs the dirty-key merge its own docs promised, so the web and headless hosts stop clobbering each other's bindings. A failed turn reports the last per-call context sample instead of a hard-coded 0/0. ADR-012 no longer claims a flat "zero interruption" fallback with a 10-minute cooldown.

### 中文 (Chinese)

- **修复（2026-10-12 审查周期）：适配器 spawn 窗口的并发槽位泄漏。** `stream()` 取得 `maxConcurrent` 槽位后只由进程结算闭包释放——调用方在突发节流 sleep 处放弃生成器（插话中止 / DSH 关闭流）会直接丢掉 release 闭包，每次事故永久泄漏一个槽位，累积后所有后续请求在队列里死锁。现在 spawn 窗口用 try/finally 持有槽位；已中止的 signal 会在 spawn 前短路；窗口内到达的中止会立刻杀进程，而不是跑完一轮没人读的 turn。
- **修复（审查周期）：滞后的 pool-auth 流程可能杀死新登录或提交幽灵账号。** `finishWithCode` 直接对 `this.flow` 结算、不校验回调属于哪个 flow：用户取消 A 并开始 B 后，A 的 `exchangeCode` 迟到返回，要么以 `invalid_state` 杀掉 B（连带删掉 B 的 staging 目录），要么把 A 的 token 文件写进刚清理的 A 目录并提交一个只剩 token 文件的幽灵账号。现在结算带 flow 身份校验。
- **修复（审查周期）：长时间 agy 工具不再让会话看起来卡死。** ACTIVE 工具信封现在会在推理块输出一次性 `[agy tool running: …]` 进行中注解——十分钟的 maven 构建期间界面有实时进展，而不是只有日志里的 5 分钟心跳。subagent 推理快照改用与 thinking 分支相同的 suffix-delta，不再整段重复；工具切割 span 转发最后一次 per-call 用量样本，不再用硬编码 0/0 在每个工具 hop 重置 DSH 的 token 计量。
- **修复（审查周期）：合成消息过滤不再吞掉用户的真实消息。** 当被嗅探命中的文本是尾随 span 里唯一的用户内容（用户粘贴 `<system-reminder>` 块本身就是要问的问题），桥接现在会转发它，而不是报「request carries no user text」；纯图片轮次依旧不会回捞更早的问题。
- **修复（审查周期）：账号池与数据加固。** `deleteAccount` 只会删除池 baseDir 下的目录（手改 `dir: "~"` 曾会被递归删除）；`pool.json` 持久化改为 known-ids 合并，web 与 headless 不再互相清掉对方账号（损坏文件先备份再被默认值覆盖，写盘失败打到 stderr）；`/agy add-account` 与 `POST /pool/add` 在登录验证通过前用 `authRequired` 隔离新槽位，调度器无法再把真实 run 路由到没人登录过的账号；额度耗尽但 reset 时间不可解析时按「已耗尽」参与资格判定与轮换，而不是「已重置」。
- **修复（审查周期）：配额 / OAuth 健壮性。** 所有 Google 端点调用默认 10s 超时（挂死的 refresh-token / 配额端点曾让 `/agy refresh-quota` 卡死数分钟）；钥匙串 / Secret Service / Windows 凭据管理器读取全部异步化（`execFileSync` 最长 8s 曾在每个轮询周期冻结整个 DSH 事件循环）；同账号并发 `getValidAccessToken` 共享一次 in-flight 刷新；配额比例钳制到 [0,1] 并拒绝 NaN；刷新后的 token 文件以 0600 落盘。
- **修复（审查周期）：登录流程生命周期。** URL 等待期间取消会 resolve 挂起的 `begin()`（`/plugins/agy-link/auth` HTTP 路由曾永久挂起）；被取代的 `begin()` 不会再覆盖新流程状态；probe/settle 计时器均已清理。
- **修复（审查周期）：agy 会话数据库读取。** 缺 `sqlite3` 或库超大/被锁时，之前每个 step 事件都会重新 spawn 一次 sqlite3 且失败被静默吞掉（缓存仍标记 loaded，风暴永不收敛）；现在失败退避（ENOENT 按整个缓存窗口、瞬时失败 300ms）、告警一次、并发读者共享一次 in-flight 加载；DB 拷贝改为私有 `mkdtemp` 目录 + 0600，不再落在可预测的 /tmp 路径。
- **修复（审查周期）：其他。** OAuth 回调页对反射的 `error` 参数做 HTML 转义；Windows `openBrowser` 在拼 cmd 字符串前拒绝含引号/换行的 URL；doctor 脱敏覆盖 `1//0…` refresh token、`AIza…` key 与带凭据的代理 URL，config dump 会抹掉 `proxyUrl` 凭据；`/agy pool` 打印脱敏后的代理；fallback 模型目录每分钟最多重探一次（未登录时不再每次列表调用都 spawn `agy models`）；会话 id 兜底发现改为监视池账号隔离 HOME；彻底移除 mermaid 的公网 CDN 回退（应用 origin 内的浮动版本无签名脚本），mermaid/reasoning 的 overlay observer 通过 `ctx.effect` 释放。
- **新增：token 速度统计。** 每条录制事件现在带到达时间；≥500ms 的分步生成窗口给出 `lastTps` / 按输出加权的 `avgTps` / 输出 token 总量，通过 `/agy status`（「last run tokens: N output tokens — avg X tok/s」）与 `lastRun` 状态载荷暴露。
- **修复（issue #43）：桌面端不再看不到思考过程与工具活动。** 两个叠加原因：(1) 思维正文来自 agy 会话 SQLite 库，而读取器依赖外部 `sqlite3` CLI——桌面/GUI 宿主的 PATH 经常没有它（macOS GUI 应用不继承 shell PATH，Windows 从不自带）。读取器现在优先用 Node 内置的 `node:sqlite`（无需外部二进制），CLI 退居兜底，桌面端也能解析出推理文本。(2) 拿不到正文时高强度轮次此前什么都不渲染；现在首段可见文本之前（以及纯思考轮次）会先流出 `[agy thinking turn · N thinking tokens]` 横幅，DB 正文稍后解析出来时无缝追加——不重复横幅、不丢文本，正文已开始后也不在工具密集步骤上刷屏。
- **修复（issue #45）：Windows 号池凭据无法隔离现在是明确、可见的已知限制。** Windows 上 agy 把登录存进系统级 Credential Manager 的单一槽位 `gemini:antigravity`（go-keyring）；HOME 隔离只隔离文件，所有池账号实际仍以系统登录认证与扣额度。插件现在 (1) 在 `/plugins/agy-link/status` 暴露 `credentialIsolationLimited` 并在设置面板渲染警告横幅，(2) Windows 下选中隔离账号时告警一次，(3) 在 KNOWN-GAPS.md 记录边界（以及为何 `maxConcurrent > 1` 时逐 run 的 `CredWrite` 槽位互换不安全）。彻底解决需要上游 agy 改动（按 HOME 命名空间的 keyring，或 keyring 槽位为空时回落文件）。


- **修复：卡死 run 的心跳日志不再谎报静默时长。** 当没有未完成的工具步骤时，静默时钟从一个空 map 上的 `Date.now()` 起算，于是每 5 分钟一次的日志永远显示「无新输出 1m」，而 run 实际已经安静了数小时。现在报告的是距最后一条 stdout 行的真实时长（`lastOutputAt`）——这正是用户决定是否按 Stop 时需要的数字。
- **修复：`agy_tool` 不再把「从未指向过任何步骤的游标」归因为「输出被回收」。** 越界的 step 索引（或非工具事件）与真正被淘汰的录像此前返回同一句「录制输出已不在内存中」——告诉模型输出丢了，而它其实从未被录制过。降级消息现在说明真实原因（「索引在此录像范围之外——尚未录制 / 不是已完成的工具步骤」vs「内存中的录像已被回收」）。
- **修复：账号故障转移现在真的能续上会话——包括在工具步骤之后（「额度用完、整轮作废」问题）。** DSH 重发失败步骤时，如果失败发生在工具续跑 span 内，消息尾部带着工具结果，于是适配器从**已 settle** 的录像里恢复、把同一个失败原样重放一遍：任何在工具调用之后出现的额度/地区/认证拒绝都会让整轮失败，而旁边还有健康账号闲着（已用 `test/fake-agy.mjs` 离线复现）。现在续跑分支拒绝重放「账号级失败的已 settle 录像」，改为丢弃它并在下一个账号上重新组装——仍在同一步内完成，用户看不到中断。故障转移有界（每会话每 2 分钟最多 `启用账号数 - 1` 次重发），且绝不适用于请求级失败，因此确定性错误不会在账号池里反复重跑用户的工具。
- **修复：传输形态的「未登录」不再被报成 AUTH（「API 密钥无效」误导）。** agy 对于真正的登出、以及**无法校验** token 的健康登录，都会说「not logged into Antigravity」（线上 2026-10-10 14:17：重试账号的 token 早 9 分钟就过期，刷新死在 `Post https://oauth2.googleapis.com/token: EOF`，同时伴随 TLS 握手超时）。适配器把它归类为 `AUTH`，后果有三：(a) 在健康账号上终止本轮；(b) 把该账号标记为「需重新登录」；(c) 让 DSH 渲染 `message.failure.auth` 文案——「API 密钥无效」——而凭据从来不是问题。现在，只要认证形态的 stdout banner、stderr 或结果信封里出现传输层证据，就会得到可重试的 `NETWORK` 失败：轮换到下一个账号，且绝不隔离任何登录状态。
- **修复：重试预算跟随账号池，登出也能在另一个账号上继续。** `maxRetries` 原先固定为 1，3 账号池永远到不了第三个账号——而线上事故恰好需要它（主账号 ELIGIBILITY → 第二账号「未登录」→ 整轮丢失，尽管第三个账号健康）。现在预算是 `min(启用账号数 - 1, 2)`；当至少还有一个账号时 `AUTH` 可重试（失败账号被标记 `authRequired` 并退出轮换）。
- **修复：软容量拒绝改为轮换，而不是直接终止本轮。** 「model overloaded」/「experiencing high traffic」原先归类为确定性 `AGY_ERROR`——终止、不轮换、不重试——于是明明还有别的账号可用，本轮却失败了。现在它们是 `OVERLOADED`：可重试、指针已轮换、且**故意不加冷却**（没有消耗任何额度）。硬额度识别也补上了过去漏掉的真实措辞（`Resource has been exhausted (e.g. check quota).`、`You have exhausted your quota`、`out of quota`、`check quota`）——这些以前会退化成一句「agy exited with code 1」，并且重试仍打在同一个已耗尽账号上。
- **修复：空闲看门狗不再杀掉「明显还在干活」的 run。** 真实日志一周内 37 次失败里有 12 次正是 `agy run was idle for 600000ms without output`，每次都赔上一轮和一次重发。现在 stderr 也算活跃（agy 会把进度写在 stderr），并且只要 run 产出过任何输出就适用长预算（`longToolIdleMinutes`，默认 240 分钟）——首个事件之前仍用严格的 `timeoutMs`，那才是真正卡死/连不上 Google 的形态。5 分钟心跳也从「仅有未完成工具步骤」扩展为覆盖「安静但存活」的 run，用户能看到它在等，并可以按 Stop。
- **修复：提示词不再重发当前 agy 会话已有的工具输出，并严格过滤 DSH 合成遥测消息。** 已绑定的会话会把历史工具结果重新塞回 `-p`（线上抓到一条命令行里带着 6.4 KB 的 Godot 模拟输出）——陈旧输出排在真正的问题前面，这正是模型转去回答「上一件事」的原因之一。现在会话已拥有工具输出时不再重发（全新会话仍会带上，因为那时 agy 从未见过）。此外，DSH 在运行时高频注入的 `role: 'user'` 合成遥测消息（如 `time-context` 时间戳、`runtime-context` 上下文快照、`<system-reminder>` 等）现在会被严格过滤，彻底解决时间戳冲掉真实用户任务导致 agy 忽略最新输入的问题；纯图片（无文本）的最新消息也不再回溯拾取旧问题。
- **修复：被中断的轮次不会再让 agy 回答你打断的那条消息。** DSH 会把 Stop / 插话时的半截回复当作普通 assistant 消息持久化，于是插件把「被打断的用户轮次」当成 agy 原生历史（而 agy 服务端那一轮并没有最终回复）——下一条提示词只有新消息，模型却去回答被打断的那条（线上 `session-c65a826e` 第 17→19 轮，用户原样重问并追问「这个咋不回答呢」）。现在 run 被中断或超时时会在 binding 上标记 `interrupted`，下一条提示词带上明确的「不要继续那件未完成的事」边界，成功一轮后清除该标记。被中断的 run 暂存的图片也不再被记为「已投递」（Stop 之后重发同一张截图会被静默去重，纯图片追问则直接报「request carries no user text or images」）。
- **修复：已经产出结果的 run 不会再被下一次调用杀掉。** 插话抢占原先会中止一个已经流完答案的进程（记为假的 `ABORTED`，并把 agy 的收尾切断）；现在会短暂等待它自然退出，只抢占仍在运行的轮次。有界的 settle 等待在超时时会记录日志，被取代的 run 的迟到回写也无法再回退 `lastMessageCount` / `sentImageIds`。
- **修复：账号池与会话绑定的健壮性。** 残缺的 `pool.json`（账号缺 `cooldowns`/`quotas`）会让 `selectAccount` 抛 `TypeError`，导致每一轮都以不透明的内部错误失败、且完全没有故障转移——现在加载时会规范化记录。限流不再删除 `(会话, 账号)` 绑定，因此不会为了 15 分钟冷却丢掉一个可续跑的原生会话（只有真正的登出或 agy 侧「conversation not found」才会作废它）。从存活 run 采纳会话 id 时限定为**同一账号**（把账号 A 的 id 用到账号 B 上会产生一次白跑的「conversation not found」）。`sessions.json` 现在真正实现其文档承诺的 dirty-key 合并，web 与 headless 宿主不再互相覆盖绑定。失败的轮次会报告最后一次 per-call 上下文用量，而不是硬编码的 0/0。ADR-012 不再声称「零中断」的平铺回退与 10 分钟冷却。

### English (continued)

- **Fix: a long-running span can no longer lose its recording to the shared run registry (`no recorded agy run`).** `RunRegistry` kept only the 8 most recently **created** runs (global FIFO across every DSH session). A run whose span waited hours on a wedged agy tool step (e.g. a headless test scene that hit a script error and never quit) was evicted while it was still in flight, and the `agy_tool` mirror call the span had already emitted — `agy_tool({run, step})` — failed with "no recorded agy run", which sent the model off to debug the bridge instead of finishing the user's task (flash-blast incident, 2026-10-10; the same shape recurred on 2026-10-09). The registry now (1) pins a run for the whole lifetime of the span driving it, (2) exempts pinned and unsettled runs from eviction, (3) never evicts the most recent entry, and (4) `remember()` now refreshes recency (delete-then-set) instead of silently keeping the old slot. Spans re-register their recording when they start and when they finish, so the run an `agy_tool` dispatch addresses is always resident, while memory stays bounded by evicting the oldest settled, unpinned run.
- **Fix: a missing recording now degrades instead of throwing a harness-internal error at the model.** `agy_tool` returning `no recorded agy run` was unrecoverable for the agent: it read the error as an environment fault and spent a whole turn reverse-engineering the plugin bundle (including a stale published copy from the pnpm store). When a run's recording is gone the mirror now returns an explicit, task-facing notice stating that the step did run, that its replay is unavailable, that there is nothing to debug, and that the operation can simply be re-run — then the agent continues its real work.
- **Add: configurable long-tool idle budget + stuck-tool heartbeat.** The watchdog raise for open tool steps (previously hard-coded to the ≥ 4 h print-mode ceiling) is now `longToolIdleMinutes` / `DSH_AGY_LONG_TOOL_IDLE_MINUTES` (default 240; `0` disables the raise so a wedged tool fails the turn after `timeoutMs` instead of holding the session for hours). While any tool step is open the adapter now logs a heartbeat every 5 minutes (open count + age + budget), so a stalled turn is visible instead of looking like a dead session.
- **Fix: `toolStepBrief` reads `CommandLine`.** The code-mode/step preview for `run_command` steps showed "run command" whenever agy sent the modern `CommandLine` key; it now shows `$ <command>` like the native card does.
- **Fix: cross-conversation & cross-account assistant replies are now digested when returning.** In multi-account pool scenarios where turns alternated between accounts, an assistant message emitted under another agy conversation id was previously ignored by `isForeignAssistant` (because `provider` was identically `antigravity`). The returning conversation never saw that intervening answer in its context digest. `isForeignAssistant` now verifies `source.replayState` conversation IDs against the current binding, guaranteeing complete cross-conversation context.
- **Fix: `forwardSystemPrompt` falls back to `role: 'system'` messages.** When `options.system` is omitted on `GenerateOptions` but system instructions are provided as an explicit system message in the chat history, the prompt now correctly includes the system instructions.
- **Add: native card presentations for web search, URL fetching, task management, scheduling, and subagents.** Mirrored cards and step previews now cleanly project `search_web`, `read_url_content` / `web_fetch`, `manage_task`, `schedule`, and `invoke_subagent` / `send_message`, avoiding generic raw JSON fallbacks. `TerminalResultView` also extracts process exit codes (`The command exited with code X`) from `run_command` output to render native status pills in DSH terminal cards.

### 中文（续）

- **修复：长时间运行的 span 不会再因为共享 run 注册表而丢失录像（`no recorded agy run`）。** `RunRegistry` 原先只按**创建顺序**保留最近 8 条 run（跨全部 DSH 会话的全局 FIFO）。当某条 run 的 span 因为 agy 工具步骤卡死（例如无头测试场景脚本报错后不退出）等待数小时，它会在仍在飞行时被淘汰，而该 span 已经排好队的 `agy_tool({run, step})` 镜像调用随即报 "no recorded agy run"——模型据此掉头去调试桥接插件，而不是继续用户的任务（flash-blast 事故，2026-10-10；2026-10-09 出现过同样形态）。现在注册表：(1) 在 span 驱动期间**钉住**该 run；(2) 被钉住与未 settle 的 run 免于淘汰；(3) 永不淘汰最近使用的那一条；(4) `remember()` 改为真正的 `delete` 再 `set`，刷新最近使用顺序而不是原地保留旧位置。span 在启动与结束时都会重新登记自己的录像，因此 `agy_tool` 派发时寻址的 run 必定仍在内存中，同时内存仍通过淘汰「最老的、已 settle 且未钉住」的 run 保持有界。
- **修复：录像缺失时改为优雅降级，而不是向模型抛桥接内部错误。** `agy_tool` 返回 `no recorded agy run` 对 agent 来说不可恢复：它把该错误理解为环境故障，整轮都在逆向插件产物（还是一份 pnpm store 里的旧发布副本）。现在录像不存在时，镜像工具返回一条明确面向任务的提示：该步骤确实执行过、只是回放不可用、这里没有可调试的东西、需要输出就重跑一次同样的操作——随后 agent 继续原本的工作。
- **新增：可配置的长工具空闲预算 + 卡死工具心跳。** 未完成工具步骤期间的空闲预算（原先硬编码为 ≥ 4 小时的 print-mode 上限）现在是 `longToolIdleMinutes` / `DSH_AGY_LONG_TOOL_IDLE_MINUTES`（默认 240；设为 `0` 表示不抬高预算，卡死的工具会在 `timeoutMs` 后让本轮失败，而不是把会话挂住数小时）。只要存在未完成的工具步骤，适配器每 5 分钟记录一条心跳（未完成数量 + 最久时长 + 当前预算），让卡住的轮次可见，而不是看起来像会话已死。
- **修复：`toolStepBrief` 会读取 `CommandLine`。** 当 agy 发送新式 `CommandLine` 键时，`run_command` 步骤的 Code Mode / 预览标题只会显示 "run command"；现在与原生卡片一致，显示 `$ <命令>`。
- **修复：跨会话 / 跨账号的助理回复在切回时现在会被完整消化（跨会话上下文丢失漏洞）。** 在多账号池轮换场景下，当某轮切到备用账号并在新 agy 会话中回答后，切回原账号会话时，由于原先 `isForeignAssistant` 仅比对 `provider !== 'antigravity'`，导致另一会话产出的 assistant 回复被误认为“本机历史”而从补充摘要中剔除，使原会话完全缺失该轮的回答上下文。现在通过对比 `source.replayState` 中的会话 ID，跨会话回复会准确作为外部上下文消化到提示词中。
- **修复：`forwardSystemPrompt` 在 `options.system` 缺省时自动回退读取 `role: 'system'` 消息。** 当宿主未在选项顶层传入 `options.system`、但在消息历史中携带了系统指示时，提示词现在仍能准确拼接系统指示。
- **新增：全面支持网页搜索、网页抓取、后台任务管理、定时任务及子 Agent 的原生工具卡片渲染。** 镜像卡片与步骤摘要现已原生支持 `search_web`、`read_url_content` / `web_fetch`、`manage_task`、`schedule` 以及 `invoke_subagent` / `send_message`，避免退化为生硬的 raw JSON；终端卡片 `TerminalResultView` 现在会从 `run_command` 输出中提取真实退出码（`The command exited with code X`），以便 DSH 渲染原生状态药丸。

## 0.4.45 (2026-10-10)

### English

- **Fix (macOS): `ensureIsolatedKeychain` no longer causes modal SecurityAgent password popups on startup (issue #42).** On macOS, `ensureIsolatedKeychain` applied `security set-keychain-settings` on existing isolated keychains on every boot and spawn. When the keychain was locked across app restarts, macOS's SecurityAgent raised blocking GUI dialogs demanding the password for each account — an unanswerable prompt because the isolated keychain was created with an ephemeral random passphrase. The settings (never auto-lock, no timeout) are already persisted on creation, so `ensureIsolatedKeychain` now returns `false` immediately when the keychain file exists on disk, never poking the security CLI again. New keychains are also provisioned with an empty passphrase (`-p ""`) and unlocked upon creation.
- **Fix: reasoning thinking thoughts arriving asynchronously are no longer dropped (issue #43).** In `EventMapper`, the thinking announcement gate prematurely consumed `thinkingAnnounced` when `thoughtTokens > 0` even before thought prose had finished resolving from the SQLite database. Later fragments or DONE tails carrying the resolved thought prose were subsequently dropped as "already announced". The announcement gate now only marks thoughts as announced when thought text is actually present. In addition, `readStepThoughts` in the adapter now adds a retry interval to accommodate SQLite WAL flush latencies during active model generation.
- **Fix (Mermaid): prevent "Syntax error in text" bomb SVG from leaking into the document body.** When a code block containing invalid diagram syntax was processed, Mermaid's fallback error-renderer appended a 2412px-wide SVG with a bomb icon directly into `document.body`. Due to an internal throw before cleanup in Mermaid v11, the leaked elements remained permanently attached to the window footer. `mermaid.initialize` now sets `suppressErrorRendering: true`, pre-validates syntax using `api.parse()`, passes a scoped mount container to `api.render()`, unconditionally sweeps temporary and stray elements (`#dagy-mmd*`, `#iagy-mmd*`) in a `finally` block, and injects protective CSS preventing body-level leaked nodes from rendering.

### 中文 (Chinese)

- **修复 (macOS)：`ensureIsolatedKeychain` 不再在每次启动时触发 SecurityAgent 钥匙串密码弹窗（issue #42）。** 在 macOS 上，`ensureIsolatedKeychain` 原先在每次 DSH 启动和进程拉起时都会对已存在的隔离钥匙串执行 `security set-keychain-settings`。当钥匙串在应用重启后处于锁定状态时，macOS 的 SecurityAgent 会对每个隔离账号弹出阻塞式系统密码框——由于此前钥匙串是使用未持久化的随机密码创建的，用户输入任何密码都无法通过。钥匙串的“永不自动锁”设置在首次创建时已持久化落盘，因此当钥匙串文件已存在时，`ensureIsolatedKeychain` 现在直接返回 `false`，绝不再调用 security CLI；新建钥匙串时也改用空密码（`-p ""`）创建并立即静默解锁。
- **修复：异步从数据库解析的思考过程正文不再被静默丢弃（issue #43）。** 在 `EventMapper` 中，思考公布逻辑原先只要检测到 `thoughtTokens > 0`，即使 SQLite 中的思考正文尚未完成异步提取，也会过早消耗 `thinkingAnnounced` 标记，导致后续分片或 DONE 尾包即使成功提取到了思考正文也被判定为“已公布”而直接丢弃。现在公布标记仅在实际存在思考正文时才消耗；同时适配器中的 `readStepThoughts` 增加了重试等待，以包容模型生成期间 SQLite WAL 写入的延迟。
- **修复 (Mermaid)：彻底解决 Mermaid 语法错误导致巨大的“Syntax error in text”炸弹图标残留在窗口底部的问题。** 当代码块包含不合法的图表语法时，Mermaid 内部的兜底错误渲染逻辑会向 `document.body` 追加一个 2412px 宽的巨大炸弹图标（💣）SVG；由于 Mermaid v11 在内部抛错前未执行清理，该临时元素会永久留在窗口底部污染界面。现在初始化时开启了 `suppressErrorRendering: true`，在渲染前通过 `api.parse()` 预校验语法，向 `api.render()` 传入局部挂载容器，在 `finally` 块中无条件清理临时节点（`#dagy-mmd*`、`#iagy-mmd*`），并通过安全 CSS 全面隐藏逃逸到 body 层级的任何错误元素。

## 0.4.44 (2026-10-09)

### English

- **Fix: a conversation stalled on a tool step no longer dead-ends after a host restart.** Continuation spans resolve their run from an **in-memory** `RunRegistry`; after DSH restarts (or the run is evicted) the recording is gone, and `stream()` used to fail that turn — and every retry of it — with "agy run … is no longer available (server restarted?) — please resend your message", an advice that could never succeed because the stale tool result stays at the end of the message list. The adapter now logs a warning and falls back to fresh-turn prompt assembly instead: the history digest carries the recorded tool result, and the session's `sessions.json` binding still points at the same agy conversation, so the next turn heals the conversation with no user action. Related hardening in the same change: (1) the `agy_tool` mirror now bypasses DSH's auto-review / permission gates via a `tools/pre-execute` hook (it only replays output agy already executed — routing it through the reviewer caused redundant review LLM calls, timeouts, and crashes on reviewer tool-call endings); (2) review-mode calls (`REVIEW_POLICY` system prompt) and calls with explicit `tools: []` are treated as auxiliary and never cut spans on tools; (3) on Windows, `.mjs`/`.js`/`.cjs` bins are spawned via `process.execPath` instead of failing with `EFTYPE` (this also makes the full test suite pass natively on Windows — the 33 pre-existing platform failures are gone). (PR #40)
- **Add: hide models from the DSH model picker (`hiddenModels`).** The Antigravity settings section (below account-pool scheduling) now renders a "Model visibility" row with one toggle per known model: hidden models disappear from the `/model` picker, everything else stays visible (deny-list semantics, so newly discovered models appear by default). Hiding is picker-only by design — `resolveModel` still accepts hidden ids, so in-flight sessions and direct model references keep working, and no catalog-cache invalidation is needed. The list is served from `/status` (`catalogModels` + `hiddenModels`) through the same sanitizer that feeds `listModels`, so the UI and the picker can never disagree; writes go through the existing `POST /config` allowlist (validated as an array of model ids) and persist to the runtime-overrides file immediately. `DSH_AGY_HIDDEN_MODELS` (comma-separated) also works as an env fallback. The plugin now also emits the payload-free `llm/adapters-updated` event whenever picker output can change (`hiddenModels` writes, boot-probe discovery, re-login, manual quota refresh) — the webview picker caches its catalog snapshot and only re-reads after that event, so without it toggles would not show up until the next app restart. (PR #39)
- **Fix: the Windows node-shim spawn merged from #40 now really runs the script instead of booting a second app instance.** `process.execPath` is the Electron binary in the packaged desktop host, so the `isNode` branch now sets `ELECTRON_RUN_AS_NODE=1`; plain node ignores the variable, so POSIX and the test suite are unaffected.

### 中文 (Chinese)

- **修复：停在工具步骤上的会话在宿主重启后不再进入死胡同。** 续接 span 依赖的 run 录像存放在**纯内存**的 `RunRegistry` 里;DSH 重启(或录像被淘汰)后录像即消失，`stream()` 会让该轮失败——而且每次重试都失败，报 "agy run … is no longer available (server restarted?) — please resend your message"。这个"请重发消息"的建议永远不可能成功：失效的工具结果始终钉在消息列表末尾，续接检测每轮都命中同一个 runId。现在适配器会记录一条警告并**回退到全新轮次的 prompt 组装**：历史 digest 携带已记录的工具结果，会话在 `sessions.json` 里的 conversation 绑定仍指向同一个 agy 会话，下一轮即自动自愈，无需用户做任何事。同一批提交中的相关加固:(1) `agy_tool` 镜像现在通过 `tools/pre-execute` 钩子绕过 DSH 的 auto-review / 权限门(它只是重放 agy 已经执行过的输出——送审会导致重复审查 LLM 调用、审查超时，以及审查员以 tool-calls 结尾时的崩溃);(2) 审查模式调用(`REVIEW_POLICY` 系统提示)与显式 `tools: []` 的调用按辅助调用对待，不再在工具步骤上切分 span;(3) Windows 下 `.mjs`/`.js`/`.cjs` 形式的 bin 改为经 `process.execPath` 启动，不再触发 `EFTYPE`(这也让整个测试套件在 Windows 上原生全绿——33 个既有平台失败清零)。（PR #40）
- **新增：在 DSH 模型选择器中隐藏指定模型（`hiddenModels`）。** Antigravity 设置区（号池调度下方）新增"模型显示"一行，每个已知模型一个开关：关闭的模型从 `/model` 选择器中消失，其余照常显示（黑名单语义——新发现的模型默认可见）。隐藏只作用于选择器：`resolveModel` 仍接受被隐藏的模型 id，进行中的会话与直接引用不受影响，也无需清空模型目录缓存。模型列表由 `/status`（`catalogModels` + `hiddenModels`）提供，与 `listModels` 共用同一清洗逻辑，UI 与选择器永远不会不一致；写入走现有 `POST /config` 白名单（校验必须是模型 id 数组），立即持久化到 runtime-overrides 文件。环境变量 `DSH_AGY_HIDDEN_MODELS`（逗号分隔）亦可作为回退。插件现在会在所有会影响选择器输出的时机发出无负载的 `llm/adapters-updated` 事件（`hiddenModels` 写入、启动探测发现模型、重新登录、手动刷新额度）——webview 的模型选择器缓存目录快照、只在该事件后重读，缺少它时开关要到下次重启应用才会生效。（PR #39）
- **修复：合入自 #40 的 Windows node 脚本启动现在真正执行脚本，而不是再启动一个 App 实例。** 打包桌面端里 `process.execPath` 是 Electron 二进制，因此 `isNode` 分支现在会设置 `ELECTRON_RUN_AS_NODE=1`；纯 node 会忽略该变量，POSIX 与测试不受影响。

## 0.4.43 (2026-10-06)

### English


- **Fix (Windows): Chinese tool output is no longer mangled (issue #37).** Windows pipes carry bytes in the child's console code page: on a zh-CN system agy captures pwsh output as CP936 (GBK), and the plugin decoded every stream as UTF-8 — so the Chinese refusal text arrived as mojibake, and because that text is what agy stores in its conversation database the damage was permanent. stdout/stderr are now read as raw bytes and decoded **per line** through the console code page (`chcp` probe → GBK/Big5/Shift_JIS/EUC-KR/Windows-125x), falling back to UTF-8 whenever a line is valid UTF-8; POSIX behaviour is bit-for-bit unchanged (the probe returns `utf-8`). Lines — not chunks — are the decoding unit because a multi-byte character can straddle a chunk boundary but never a newline.
- **Fix: `dsh plugin add git+https://…` installs now build the plugin (issue #38).** `dist/` is not committed and only `prepack` existed, which never runs for git dependencies — so a hub/git install produced a package without `dist/` and failed to load. A `prepare` script now builds on git installs (npm/pnpm install devDependencies for git deps first); npm consumers are unaffected because `prepare` does not run for published tarballs. The install also aborted **earlier** than that: `@deepseek-ai/dsh-client-locale` was declared as a **non-optional** peer, so npm's automatic peer installation tried to fetch the unpublished `@deepseek-ai/dsh-paths@^0.0.1-rc.1` chain from the public registry and failed with a 404 — every `@deepseek-ai/*` peer is now optional (the host provides them at runtime and the bundle keeps them external), matching how third-party DSH plugins declare theirs.
- **Fix: the live "User location is not supported for the API use" refusal is now recognized, explained and routed around.** agy exits 3 with a `FAILED_PRECONDITION (code 400)` result envelope for this refusal, but the classifier only knew the older issue-#32 wording — so it surfaced as a bare `PROCESS_EXIT`, the sticky account never moved, and every retry hit the same unsupported location (hence the recurring failure). The signature is now matched, the failure carries a dedicated, retryable `ELIGIBILITY` code plus the actionable hint, and the refused account is rotated off the sticky pointer before the error surfaces (no cooldown penalty) — the automatic retry is then served by an account whose own proxy/egress region is supported.
- **Add: rotation now drains the account whose quota expires soonest (use-it-or-lose-it).** Sequential fallback used to advance in pool order, which could leave an account sitting on 60 % of a 5-hour window that resets in 20 minutes — that residual is discarded at the reset, so it was wasted. When the sticky account is drained (hard quota, cooldown, silent timeout) the next account is now the eligible one whose quota window refreshes **soonest** (5-hour window or weekly cap, whichever comes first); ties and accounts with no quota metadata yet keep the previous cyclic order, so a drained slot never bounces back to the primary, and rotation still never cools an account down on its own.
- **Fix: quota exhaustion and silent timeouts now retry onto the next account instead of dead-ending.** A hard server-issued quota / rate-limit refusal was classified as the generic `AGY_ERROR`, which the provider retry policy never retried — the account cooled down and the sticky pointer advanced, but the turn still surfaced a user-visible error while a healthy account sat idle. It now carries a dedicated, retryable `RATE_LIMIT` code, so the automatic retry is served by the next account in the pool. Deterministic `AGY_ERROR`s (bad region, empty request, pool fully cooled) deliberately stay single-shot. A **silent** timeout (no stdout event at all — unreachable Google or a wedged credential) now rotates the sticky pointer to the next account for the retry *without* a cooldown, so one account's black hole cannot masquerade as "all accounts in cooldown". Finally, `autoFallbackModel` is no longer useless: the hardcoded `gemini-3.5/3.6-flash` list downgraded *within* the exhausted family (all Gemini models share one quota pool), so a drained Google family could never be rescued — it now fails over across families (Gemini ⇄ Claude ⇄ GPT-OSS), which have separate quotas.
- **Fix: Antigravity console and chat toolbar now immediately display the active account when switching or after quota exhaustion.** When an account exhausted its 5h or weekly quota or hit rate limits, the scheduler advanced to the next backup account, but `lastActiveAccountId` was not proactively updated, leaving the console showing an outdated badge or no badge at all. `recordFailure` and `updateAccountQuotas` now proactively advance the active pointer immediately, self-heal client badges away from cooldown/quarantined accounts, clean up pointers when accounts are deleted/disabled/quarantined, and the chat toolbar button now visibly displays the active account alias (`AGY · <alias>`) in real-time. Furthermore, caller-aborted runs (`outcome.aborted`) are exempt from recording rate-limit failures, preventing ghost cooldowns (`"agy run aborted by caller"`) from poisoning pool rotation, and any historical abort cooldowns are automatically purged on startup.
- **Fix & Add: Mermaid diagram rendering with bundled local assets and universal block sniffing.** DSH renders fences with unknown grammar (like `mermaid`) as localized code blocks (labeled "代码块" in Chinese or "Code block" in English) with stripped or non-standard language attributes. Diagram detection now universally scans `.md-code-block` elements, filters known programming languages, and sniffs Mermaid diagrams from the content. Furthermore, `mermaid.min.js` (v11.17.2) is now served directly from the local plugin endpoint (`/plugins/agy-link/mermaid.min.js`), completely eliminating external CDN timeouts, failures, or blocking.
- **Fix: code cards referenced a non-existent font token, so the code font silently fell back to the hardcoded stack.** `ROW_CSS` spelled the DSH code-font token as `--dsw-font-family-code`, but the real token is `--ds-font-family-code` (no `w`). The mistyped name has zero definitions anywhere in DSH, so every `var(--dsw-font-family-code, <fallback>)` resolved to its hardcoded fallback (`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`), which carries no CJK coverage — Chinese text inside agy tool cards rendered in the OS default (SimSun / Microsoft YaHei) instead of the host's configured code font. The three affected selectors are `.agy-tv-card` (whose `font-family` is inherited by the header, copy button and body), `.agy-tv-preview` and `.agy-tv-diff-stat`.
- **Fix: tool-hop continuations no longer re-attach every historical screenshot.** When a continuation carried no new image, the prompt builder fell back to collecting attachments from *all* earlier user turns, so the same 4–5 UI screenshots were re-staged and re-referenced on every step (observed: 61 staged files for 5 unique images in one session). Image forwarding is now watermark-aware (`SessionBinding.sentImageIds`): only attachments the current agy conversation has not seen are staged. Staged files are also keyed by attachment id instead of call index, so a legitimate re-reuse overwrites rather than accumulates.
- **Fix: account / model switches now transfer the prior conversation properly.** A brand-new agy conversation (account switch, model switch, post-compaction re-seed) used to be seeded with only `digestMaxChars` (8K), silently dropping most of a long session. First contact now uses the new `contextTransferMaxChars` budget (default 660K, sized for 1M-token-class models), and the attachments that carry the visual context ride along once via the same image watermark.

### 中文 (Chinese)


- **修复（Windows）：中文工具输出不再乱码（issue #37）。** Windows 管道里的字节使用**子进程的控制台代码页**：中文系统上 agy 捕获到的 pwsh 输出是 CP936（GBK），而插件把整条流按 UTF-8 解码——中文报错于是变成乱码；又因为这段文本正是 agy 写入会话库的内容，损坏不可追回。现在 stdout/stderr 以**原始字节**读取并按**行**用控制台代码页解码（`chcp` 探测 → GBK/Big5/Shift_JIS/EUC-KR/Windows-125x），凡是合法的 UTF-8 行仍按 UTF-8 处理；POSIX 行为逐字节不变（探测直接返回 `utf-8`）。以「行」而非「块」为解码单位，是因为多字节字符可能跨块但绝不会跨换行。
- **修复：`dsh plugin add git+https://…` 安装现在会构建插件（issue #38）。** 仓库里没有提交 `dist/`，而只有 `prepack`——它**不会**在 git 依赖安装时执行，所以市场/git 安装得到的包没有 `dist/`，加载失败。现在新增 `prepare` 脚本，git 安装时会构建（npm/pnpm 会先为 git 依赖安装 devDependencies）；从 npm 安装的用户不受影响，因为 `prepare` 不会对已发布的 tarball 执行。安装其实在更早一步就已经失败：`@deepseek-ai/dsh-client-locale` 曾被声明为**非可选** peer，npm 的自动 peer 安装因此去公共 registry 拉取未发布的 `@deepseek-ai/dsh-paths@^0.0.1-rc.1` 依赖链并报 404 —— 现在所有 `@deepseek-ai/*` peer 都标为 optional（运行时由宿主提供，打包时保持 external），与第三方 DSH 插件的声明方式一致。
- **修复：线上「User location is not supported for the API use」区域拒绝现在被正确识别、解释并绕开。** 该拒绝报文是 agy 以退出码 3 + `FAILED_PRECONDITION (code 400)` 结果信封抛出的，而分类器只认得 issue #32 时期的旧措辞——于是它被当成裸 `PROCESS_EXIT`，粘性账号也不会移动，每次重试都撞同一个不支持的地区，所以你会觉得"总是出现这个问题"。现在该签名已被匹配，失败会带专用且**可重试**的 `ELIGIBILITY` 错误码与可操作提示，同时在错误抛出前把被拒账号从粘性指针上换掉（**不扣冷却**），自动重试就会落到代理/出口地区受支持的账号上。
- **新增：轮换优先使用「快过期」的账号（不用就浪费）。** 顺次兜底此前按号池顺序推进，可能让某账号 5 小时窗口里还剩 60%、20 分钟后就要刷新——这部分余量在刷新时会被直接丢弃，等于白扔。现在当粘性账号耗尽（硬限流 / 冷却 / 静默超时）时，轮换目标改为**额度窗口刷新最近**的可用账号（5 小时窗口与周额度取更早者）；时间相同或尚无额度信息时沿用原有循环顺序，既避免耗尽后回弹到主账号，也保证轮换本身不会给账号扣冷却。
- **修复：额度耗尽与静默超时不再「直接失败」，而是自动重试到下一个账号。** 服务器硬性限流/额度拒绝此前被归为通用 `AGY_ERROR`，而重试策略从不重试该错误码——账号确实进了冷却、粘性指针也确实推进了，但这一轮仍然把错误抛给用户，明明还有健康账号闲着。现在它使用独立的可重试错误码 `RATE_LIMIT`，自动重试即由池中下一个账号接管。确定性的 `AGY_ERROR`（区域不可用、空请求、全池冷却）刻意保持不重试。**静默超时**（全程零 stdout 事件——连不上 Google 或凭证卡死）现在会推进粘性指针到下一个账号供重试，且**不给账号扣冷却**，避免单个账号的黑洞被误报成「所有账号都在冷却」。另外 `autoFallbackModel` 不再是废功能：原先硬编码的 `gemini-3.5/3.6-flash` 是**同族内**降级（所有 Gemini 模型共用一个额度池），Google 族耗尽时永远救不回来；现在改为**跨族兜底**（Gemini ⇄ Claude ⇄ GPT-OSS，各自独立额度）。
- **修复：账号额度用尽或切号后，Antigravity 控制台与会话工具栏即时准确展示当前使用账号。** 当首选账号 5 小时/周额度用尽或触发限流冷却时，调度器虽能在内部切到次选账号，但此前 `lastActiveAccountId` 未被主动更新，导致管理控制台的绿色「当前使用」徽标停留在旧账号上或未点亮。现在 `recordFailure` 与 `updateAccountQuotas` 在耗尽时主动推进激活指针，前端直接信赖后端权威计算的当前账号；会话顶栏按钮直接常驻显示当前账号（如 `AGY · g98`），一目了然；同时修复了用户主动中断（Stop / 插话抢占）被误判为限流并给账号扣上“幽灵冷却”（`"agy run aborted by caller"`）的严重缺陷，启动时自动清理历史幽灵冷却。
- **修复与新增：Mermaid 图表离线本地直出与通用代码块识别。** DSH 的 Markdown 渲染管线没有 Mermaid 语法高亮，未识别的围栏会被渲染为“代码块”（英文 "Code block"）且语言标识可能丢失或非标准。探测机制现升级为全覆盖扫描 `.md-code-block`，排除常见编程语言后智能探测图表语法；并将 `mermaid.min.js` (v11.17.2) 随插件本地内置并由插件端口直出（`/plugins/agy-link/mermaid.min.js`），彻底告别外网 CDN 超时、连接挂起或被阻断导致的图表无法渲染问题。
- **修复：代码卡片引用了一个不存在的字体 token，导致代码字体静默回落到硬编码兜底栈。** `ROW_CSS` 里把 DSH 的代码字体 token 写成了 `--dsw-font-family-code`，而真实 token 是 `--ds-font-family-code`（无 `w`）。这个拼错的名称在整个 DSH 代码库里零定义，因此每一处 `var(--dsw-font-family-code, <兜底>)` 都取到硬编码兜底值 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`——该栈不含中文字形，导致 agy 工具卡片里的中文以系统默认字体（宋体 / 微软雅黑）渲染，而非宿主配置的代码字体。受影响的三个选择器是 `.agy-tv-card`（其 `font-family` 会向下继承到标题栏、复制按钮与正文）、`.agy-tv-preview` 与 `.agy-tv-diff-stat`。
- **修复：工具往返续跑不再重复附加全部历史截图。** 当续跑请求里没有新图片时，提示词组装会回退成收集**全部**历史 user 轮次的附件，于是同样的 4～5 张 UI 截图在每一步都被重新落盘、重新引用（实测一个会话 61 个暂存文件只有 5 份唯一内容）。图片转发现在按水位去重（`SessionBinding.sentImageIds`）：只暂存当前 agy 会话还没见过的附件。暂存文件名也改为按 attachment id 而不是调用序号，合法重用会覆盖而不是堆积。
- **修复：切换账号 / 切换模型后能正确带上此前的对话上下文。** 新建 agy 会话（切账号、切模型、压缩后重播种）此前只用 `digestMaxChars`（8K）做种子摘要，长会话的历史被大量丢掉。首次接入现在使用新的 `contextTransferMaxChars` 预算（默认 660K，面向 1M token 级模型），承载视觉上下文的图片也会通过同一水位机制补发一次。


## 0.4.42 (2026-09-30)

### English

- **Fix: provisioned pool keychains are now set to never auto-lock.** A created keychain can lock later (system sleep / lock policy); a locked keychain turns every agy keyring save into an unanswerable password dialog — the keychain password is random and only the plugin knows it, so the user's login password is always rejected. `ensureIsolatedKeychain` now applies never-auto-lock settings on every boot/spawn/login (idempotent), not just at creation.

### 中文 (Chinese)

- **修复：预置的池账号钥匙串现在设置为永不自动锁。** 新建的钥匙串之后可能被系统上锁（系统睡眠/锁定策略）；一旦上锁，agy 的每次 keyring 保存都会弹一个**无法回答**的密码框——钥匙串密码是随机的、只有插件自己知道，用户输登录密码永远不对。`ensureIsolatedKeychain` 现在在每次启动/拉起/登录时都会幂等地套用"永不自动锁"设置，而不仅仅在创建时。

## 0.4.41 (2026-09-30)

### English

- **Fix: the UI Stop button could not kill an offline wedged run.** `killTree` sent a single SIGTERM to the process group; agy's graceful-shutdown path ignores it while the process is wedged in offline dial retries (verified live: the run survived `kill <pid>` and only died on `kill -9`). The runner now escalates to SIGKILL for the whole group 3s after SIGTERM, so Stop always wins.
- **Fix: offline runs spun on "thinking" forever.** The idle watchdog treated stderr chatter as activity — agy logs a dial-retry line to stderr every ~35s when it cannot reach Google, so a run that never emitted one stdout event stayed "active" until the 240m print-timeout. The watchdog is now **stdout-only**; login flows opt back in via the new `stderrKeepalive` run option (a browser login is legitimately stdout-silent for minutes). A timeout with zero stdout events now reports the likely cause: the run cannot reach Google (check proxy/network).
- **Add: global `proxyUrl` config (`DSH_AGY_PROXY_URL` env works too).** GUI hosts don't inherit shell proxy env — the #1 reason plugin runs time out while the same command in a terminal works. An account's dedicated `proxyUrl` wins, then the global config; the effective proxy is injected into every agy spawn (`ALL_PROXY`/`HTTP(S)_PROXY`) and used by the quota / OAuth fetches. `/agy pool` now shows the effective proxy per account.
- **Fix (macOS): recurring "create login keychain" password popup.** Pool accounts run with an isolated HOME, and macOS has **no login keychain inside it** (`security default-keychain` → "A default keychain could not be found"), so agy's keyring save triggered the `system.keychain.create.loginkc` password dialog on every ~hourly token refresh; denying it fell back to the on-disk token (auth kept working — exit status 45/154 in agy logs). The plugin now provisions a throwaway per-account keychain and sets it as the default under that HOME — idempotently at boot, before every spawn and before every login — so keyring writes are silent and truly per-account.
- **Fix: transient network errors no longer flag accounts as "needs re-login".** Both flagging paths were too eager: the run-failure path matched any message containing `/auth/i` (e.g. `oauth2.googleapis.com … i/o timeout` transport noise) and the token-refresh path flagged **any** `token endpoint 400` — including captive-portal / proxy error pages. Both now require an authoritative OAuth state (`invalid_grant` / `invalid_client` / `revoked` / `disabled` / `unauthorized_client`) and transport-shaped failures are exempt — even a genuine AUTH classification is not trusted when the message is transport-shaped. A false flag also **removed the account from pool rotation** (`selectAccount` skips authRequired), so this was silent capacity loss plus a scary badge that the next manual quota refresh would immediately disprove.
- **Add: flagged accounts self-heal in the background.** `markAuthRequired` now stamps `authMarkedAt`; after 10 minutes the background poll includes the flagged account for one token verification — if the stored refresh token still works the flag clears itself (previously this required a manual 刷新额度 click); if it is truly dead the flag is re-stamped. Risk-control exposure: at most one token-endpoint call per 10 minutes per flagged account.
- **Add: "In use" badge in the Antigravity console.** Exactly **one** account card shows the green zap badge: the account of the most recent agy spawn (`lastActiveAccountId`), localized (zh/en/pt-BR/es). The per-family scheduler pointers (`activeAccountIds`) are an internal scheduling detail and can legitimately sit on families that are not running anything — deriving the badge from them lit up two cards at once, which reads as "two accounts in use".
- **Fix: a steer replacement now waits for the run it killed to exit.** A new prompt arriving while a run is live preempts that run and resumes the same agy conversation (`--conversation <id>`); the replacement spawn previously raced the abort, so two agy processes could briefly append to one conversation. The spawn now waits (bounded, 3.5 s) for the aborted run to settle.
## 0.4.40 (2026-09-28)

### English

- **Fix (issue #34): post-tool hops dropped the task text and images.** dsh-llm 0.1.7 promotes tool results to `role: 'tool'` (0.1.x used `role: 'user'` + `source.callId`). `detectContinuation` and the trailing-span extractor only accepted the 0.1.x shape, so every hop after the first tool round-trip lost the mirror continuation, assembled an empty/digest-only prompt (`request carries no user text` or "what should I do next?"), and silently dropped image attachments. Both schemas are now accepted (`message.toolCallId`, `source.callId`, nested `tool-result` blocks); nested tool-result text and images are forwarded.
- **Fix (issue #35): continuation prompts must keep the live task.** `buildDigest` used to let a wall of tool-result text consume the 8K budget and truncate the user's question away. The latest real user turn is now reserved at the head of the digest; the assembled prompt always re-states it whenever the trailing span is tool-results only. A dead loop of "read my own agy logs" with no task can no longer start.
- **Fix (issue #35): aborted runs now persist the agy conversation id.** Binding was only written when `failure === null`, but a tool-cut / caller abort / timeout is exactly the path that used to drop it — so the next hop always started a brand-new agy conversation (`conversationID=""`) with digest-only prompt. The id is now harvested from a live run before steer-preemption and persisted on abort/timeout/process-exit (auth / rate-limit / conversation-rejected still drop the binding).
- **Fix (issue #32): region eligibility refusals get a clear cause.** agy exits 1 with `Eligibility check failed: … not currently available in your location` (e.g. Seoul). This is a Google-side account/region restriction, not a proxy or quota bug. The bridge now classifies it and surfaces an explicit `AGY_ERROR` with guidance instead of a bare `PROCESS_EXIT`.

### 中文 (Chinese)

- **修复：UI 的 Stop 按钮杀不掉离线卡死的 run。** `killTree` 只对进程组发一次 SIGTERM；而 agy 困在离线拨号重试里时会无视 SIGTERM（实测 `kill <pid>` 无效、只有 `kill -9` 能杀掉）。现在 runner 在 SIGTERM 3 秒后对整组升级 SIGKILL，Stop 按钮必定生效。
- **修复：连不上 Google 时 run 永远转圈。** 旧看门狗把 stderr 输出当作活动——agy 连不上 Google 时每 ~35 秒往 stderr 写一条拨号重试日志，于是一个连一条 stdout 事件都没有的 run 一直“活着”，直到 240 分钟的 print-timeout。看门狗现在**只认 stdout**；登录流程通过新的 `stderrKeepalive` 选项继续保活（浏览器登录本来就会长时间没有 stdout）。零 stdout 事件的超时现在会直接说明原因：无法连接 Google（检查代理/网络）。
- **新增：全局 `proxyUrl` 配置（也支持 `DSH_AGY_PROXY_URL` 环境变量）。** GUI 应用不继承 shell 的代理环境变量——这是“终端里没问题、插件里必超时”的头号原因。账号专属 `proxyUrl` 优先，其次全局配置；生效代理会注入每个 agy 进程（`ALL_PROXY`/`HTTP(S)_PROXY`），额度 / OAuth 请求同样走代理。`/agy pool` 现在会显示每个账号的生效代理。
- **修复（macOS）：反复弹出“创建登录钥匙串”密码框。** 池账号使用隔离 HOME，而隔离 HOME 里**没有登录钥匙串**（`security default-keychain` → "A default keychain could not be found"），agy 每次约每小时的 token 续期写入都会触发 `system.keychain.create.loginkc` 密码弹窗；取消后回退磁盘 token（认证不受影响——agy 日志里的 exit status 45/154 即此）。插件现在会为每个池账号预置一个专属的一次性钥匙串并设为该 HOME 的默认——在启动时、每次拉起前、每次登录前幂等执行——钥匙串写入从此静默，且真正做到按账号隔离。
- **修复：瞬时网络错误不再把账号标记为「需重新登录」（误判修复）。** 两条标记路径都过于激进：run 失败路径会匹配任何包含 `/auth/i` 的报错（比如 `oauth2.googleapis.com … i/o timeout` 这种纯传输噪音）；token 刷新路径会把**任何** `token endpoint 400` 都当成认证死亡——包括代理/门户返回的错误页。现在两条路径都要求出现权威的 OAuth 状态（`invalid_grant` / `invalid_client` / `revoked` / `disabled` / `unauthorized_client`），传输型失败一律豁免——即使带 AUTH 分类，只要报错文本是传输形态也不标记。误判的代价不只是吓人的徽标：被标记的账号会被调度器**排除出轮换**，等于静默损失一个账号，直到手动「刷新额度」把它证伪。
- **新增：被标记的账号后台自动复验。** `markAuthRequired` 现在会记录 `authMarkedAt`；10 分钟后后台轮询会把该账号放进来做一次 token 验证——刷新令牌若仍可用，标记自动清除（以前必须手动点「刷新额度」）；若真的失效则重新盖章。风控代价：每个被标记账号至多每 10 分钟一次 token endpoint 调用。
- **新增：控制台「当前使用」标识。** 现在**只会有一张**账号卡片显示绿色 ⚡「当前使用」徽标：最近一次真正拉起 agy 的账号（`lastActiveAccountId`），四种语言（zh/en/pt-BR/es）均已本地化。按模型族的调度指针（`activeAccountIds`）只是内部调度细节，可能停在当前并没有跑任何东西的模型族上——用它做徽标会一次点亮两张卡，看起来像"两个账号在用"。
- **修复：插话（steer）替换进程现在会等被抢占的 run 真正退出。** run 还在跑时来一条新提示词会抢占该 run 并续用同一个 agy 会话（`--conversation <id>`）；此前替换进程与 abort 存在竞争，极端情况下会有两个 agy 进程短暂同时往同一个会话追加。现在拉起前会有界等待（3.5 秒）被抢占的 run 收尾。
## 0.4.40 (2026-09-28)

### 中文 (Chinese)

- **修复 #34：工具往返之后任务文本和图片丢失。** dsh-llm 0.1.7 把工具结果提升为 `role: 'tool'`（0.1.x 是 `role: 'user'` + `source.callId`）。`detectContinuation` 与尾部消息提取只认 0.1.x 形态，于是第一次工具往返之后的每一跳都丢掉镜像续跑，拼出空 prompt 或纯 digest（`request carries no user text`，或 agy 反问「接下来做什么」），图片附件也一并丢失。现在两种 schema 都识别（`message.toolCallId` / `source.callId` / 嵌套 `tool-result`），嵌套工具结果文本与图片会一并转发。
- **修复 #35：续跑提示词必须保住任务。** 旧 `buildDigest` 允许大段工具结果吃掉 8K 预算，把用户的问题截掉。现在最新一条真实用户消息固定保留在 digest 开头；只要尾部只有工具结果，组装出的 prompt 也会重申该任务。「反复读自己日志、没有题目」的死循环不会再出现。
- **修复 #35：aborted 路径也会落库 conversationId。** 旧逻辑只在 `failure === null` 时写 binding，而工具切断 / 调用方中止 / 超时恰恰是最容易丢 id 的路径——下一跳于是每次都开全新 agy 会话（`conversationID=""`）+ 纯 digest。现在会在 steer 抢占前从 live run 收割 id，并在 abort/timeout/process-exit 时落库（auth / 限流 / 会话失效仍会删除 binding）。
- **修复 #32：地区资格拒绝给出明确原因。** agy 以 `Eligibility check failed: … not currently available in your location` 退出（例如首尔）。这是 Google 账号/地区限制，不是代理或额度问题。桥接层现在会识别并给出明确的 `AGY_ERROR` 与指引，而不是裸的 `PROCESS_EXIT`。

## 0.4.39 (2026-09-21)

### English

- **Fix (issue #33): DSH session interrupt during long tools (maven / compile).** An ACTIVE agy tool is silent on stdout for many minutes while it builds. The idle watchdog used the normal `timeoutMs` (default 10 min) and killed the healthy run mid-compile. While any tool step is outstanding the idle budget now rises to the print-mode ceiling (≥ 4 h) and restores to `timeoutMs` when the last tool completes (`RunningProcess.noteActivity`).
- **Fix (issue #33): identical retries no longer preempt a live long tool.** Session ownership is decided after prompt assembly: same prompt + live run → `BUSY` (leave the maven/compile alone); different prompt + live run → steer-preempt; settled run → retry allowed (still honors issue #32).

### 中文 (Chinese)

- **修复 #33：耗时工具（Maven/编译）期间会话被中断。** 工具 ACTIVE 后 agy 在 stdout 上长时间静默是正常的；旧空闲看门狗按 `timeoutMs`（默认 10 分钟）把还在编译的进程杀掉。现在只要存在未完成的工具步骤，空闲预算就抬到 print-mode 上限（≥ 4 小时），工具全部结束后恢复 `timeoutMs`。
- **修复 #33：同 prompt 重试不再抢占正在跑的长任务。** 会话所有权在 prompt 组装之后判定：同 prompt + live run → `BUSY`（不杀 Maven/编译）；不同 prompt + live run → 作为 steer 抢占；已 settle 的请求仍放行重试（兼容 #32）。

## 0.4.38 (2026-09-21)

### English

- **Fix (issue #32): "Duplicate request ignored" dead-end after a failed turn.** The in-flight debounce used a 10-second time wall keyed only on identical prompt text, and never cleared when a run settled. DSH auto-retries after a fast agy failure; that retry was rejected as `BUSY`, so every subsequent turn looked like "model unreachable" even with quota at 100% and a healthy proxy. Debounce now rejects only while a live (unsettled) run owns the session, or during a tight pre-spawn double-submit race. Settled runs (success / error / abort) never block a retry. A stream that itself preempts a live run always proceeds.

### 中文 (Chinese)

- **修复 #32：失败后重试被「Duplicate request ignored」卡死。** 旧的防抖只按「同 prompt + 10 秒」拦截，且请求结束后不清理。agy 快速失败后 DSH 会自动重试，结果被当成 BUSY 拒掉，后续每一轮都看起来像「模型不可访问」（额度 100%、代理正常也会中招）。现在只有会话上仍存在未结束的 live run，或 spawn 前极短窗口内的真双击，才会拒绝；已 settle 的请求（成功/失败/中止）一律放行重试；由本请求抢占 live run 的新回合一定放行。

## 0.4.37 (2026-09-18)

### English

- **Fix: ordinary `run_code` calls lost the code card.** The keyed `tool.call.toolview` registration for `run_code` **replaces** the host's built-in code row (a keyed slot is a takeover, not an addition), so every non-mirror Code Mode program was rendered by the plugin's fallback wrapper instead of DSH's code card. That wrapper used three classes — `agy-tv-header`, `agy-tv-badge`, `agy-tv-pre` — that carry **no CSS rule at all** in this package or in the host, so the icon, title and copy affordance disappeared and the body rendered as unstyled block text; the program was also silently truncated to 400 characters.
  - Non-mirror programs now render through a new `AgyCodeToolView` that reuses the mirror card's own styled vocabulary (`agy-tv-row`, `agy-tv-leading`, `agy-tv-title`, `agy-tv-sep`, `agy-tv-summary`, `agy-tv-card`, `agy-tv-card-content`, `agy-tv-copy-btn`): tool icon, localized title, `description` (or first program line) as the summary, click-to-expand full program, and a copy button.
  - Mirror wrappers are unaffected: they still delegate to `AgyMirrorToolView`, and the classification is byte-for-byte unchanged.
  - Added `code.title` / `code.inspect` / `code.copy` / `code.copied` to all four locale dictionaries, and declared `locale: NS` on the `run_code` registration so the standard `t` seat resolves them.

### 中文 (Chinese)

- **修复：普通 `run_code` 调用丢失代码卡片。** `run_code` 的 keyed `tool.call.toolview` 注册是**接管**而非叠加，因此每一次非镜像的 Code Mode 程序都落到插件的兜底包装上，而该包装用的 `agy-tv-header` / `agy-tv-badge` / `agy-tv-pre` 三个类在本包与宿主中**都没有任何 CSS 规则**——图标、标题与复制入口消失，正文变成无样式块级文本，程序还被静默截断到 400 字。
  - 非镜像程序改由新的 `AgyCodeToolView` 渲染，复用镜像卡片自身的样式词汇：工具图标、本地化标题、`description`（或程序首行）摘要、点击展开全文、复制按钮。
  - 镜像包装不受影响：仍委托 `AgyMirrorToolView`，分类结果逐字节不变。
  - 四份词典补齐 `code.title` / `code.inspect` / `code.copy` / `code.copied`，并在 `run_code` 注册上声明 `locale: NS`，让标准 `t` 座位解析这些键。

## 0.4.36 (2026-09-18)

### English

- **Fix (issue #30): Windows quota panel empty.** `readSystemKeychainToken()` had no win32 branch; primary credentials live in Windows Credential Manager (`gemini:antigravity`), not a disk token file. Added a PowerShell `CredRead` reader (same zero-dep pattern as macOS `security` / Linux `secret-tool`).
- **Fix: thinking blank after a reply finishes.** The client no longer rewrites React-managed `thinkBody` DOM (that wiped thought text on post-turn re-render). Styling is CSS-only; auto-expand uses the host disclosure control when prose is present.

### 中文 (Chinese)

- **修复 #30：** Windows 额度读取 — 从 Credential Manager 读 `gemini:antigravity`。
- **修复：思考结束后变空** — 不再改写宿主 React 的 thinkBody；仅 CSS + 非破坏性展开。

## 0.4.35 (2026-09-18)

### English

- **Reasoning UI: only show thinking when there is real content.** Empty `[agy thinking turn · N thinking tokens]` chips no longer spam tool-heavy turns. When agy stores only `toolAction`/`toolSummary` (common), those become the visible thought line (e.g. `Searching the web — Search Wo Tianyu profile`). Full CoT prose still renders when present in the conversation DB.

### 中文 (Chinese)

- **思考 UI：** 无正文时不再刷 token 横幅；工具步骤优先展示 `toolAction`/`toolSummary` 作为意图说明；完整思维链仍按 DB 正文展示。

## 0.4.34 (2026-09-18)

### English

- **UI: cleaner tool cards in Code Mode.** When DSH registers `agy_tool`, the bridge now emits native tool-call blocks instead of `run_code` wrappers. Code Mode titles use a human preview (`$ ls · run_command`) instead of `replay agy tool step N`. A `run_code` toolview renders Antigravity cards when the program is still a mirror wrapper.
- **UI: less thinking spam.** Banner-only `[agy thinking turn · N tokens]` chips (no prose) emit at most once per run; turns that extract thought prose still show full reasoning.

### 中文 (Chinese)

- **界面：** Code Mode 下工具卡片更干净；有 prose 的思考仍完整展示，无正文的 token 横幅每轮最多一条。

## 0.4.33 (2026-09-18)

### English

- **Fix: thinking / tool-args invisible for pool accounts.** agy conversation SQLite DBs for isolated accounts live under `~/.dsh/agy-accounts/<id>/.gemini/antigravity-cli/conversations`, not system `~/.gemini`. The reader now searches the run's account home, `GEMINI_CLI_HOME`, system home, and pool account dirs.
- **Fix: `/agy status` could hang the command UI.** Auth probe is now bounded (8s) so command results always return (issue #29 symptom).

### 中文 (Chinese)

- **修复：号池隔离账号看不到思维链/工具参数** — 会话库在账号自己的 HOME 下，读取时会搜索账号目录。
- **修复：`/agy status` 可能挂起导致命令无输出** — 探测加 8s 超时。

## 0.4.32 (2026-09-17)

### English

- **Fix: agy Active Workspace falls back to C-drive scratch (issue #26).**
  - agy ignores process `cwd` for workspace activation; the resolved DSH/session workspace root is now always passed via `--add-dir` (in addition to media staging dirs).
- **Fix: `/agy <subcommand>` treated as plain chat (issue #27).**
  - Registered `input.hint` on the `/agy` command so DSH's composer intercepts `/agy workspace`, `/agy status`, etc. instead of silently falling back to a prompt.
- **Feature (via PR #25): stream full model thoughts** from agy SQLite (protobuf field 20.3) as native reasoning blocks.

### 中文 (Chinese)

- **修复：agy 无 Active Workspace、落到 C 盘 scratch（#26）** — 工作区根目录现在会通过 `--add-dir` 传入。
- **修复：`/agy` 子命令被当普通对话（#27）** — 补上 `input.hint` 声明。
- **特性（PR #25）：** 从 agy SQLite 提取并流式展示完整思维链。

## 0.4.31 (2026-09-17)

### English

- **UI & UX: Align thinking process and tool invocation view with native DeepSeek Harness (DSH) styling.**
  - **Native SVG Icons & Hover Transition (`src/client/toolview.ts` & `src/client/reasoning.ts`)**: Integrated native DSH icons (`IconChevronDownOutline14`, `IconApiOutline14`, `IconCodeOutline16`, `IconEditOutline16`, `IconBrowseOutline16`, `IconSearchOutline16`, `IconCopyOutline16`, `IconCheckOutline14`). Hovering over a row smoothly transitions the leading icon into a downward chevron (`chevronHover`, opacity 0 -> 1), reproducing official DSH micro-interactions.
  - **Tool Row & Card Restyling (`src/client/toolview.ts`)**: Replaced custom boxed badges with native 24px borderless inline rows featuring official running sweep animation (`data-state="run"`). Expanded card includes an interactive header with Cwd, command/path, and a one-click copy button with temporary checkmark feedback.
  - **Scrollable Long Content (`src/client/toolview.ts`)**: Added scrollable bounds (`max-height: 260px` / `280px` with thin scrollbars) for terminal stdout, file edits/diffs, and file viewing, preventing long output from overwhelming the chat stream.
  - **Reasoning Process Presentation (`src/client/reasoning.ts`)**: Adheres to official DSH default collapsed state. Implemented scrollable container (`max-height: 360px`) with slim scrollbars for expanded reasoning thoughts and styled turn metadata into clean tags (`.agy-thought-banner`).

### 中文 (Chinese)

- **界面与交互：深度对齐官方 DeepSeek Harness (DSH) 默认思维链与工具调用展示样式。**
  - **原生 SVG 图标与鼠标悬停动效（`src/client/toolview.ts` 与 `src/client/reasoning.ts`）**：集成官方原生工具图标（`IconChevronDownOutline14`、`IconApiOutline14`、`IconCodeOutline16`、`IconEditOutline16`、`IconBrowseOutline16`、`IconSearchOutline16`、`IconCopyOutline16`、`IconCheckOutline14`）。鼠标悬浮整行时，小图标平滑过渡显示为下拉箭头图标（`chevronHover`，opacity 0 → 1），高度还原官方原生微动效。
  - **工具行与卡片设计还原（`src/client/toolview.ts`）**：移除冗余徽章药丸，还原原生 24px 无边框轻量内联行与运行态扫光动画（`data-state="run"`）；展开卡片包含 Cwd、命令/路径头部与交互式「复制」按钮（带「已复制」反馈与自动复原）。
  - **超长内容滚动浏览（`src/client/toolview.ts`）**：针对终端输出、文件查看与 Diff 代码块增加最大高度限制（`max-height: 260px` / `280px`）与微型细滚动条，避免超长内容撑乱对话流。
  - **思维链正文呈现（`src/client/reasoning.ts`）**：遵循官方默认折叠规范；为展开后的思考过程增加独立滚动浏览区域（`max-height: 360px`）与细滚动条，并将轮次思考元数据美化为轻量圆角标签（`.agy-thought-banner`）。

## 0.4.30 (2026-09-15)

### English

- **Feature: Extract and stream model thoughts/reasoning from agy database.**
  - **Protobuf Field 20.3 Extraction (`src/host/agy-db.ts`)**: Decodes full model Chain-of-Thought (thoughts) from agy SQLite conversation databases (`steps` table, step_type `14`/`15` agent_response) via a deterministic varint protobuf scanner with sub-millisecond execution and zero external dependencies.
  - **Live Streaming Reasoning Card (`src/host/mapper.ts` & `src/host/adapter.ts`)**: Injects resolved thoughts into native DSH reasoning blocks (`reasoning: true`), presenting the structured template `[agy thinking turn · {N} thinking tokens]\n\n{thoughtBody}` for model thinking turns. Supports both eager leading reasoning blocks and deferred trailing blocks without breaking tool spans or text fragments.
  - **Client-Side Auto-Expansion (`src/client/reasoning.ts`)**: Auto-expands reasoning blocks when thoughts prose is present, while strictly respecting manual user collapse actions via DOM attribute tracking.
  - **Run Traceability (`src/host/recording.ts`)**: Persists extracted thought text in `AgyRunRecording` for full lifecycle traceability and replay.

### 中文 (Chinese)

- **特性：从 agy 数据库提取并流式展示完整思维链（Reasoning/Thinking）。**
  - **Protobuf Field 20.3 确定性解码（`src/host/agy-db.ts`）**：针对 agy 会话 SQLite 库（`steps` 表，step_type `14`/`15` agent_response），通过原生 Varint Protobuf 扫描器高性能提取模型完整思考正文（Field 20 -> Sub-field 3），亚毫秒级解析且无额外依赖。
  - **原生 Reasoning 卡片流式呈现（`src/host/mapper.ts` 与 `src/host/adapter.ts`）**：将提取到的思考内容流式推送至 DSH 原生推理卡片（`reasoning: true`），格式化呈现 `[agy thinking turn · *** thinking tokens]\n\n{思维链正文}`；支持前置流式输出与延迟解析补发，与工具步骤及正文片段无缝衔接。
  - **客户端智能展开（`src/client/reasoning.ts`）**：检测到思维链正文时自动展开 Reasoning 卡片，并通过 DOM 属性标记保证用户手动折叠行为不被覆盖。
  - **会话持久化与回放（`src/host/recording.ts`）**：在 `AgyRunRecording` 中记录思维链内容，保障全生命周期可追溯与回放。

## 0.4.29 (2026-09-15)

### English

- **Hotfix: client blank page / `cannot get property "locale" without inject` (issue #24).**
  - 0.4.28 removed `locale` from the client `export inject` list while still reading `ctx.locale`. Cordis treats every inject entry as a hard dependency and throws on undeclared service access, so the web client failed to load.
  - Restored `inject = ['slots', 'locale']`, use `ctx.locale` directly, and mark `@deepseek-ai/dsh-client-locale` as a required peer (shipped with `dsh-web-app`).

### 中文 (Chinese)

- **热修：0.4.28 客户端白屏 / `cannot get property "locale" without inject`（#24）。**
  - 0.4.28 把 `locale` 从 client `inject` 里拿掉却仍访问 `ctx.locale`；Cordis 对未声明服务的属性访问会直接抛错。
  - 恢复 `inject = ['slots', 'locale']`，直接使用 `ctx.locale`，并将 `@deepseek-ai/dsh-client-locale` 标回必选 peer。

## 0.4.28 (2026-09-15)

### English

- **Fix: Long prompts no longer hit Windows `spawn ENAMETOOLONG` (issues #14 / #11).**
  - When assembled argv would exceed a 24KB budget, the bridge drops `-p <prompt>` and feeds the prompt via `--input-format stream-json` on stdin (`{"event":"user","message":{"role":"user","content":...}}`), verified against live agy 1.2.x.
- **Fix: No flashing CMD consoles on Windows GUI hosts (issue #13).**
  - `openBrowser` and pool `open-terminal` / `add` `execFile('cmd.exe', …)` now pass `windowsHide: true`.
- **Fix: Dropped keyword-driven Recovery-boundary prompt injection** (from PR #20). Missing-file guidance stays in `/agy status` only.
- **Fix: Harden agy conversation DB reads.** Conversation ids are whitelist-validated before path join (path-traversal guard).
- **i18n: `@deepseek-ai/dsh-client-locale` is an optional peer.** Older DSH hosts install cleanly; the client falls back to Chinese strings when `ctx.locale` is absent.
- **CI: fork PR workflow approval documented** in `AGENTS.md` (maintainers approve `action_required` runs).
- **Fix: Windows conhost flash from agy itself (issue #23).**
  - Every agy spawn now defaults `AGY_CLI_DISABLE_AUTO_UPDATE=1` and `AGY_CLI_INTERACTIVE_HEADLESS=1` (present in the official binary; breaks the `--bg-updater` child chain that creates visible conhost even under `windowsHide`). Operator-set values win.
  - Boot-time `agy --version` + catalog probe is deferred 4s (unref'd); catalog still refreshes lazily on first model list / turn.

### 中文 (Chinese)

- **修复：长 prompt 在 Windows 上触发 `spawn ENAMETOOLONG`（#14 / #11）。**
  - argv 预算超过 24KB 时改为 `--input-format stream-json` 经 stdin 传入 prompt，协议已在本机 agy 1.2.x 验证。
- **修复：Windows GUI 下 CMD 窗口闪烁（#13）** — 相关 `execFile` 增加 `windowsHide: true`。
- **修复：移除关键词驱动的 Recovery boundary prompt 注入**；missing_file 指引仅保留在 `/agy status`。
- **加固：** agy 会话库 conversation id 白名单校验，防路径穿越。
- **i18n：** locale peer 改为可选，旧宿主可安装；无 `ctx.locale` 时回退中文。
- **CI：** 在 `AGENTS.md` 记录 fork PR 需维护者批准 workflow。
- **修复：Windows 上 agy 自身拉起可见 conhost（#23）。** 所有 agy spawn 默认注入 `AGY_CLI_DISABLE_AUTO_UPDATE=1` 与 `AGY_CLI_INTERACTIVE_HEADLESS=1`（阻断 `--bg-updater`）；启动探测延迟 4s。

### English

- **Feature: Native `agy_tool` Tool Card UI for DSH >= 0.1.5.**
  - **Root cause (verified against DSH 0.1.5-rc.2)**: The browser conversation UI (`@deepseek-ai/dsh-client-ui-tool`) hardcodes card rendering by wire tool name through a lookup table (`TOOL_VARIANTS`: `bash`/`pwsh`→terminal, `write`/`edit`→diff, `read`/`grep`/`glob`→read/search, etc.), and never consults `presentCall`/`presentResult`. The bridge's internal `agy_tool` had no entry, causing every mirrored tool step (`run_command`, `write_to_file`, `replace_file_content`, `view_file`, `grep_search`, ...) to regress to a generic "agy_tool" raw JSON text row.
  - **Fix**: Registered a keyed `tool.call.toolview` extension slot for `agy_tool`, rendering native cards (`terminal`, `diff`, `read`, `search`, `list`, `delete`, `generic`) directly from mirror arguments in pure React with DSH theme CSS variables.
- **Fix: Restore Full Tool Arguments & Real Line Diffs via Agy DB (`replace_file_content` / `write_to_file`).**
  - **Root cause**: agy CLI's `filterToolParameters` strips large arguments (`CodeContent`, `TargetContent`, `ReplacementContent`) from `stream-json`, leaving only metadata like `TargetFile`. Diff cards could not show old vs new line contents.
  - **Fix**:
    - `src/host/agy-db.ts`: Sub-millisecond deterministic protobuf parser directly extracts `tool_name` and full arguments JSON from the agy SQLite conversation database (`~/.gemini/antigravity-cli/conversations/<id>.db`), copying `-wal` and `-shm` sidecars to guarantee WAL commit visibility.
    - `src/host/adapter.ts`: Dynamically resolves `activeConvId` and step index (`parseInt(ev.stepKey, 10)`), pre-resolving full tool args. Incorporates `getGitHeadContent` for `write_to_file` to diff against committed git HEAD on full-file writes.
    - Fixed `readFullToolArgs` cache to reload SQLite DB when newly generated steps are queried, plus added 50ms WAL flush retry.
- **Fix: Tool Span Cutting on Completion When Output Is Omitted in Stream-JSON.**
  - **Root cause**: In `agy stream-json`, file modification tools (`replace_file_content`, `write_to_file`) emit `state: "DONE"` without an `output` field in `tool_info`. `mapper.ts` previously checked `ev.tool.output !== undefined || ev.tool.error !== undefined`, dropping the completion event and causing the tool card to be skipped entirely (falling through to assistant text).
  - **Fix**: Updated `EventMapper` to recognize `ev.state === 'DONE' || ev.state === 'ERROR'`, cutting the span and emitting native `agy_tool` cards even when `output` is omitted. Ensured `toolInfo.error` is populated on `state: 'ERROR'`.
- **UI: Default Collapsed State, Content Previews, Badges, and Semantic Diff Styling.**
  - **Default Collapsed**: Tool cards now default to collapsed state (`useToggle(false)`), keeping the conversation stream neat and compact.
  - **Content Preview**: Collapsed cards display a concise one-line preview in the header (e.g. `± demo/old.txt` for edits, `+ demo/old.txt` for writes, first line of terminal output, search queries).
  - **Header Badges**: Added card kind badge (`[diff]`, `[terminal]`, etc.) and wire tool name badge (`[replace_file_content]`, `[run_command]`, etc.) beside the title.
  - **Body Output Caption**: Added an uppercase **输出** (OUTPUT) label caption above the output content in the expanded card body.
  - **Line Diff Styling**: Line diffs format relative paths (`Edit demo/old.txt`), bold red deletion markers (`-`) on red background, and bold green addition markers (`+`) on green background.
  - **Reliable Toggle**: Replaced raw `useState` setter with `makeToggle(setValue)` to ensure infinite multi-click collapse/expand reliability.
- **Test Suite**: 22 new unit tests across `test/toolview.test.ts`, `test/agy-db.test.ts`, and `test/mapper.test.ts`. 173/173 tests passing.

---

### 中文 (Chinese)

- **新特性：适配 DSH >= 0.1.5 的 `agy_tool` 原生工具卡片 UI**
  - **根因分析（针对 DSH 0.1.5-rc.2 前端验证）**：DSH 浏览器对话界面（`@deepseek-ai/dsh-client-ui-tool`）通过硬编码变体表（`TOOL_VARIANTS`）按 wire tool name 渲染卡片，且未消费 `presentCall`/`presentResult`。桥接内部镜像工具 `agy_tool` 未在表中，导致所有工具调用（`run_command`、`write_to_file`、`replace_file_content`、`view_file`、`grep_search` 等）均退化为带有原始 JSON 参数的通用文本行。
  - **修复方案**：为 `agy_tool` 注册专有的 keyed `tool.call.toolview` 扩展槽，直接基于镜像参数渲染高仿生的原生卡片（终端 `terminal`、代码对比 `diff`、阅读 `read`、搜索 `search`、列出目录 `list`、删除 `delete`、通用 `generic`），完全使用原生 React 与 DSH 主题 CSS 变量实现。
- **修复：通过 Agy 会话数据库恢复完整工具参数与真实代码 Diff（`replace_file_content` / `write_to_file`）**
  - **根因分析**：`agy` CLI 在输出 `stream-json` 时通过 `filterToolParameters` 过滤掉了大参数字段（`CodeContent`、`TargetContent`、`ReplacementContent` 等），导致前端 Diff 卡片仅能拿到 `TargetFile`，无法展示旧行与新行的代码变更。
  - **修复方案**：
    - `src/host/agy-db.ts`：实现确定性亚毫秒级 Protobuf 解析器，直接从本地 SQLite 会话库（`~/.gemini/antigravity-cli/conversations/<id>.db`）精准提取完整 JSON 参数，并拷贝 `-wal` 和 `-shm` 侧车文件以保证 WAL 提交完全可见。
    - `src/host/adapter.ts`：动态获取 `activeConvId` 与真实的步骤索引（`parseInt(ev.stepKey, 10)`），提前异步解析全量参数；并在 `write_to_file` 时结合 `getGitHeadContent` 读取已提交的 Git HEAD 内容进行整文件 Diff 比对。
    - 修复 `readFullToolArgs` 缓存：当查询会话后续新增的步骤时重新读取数据库，并加入 50ms WAL 刷盘重试容错。
- **修复：解决 stream-json 中工具完成无 output 时卡片截断丢失问题**
  - **根因分析**：在 `agy stream-json` 中，文件修改与写入工具（`replace_file_content`、`write_to_file`）在 `state: "DONE"` 时 `tool_info` 不输出 `output` 字段。原 `mapper.ts` 检查 `output !== undefined` 导致该完成事件被丢弃，卡片从未触发截断派发，直接滑入了后续助手正文。
  - **修复方案**：更新 `EventMapper` 完成判断，支持 `state === 'DONE' || state === 'ERROR'`，确保无输出工具亦能正常截断并生成原生工具卡片。
- **界面优化：默认折叠状态、单行内容预览、卡片双徽章与高亮 Diff 呈现**
  - **默认折叠**：工具卡片默认初始为折叠状态（`useToggle(false)`），保持对话流整洁紧凑，点击卡片头部即可展开查看输出。
  - **单行内容预览**：折叠状态下在头部展示单行内容摘要（如 Diff 显示 `± demo/old.txt` 或 `+ demo/old.txt`，终端显示首行输出，只读显示文件路径等）。
  - **双标签徽章**：卡片头部展示卡片类型徽章（如 `[diff]`、`[terminal]`）与工具原始名（如 `[replace_file_content]`、`[run_command]`）。
  - **正文输出标题**：卡片正文区域增设大写 **输出**（OUTPUT）标签标题。
  - **Diff 高亮呈现**：标题展示相对工作区路径（`Edit demo/old.txt`），删除行带有加粗红底 `-`，新增行带有加粗绿底 `+`。
  - **展开/折叠防死锁**：修复 `useToggle` 在无参调用时触发 `setState(undefined)` 导致折叠后无法再次展开的缺陷，封装为纯函数 `makeToggle` 保证多轮点击稳定翻转。
- **测试套件**：新增 22 个单元测试用例，涵盖 `test/toolview.test.ts`、`test/agy-db.test.ts` 与 `test/mapper.test.ts`，173 个测试全部通过。

---

## 0.4.27 (2026-09-11)

- **Fixed: Windows binary discovery misses the official Google installer path (Issue #7).**
  - `resolveAgyBin()` now probes `%LOCALAPPDATA%\agy\bin\agy.exe` (plus `.cmd`/`.bat` siblings and the WinGet Links shim), so installs via `irm https://antigravity.google/cli/install.ps1 | iex` no longer raise `AGY_NOT_INSTALLED` when PATH has not propagated to the GUI process.
- **Fixed: Quota unavailable on Linux (Issue #8).**
  - Added `readLinuxSecretToken()`: the primary account's OAuth credential is now read from the FreeDesktop Secret Service (GNOME Keyring / KDE Wallet) via `secret-tool`, with a python3-dbus fallback — the same `service="gemini" / username="antigravity"` go-keyring slot agy writes on Linux.
  - `QuotaService.readSystemKeychainToken()` now dispatches per platform (darwin → Keychain, linux → Secret Service), restoring quota refresh on Linux where no on-disk token file exists.
  - Shared go-keyring payload parsing (raw or `go-keyring-base64:` prefixed JSON) extracted into `parseGoKeyringPayload`.

## 0.4.26 (2026-09-07)

- **Added: Support for `gemini-3.8-flash` in Fallback Models Catalog (Issue #6).**
  - **Root cause**: `DEFAULT_FALLBACK_MODELS` defined in `src/common/types.ts` had not been synced with Google's latest model line-up, stopping at `gemini-3.7-flash`. When DSH booted or ran offline prior to dynamic `agy models` discovery, `gemini-3.8-flash` was missing from the model picker.
  - **Fix**: Added `{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] }` to `DEFAULT_FALLBACK_MODELS`.
- **Fixed: Client Bundle `process is not defined` (PR #5 / realguan).**
  - In `tsdown.config.ts`, marked `react-dom` and `react/jsx-runtime` as external dependencies for client bundling (`platform: "browser"`), preventing development React runtime from being inlined into `dist/client.js` and eliminating browser `ReferenceError: process is not defined`.
- **Hardened: Test Suite Stability & Debounce Timing on macOS.**
  - Relaxed duplicate submission debounce window in `AgyAdapter` to 10,000ms with automatic size-capped map pruning, and adjusted test thresholds to account for cold Node subprocess spawning latency on macOS. All 151 unit tests passing.

## 0.4.25 (2026-09-04)

- **Fixed: Plugin Startup Blocker on DSH >= 0.1.1-rc.x / 0.1.2-rc.1 (`missing export 'CallId'`, issue #4).**
  - **Root cause**: Newer `@deepseek-ai/dsh-llm` versions (e.g. `0.1.2-alpha.1` ~ `0.1.2-rc.1`) renamed `CallId` to `ToolCallId`. A named import `import { CallId } from '@deepseek-ai/dsh-llm'` caused Node ESM static resolution to fail at startup with `The requested module '@deepseek-ai/dsh-llm' does not provide an export named 'CallId'`, surfacing as a plugin load failure on DSH Desktop 2.0.5 and CLI.
  - **Fix**: Replaced named import with a namespace fallback resolution `toToolCallId = dshLlm.ToolCallId ?? dshLlm.CallId ?? identity`. This avoids missing named export evaluation errors and ensures seamless backwards and forwards compatibility across all DSH host versions.
  - **Ecosystem & Test Hardening**: Upgraded development dependencies to `@deepseek-ai/dsh-*@0.1.2-rc.1`. Configured `--test-concurrency=1` in test runner to prevent mock environment variable collisions across concurrent subprocess tests, achieving 100% pass rate across all 151 unit tests. Verified live startup with DSH 0.1.2-rc.1 and `dsh-lark-link`.

## 0.4.24 (2026-08-28)

- **Fixed: Antigravity Models Missing From Picker When Logged In (已登录/显示余量但模型列表不显示 — issue #1).**
  - **Decoupled Adapter Registration from Synchronous Binary Discovery**: `registerAdapter` now executes regardless of initial `bin()` probe results (using resilient fallback model catalog), ensuring the Antigravity provider is never dropped during startup even if CLI path resolution is deferred.
  - **Expanded macOS / Linux GUI App Path Discovery**: extended `resolveAgyBin` search candidates to include `~/.bun/bin`, `~/.cargo/bin`, `~/.local/share/pnpm`, `~/Library/pnpm`, `~/.yarn/bin`, `~/.npm-global/bin`, NVM (`~/.nvm/versions/node/*/bin`), FNM, Volta, ASDF shims, Linuxbrew, etc., fixing GUI desktop apps starting with minimal default system PATH.
  - **Account-Aware Model Discovery & Environment Isolation**: model discovery now inherits current active/primary account isolated environment and proxy settings, falling back across ready pool accounts if default system HOME is unauthenticated.
  - **Defensive Model & Effort Sanitization**: defensive catalog cleaning against empty IDs, blank names, empty reasoning effort arrays, and out-of-bounds `defaultEffort` to strictly satisfy DSH host validation and prevent fail-all provider group drops (`INVALID_CATALOG` / `INVALID_MODEL_*`).
  - **Cross-Platform & Unit Tests**: added defensive catalog normalization and explicit binary path resolution tests across test suites.

## 0.4.23 (2026-08-27)

- **Enhanced: Antigravity Tool Mirroring with Native Git +/- Diff Cards & Full Tool Vocabulary.**
  - **Tool Vocabulary & Parameter Mapping**: mapped agy's official editing tool `replace_file_content` (`TargetFile`, `TargetContent`, `ReplacementContent`, `Description`, `Instruction`) and write tool `write_to_file` (`TargetFile`, `CodeContent`, `Overwrite`, `Description`) to DSH native `DiffCallView` / `DiffResultView` cards.
  - **Git Head Base Line Diffing**: added cross-platform `getGitHeadContent` to retrieve committed file content for full-file writes (`write_to_file`), allowing DSH to render line-by-line git `+`/`-` additions and deletions rather than treating existing modified files as blank new files.
  - **Expanded Tool Support**: mapped `view_file` (with `AbsolutePath`/`StartLine` line location navigation), `grep_search`, `find_by_name`, `ask_question`, `read_url_content`, and `generate_image` onto their respective native/generic tool cards with descriptive titles.
  - **Cross-Platform Hardened**: path normalization with forward-slash compatibility across Windows/macOS/Linux, `windowsHide: true`, strict subprocess timeout, and safe error fallback.

## 0.4.22 (2026-08-27)

- **Fixed: `registration.adapter.prepareCall is not a function` on new DSH hosts (本轮运行失败 UNKNOWN).**
  - **Field report**: after upgrading the DSH host (manjh's source checkout), every turn failed immediately with `registration.adapter.prepareCall is not a function` — category UNKNOWN in the GUI, no reply at all.
  - **Root cause (interface drift)**: dsh-llm >= 0.1.1-rc.2 added `LlmAdapter.prepareCall(provider, model, signal)` and `LlmRuntime.prepareCall()` now calls `registration.adapter.prepareCall(...)` **unconditionally** (both the prepared-call path and the direct `adapterStream` path). The plugin's devDependency pinned `@deepseek-ai/dsh-llm ^0.1.0-rc.6` (base class without `prepareCall`); when the plugin's adapter class resolved an older dsh-llm copy than the host runtime, `registration.adapter.prepareCall` was `undefined` and every turn threw a bare TypeError.
  - **Fix**: `AgyAdapter` now implements `prepareCall` explicitly, returning `{ model: await this.resolveModel(...), stream: options => this.stream(options) }` — the exact one-generation capability-bound handle the new runtime expects (same shape as the base default, but present regardless of which dsh-llm copy the plugin resolves). Backward compatible: runtimes < 0.1.1-rc.2 never call it. The method is declared structurally (no `override` / new-type import) so the plugin keeps typechecking against dsh-llm `^0.1.0-rc.6` and the repo's `npm ci` peer resolution stays intact; the runtime contract matches the 0.1.1-rc.2 `PreparedAdapterCall` shape.
  - Regression test pins the contract end-to-end: `prepareCall` returns resolved model metadata (id/provider/defaultMaxTokens) plus a stream that runs a full fake turn.

## 0.4.21 (2026-08-27)

- **Fixed: Silent `agy exited with code 1` Hid the Real Cause (发送消息无回复、只见 exit 1).**
  - **Field report**: a user session log showed every turn failing with the bare message `agy exited with code 1` (code PROCESS_EXIT, empty stderr, zero tokens) — each attempt ran ~7–10s, failed once, retried once, failed again, and the UI never surfaced WHY (no reply text at all).
  - **Root cause of the blindness (verified live against agy 1.1.22)**: agy reports its failure as a `result` envelope on **stdout** (`{"event":"result",...,"status":"ERROR","error":"<human-readable reason>"}`) and exits 1 with EMPTY stderr — e.g. an invalid model/effort pairing fails instantly with `--model gemini-3.7-flash requires --effort (available: low, medium, high)`. The adapter's non-zero-exit branch dropped that envelope entirely: rate-limit-shaped errors were still classified (the classifier already read `lastResultError`), but any OTHER failure degraded to the bare exit-code line with no cause.
  - **Fix**: the PROCESS_EXIT failure message now prefers the stdout envelope's error text (falling back to the stderr tail). Same error code and retry policy; users finally see agy's own reason, e.g. `agy exited with code 1: upstream request failed while generating` or `…: --model gemini-3.7-flash requires --effort (available: low, medium, high)`.
  - **Diagnostics unaffected**: `/agy doctor` (`~/.dsh/agy-link/diagnostics/doctor-*.md`) still carries the full redacted raw stdout tail for deeper incidents.
  - Regression test pins the exact silent-failure shape (stdout envelope + exit 1 + empty stderr) via a new `exit-error` fake-agy mode.

## 0.4.20 (2026-08-27)

- **Fixed: Primary Account Quota Fetched With a STALE Token (主账号刷新/同步拿的值不对).**
  - **Root cause (verified live)**: on macOS, agy >= 1.1.15 keeps its CURRENT credential in the Keychain; the on-disk `antigravity-oauth-token` was a stale leftover from a PREVIOUS account's login. `getStoredToken` read the disk file FIRST and only fell back to the Keychain — so every 刷新/同步 used the old account's (still-valid) token and displayed ITS quota under the current login's name (observed: agy authenticated as q98… while the disk file still held elegantmanco's token; UI showed the wrong account's 5h/weekly numbers).
  - **Keychain-first token resolution**: for the primary / system-HOME account the Keychain credential now WINS over the on-disk file (disk remains the fallback for older agy builds and non-mac systems). Isolated pool accounts are pinned by test to never touch the shared Keychain. Verified end-to-end against live Google endpoints: the primary's token identity and quota now match the actual agy login (5h 91% / weekly 31% instead of the stale account's numbers).
  - **Token-anchored identity on manual refresh**: `refreshAccountQuota(force=true)` additionally calls the OAuth userinfo endpoint once per explicit user click and re-labels the slot to the token's TRUE owner (`resetAccountIdentity`), so an external `agy logout` + re-login self-heals in one click even when logs disagree.
  - **Log detection hardened**: `detectEmailFromAgyLogs` returns the LAST match per file (append-ordered logs → newest login wins), fixing first-match returning a superseded account.
  - **Risk posture preserved**: background polls (force=false) still NEVER call userinfo — zero extra network on the automatic path (pinned by a regression test).

## 0.4.19 (2026-08-26)

- **Fixed: Antigravity Models Missing From the Model Picker (登录成功、额度正常但模型列表为空 — issue #1).**
  - **Root cause**: when `agy models` lists a bare Gemini base alongside its effort variants (the agy 1.1.13 output shape, e.g. `gemini-3.7-flash` + `gemini-3.7-flash-medium`), `foldEfforts` emitted the base id TWICE — once as the folded base entry and once as a verbatim row. DSH's `llm.listModels` contract throws `INVALID_CATALOG` on any duplicate model id, and the host's model-catalog builder then drops the ENTIRE Antigravity provider group from the picker — so login and quota panels looked perfectly healthy while no Antigravity model could be selected.
  - **Fix (three layers)**: (1) `foldEfforts` now absorbs the bare base into its folded entry instead of duplicating it; (2) `parseModelsOutput` dedupes repeated raw slugs (first occurrence wins); (3) `AgyAdapter.listModels` dedupes ids as a final guard, so even a user-configured `fallbackModels` list containing repeats can never nuke the whole group.
  - Regression tests pin both bare-base-plus-variants shapes and the duplicate-slug parse, plus an adapter-level uniqueness guard test.
  - **Observability**: when the adapter-level guard drops duplicate ids it now logs which ids were removed (`model catalog contained duplicate ids [...]`) so field instances surface in DSH server logs instead of being silently masked. When reporting picker issues, attach the `/agy doctor` report (`~/.dsh/agy-link/diagnostics/doctor-*.md`) and the raw `agy models` output.

## 0.4.18 (2026-08-25)

- **Quota Fallback Never Clobbers Good Data (5h=100%/weekly-missing 根因).**
  - **What happened**: `retrieveUserQuotaSummary` transiently failed (proxy blip) while `fetchAvailableModels` still answered; the per-model fallback then OVERWROTE the stored family entry with a single-window partial shape — weeklyFraction vanished and the 5h row received wrong-window numbers (observed 5h=100%, reset a week out, weekly `—`, while the live API actually reported 5h 84% / weekly 47%).
  - **`mergeFallbackFamilyQuota`**: last-known-good complete family data now always wins over partial fallback; the fallback only fills families with no usable previous entry (first-ever refresh). Verified live: both endpoints answer correctly and a successful summary refresh fully restores the display.
  - Added `scripts/diag-quota.mts` one-shot endpoint probe for future incidents.

## 0.4.17 (2026-08-25)

- **Ghost-Cooldown & Quota-Display Fix (额度显示 0% 根因).**
  - **What happened**: the UI showed 5h quota as 0% while `agy` reported 98% — the parsed quota data was CORRECT all along, but (a) any active local cooldown forced the 5h bar to render 0%, and (b) the loose rate-limit classifier kept creating ghost cooldowns: it scanned the ENTIRE stdout (model prose mentioning "rate limit"/"quota", hash fragments containing "429") and matched bare keywords, so an unrelated tool/permission error froze a healthy account out of rotation with a 15-minute+ cooldown (captured real reason: `rate limit reached: declaring permissions: cortex tool write_to_file … invalid tool call error`).
  - **Hard vs soft classification**: new `looksLikeHardRateLimit` (RESOURCE_EXHAUSTED / code·status·HTTP 429 / too many requests / individual quota reached / quota exceeded·reached·exhausted / rate limit exceeded·reached·hit) is the ONLY pattern allowed to put an account into cooldown; soft signals (model overloaded / high traffic) still shape the error message but never cool accounts.
  - **Scan scope narrowed**: error classification reads stderr + the result envelope's error field only — stdout (event JSON + model prose) no longer participates.
  - **Honest quota bars**: a local cooldown no longer overwrites the server-reported fraction with 0%; it now appends a `· 本地冷却中` note next to the reset time instead.
  - Regression tests pin the exact incident text (cortex tool permission error) as a non-rate-limit fixture.

## 0.4.16 (2026-08-24)

- **External Re-Login Sync (换号自动/手动同步).**
  - **Root cause fixed**: after `agy logout` + re-login as a DIFFERENT account, the pool slot kept the old account's email, cooldowns, quotas and `auth_required` quarantine — and poll gating (0.4.15) then skipped the flagged slot forever, freezing the UI on the stale account.
  - **`resetAccountIdentity`**: detecting a changed email (from local CLI logs, zero network) now resets all identity-bound state (cooldowns / quotas / auth quarantine) while keeping slot config — the new account starts clean instead of inheriting the old one's restrictions.
  - **Zero-network reconciliation before poll gating**: the background poller pre-checks flagged slots via local log scan, so an external re-login self-heals within one poll cycle (≤15 min) without any extra request to Google. Manual click is instant.
  - **Auth self-heal on success**: a successful authenticated quota fetch clears a stale `auth_required` flag (the old token's invalid_grant no longer condemns the new login).
  - **Manual refresh upgrades**: the 刷新 button now also re-reads the model catalog (one `agy models` spawn per explicit click only — new subscription tier may expose different models), and every account card gains a 同步 button for single-account refresh.
  - **Primary slot always re-bootstrapped (real root cause of "UI stuck on old account")**: the primary slot was only created for an EMPTY pool, so once deleted it never came back while other accounts remained — the system-HOME login (e.g. after `agy logout` + re-login) had no slot to attach to and the UI kept showing an isolated account as 主账号. The slot is now recreated at the front on every load; deleting it no longer promotes an isolated account to primary. Disable the slot instead of deleting if unwanted.

## 0.4.15 (2026-08-24)

- **Quota Polling Risk-Exposure Minimization (root-cause follow-up).**
  - **Poll Interval 5min → 15min (configurable)**: New `quotaPollIntervalMs` config (env `DSH_AGY_QUOTA_POLL_INTERVAL_MS`, clamped to >= 60s) cuts background `v1internal` polling volume by 3x — the poller was the last remaining high-frequency network surface after the CLI-level hardening.
  - **Restricted-Account Poll Gating**: Automatic polling now skips disabled, auth-quarantined (`invalid_grant`) and 429-cooldown accounts (`shouldPollAccount`), so the poller never keeps probing Google endpoints for accounts already known to be limited. Manual UI force-refresh still refreshes everything.
  - **Userinfo Endpoint Called Only When Email Unknown**: The primary account previously hit the OAuth userinfo endpoint on every poll cycle just to detect account switching; that detection now rides the local log scan (`detectEmailFromAgyLogs`, zero network), eliminating one network call per cycle.

## 0.4.14 (2026-08-24)

- **Hardened 429 Rate Limit Cooldown & Circuit Breaker (Anti-Risk Control).**
  - **Accurate Reset Duration Parsing**: Added `parseResetDurationMs` to accurately extract server reset countdowns from strings like `"Resets in 21m25s"`, `"Resets in 2h26m6s"`, `"Resets in 45s"`, or verbose duration phrases.
  - **Safety Cooldown Buffer**: Account failures on 429 now automatically apply the parsed reset duration + a 10s safety buffer (or a 15-minute minimum backoff), preventing accounts from re-triggering rate limiters at the exact millisecond of reset.
  - **Non-Retryable 429 Classification**: Identified 429 / quota exhaustion errors from stderr / stdout and classified them as non-retryable `Err.AGY_ERROR` instead of `Err.PROCESS_EXIT`, stopping DSH from executing automatic rapid retries on exhausted accounts.
- **Organic Spacing Jitter, In-Flight Debounce & Burst Protection.**
  - **Human-like Timing Jitter**: Added randomized timing jitter (`+100ms ~ 400ms`) on top of the 500ms single-account throttle to produce natural non-periodic traffic distributions that evade automated queue detection.
  - **In-Flight Session Debounce**: Rejects identical prompt submissions within a 3-second window while an existing request is active (`Err.BUSY`), preventing frontend repeat loops and double-clicks from hammering the backend.
  - **Sliding-Window Rate Limiter**: Added configurable `rateLimitPerMinute` protection across all sessions to prevent runaway `/goal` autonomous loops from draining daily quotas.
- **Account Health Quarantine & Self-Healing.**
  - **Invalid Grant Quarantine**: Automatically detects `invalid_grant` / revoked OAuth tokens during refresh and flags the account as `auth_required`, immediately taking it out of pool selection and alerting the user in UI.
  - **Visual Health Dashboard**: Added red alert badges (`需重新登录`) and health indicators on account cards.
  - **Automatic Fallback Model**: Supports `autoFallbackModel` to smoothly route requests to available lower-tier models when high-tier models are exhausted.
- **System Hygiene & Telemetry Minimization.**
  - **Telemetry Opt-out**: Injected telemetry suppression flags (`DO_NOT_TRACK`, `DISABLE_TELEMETRY`) into child process environments to reduce unnecessary background event tracking to Google `cclog`.
  - **Automated Old Log Purge**: Added `sweepOldLogs` on plugin boot to automatically sweep CLI log files older than 7 days across system and isolated account directories.

## 0.4.13 (2026-08-21)

- **Fixed Multimodal Image Attachment Staging & Direct Disk Fallback.**
  - **Dynamic Attachment Service Lookup**: Fixed Cordis proxy boundary issue where `(ctx as any).attachments` evaluated to `undefined` when not statically declared in `inject`; now resolves via `ctx.get('attachments')`.
  - **Local Storage Direct Disk Fallback**: Added direct fallback to read from DSH's local content-addressed storage (`~/.dsh/attachments/v1/objects/<prefix>/<id>`), guaranteeing 100% reliable image byte extraction even if service bindings are uninitialized.
  - **Explicit Vision Tool Directives**: Enhanced prompt staging lines to explicitly reference the `view_file` tool and absolute file path (`[image attached: "..." staged at ... Inspect it using the view_file tool with AbsolutePath: "..."]`), ensuring `agy` proactively inspects attached images even when the user sends an image without accompanying text.

## 0.4.12 (2026-08-21)

- **Adaptive Tool Dispatch for Both Standard / Native Mode and Code Mode.**
  - Dynamically inspects `options.tools` on each model stream call.
  - In **Code Mode** (`run_code` present in tools list): emits `run_code` program wrapping `tools['agy_tool'](...)` to conform to code-mode dispatch rules.
  - In **Standard / Native Mode** (`agy_tool` / normal tools present): emits `agy_tool` directly with structured cursor arguments, eliminating `unknown tool "run_code"` and `unknown tool "agy_tool"` errors across all preset modes.
- **Fixed Primary Account Stale Token & Quota Sync on macOS Keychain.**
  - `agy` 1.1.15+ on macOS persists active login credentials via `go-keyring` in the macOS Keychain (`service: "gemini"`, `account: "antigravity"`), leaving stale files in `~/.gemini/antigravity-cli/antigravity-oauth-token` when users switch accounts outside DSH.
  - Added `readMacKeychainToken` to decode active `go-keyring-base64` credentials directly from macOS Keychain for the primary/system account.
  - Live quota & user profile (`fetchUserInfo`) now always read the active Keychain token, immediately detecting account switches and syncing the correct email and quotas.
- **Auto-Invalidate Conversation Binding on Model Switch.**
  - Switching models in the same DSH session now automatically drops the old agy `conversationId` binding, ensuring the prompt immediately executes with the new model without being locked to old agy conversation state.

## 0.4.11 (2026-08-21)

- **Fixed `Error: unknown tool "agy_tool": only run_code is callable directly` in DSH Code Mode.**
  - Restored the `run_code` wrapper dispatch (`WRAPPER_TOOL_NAME` + `buildMirrorRunCode`) for span cuts.
  - Under DSH's default Code Mode (`agent-presets: default: code`), model-direct tool calls are collapsed unless addressed to `run_code`. Wrapping the mirror invocation in `run_code` allows internal sub-dispatch to `agy_tool` to replay recorded events without being blocked by DSH's dispatch guard.

## 0.4.10 (2026-08-21)

- **Fixed `Error: unknown tool "run_code"` loop (Root Cause).**
  - Standard DSH agents and WebUI run direct tool dispatch without Code Mode runner (`run_code`). Emitting span cuts addressed to `run_code` triggered `ToolNotFoundError: unknown tool "run_code"` and trapped agy in an infinite error loop.
  - Span cuts now directly emit `agy_tool` tool-call blocks, which execute instantly and render native tool cards (Terminal, Diff, Read, Search).
- **Emphasized System Proxy & TUN Mode Requirements in README.**
  - Added prominent warnings and configuration instructions for system proxy, TUN mode, and environment variables (`HTTPS_PROXY`) required for Google connectivity in restricted regions.

## 0.4.9 (2026-08-20)

- **Theme-Adaptive System & High-Contrast Typography.**
  - Dynamic adaptation to DSH light and dark themes (`body[data-ds-dark-theme]` / `[data-theme="dark"]` / system preferences) across all UI elements (Settings section, header status badge `AGY (n)`, and modal console dialog).
  - High-contrast text & palette tuning: replaced hardcoded dark backgrounds and pale/white text with responsive semantic tokens, ensuring crystal clear legibility in light mode without washed-out or invisible text.
  - Redesigned quota bars, status pills, submodel breakdown rows, buttons, segment toggles, OAuth dialogs, and alert banners with theme-adaptive contrast.

## 0.4.8 (2026-08-20)

- **Pure SVG UI icon system (zero emojis).** Replaced tacky unicode emojis across the UI (trash can, star, plus, refresh, globe, mail, zap, alert, chevrons, close buttons) with clean, crisp, Lucide-style vector SVG icons for a professional developer experience.
- **Accurate quota window display & weekly lockout aggregation.**
  - Quota bars and breakdown rows now display clear window badges (`5h 滚动` / `周限额`) and time countdowns (`↻ 15:46 (4h36m)`).
  - Fixed family quota aggregation: bottleneck model selection now correctly binds the family `resetTime` to the bottleneck model with the lowest `remainingFraction` (and picks the furthest reset on tie), ensuring 7-day weekly rate limits are faithfully preserved and displayed.


- **Mid-turn steer preemption.** DSH claims a steered ("插话") message at the next step boundary and opens a NEW stream() call; the previous run's agy process used to stay alive and keep appending to the SAME conversation concurrently. The adapter now tracks the in-flight run per session and aborts it before starting the steered run (auxiliary calls neither preempt nor get tracked).
- **UI simplification.** Sidebar bottom-left shortcut removed (the console modal now lives on the header `AGY (n)` badge); quota rows are percent-first — brand logo + bar + `85%` + `↻ 14:44 · 3h12m` — with language-neutral `5h`/`7d` window badges and all Chinese status words (`充足/紧张/适中/未知`) dropped.

## 0.4.6 (2026-08-20)

- **Fixed premature context compaction (root cause).** agy's `result` envelope reports CONVERSATION-CUMULATIVE usage (input 3.8M / cacheRead 72M in the wild), while `step_update` usage is per-call (true current context). DSH's token meter treats the last sample as context occupancy, so forwarding the cumulative envelope exploded pressure past the 80%-of-1M threshold within a few turns and fired constant compactions. The mapper now reports the last per-call step sample (tracked on the shared run recording, span-safe); falls back to the envelope only when no step carried usage.
- **Quota windows + model logos in the UI.** Per-family bars now carry official Gemini / Claude / OpenAI brand SVG marks, a 5小时额度/周额度 window badge (inferred from reset distance), and a live reset countdown; per-model breakdown rows stay available on expand. Removed the verbose mechanism-explainer block.
- **Unified browser login everywhere.** `/agy auth` now runs the same PKCE + loopback-callback flow as the pool's add-account (new `PoolAuthFlow.beginPrimary()` writing agy-format tokens into the real HOME); the QR/code-paste-first copy is gone from README and command help. Primary flows never touch staging cleanup.
- **README refresh.** Install/login instructions match the browser flow; new References section (CLIProxyAPI, opencode-antigravity-auth, OmniRoute, pi-mono).

## 0.4.5 (2026-08-20)

- **Fixed Quota Display (Root Cause).**
  - agy ≥ 1.1.15 writes the token file in a NESTED shape (`{"token": {...}, "auth_method": "consumer"}` with ISO-8601 string expiry); the old flat parser read the nested `token` object as the access token string, producing `Authorization: Bearer [object Object]` → every quota fetch failed 401 → the UI permanently showed a fake `100% 充足`.
  - `normalizeStoredToken` now handles nested + flat shapes, ISO/epoch-second/epoch-ms expiries, and rejects non-string access tokens.
  - Token refresh now works out of the box via the public Antigravity client credentials (env-overridable with `AGY_CLIENT_ID`/`AGY_CLIENT_SECRET`), and quota fetch walks the verified 4-endpoint fallback order (daily → prod → daily-sandbox → autopush).
  - All Node-side Google calls now go through `src/host/net.ts` (undici's own fetch + EnvHttpProxyAgent): Node's built-in fetch ignores `HTTP(S)_PROXY`, and mixing an external undici dispatcher into it throws `UND_ERR_INVALID_ARG` — both silently failed every call behind a proxy. Per-account `proxyUrl` wins over env.
  - The client renders an explicit grey `— 未知` state when no quota data exists instead of a fake 100%.
  - Background quota refresh every 5 minutes (token-file reads only — no agy spawns, no Keychain prompts).
- **Rebuilt Add-Account OAuth (Root Cause).**
  - The old flow scraped a login URL out of `agy -p ping` print mode; agy ≥ 1.1.15 never prints one when logged out, so the probe timed out after 20s and the route STILL returned `ok:true` — the UI claimed "浏览器已调起" while no browser ever opened, leaving a stuck `auth.phase='ok'` and orphaned `staging_*` dirs.
  - New self-owned flow (`src/host/oauth.ts` + `src/host/pool-auth.ts`): PKCE + public Antigravity client credentials + loopback callback listener on `http://localhost:51121/oauth-callback` (the redirect registered for the Antigravity client), browser opened server-side. The authorization code is captured automatically — no manual pasting; paste of a bare code or the full callback URL remains as fallback.
  - Tokens are written in agy's own on-disk format into the account's isolated HOME, so the official agy binary is immediately signed in for that account; email is resolved via userinfo and quota refreshed on commit.
  - Failures now return `ok:false` with the real reason; staging dirs are cleaned on failure/cancel, and stale `staging_*` dirs are swept at boot.
- **Fixed "cannot add a second account".** The server holds the `done` auth status for 30s so pollers can observe it; reopening the add-account panel inside that window replayed the previous success toast and closed the panel instantly. The client now only reacts to `done`/`failed` for a flow actually started from the current panel session.
- **Cross-Platform Hardening.**
  - Windows account isolation actually works now: `isolatedHomeEnv()` sets `USERPROFILE`/`HOMEDRIVE`/`HOMEPATH` alongside `HOME` — Node (libuv) and Go ignore `$HOME` on Windows, so secondary accounts previously shared the real user profile there. Applied to the adapter, the auth probe, and the terminal-login routes.
  - Windows browser open no longer breaks on the OAuth URL's `&` query separators (pre-quoted `cmd /d /s /c start "" "url"` with verbatim arguments).
  - Quota `User-Agent` now reflects the real platform/arch instead of a hardcoded `darwin/arm64` fingerprint.
  - Token file writes are mode-0600 on POSIX and safely skipped on Windows.
- **Fixed Settings Flicker (Residual).**
  - v0.4.3 removed the per-poll re-render; the remaining flash came from the settings modal unmounting the section on close — every reopen rendered a misleading amber "待认证" empty state until the first poll landed. A module-level status cache now seeds the first render instantly.
  - Removed the 2s pulse animation on status dots (static dots; color still conveys state) and added a fixed-height skeleton for the first-ever load.

## 0.4.3 (2026-08-20)

- **Eliminated macOS Keychain Prompts ("Antigravity Safe Storage").**
  - Removed periodic `agy models` process spawns from the high-frequency `/plugins/agy-link/status` endpoint.
  - The status endpoint now serves instantaneous cached state in 0ms, preventing macOS Gatekeeper / Security daemon from triggering keychain dialogs or access errors in background sessions.
- **Fixed UI Flickering & Re-render Thrashing.**
  - Implemented payload hash/equality checks before setting state in the React hook, completely eliminating re-render flashing during polling.
  - Cleaned up duplicated definitions in the client bundle.
- **Fixed Quota Percentage Display.**
  - Properly unified remaining quota percentage rendering for Gemini, Claude, and GPT-OSS families across all active and primary accounts (showing `100% 充足` / live percentages or cooldown time).

## 0.4.2 (2026-08-20)

- **Remaining Quota Quantitative Display & Clean Progress Meters.**
  - Every account card now displays explicit, quantitative remaining quota meters (percentages and progress bars) for all three model families: Gemini (`✨`), Claude (`🧠`), and GPT-OSS (`⚡`).
  - Active and healthy accounts display 100% capacity (or live fractional quota returned from Google CloudCode backend) with emerald green progress bars; accounts in cooldown display 0% with real-time countdown badges (`Xs 冷却`).
- **Eliminated False Premature Account Additions & Browser OAuth.**
  - Staging account slot isolation: new accounts are created in temporary staging directories and only committed to `pool.json` when authorization code verification actually succeeds (`code === 0`). Cancelling or failing auth cleans up staging files with zero ghost accounts left behind.
  - Automatic system browser launch (`open <url>` on macOS, `start` on Windows, `xdg-open` on Linux) when initiating account addition, plus a direct one-click fallback link in the UI.
- **Drastic WebUI Simplification & Modern Redesign.**
  - Clean, high-contrast, linear-style UI: removed all noisy explanatory paragraphs, repetitive buttons, and cluttered text disclaimers.
  - Compact account cards with essential actions (`设为主用`, `⚙️ 代理`, `🗑️ 移除`).
  - Sleek segmented pill controls for pool scheduling mode (`顺次耗尽` / `轮询均衡`), permission mode (`plan` / `accept-edits` / `skip`), and reasoning effort (`auto` / `low` / `medium` / `high`).

## 0.4.1 (2026-08-20)

- **Context Optimization & Compaction Lifecycle Sync (ADR-013).**
  - **Uniform 1M Context Window**: `resolveModel` uniformly advertises 1,048,576 (1M) context window across all Antigravity models (Gemini, Claude via Antigravity, GPT-OSS). Prevents DSH from prematurely firing context compaction requests due to agy's cumulative tool token reporting.
  - **Compaction-Aware Session Rebinding**: When DSH compacts history or clears session messages (detected by `messages.length < binding.lastMessageCount`), the adapter automatically releases the stale `conversationId` binding and seeds a fresh, clean agy session with the compacted summary digest, eliminating infinite compaction loops.
  - **Pure Transparent Message Pass-Through**: Multi-turn continuations in active bound sessions pass only the trailing user prompt + `--conversation <id>`, leaving conversation state management and tool chaning to Antigravity's native engine.
  - **Multimodal Support Fix**: Declared `inputModalities: ['text', 'image']` across all Antigravity models in `listModels` and `resolveModel`, enabling native drag-and-drop / paste image support in DSH.
  - **Unified One-Click macOS Terminal Login**: Streamlined account addition to native macOS Terminal auth with real Gmail extraction and visual health indicators.

## 0.4.0 (2026-08-20)

- **Multi-Account Pool & Process-Level Profile Isolation.**
  - Account pool management under `~/.dsh/agy-accounts/` with physical process-level environment isolation (`HOME=~/.dsh/agy-accounts/<id>/`).
  - Primary account rides system `HOME` to reuse Mac OS Keychain credentials without duplicate login.
  - Multi-profile Google OAuth flow: dynamic state machine per account, drop hardcoded OAuth credentials, secure in-memory and isolated disk storage.
  - Per-account proxy configuration (`ALL_PROXY` / `HTTPS_PROXY`) preventing IP correlation across accounts.
- **Sticky Sequential Drain (按模型家族顺次耗尽).**
  - Fine-grained rate limit tracking scoped to model family (`google`, `anthropic`, `openai`). Exhausting Claude quota will not penalize Gemini requests.
  - Transparent in-flight failover: upon encountering `429` / `RESOURCE_EXHAUSTED`, the active turn immediately and seamlessly switches to the next healthy account.
  - Automatic cooldown calculation with tiered backoff and reset time detection.
- **Real-Time Quota Progress Bars & Silent Degradation.**
  - Real-time token consumption and quota percentage tracking for all pooled accounts.
  - Quota statistics surface directly to DSH WebUI with visual progress bars and bottleneck indicators.
  - Graceful silent degradation: token polling failures fall back smoothly without interrupting ongoing runs.
- **DSH In-GUI Management & Slash Commands.**
  - New slash commands: `/agy pool`, `/agy add-account`, `/agy switch`, and `/agy quota`.
  - Rich WebUI status card with account list, quota meters, proxy badges, and fast switcher.

## 0.3.6 (2026-08-20)

- **Comprehensive Google OAuth login state machine & reliable QR rendering.**
  - Fixed broken QR image rendering by generating inline base64 data URLs directly in the `/status` payload (`auth.qrDataUrl`).
  - Added direct one-click authorization link (`👉 点击在浏览器中打开 Google 授权页面`) so users can open the consent URL in their browser tab with proxy support.
  - Implemented explicit state machine lifecycle: `signed-out` -> `pending` (URL & QR active) -> `submitting` (exchanging authorization code) -> `ok` (connected & refreshed) / `failed` (actionable error & restart).
  - Added `/plugins/agy-link/auth-cancel` endpoint and in-GUI Cancel / Restart buttons.
- **Fixed non-Gemini model execution (Claude Sonnet / Claude Opus / GPT-OSS).**
  - The agy CLI rejects the `--effort` flag for Claude and GPT-OSS models (`--effort is not supported for model ...`). The adapter now automatically strips `--effort` when calling non-Gemini models.
  - Added automatic model slug alias resolution: `claude-opus-4-6` and `claude-opus` resolve to `claude-opus-4-6-thinking`; `gpt-oss-120b` resolves to `gpt-oss-120b-medium`.
  - Updated `DEFAULT_FALLBACK_MODELS` to match live agy 1.1.15 slugs.


- **Sliding activity watchdog for long-running tasks.** Replaced the static
  wall-clock timeout with an activity-based idle watchdog: the timer rearms
  on every chunk of stdout/stderr activity. Long-running tasks (e.g. multi-step
  refactors, extensive test suites, deep searches) can now run indefinitely as
  long as the process is actively working, while deadlocked/silent processes
  are still cleanly terminated after `timeoutMs` of complete inactivity.
  The agy CLI `--print-timeout` is given a generous ceiling (4h) to avoid
  premature termination of active print sessions.

## 0.3.4 (2026-08-19)

- **Tool activity moved out of the thinking panel into the reply body.**
  User feedback on 0.2.8: tool annotations hidden inside the DSH thinking
  fold were invisible and felt wrong. agy tools now render as visible
  `🔧 [agy tool: name] args -> output` lines in the message body (they
  cannot become native DSH tool cards: a finish:tool-calls would make the
  DSH agent try to execute tools it does not own — agy runs its own closed
  tool loop). The thinking panel keeps only what is genuinely thinking
  signal: `[agy thinking turn · N thinking tokens]` turn annotations
  (agy print mode never streams thinking text) and terminal error notes.

## 0.2.8 (2026-08-19)

- **Fix: real agy 1.1.15 stream-json parsing.** The parser only understood
  flat, hypothesized event shapes; the live CLI nests every step payload
  under a `step_update` envelope and uses a different vocabulary
  (`agent_response` + `text_delta` fragments, `tool` with `tool_name` /
  `tool_info` with `parameters` / `output` / `error`). As a result thinking
  and tool activity were silently dropped and only the final result text
  survived. Both shapes are now parsed (legacy aliases kept).
- **New: visible thinking turns + tool activity.** agy does not stream
  thinking text in print mode (only `thinking_tokens` usage), so each
  thinking-only `agent_response` turn surfaces as an annotated reasoning
  block (`[agy thinking turn · N thinking tokens]`), tool calls render as
  `[agy tool: name] args -> output` reasoning annotations, and failed tools
  render `[agy tool error: name] message`.
- **Fix: `result.status=ERROR` with a usable response** (e.g. a tool timed
  out mid-run) no longer discards the answer — the response streams, the
  error is annotated, the turn finishes normally. A bare envelope error
  now maps to a precise `AGY_ERROR` finish instead of INVALID_OUTPUT.
- **Fix: `agy models` deadlock — stdin pipe never closed.** agy reads stdin
  when it is a pipe and waits for EOF; every non-auth spawn kept the pipe
  open, so model discovery silently timed out and the catalog always fell
  back to the bundled list. Stdin now closes right after spawn (auth probes
  keep it open).
- **Fix: auth phase was always `idle`** until someone ran `/agy auth`, so
  the settings page claimed "needs Google login" for signed-in users.
  Status surfaces now lazily probe the real login state via `agy models`
  (60s cache) and report `ok` / `signed-out` truthfully.
- **Fix: `/plugins/agy-link/*` routes never registered on dsh web** (settings
  page stuck on `binary: not found / auth: unknown / models: 0`). Routes are
  now registered through a reactive `ctx.inject(['webServer'])` sub-fiber,
  so they attach whenever the service appears instead of racing it. The
  settings page also renders an honest "endpoint unreachable" state instead
  of misleading placeholders when the route is missing.
- **Removed: sidebar footer AGY button** (user request). Login (QR +
  authorization code) and mode/effort quick controls moved to Settings →
  Antigravity; the conversation header `AGY` pill stays.
- Tests: real-1.1.15 fixture modes (`real`, `real-error`, `real-fail`) and
  parser/mapper/adapter coverage for the nested format (73 tests).

## 0.2.7 (2026-08-19)

- Visible agy status in DSH: conversation header `AGY` pill, Settings → Antigravity status page, and sidebar footer label.
- Workspace auto-binding: agy now runs in the DSH session's `cwd` when `workspaceRoot` is not configured.
- New `/agy workspace [path]` command and `DSH_AGY_WORKSPACE_ROOT` env.
- README language switcher at the top (中文 / English).

## 0.2.2 (2026-08-19)

- README: dedicated Prerequisites section (DSH, Node >= 24, the agy CLI with Google's official install guide link, first-run login, subscription note), a "how it works" intro paragraph, and an honest "what it cannot do" list in both languages - onboarding now covers first-time users.
## 0.2.1 (2026-08-19)

- Cross-platform hardening (Linux / macOS / Windows):
  - binary discovery is platform-aware: agy / agy.exe / .cmd / .bat across
    PATH, ~/.local/bin, /usr/local/bin, /opt/homebrew/bin,
    %LOCALAPPDATA%\Programs, and the npm shim dir; a real executable is
    always preferred over a cmd shim
  - Windows .cmd/.bat shims spawn through cmd.exe with cross-spawn-style
    argument quoting (unit-tested)
  - tree-kill uses taskkill /T /F on Windows (Unix process groups do not
    exist there); detached sessions are POSIX-only so no console window
    flashes on Windows
  - CRLF stdout is normalized (trailing \r stripped per line)
  - the MCP bridge script path resolves via fileURLToPath (URL.pathname
    would yield /C:/... on Windows and break the spawn)
- 5 new cross-platform tests (56 total).

## 0.2.0 (2026-08-19)

- Multimodal (path-based): DSH image attachments are staged to a local media
  directory (config `mediaDir`, TTL sweep `mediaTtlMs`, caps `mediaMaxBytes` /
  `mediaMaxImages`) and referenced by absolute path in the agy prompt with
  `--add-dir` - agy views them with its own tools. Env: `DSH_AGY_MEDIA_DIR`,
  `DSH_AGY_MEDIA_TTL_MS`.
- `agy_ask` gains `readPaths` (inline text files into the one-shot prompt;
  binaries skipped with a note) and `schema` (JSON Schema enforced via
  `--json-schema`).
- MCP reverse bridge (experimental, `mcpBridge: true` / `DSH_AGY_MCP_BRIDGE=1`):
  agy can call DSH-side tools through a loopback, token-guarded endpoint plus a
  zero-dep stdio MCP server merged into the workspace `.mcp.json`.
  `mcpToolAllowlist` restricts the exposed set; `run_code` / `agy_ask` are
  never bridged.
- Abort semantics locked by a regression test: everything the model produced
  before the caller hits stop is preserved (open block closed, then failure
  finish).
- 12 new tests (51 total).

## 0.1.5 (2026-08-19)

- README restructured into a single bilingual page: Chinese first, then
  English (README.zh.md removed; package files list updated).
- Releases now publish to npm automatically (NPM_TOKEN secret configured).
