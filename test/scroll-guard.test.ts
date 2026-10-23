import test from 'node:test';
import assert from 'node:assert/strict';
import {
	isScrollActive,
	setScrollActiveForTest,
	onScrollSettle,
	ensureScrollListener,
	disposeScrollListener,
} from '../src/client/scroll-guard.ts';

test('isScrollActive returns false by default and accepts test override', () => {
	disposeScrollListener();
	assert.equal(isScrollActive(), false);
	setScrollActiveForTest(true);
	assert.equal(isScrollActive(), true);
	setScrollActiveForTest(false);
	assert.equal(isScrollActive(), false);
});

test('onScrollSettle unbinds cleanly', () => {
	let settled = 0;
	const unbind = onScrollSettle(() => {
		settled++;
	});
	unbind();
	disposeScrollListener();
	assert.equal(settled, 0);
});
