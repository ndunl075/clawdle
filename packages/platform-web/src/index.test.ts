import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createController, emptyState, type Platform } from '@clawdle/app-core';
import { createWebPlatform } from './index';
const platforms: Platform[] = [];
beforeEach(() => { vi.stubGlobal('navigator', {}); });
afterEach(() => {
    for (const p of platforms.splice(0))
        p.dispose?.();
    vi.unstubAllGlobals();
});
async function open(name = crypto.randomUUID()) { const p = await createWebPlatform({ databaseName: name }); platforms.push(p); return p; }
describe('IndexedDB platform', () => {
    it('enforces one mutable tab without Web Locks and allows a new owner after close', async () => { const name = crypto.randomUUID(), a = await open(name), b = await open(name); expect(a.readonly).toBe(false); expect(b.readonly).toBe(true); await expect(b.append(b.id(), { type: 'startDaily' })).rejects.toThrow('read-only'); a.dispose?.(); platforms.splice(platforms.indexOf(a), 1); const c = await open(name); expect(c.readonly).toBe(false); });
    it('uses the Web Locks owner when available', async () => {
        let held = false;
        vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
                    const lock = held ? null : {};
                    if (lock)
                        held = true;
                    await callback(lock);
                    if (lock)
                        held = false;
                } } });
        const name = crypto.randomUUID(), a = await open(name), b = await open(name);
        expect(a.readonly).toBe(false);
        expect(b.readonly).toBe(true);
    });
    it('deduplicates action IDs and preserves daily game/result across reopening', async () => { const name = crypto.randomUUID(), p = await open(name), c = await createController(p); const id = p.id(); await c.dispatch({ type: 'startDaily' }, id); await c.dispatch({ type: 'startDaily' }, id); expect((await p.read(0))).toHaveLength(1); const gameId = c.state.activeGameId!; c.dispose(); platforms.splice(platforms.indexOf(p), 1); const p2 = await open(name), reopened = await createController(p2); expect(reopened.state.activeGameId).toBe(gameId); expect(Object.keys(reopened.state.games)).toHaveLength(1); });
    it('rejects a stale checkpoint atomically', async () => { const p = await open(), state = emptyState(); await p.append(p.id(), { type: 'startDaily' }); state.processedSeq = 1; await p.commit(0, state, []); await expect(p.commit(0, state, [])).rejects.toThrow('conflict'); expect((await p.snapshot()).checkpoint?.stateVersion).toBe(1); });
    it('lets secondary tabs read committed snapshots without writing', async () => { const name = crypto.randomUUID(), a = await open(name), c = await createController(a); await c.dispatch({ type: 'startDaily' }); const b = await open(name), spectator = await createController(b); expect(spectator.state.activeGameId).toBe(c.state.activeGameId); await expect(spectator.dispatch({ type: 'startEndless' })).rejects.toThrow('Another tab'); });
});
