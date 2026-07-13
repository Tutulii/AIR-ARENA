import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import {
    ODDS_STREAM_ENDPOINT,
    SCORES_STREAM_ENDPOINT,
    normalizeOddsPayload,
    normalizeScoresPayload,
    readTxlineSseStream,
    txlineActiveFixtureSource,
    txlineAuthConfigured,
} from './txlineClient';
import { recordOddsUpdates, recordScoreUpdates, syncFixturesFromTxline, syncOddsSnapshot } from './arena.service';

type StreamName = 'odds' | 'scores';
type IngestionChannelKind = 'snapshot' | 'sse';

interface StreamState {
    endpoint: string;
    kind: IngestionChannelKind;
    connected: boolean;
    events: number;
    updates: number;
    lastMessageAt?: string;
    lastError?: string;
    reconnects?: number;
}

interface OddsHydrationState {
    enabled: boolean;
    running: boolean;
    cursor: number;
    lastRunAt?: string;
    lastFixtureIds: string[];
    lastRecorded: number;
    lastError?: string;
    intervalMs: number;
    batchSize: number;
}

interface IngestionState {
    running: boolean;
    mode: 'txline_stream' | 'unconfigured';
    source: string;
    startedAt?: string;
    stoppedAt?: string;
    fixtures: StreamState;
    odds: StreamState;
    scores: StreamState;
    oddsHydration: OddsHydrationState;
}

const prismaAny = prisma as any;
const DEMO_FIXTURE_RE = /^(demo-replay-|demo-)/i;

const state: IngestionState = {
    running: false,
    mode: 'unconfigured',
    source: txlineActiveFixtureSource(),
    fixtures: {
        endpoint: '/api/fixtures/snapshot',
        kind: 'snapshot',
        connected: false,
        events: 0,
        updates: 0,
    },
    odds: {
        endpoint: ODDS_STREAM_ENDPOINT,
        kind: 'sse',
        connected: false,
        events: 0,
        updates: 0,
        reconnects: 0,
    },
    scores: {
        endpoint: SCORES_STREAM_ENDPOINT,
        kind: 'sse',
        connected: false,
        events: 0,
        updates: 0,
        reconnects: 0,
    },
    oddsHydration: {
        enabled: true,
        running: false,
        cursor: 0,
        lastFixtureIds: [],
        lastRecorded: 0,
        intervalMs: 4_000,
        batchSize: 3,
    },
};

let controller: AbortController | null = null;
let fixtureSyncInterval: NodeJS.Timeout | null = null;
let oddsHydrationInterval: NodeJS.Timeout | null = null;
let oddsHydrationInFlight = false;

function cloneState(): IngestionState {
    return JSON.parse(JSON.stringify(state));
}

function fixtureSyncIntervalMs(): number {
    return Math.max(Number(process.env.TXLINE_FIXTURE_SYNC_INTERVAL_MS) || 120_000, 30_000);
}

function oddsHydrationIntervalMs(): number {
    return Math.max(Number(process.env.TXLINE_ODDS_HYDRATION_INTERVAL_MS) || 4_000, 2_000);
}

function oddsHydrationBatchSize(): number {
    return Math.min(Math.max(Number(process.env.TXLINE_ODDS_HYDRATION_BATCH_SIZE) || 3, 1), 10);
}

function oddsHydrationEnabled(): boolean {
    return (process.env.TXLINE_ODDS_HYDRATION_ENABLED || 'true').toLowerCase() !== 'false';
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLiveFixtureId(fixtureId: string): boolean {
    return Boolean(fixtureId) && !DEMO_FIXTURE_RE.test(fixtureId) && !fixtureId.startsWith('espn:');
}

function isTxlineFixtureRow(row: any): boolean {
    const fixtureId = String(row?.fixtureId || '');
    if (!isLiveFixtureId(fixtureId)) return false;
    const source = String(row?.raw?.source || '');
    return source === 'txline';
}

async function syncFixtureSnapshot(): Promise<void> {
    state.fixtures.lastError = undefined;
    try {
        const result = await syncFixturesFromTxline();
        state.fixtures.events += 1;
        state.fixtures.updates += Number(result.count || 0);
        state.fixtures.lastMessageAt = new Date().toISOString();
        state.fixtures.connected = true;
    } catch (error: any) {
        state.fixtures.lastError = error?.message || 'txline_fixture_snapshot_sync_failed';
        state.fixtures.connected = false;
    }
}

/**
 * Round-robin odds snapshot hydration for every non-demo upcoming/live fixture.
 * Global SSE often only ticks one active fixture; without this, other matches look frozen/empty.
 */
async function hydrateFixtureOddsBatch(): Promise<void> {
    if (!oddsHydrationEnabled() || oddsHydrationInFlight || !state.running) return;
    oddsHydrationInFlight = true;
    state.oddsHydration.running = true;
    state.oddsHydration.intervalMs = oddsHydrationIntervalMs();
    state.oddsHydration.batchSize = oddsHydrationBatchSize();
    state.oddsHydration.enabled = true;

    try {
        const now = new Date();
        const horizon = new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000);
        const pastGrace = new Date(now.getTime() - 6 * 60 * 60 * 1000);
        const candidates = await prismaAny.arenaFixture.findMany({
            where: {
                OR: [
                    { status: { in: ['upcoming', 'live', 'scheduled'] } },
                    {
                        startsAt: {
                            gte: pastGrace,
                            lte: horizon,
                        },
                    },
                ],
            },
            orderBy: [{ startsAt: 'asc' }, { updatedAt: 'desc' }],
            take: 120,
            select: { fixtureId: true, startsAt: true, status: true, raw: true },
        });

        const fixtureIds = (candidates || [])
            .filter(isTxlineFixtureRow)
            .map((row: any) => String(row.fixtureId || ''))
            .filter((fixtureId: string, index: number, all: string[]) => all.indexOf(fixtureId) === index);

        if (fixtureIds.length === 0) {
            state.oddsHydration.lastFixtureIds = [];
            state.oddsHydration.lastRecorded = 0;
            state.oddsHydration.lastRunAt = new Date().toISOString();
            return;
        }

        const batchSize = Math.min(oddsHydrationBatchSize(), fixtureIds.length);
        const selected: string[] = [];
        for (let i = 0; i < batchSize; i += 1) {
            const index = (state.oddsHydration.cursor + i) % fixtureIds.length;
            selected.push(fixtureIds[index]);
        }
        state.oddsHydration.cursor = (state.oddsHydration.cursor + batchSize) % fixtureIds.length;

        let recorded = 0;
        for (const fixtureId of selected) {
            try {
                const result = await syncOddsSnapshot(fixtureId);
                recorded += Number(result.count || 0);
            } catch (error: any) {
                state.oddsHydration.lastError = error?.message || 'odds_hydration_failed';
                logger.warn('txline_odds_hydration_fixture_failed', {
                    fixtureId,
                    error: error?.message || String(error),
                });
            }
        }

        state.oddsHydration.lastFixtureIds = selected;
        state.oddsHydration.lastRecorded = recorded;
        state.oddsHydration.lastRunAt = new Date().toISOString();
        if (recorded > 0) {
            state.oddsHydration.lastError = undefined;
            state.odds.lastMessageAt = new Date().toISOString();
        }
    } catch (error: any) {
        state.oddsHydration.lastError = error?.message || 'odds_hydration_batch_failed';
        logger.warn('txline_odds_hydration_batch_failed', {
            error: error?.message || String(error),
        });
    } finally {
        oddsHydrationInFlight = false;
        state.oddsHydration.running = false;
    }
}

async function runStream(name: StreamName, endpoint: string, signal: AbortSignal): Promise<void> {
    const streamState = state[name];
    streamState.connected = true;
    streamState.lastError = undefined;
    try {
        await readTxlineSseStream(endpoint, {
            signal,
            onMessage: async (message) => {
                streamState.events += 1;
                streamState.lastMessageAt = new Date().toISOString();
                if (name === 'odds') {
                    const updates = normalizeOddsPayload(message.data);
                    if (updates.length > 0) {
                        await recordOddsUpdates(updates);
                        streamState.updates += updates.length;
                    }
                } else {
                    const updates = normalizeScoresPayload(message.data);
                    if (updates.length > 0) {
                        await recordScoreUpdates(updates);
                        streamState.updates += updates.length;
                    }
                }
            },
        });
    } catch (error: any) {
        if (!signal.aborted) {
            streamState.lastError = error?.message || 'txline_stream_failed';
        }
    } finally {
        streamState.connected = false;
    }
}

async function runStreamWithReconnect(name: StreamName, endpoint: string, signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
        attempt += 1;
        if (attempt > 1) {
            state[name].reconnects = (state[name].reconnects || 0) + 1;
            logger.warn('txline_stream_reconnecting', {
                stream: name,
                attempt,
                endpoint,
                lastError: state[name].lastError,
            });
            await sleep(Math.min(15_000, 1_500 * attempt));
        }
        if (signal.aborted) break;
        await runStream(name, endpoint, signal);
        if (signal.aborted) break;
        // Stream ended cleanly; reconnect after a short pause.
        await sleep(1_500);
    }
}

export function getTxlineIngestionStatus(): IngestionState {
    return cloneState();
}

export function startTxlineIngestion(): IngestionState {
    if (state.running) return cloneState();

    state.source = txlineActiveFixtureSource();
    controller = new AbortController();
    state.running = true;
    state.startedAt = new Date().toISOString();
    state.stoppedAt = undefined;
    state.mode = txlineAuthConfigured() ? 'txline_stream' : 'unconfigured';
    state.fixtures.lastError = undefined;
    state.odds.lastError = undefined;
    state.scores.lastError = undefined;
    state.oddsHydration.enabled = oddsHydrationEnabled();
    state.oddsHydration.intervalMs = oddsHydrationIntervalMs();
    state.oddsHydration.batchSize = oddsHydrationBatchSize();
    state.oddsHydration.lastError = undefined;

    if (!txlineAuthConfigured()) {
        state.running = false;
        state.stoppedAt = new Date().toISOString();
        state.fixtures.lastError = 'TXLINE_API_TOKEN is required before starting TxLINE ingestion';
        return cloneState();
    }

    void syncFixtureSnapshot();
    fixtureSyncInterval = setInterval(() => {
        void syncFixtureSnapshot();
    }, fixtureSyncIntervalMs());

    if (oddsHydrationEnabled()) {
        void hydrateFixtureOddsBatch();
        oddsHydrationInterval = setInterval(() => {
            void hydrateFixtureOddsBatch();
        }, oddsHydrationIntervalMs());
    }

    void Promise.allSettled([
        runStreamWithReconnect('odds', ODDS_STREAM_ENDPOINT, controller.signal),
        runStreamWithReconnect('scores', SCORES_STREAM_ENDPOINT, controller.signal),
    ]).finally(() => {
        if (!controller?.signal.aborted) {
            state.running = false;
            state.stoppedAt = new Date().toISOString();
        }
    });

    return cloneState();
}

export function stopTxlineIngestion(): IngestionState {
    if (fixtureSyncInterval) {
        clearInterval(fixtureSyncInterval);
        fixtureSyncInterval = null;
    }
    if (oddsHydrationInterval) {
        clearInterval(oddsHydrationInterval);
        oddsHydrationInterval = null;
    }
    if (controller) {
        controller.abort();
        controller = null;
    }
    state.running = false;
    state.stoppedAt = new Date().toISOString();
    state.fixtures.connected = false;
    state.odds.connected = false;
    state.scores.connected = false;
    state.oddsHydration.running = false;
    return cloneState();
}
