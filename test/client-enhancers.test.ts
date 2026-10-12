import test from 'node:test';
import assert from 'node:assert/strict';
import { isImageFile, buildMediaUrl } from '../src/client/images.ts';

// NOTE (merge recovery 2026-10-13): the mermaid half of this file tested the
// recovered working tree's own renderer (isMermaidCodeBlock / mermaidInitConfig
// / isValidMermaidSyntax / processMermaidBlock / sweepStrayMermaidErrors).
// Upstream main ships an equivalent, hardened renderer in
// src/client/mermaid.ts (vendored asset, no CDN fallback, MERMAID_CSS
// suppression + cleanupTempElements sweeps) covered by test/mermaid.test.ts,
// so the duplicate implementation and its tests were dropped.

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
