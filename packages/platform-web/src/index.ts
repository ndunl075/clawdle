import type { Platform, Command, JournalEntry, AppState, ResultRow, Checkpoint, Snapshot } from '@clawdle/app-core';
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const completion = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted')); tx.onerror = () => reject(tx.error); });
export async function createWebPlatform(options: {
    databaseName?: string;
} = {}): Promise<Platform> {
    const databaseName = options.databaseName ?? 'clawdle-v1';
    const open = indexedDB.open(databaseName, 1);
    open.onupgradeneeded = () => { const db = open.result; db.createObjectStore('meta'); db.createObjectStore('journal', { keyPath: 'seq', autoIncrement: true }).createIndex('eventId', 'eventId', { unique: true }); db.createObjectStore('daily'); db.createObjectStore('results', { keyPath: 'identity' }); db.createObjectStore('effects'); };
    const db = await request(open);
    const runtimeEpoch = crypto.randomUUID();
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(databaseName) : null;
    const listeners = new Set<() => void>();
    let release: () => void = () => { };
    let readonly = true;
    if (navigator.locks) {
        await new Promise<void>(resolve => {
            void navigator.locks.request(`${databaseName}:owner`, { ifAvailable: true }, async (lock) => {
                readonly = !lock;
                resolve();
                if (lock)
                    await new Promise<void>(done => { release = done; });
            });
        });
    }
    else {
        const tx = db.transaction('meta', 'readwrite');
        const done = completion(tx);
        const lease = await request<{
            owner: string;
            expires: number;
        } | undefined>(tx.objectStore('meta').get('owner'));
        if (!lease || lease.expires < Date.now()) {
            readonly = false;
            tx.objectStore('meta').put({ owner: runtimeEpoch, expires: Date.now() + 15000 }, 'owner');
        }
        await done;
        if (!readonly) {
            const timer = setInterval(() => {
                const renew = db.transaction('meta', 'readwrite');
                const lease = renew.objectStore('meta').get('owner');
                lease.onsuccess = () => {
                    if (lease.result?.owner === runtimeEpoch)
                        renew.objectStore('meta').put({ owner: runtimeEpoch, expires: Date.now() + 15000 }, 'owner');
                    else
                        readonly = true;
                };
            }, 5000);
            release = () => {
                clearInterval(timer);
                const close = db.transaction('meta', 'readwrite');
                const lease = close.objectStore('meta').get('owner');
                lease.onsuccess = () => {
                    if (lease.result?.owner === runtimeEpoch)
                        close.objectStore('meta').delete('owner');
                };
            };
        }
    }
    const signal = () => {
        channel?.postMessage({ type: 'updated' });
        for (const f of listeners)
            f();
    };
    if (channel)
        channel.onmessage = () => {
            for (const f of listeners)
                f();
        };
    const snapshot = async (): Promise<Snapshot> => { const tx = db.transaction('meta', 'readonly'); const checkpoint = await request<Checkpoint | undefined>(tx.objectStore('meta').get('checkpoint')); const latestSeq = await request<number | undefined>(tx.objectStore('meta').get('latestSeq')); return { runtimeEpoch, receivedAtUtc: new Date().toISOString(), receivedMonoMs: performance.now(), latestSeq: latestSeq ?? 0, checkpoint: checkpoint ?? null }; };
    const platform: Platform = { get readonly() { return readonly; }, snapshot, id: () => crypto.randomUUID(), randomUnit: () => { const n = new Uint32Array(1); crypto.getRandomValues(n); return n[0]! / 4294967296; }, subscribe: async (f) => { listeners.add(f); return () => { listeners.delete(f); }; },
        append: async (eventId: string, command: Command) => {
            if (readonly)
                throw new Error('This tab is read-only');
            const tx = db.transaction(['journal', 'meta'], 'readwrite');
            const done = completion(tx);
            if (!navigator.locks) {
                const lease = await request<{
                    owner: string;
                } | undefined>(tx.objectStore('meta').get('owner'));
                if (lease?.owner !== runtimeEpoch) {
                    readonly = true;
                    tx.abort();
                    await done.catch(() => { });
                    throw new Error('Profile ownership changed');
                }
            }
            const store = tx.objectStore('journal');
            const existing = await request<JournalEntry | undefined>(store.index('eventId').get(eventId));
            if (existing) {
                if (JSON.stringify(existing.payload) !== JSON.stringify(command)) {
                    tx.abort();
                    await done.catch(() => { });
                    throw new Error('Idempotency conflict');
                }
                await done;
                return existing;
            }
            const entry = { eventId, runtimeEpoch, receivedAtUtc: new Date().toISOString(), receivedMonoMs: performance.now(), kind: 'command' as const, payload: command };
            const seq = Number(await request(store.add(entry)));
            tx.objectStore('meta').put(seq, 'latestSeq');
            await done;
            signal();
            return { ...entry, seq };
        },
        read: async (afterSeq) => { const tx = db.transaction('journal', 'readonly'); return request<JournalEntry[]>(tx.objectStore('journal').getAll(IDBKeyRange.lowerBound(afterSeq, true))); },
        commit: async (expectedVersion: number, state: AppState, results: ResultRow[]) => {
            if (readonly)
                throw new Error('This tab is read-only');
            const tx = db.transaction(['meta', 'results', 'journal', 'daily'], 'readwrite');
            const done = completion(tx);
            const meta = tx.objectStore('meta');
            if (!navigator.locks) {
                const lease = await request<{
                    owner: string;
                } | undefined>(meta.get('owner'));
                if (lease?.owner !== runtimeEpoch) {
                    readonly = true;
                    tx.abort();
                    await done.catch(() => { });
                    throw new Error('Profile ownership changed');
                }
            }
            const old = await request<Checkpoint | undefined>(meta.get('checkpoint'));
            if ((old?.stateVersion ?? 0) !== expectedVersion) {
                tx.abort();
                await done.catch(() => { });
                throw new Error('Checkpoint conflict');
            }
            const oldSeq = old?.processedSeq ?? 0;
            const count = state.processedSeq > oldSeq ? await request(tx.objectStore('journal').count(IDBKeyRange.bound(oldSeq, state.processedSeq, true, false))) : 0;
            if (state.processedSeq < oldSeq || count !== state.processedSeq - oldSeq) {
                tx.abort();
                await done.catch(() => { });
                throw new Error('Noncontiguous checkpoint');
            }
            if (state.dataResetSeq > (old?.state.dataResetSeq ?? 0)) {
                tx.objectStore('results').clear();
                tx.objectStore('daily').clear();
            }
            for (const game of Object.values(state.games))
                if (game.mode === 'daily' && game.dailyKey) {
                    const key = `daily-v1:${game.dailyKey}`;
                    const existing = await request<string | undefined>(tx.objectStore('daily').get(key));
                    if (existing && existing !== game.gameId) {
                        tx.abort();
                        await done.catch(() => { });
                        throw new Error('Official daily already exists');
                    }
                    tx.objectStore('daily').put(game.gameId, key);
                }
            for (const row of results) {
                const prior = await request<ResultRow | undefined>(tx.objectStore('results').get(row.identity));
                if (prior && JSON.stringify(prior) !== JSON.stringify(row)) {
                    tx.abort();
                    await done.catch(() => { });
                    throw new Error('Conflicting result');
                }
                tx.objectStore('results').put(row);
            }
            const checkpoint = { stateVersion: expectedVersion + 1, processedSeq: state.processedSeq, state: { ...state, stateVersion: expectedVersion + 1 } };
            meta.put(checkpoint, 'checkpoint');
            await done;
            signal();
            return checkpoint;
        },
        claimEffect: async (id) => {
            const tx = db.transaction('effects', 'readwrite');
            const done = completion(tx);
            const store = tx.objectStore('effects');
            const exists = await request(store.get(id));
            if (!exists)
                store.put(true, id);
            await done;
            return !exists;
        }, clipboard: async (text) => { await navigator.clipboard.writeText(text); }, dispose: () => { release(); channel?.close(); db.close(); } };
    return platform;
}
