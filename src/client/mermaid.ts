// Client-side Mermaid diagram rendering for dsh-agy-link.
//
// Automatically detects ```mermaid code blocks rendered by DSH Web / Desktop,
// dynamically loads mermaid.min.js from the plugin asset surface, and mounts
// an interactive diagram viewer with:
//  - Diagram / Code tab switching (100% non-destructive to React's <pre> node)
//  - Zoom In / Zoom Out / Reset controls with pan support
//  - Copy SVG to clipboard
//  - Auto dark / light theme adaptation
//  - Safe fallback if diagram syntax is invalid or still streaming
//
// NOTE on `suppressErrorRendering`: mermaid's `render()` appends a temporary
// `<div id="d<id>">` to `document.body` when no container is passed. On a parse
// failure it *draws its own "Syntax error in text" diagram into that div* and
// only rethrows when `suppressErrorRendering` is enabled — otherwise the call
// resolves "successfully" with a bomb SVG that escapes our card and floats at
// the end of the page. We always enable the flag, validate with `parse()`
// first, and sweep any stray error diagrams left in the DOM.

export interface MermaidOptions {
  assetBaseUrl?: string;
}

/** Minimal structural type of the `window.mermaid` global we rely on. */
export interface MermaidGlobalLike {
  initialize: (config: Record<string, unknown>) => void;
  parse?: (text: string, options?: { suppressErrors?: boolean }) => unknown;
  render: (id: string, text: string) => Promise<{ svg: string }>;
}

let mermaidLoadedPromise: Promise<void> | null = null;
let mermaidConfigured = false;
let diagramSeq = 0;

/** Mermaid init config — `suppressErrorRendering` is what keeps parse failures
 *  from being painted into `document.body` as a floating error diagram. */
export function mermaidInitConfig(dark: boolean): Record<string, unknown> {
  return {
    startOnLoad: false,
    theme: dark ? 'dark' : 'default',
    securityLevel: 'loose',
    fontFamily: 'inherit',
    suppressErrorRendering: true,
  };
}

/** Text mermaid writes into its built-in parse-failure diagram. */
const MERMAID_ERROR_TEXT = 'Syntax error in text';

/**
 * Remove mermaid error diagrams that escaped their message container.
 *
 * Mermaid renders them into a bare `<div id="d...">` appended to
 * `document.body`, so they show up detached from the conversation (bottom of
 * the page). Older sessions may already contain such nodes, and a render that
 * slips past `suppressErrorRendering` would add more — this sweep is the net.
 */
export function sweepStrayMermaidErrors(): number {
  if (typeof document === 'undefined') return 0;
  let removed = 0;
  const svgs = document.querySelectorAll('svg');
  for (let i = 0; i < svgs.length; i++) {
    const svg = svgs[i];
    if (!svg) continue;
    if (!(svg.textContent ?? '').includes(MERMAID_ERROR_TEXT)) continue;
    // Never touch a diagram card we mounted ourselves.
    if (svg.closest('.agy-mermaid-card')) continue;
    // Only strip the detached body-level wrappers mermaid creates.
    const host = svg.parentElement;
    const isMermaidTempWrapper = host !== null && /^d[\w-]+$/.test(host.id) && host.parentElement === document.body;
    if (!isMermaidTempWrapper && host !== document.body) continue;
    (isMermaidTempWrapper ? host : svg).remove();
    removed++;
  }
  return removed;
}

/** Configure the globally loaded mermaid runtime exactly once. */
function configureMermaid(mermaid: MermaidGlobalLike): void {
  if (mermaidConfigured) return;
  mermaidConfigured = true;
  mermaid.initialize(mermaidInitConfig(isDarkMode()));
}

const MERMAID_CSS = `
.agy-mermaid-card {
  margin: 8px 0;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.25));
  border-radius: 8px;
  overflow: hidden;
  background: var(--dsw-alias-bg-l1, rgba(255, 255, 255, 0.04));
  font-family: inherit;
}

.agy-mermaid-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--dsw-alias-bg-l2, rgba(127, 127, 127, 0.08));
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.15));
  font-size: 12px;
  user-select: none;
}

.agy-mermaid-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
}

.agy-mermaid-tab {
  background: transparent;
  border: 1px solid transparent;
  color: var(--dsw-alias-label-secondary, #888);
  padding: 3px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: all 0.15s ease;
}

.agy-mermaid-tab:hover {
  color: var(--dsw-alias-label-primary, #fff);
  background: var(--dsw-alias-bg-hover, rgba(127, 127, 127, 0.1));
}

.agy-mermaid-tab.active {
  color: var(--dsw-alias-label-primary, #fff);
  background: var(--dsw-alias-bg-l3, rgba(127, 127, 127, 0.18));
  border-color: var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.25));
}

.agy-mermaid-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.agy-mermaid-btn {
  background: transparent;
  border: 1px solid transparent;
  color: var(--dsw-alias-label-secondary, #888);
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  transition: all 0.15s ease;
}

.agy-mermaid-btn:hover {
  color: var(--dsw-alias-label-primary, #fff);
  background: var(--dsw-alias-bg-hover, rgba(127, 127, 127, 0.15));
  border-color: var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
}

.agy-mermaid-viewport {
  position: relative;
  overflow: hidden;
  padding: 16px;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 120px;
  max-height: 600px;
  background: var(--dsw-alias-bg-l0, transparent);
  cursor: grab;
}

.agy-mermaid-viewport.grabbing {
  cursor: grabbing;
}

.agy-mermaid-svg-container {
  display: inline-block;
  transform-origin: center center;
  transition: transform 0.05s ease-out;
  max-width: 100%;
}

.agy-mermaid-svg-container svg {
  max-width: 100%;
  height: auto;
  display: block;
}

.agy-mermaid-error {
  padding: 12px;
  color: #ef4444;
  font-size: 12px;
  font-family: monospace;
  background: rgba(239, 68, 68, 0.08);
  border-radius: 4px;
  margin: 8px;
}

.agy-mermaid-loading {
  padding: 24px;
  color: var(--dsw-alias-label-tertiary, #999);
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
`;

function injectStyles(): void {
  if (typeof document === 'undefined') return;
  const styleId = 'dsh-agy-link-mermaid-css';
  if (document.getElementById(styleId) === null) {
    const st = document.createElement('style');
    st.id = styleId;
    st.textContent = MERMAID_CSS;
    const host = document.head ?? document.documentElement;
    if (host) host.appendChild(st);
  }
}

/**
 * Dynamically load mermaid.min.js from plugin asset surface
 */
export function ensureMermaidLoaded(assetBaseUrl = '/plugins/agy-link/assets'): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  const win = window as unknown as { mermaid?: MermaidGlobalLike };
  if (win.mermaid) {
    configureMermaid(win.mermaid);
    sweepStrayMermaidErrors();
    return Promise.resolve();
  }
  if (mermaidLoadedPromise) return mermaidLoadedPromise;

  mermaidLoadedPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${assetBaseUrl}/mermaid.min.js`;
    script.async = true;
    script.onload = () => {
      try {
        if (win.mermaid) {
          configureMermaid(win.mermaid);
          sweepStrayMermaidErrors();
          resolve();
        } else {
          reject(new Error('mermaid global not found after script load'));
        }
      } catch (e) {
        reject(e);
      }
    };
    script.onerror = () => {
      mermaidLoadedPromise = null;
      reject(new Error('failed to load mermaid.min.js from ' + script.src));
    };
    (document.head || document.documentElement).appendChild(script);
  });

  return mermaidLoadedPromise;
}

function isDarkMode(): boolean {
  if (typeof document === 'undefined') return false;
  const html = document.documentElement;
  const body = document.body;
  if (html.classList.contains('dark') || body.classList.contains('dark')) return true;
  if (body.getAttribute('data-theme') === 'dark' || html.getAttribute('data-theme') === 'dark') return true;
  if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return true;
  }
  return false;
}

/** Check if code or banner indicates a Mermaid diagram */
export function isMermaidCodeBlock(block: HTMLElement): boolean {
  // 1. Check data-language or class
  const pre = block.querySelector('pre');
  const code = block.querySelector('code');
  const lang = (code?.className || '').toLowerCase();
  if (lang.includes('language-mermaid') || lang.includes('mermaid')) return true;

  // 2. Check banner text
  const banner = block.querySelector('[data-code-block-banner]') ?? block.querySelector('[class*="banner"]');
  if (banner && /mermaid/i.test(banner.textContent ?? '')) return true;

  // 3. Check code content prefix
  const text = (code?.textContent ?? pre?.textContent ?? '').trim();
  if (/^(?:flowchart|graph|sequenceDiagram|stateDiagram|classDiagram|erDiagram|journey|gantt|pie|gitGraph|quadrantChart|xychart-beta|mindmap|timeline)\b/i.test(text)) {
    return true;
  }

  return false;
}

/**
 * Validate diagram syntax without touching the DOM.
 *
 * `mermaid.parse(text, { suppressErrors: true })` returns `false` instead of
 * throwing/reporting when the diagram cannot be parsed; older/unknown builds
 * that lack `parse` are treated as "cannot pre-validate" so `render()` still
 * decides.
 */
export async function isValidMermaidSyntax(mermaid: MermaidGlobalLike, code: string): Promise<boolean> {
  if (typeof mermaid.parse !== 'function') return true;
  try {
    const result = await mermaid.parse(code, { suppressErrors: true });
    return result !== false;
  } catch {
    return false;
  }
}

/** Fall back to the host's plain code block, discarding any diagram card. */
function fallbackToRawCode(block: HTMLElement, pre: HTMLElement, status: string): void {
  block.dataset.agyMermaidStatus = status;
  block.querySelector('.agy-mermaid-card')?.remove();
  pre.style.display = '';
  sweepStrayMermaidErrors();
}

/** Render a single Mermaid block (exported for regression tests). */
export async function processMermaidBlock(block: HTMLElement): Promise<void> {
  if (block.dataset.agyMermaidStatus === 'rendering') return;

  const pre = block.querySelector<HTMLElement>('pre');
  if (!pre) return;

  const rawCode = (pre.textContent ?? '').trim();
  if (!rawCode) return;

  const previousCode = block.dataset.agyMermaidCode;
  const previousStatus = block.dataset.agyMermaidStatus;

  // Same source we already settled on: a rendered card still in place, or code
  // we know does not parse. Re-running on every MutationObserver tick would
  // only burn CPU (and, on failure, log the same syntax error repeatedly).
  // 'error' (asset load failure) and a 'done' block whose card React removed
  // are deliberately retried.
  if (previousCode === rawCode) {
    if (previousStatus === 'invalid') return;
    if (previousStatus === 'done' && block.querySelector('.agy-mermaid-card') !== null) return;
  }

  block.dataset.agyMermaidStatus = 'rendering';
  block.dataset.agyMermaidCode = rawCode;

  try {
    await ensureMermaidLoaded();
  } catch {
    block.dataset.agyMermaidStatus = 'error';
    return;
  }

  const win = window as unknown as { mermaid: MermaidGlobalLike };
  const diagramId = `agy-mm-${Date.now()}-${++diagramSeq}`;

  // Sanitize any unescaped tags or non-printable chars
  const sanitizedCode = rawCode.replace(/\r\n/g, '\n');

  // Pre-validate: partial/streaming or malformed diagrams keep the raw code
  // block and never reach mermaid's renderer (which would otherwise paint its
  // own error diagram into document.body).
  if (!(await isValidMermaidSyntax(win.mermaid, sanitizedCode))) {
    fallbackToRawCode(block, pre, 'invalid');
    return;
  }

  let svgContent = '';
  try {
    const res = await win.mermaid.render(diagramId, sanitizedCode);
    svgContent = res.svg;
  } catch {
    // If syntax error (often while streaming partial code), don't crash.
    document.getElementById(`d${diagramId}`)?.remove();
    fallbackToRawCode(block, pre, 'invalid');
    return;
  }

  block.dataset.agyMermaidStatus = 'done';

  // Mount or update the interactive diagram card
  let card = block.querySelector<HTMLElement>('.agy-mermaid-card');
  if (!card) {
    card = document.createElement('div');
    card.className = 'agy-mermaid-card';
    block.insertBefore(card, pre);
  }

  let activeTab: 'diagram' | 'code' = 'diagram';
  let scale = 1.0;
  let translateX = 0;
  let translateY = 0;
  let isDragging = false;
  let startX = 0;
  let startY = 0;

  const updateTransform = (container: HTMLElement) => {
    container.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  };

  card.innerHTML = '';

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'agy-mermaid-toolbar';

  // Tab switch
  const tabs = document.createElement('div');
  tabs.className = 'agy-mermaid-tabs';

  const tabDiagram = document.createElement('button');
  tabDiagram.type = 'button';
  tabDiagram.className = 'agy-mermaid-tab active';
  tabDiagram.textContent = '📊 流程图';

  const tabCode = document.createElement('button');
  tabCode.type = 'button';
  tabCode.className = 'agy-mermaid-tab';
  tabCode.textContent = '📝 源码';

  tabs.appendChild(tabDiagram);
  tabs.appendChild(tabCode);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'agy-mermaid-actions';

  const btnZoomIn = document.createElement('button');
  btnZoomIn.type = 'button';
  btnZoomIn.className = 'agy-mermaid-btn';
  btnZoomIn.title = '放大 / Zoom In';
  btnZoomIn.textContent = '🔍+';

  const btnZoomOut = document.createElement('button');
  btnZoomOut.type = 'button';
  btnZoomOut.className = 'agy-mermaid-btn';
  btnZoomOut.title = '缩小 / Zoom Out';
  btnZoomOut.textContent = '🔍-';

  const btnReset = document.createElement('button');
  btnReset.type = 'button';
  btnReset.className = 'agy-mermaid-btn';
  btnReset.title = '重置视角 / Reset';
  btnReset.textContent = '↺';

  const btnCopySvg = document.createElement('button');
  btnCopySvg.type = 'button';
  btnCopySvg.className = 'agy-mermaid-btn';
  btnCopySvg.title = '复制 SVG 代码';
  btnCopySvg.textContent = '📋 SVG';

  actions.appendChild(btnZoomIn);
  actions.appendChild(btnZoomOut);
  actions.appendChild(btnReset);
  actions.appendChild(btnCopySvg);

  toolbar.appendChild(tabs);
  toolbar.appendChild(actions);
  card.appendChild(toolbar);

  // Viewport
  const viewport = document.createElement('div');
  viewport.className = 'agy-mermaid-viewport';

  const svgWrapper = document.createElement('div');
  svgWrapper.className = 'agy-mermaid-svg-container';
  svgWrapper.innerHTML = svgContent;
  viewport.appendChild(svgWrapper);
  card.appendChild(viewport);

  // Hide the host's <pre> node cleanly without destroying it
  pre.style.display = 'none';

  // Tab switching logic
  tabDiagram.onclick = (e) => {
    e.stopPropagation();
    activeTab = 'diagram';
    tabDiagram.classList.add('active');
    tabCode.classList.remove('active');
    viewport.style.display = 'flex';
    actions.style.display = 'flex';
    pre.style.display = 'none';
  };

  tabCode.onclick = (e) => {
    e.stopPropagation();
    activeTab = 'code';
    tabCode.classList.add('active');
    tabDiagram.classList.remove('active');
    viewport.style.display = 'none';
    actions.style.display = 'none';
    pre.style.display = '';
  };

  // Zoom buttons
  btnZoomIn.onclick = (e) => {
    e.stopPropagation();
    scale = Math.min(scale * 1.25, 4.0);
    updateTransform(svgWrapper);
  };

  btnZoomOut.onclick = (e) => {
    e.stopPropagation();
    scale = Math.max(scale / 1.25, 0.3);
    updateTransform(svgWrapper);
  };

  btnReset.onclick = (e) => {
    e.stopPropagation();
    scale = 1.0;
    translateX = 0;
    translateY = 0;
    updateTransform(svgWrapper);
  };

  // Copy SVG
  btnCopySvg.onclick = (e) => {
    e.stopPropagation();
    if (navigator.clipboard && svgContent) {
      navigator.clipboard.writeText(svgContent).then(() => {
        btnCopySvg.textContent = '✓ 已复制';
        setTimeout(() => { btnCopySvg.textContent = '📋 SVG'; }, 1500);
      }).catch(() => {});
    }
  };

  // Mouse pan & drag
  viewport.onmousedown = (e) => {
    if (activeTab !== 'diagram') return;
    isDragging = true;
    startX = e.clientX - translateX;
    startY = e.clientY - translateY;
    viewport.classList.add('grabbing');
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;
    translateX = e.clientX - startX;
    translateY = e.clientY - startY;
    updateTransform(svgWrapper);
  };

  const onMouseUp = () => {
    if (isDragging) {
      isDragging = false;
      viewport.classList.remove('grabbing');
    }
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  // Wheel zoom
  viewport.onwheel = (e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1.15 : 0.87;
    scale = Math.max(0.3, Math.min(scale * delta, 4.0));
    updateTransform(svgWrapper);
  };
}

export function scanAndRenderMermaid(): void {
  if (typeof document === 'undefined') return;
  const blocks = document.querySelectorAll<HTMLElement>('.md-code-block, [class*="md-code-block"], div[data-code-block-banner]');
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b && isMermaidCodeBlock(b)) {
      void processMermaidBlock(b);
    }
  }
}

export function installMermaid(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  injectStyles();

  const observer = new MutationObserver(() => {
    scanAndRenderMermaid();
  });

  const setup = () => {
    if (document.body) {
      // Clear error diagrams left behind by a previous client build that ran
      // without `suppressErrorRendering` (they survive until a reload).
      sweepStrayMermaidErrors();
      observer.observe(document.body, { childList: true, subtree: true });
      scanAndRenderMermaid();
    }
  };

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', setup, { once: true });
  } else {
    setup();
  }
}
