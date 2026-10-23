// Global scroll activity coordinator (dsh-agy-link).
//
// Dynamic measurement virtual lists (TanStack Virtualizer in DSH) continuously
// mount and unmount DOM nodes at high frequency during scroll gestures. If any
// client scanner mutates the DOM, injects nodes, or simulates clicks while
// scrolling is in progress, the virtualizer's item height measurements change
// mid-motion, triggering anchor compensation (scrollTop rewrite) and causing
// violent screen flickering / jumping.
//
// This coordinator provides a single source of truth for active scrolling:
// observers and scanners suppress layout-altering operations while scrolling
// is active and settle cleanly once scrolling stops (150ms quiet).

let isScrolling = false;
let scrollTimer: ReturnType<typeof setTimeout> | null = null;
let listenerAttached = false;
const settleListeners = new Set<() => void>();

function onScrollActivity(): void {
	isScrolling = true;
	if (scrollTimer !== null) clearTimeout(scrollTimer);
	scrollTimer = setTimeout(() => {
		isScrolling = false;
		scrollTimer = null;
		for (const fn of settleListeners) {
			try { fn(); } catch { /* ignore listener errors */ }
		}
	}, 150);
}

export function isScrollActive(): boolean {
	return isScrolling;
}

/** Set scroll active state explicitly (useful for testing or programmatic scrolls). */
export function setScrollActiveForTest(active: boolean): void {
	isScrolling = active;
}

/** Register a callback to run once scrolling has settled. Returns an unregister function. */
export function onScrollSettle(fn: () => void): () => void {
	ensureScrollListener();
	settleListeners.add(fn);
	return () => {
		settleListeners.delete(fn);
	};
}

export function ensureScrollListener(): void {
	if (typeof window === 'undefined' || typeof window.addEventListener !== 'function' || listenerAttached) return;
	listenerAttached = true;
	window.addEventListener('scroll', onScrollActivity, { passive: true, capture: true });
	window.addEventListener('wheel', onScrollActivity, { passive: true, capture: true });
}

export function disposeScrollListener(): void {
	if (typeof window === 'undefined' || typeof window.removeEventListener !== 'function' || !listenerAttached) return;
	window.removeEventListener('scroll', onScrollActivity, true);
	window.removeEventListener('wheel', onScrollActivity, true);
	listenerAttached = false;
	if (scrollTimer !== null) {
		clearTimeout(scrollTimer);
		scrollTimer = null;
	}
	settleListeners.clear();
	isScrolling = false;
}
