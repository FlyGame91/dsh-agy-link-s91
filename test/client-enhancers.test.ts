import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isMermaidCodeBlock,
  isValidMermaidSyntax,
  mermaidInitConfig,
  processMermaidBlock,
  sweepStrayMermaidErrors,
  type MermaidGlobalLike,
} from '../src/client/mermaid.ts';
import { isImageFile, buildMediaUrl } from '../src/client/images.ts';
import { insertTextIntoChatComposer } from '../src/client/decisions.ts';

test('isMermaidCodeBlock detects mermaid blocks from className, banner, and diagram syntax', () => {
  // 1. By code class
  const mockBlock1 = {
    querySelector(sel: string) {
      if (sel === 'code') return { className: 'language-mermaid', textContent: 'graph TD; A-->B;' };
      return null;
    },
  } as unknown as HTMLElement;
  assert.equal(isMermaidCodeBlock(mockBlock1), true);

  // 2. By banner text
  const mockBlock2 = {
    querySelector(sel: string) {
      if (sel === 'code') return { className: '', textContent: 'A --> B' };
      if (sel === '[data-code-block-banner]' || sel.includes('banner')) return { textContent: 'mermaid' };
      return null;
    },
  } as unknown as HTMLElement;
  assert.equal(isMermaidCodeBlock(mockBlock2), true);

  // 3. By flowchart syntax
  const mockBlock3 = {
    querySelector(sel: string) {
      if (sel === 'code') return { className: '', textContent: 'flowchart LR\n A["Node 1"] --> B["Node 2"]' };
      return null;
    },
  } as unknown as HTMLElement;
  assert.equal(isMermaidCodeBlock(mockBlock3), true);

  // 4. By sequenceDiagram syntax
  const mockBlock4 = {
    querySelector(sel: string) {
      if (sel === 'code') return { className: '', textContent: 'sequenceDiagram\n Alice->>Bob: Hello' };
      return null;
    },
  } as unknown as HTMLElement;
  assert.equal(isMermaidCodeBlock(mockBlock4), true);

  // 5. Non-mermaid block
  const mockBlock5 = {
    querySelector(sel: string) {
      if (sel === 'code') return { className: 'language-typescript', textContent: 'const x = 1;' };
      return null;
    },
  } as unknown as HTMLElement;
  assert.equal(isMermaidCodeBlock(mockBlock5), false);
});

test('isImageFile accurately detects image extensions ignoring queries and fragments', () => {
  assert.equal(isImageFile('flint_hunter_local_concept.png'), true);
  assert.equal(isImageFile('file:///D:/proj/tribal-era/docs/previews/flint_hunter_local_concept.png'), true);
  assert.equal(isImageFile('http://127.0.0.1:5173/preview.webp?v=123'), true);
  assert.equal(isImageFile('image.jpeg#preview'), true);
  assert.equal(isImageFile('diagram.svg'), true);
  assert.equal(isImageFile('photo.jpg'), true);
  assert.equal(isImageFile('code.ts'), false);
  assert.equal(isImageFile('script.py'), false);
  assert.equal(isImageFile(''), false);
});

test('buildMediaUrl encodes target path and preserves origin', () => {
  const url = buildMediaUrl('file:///D:/proj/tribal-era/test.png');
  assert.ok(url.includes('/plugins/agy-link/media?path='));
  assert.ok(url.includes('file%3A%2F%2F%2FD%3A%2Fproj%2Ftribal-era%2Ftest.png'));
});

// ---------------------------------------------------------------------------
// Mermaid error rendering (regression: a malformed ```mermaid block painted
// mermaid's own "Syntax error in text / mermaid version 12.0.0" bomb diagram
// into document.body, where it floated at the end of the page).
// ---------------------------------------------------------------------------

test('mermaidInitConfig enables suppressErrorRendering so parse failures never paint into document.body', () => {
  for (const dark of [true, false]) {
    const cfg = mermaidInitConfig(dark);
    assert.equal(cfg.suppressErrorRendering, true, 'must suppress mermaid error diagrams');
    assert.equal(cfg.startOnLoad, false, 'the host owns when diagrams render');
    assert.equal(cfg.theme, dark ? 'dark' : 'default');
  }
});

test('isValidMermaidSyntax delegates to parse(suppressErrors) and treats failures as invalid', async () => {
  const calls: Array<{ text: string; suppress: boolean | undefined }> = [];
  const valid: MermaidGlobalLike = {
    initialize() {},
    parse(text, options) {
      calls.push({ text, suppress: options?.suppressErrors });
      return text === 'flowchart TD\n A-->B' ? { diagramType: 'flowchart' } : false;
    },
    async render() { return { svg: '' }; },
  };

  assert.equal(await isValidMermaidSyntax(valid, 'flowchart TD\n A-->B'), true);
  assert.equal(await isValidMermaidSyntax(valid, 'flowchart TD\n A--'), false);
  assert.deepEqual(calls[0], { text: 'flowchart TD\n A-->B', suppress: true });
  assert.deepEqual(calls[1], { text: 'flowchart TD\n A--', suppress: true });

  // A throwing parser is invalid, never fatal.
  const throwing: MermaidGlobalLike = {
    initialize() {},
    parse() { throw new Error('boom'); },
    async render() { return { svg: '' }; },
  };
  assert.equal(await isValidMermaidSyntax(throwing, 'graph TD'), false);

  // Unknown build without parse(): defer to render() instead of blocking.
  const noParse: MermaidGlobalLike = {
    initialize() {},
    async render() { return { svg: '' }; },
  };
  assert.equal(await isValidMermaidSyntax(noParse, 'graph TD'), true);
});

test('a diagram that fails to parse keeps the raw code block and never calls render()', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalDocument = (globalThis as { document?: unknown }).document;
  let renderCalls = 0;

  try {
    const mermaid: MermaidGlobalLike = {
      initialize() {},
      parse: () => false,
      async render() { renderCalls++; return { svg: '<svg/>' }; },
    };

    (globalThis as { window?: unknown }).window = {
      mermaid,
      matchMedia: () => ({ matches: false }),
    };
    const sweepTargets: unknown[] = [];
    (globalThis as { document?: unknown }).document = {
      documentElement: { classList: { contains: () => false }, getAttribute: () => null },
      body: { classList: { contains: () => false }, getAttribute: () => null },
      getElementById: () => null,
      querySelectorAll: () => sweepTargets,
      createElement: () => ({ className: '', style: {}, dataset: {}, appendChild() {}, set innerHTML(_v: string) {} }),
    };

    const pre = { textContent: 'flowchart TD\n A -->', style: { display: 'none' } };
    const block = {
      dataset: {} as Record<string, string>,
      querySelector: (sel: string) => (sel === 'pre' ? pre : null),
      insertBefore() {},
    } as unknown as HTMLElement;

    await processMermaidBlock(block);

    assert.equal(renderCalls, 0, 'mermaid.render must not run for invalid syntax');
    assert.equal(block.dataset.agyMermaidStatus, 'invalid');
    assert.equal(pre.style.display, '', 'the original code block must stay visible');

    // The same source is not re-parsed on every MutationObserver tick...
    await processMermaidBlock(block);
    assert.equal(renderCalls, 0, 'unchanged invalid source must not retry forever');
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = originalDocument;
  }
});

test('sweepStrayMermaidErrors only removes detached body-level error diagrams', () => {
  const originalDocument = (globalThis as { document?: unknown }).document;
  try {
    const mkSvg = (text: string, parent: unknown) => ({
      textContent: text,
      parentElement: parent,
      closest: () => null,
      remove() { removed.push(this); },
    });
    const removed: unknown[] = [];
    const body = { tag: 'body' } as unknown;
    const tempWrapper = { id: 'dagy-mm-1', parentElement: body, remove() { removed.push(this); } };
    const detachedSvg = mkSvg('Syntax error in text', body);
    const wrappedSvg = mkSvg('Syntax error in text\nmermaid version 12.0.0', tempWrapper);
    const inMessageSvg = mkSvg('Syntax error in text', { tag: 'div' });
    const realDiagram = mkSvg('flowchart TD A-->B', body);

    (globalThis as { document?: unknown }).document = {
      body,
      querySelectorAll: () => [detachedSvg, wrappedSvg, inMessageSvg, realDiagram],
    };

    assert.equal(sweepStrayMermaidErrors(), 2);
    assert.deepEqual(removed, [detachedSvg, tempWrapper], 'only the body-level bomb is removed');
    assert.equal(realDiagram.parentElement, body, 'a legitimate diagram is untouched');
  } finally {
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = originalDocument;
  }
});
