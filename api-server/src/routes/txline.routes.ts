import { Router, Request, Response, NextFunction } from 'express';
import {
    getTxlineSnapshotProof,
    getReplayEventsAfterId,
    getReplayTimeline,
    ingestOddsPayload,
    ingestScoresPayload,
    listTxlineFixtures,
    rebuildReplayTimeline,
    syncFixturesFromTxline,
    syncOddsSnapshot,
    syncScoresSnapshot,
    txlineRuntimeConfig,
} from '../services/arena/arena.service';
import {
    getTxlineIngestionStatus,
    startTxlineIngestion,
    stopTxlineIngestion,
} from '../services/arena/txlineStreamIngestion';
import {
    listStrategySignals,
    runStrategyForFixture,
    strategyRuntimeConfig,
} from '../services/arena/strategyEngine';
import { createOfferFromStrategySignal } from '../services/arena/strategyOfferBridge';
import {
    deriveOutcomesFromStoredScores,
    getOutcomeForFixture,
    listOutcomes,
    runBacktest,
    syncOutcomeForFixture,
} from '../services/arena/outcomeBacktest';
import {
    getSettledDemoReplayProof,
    seedSettledDemoReplay,
} from '../services/arena/demoReplayBackfill';
import { authenticateSolana } from '../middleware/auth';

const router = Router();

function parseLimit(value: unknown, fallback = 50): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), 1), 100) : fallback;
}

function pathParam(value: string | string[] | undefined): string {
    return Array.isArray(value) ? value[0] : value || '';
}

function optionalNumber(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function requireTxlineAdmin(req: Request, res: Response, next: NextFunction): void {
    const expected = process.env.TXLINE_ADMIN_TOKEN || process.env.ARENA_ADMIN_TOKEN || '';
    if (!expected && process.env.NODE_ENV !== 'production') {
        next();
        return;
    }

    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    if (!expected || token !== expected) {
        res.status(401).json({ success: false, error: 'txline_admin_auth_required' });
        return;
    }
    next();
}

function sendError(res: Response, error: any, fallback: string): void {
    const status = Number(error?.statusCode) || 500;
    res.status(status).json({ success: false, error: error?.message || fallback });
}

router.get('/v1/txline/config', (_req: Request, res: Response) => {
    res.json({
        success: true,
        data: {
            ...txlineRuntimeConfig(),
            publicEndpoints: {
                fixtures: '/v1/txline/fixtures',
                proof: '/v1/txline/proof/:fixtureId',
                replay: '/v1/txline/replay/:fixtureId',
                replayStream: '/v1/txline/replay/:fixtureId/stream',
                strategyConfig: '/v1/txline/strategy/config',
                strategySignals: '/v1/txline/strategy/signals/:fixtureId',
                strategyOffer: 'POST /v1/txline/strategy/signals/:signalId/offer',
                outcomes: '/v1/txline/outcomes',
                outcome: '/v1/txline/outcomes/:fixtureId',
                backtest: '/v1/txline/backtest',
                demoReplayProof: '/v1/txline/demo-replay/proof',
            },
            adminEndpoints: {
                syncFixtures: 'POST /v1/txline/sync/fixtures',
                syncOdds: 'POST /v1/txline/sync/odds/:fixtureId',
                syncScores: 'POST /v1/txline/sync/scores/:fixtureId',
                startIngestion: 'POST /v1/txline/ingestion/start',
                stopIngestion: 'POST /v1/txline/ingestion/stop',
                rebuildReplay: 'POST /v1/txline/replay/:fixtureId/rebuild',
                runStrategy: 'POST /v1/txline/strategy/run/:fixtureId',
                syncOutcome: 'POST /v1/txline/outcomes/sync/:fixtureId',
                deriveOutcomes: 'POST /v1/txline/outcomes/derive',
                seedDemoReplay: 'POST /v1/txline/demo-replay/seed',
            },
        },
    });
});

router.get('/v1/txline/fixtures', async (req: Request, res: Response) => {
    try {
        const fixtures = await listTxlineFixtures(parseLimit(req.query.limit));
        res.json({ success: true, data: fixtures });
    } catch (error: any) {
        sendError(res, error, 'Failed to list TxLINE fixtures');
    }
});

router.post('/v1/txline/sync/fixtures', requireTxlineAdmin, async (_req: Request, res: Response) => {
    try {
        const result = await syncFixturesFromTxline();
        res.json({ success: true, data: result });
    } catch (error: any) {
        sendError(res, error, 'Failed to sync TxLINE fixtures');
    }
});

router.post('/v1/txline/sync/odds/:fixtureId', requireTxlineAdmin, async (req: Request, res: Response) => {
    try {
        const fixtureId = pathParam(req.params.fixtureId);
        const result = req.body && Object.keys(req.body).length > 0
            ? await ingestOddsPayload(fixtureId, req.body)
            : await syncOddsSnapshot(fixtureId);
        res.json({ success: true, data: result });
    } catch (error: any) {
        sendError(res, error, 'Failed to sync TxLINE odds');
    }
});

router.post('/v1/txline/sync/scores/:fixtureId', requireTxlineAdmin, async (req: Request, res: Response) => {
    try {
        const fixtureId = pathParam(req.params.fixtureId);
        const result = req.body && Object.keys(req.body).length > 0
            ? await ingestScoresPayload(fixtureId, req.body)
            : await syncScoresSnapshot(fixtureId);
        res.json({ success: true, data: result });
    } catch (error: any) {
        sendError(res, error, 'Failed to sync TxLINE scores');
    }
});

router.get('/v1/txline/ingestion/status', (_req: Request, res: Response) => {
    res.json({ success: true, data: getTxlineIngestionStatus() });
});

router.post('/v1/txline/ingestion/start', requireTxlineAdmin, (_req: Request, res: Response) => {
    res.json({ success: true, data: startTxlineIngestion() });
});

router.post('/v1/txline/ingestion/stop', requireTxlineAdmin, (_req: Request, res: Response) => {
    res.json({ success: true, data: stopTxlineIngestion() });
});

router.post('/v1/txline/replay/:fixtureId/rebuild', requireTxlineAdmin, async (req: Request, res: Response) => {
    try {
        const fixtureId = pathParam(req.params.fixtureId);
        const result = await rebuildReplayTimeline(fixtureId);
        res.json({ success: true, data: result });
    } catch (error: any) {
        sendError(res, error, 'Failed to rebuild TxLINE replay timeline');
    }
});

router.get('/v1/txline/replay/:fixtureId/stream', async (req: Request, res: Response) => {
    try {
        const fixtureId = pathParam(req.params.fixtureId);
        const intervalMs = Math.min(Math.max(Number(req.query.intervalMs) || 250, 25), 5_000);
        const follow = String(req.query.follow || '').toLowerCase() === 'true';
        const latest = follow || String(req.query.latest || '').toLowerCase() === 'true';

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();
        const writeEvent = (payload: string): void => {
            res.write(payload);
            (res as any).flush?.();
        };

        let closed = false;
        req.on('close', () => {
            closed = true;
        });

        writeEvent(`event: arena.replay.start\n` +
            `data: ${JSON.stringify({ fixtureId, count: 0, loading: true, deterministic: true, intervalMs, follow, latest })}\n\n`);

        const replay = await getReplayTimeline(fixtureId, parseLimit(req.query.limit, 500), {
            window: latest ? 'latest' : 'earliest',
        });
        const events = Array.isArray(replay.events) ? replay.events : [];

        if (!closed) {
            writeEvent(`event: arena.replay.loaded\n` +
                `data: ${JSON.stringify({ fixtureId, count: events.length, deterministic: true, intervalMs, follow, latest })}\n\n`);
        }

        let lastEventId = typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : undefined;
        for (const event of events) {
            if (closed) return;
            lastEventId = (event as any).id;
            writeEvent(`id: ${lastEventId}\n` +
                `event: arena.replay.event\n` +
                `data: ${JSON.stringify(event)}\n\n`);
            if (!follow) {
                await new Promise((resolve) => setTimeout(resolve, intervalMs));
            }
        }

        if (follow) {
            let heartbeatAt = Date.now();
            while (!closed) {
                const nextEvents = await getReplayEventsAfterId(fixtureId, lastEventId, 100);
                if (nextEvents.length > 0) {
                    for (const event of nextEvents) {
                        if (closed) return;
                        lastEventId = event.id;
                        writeEvent(`id: ${lastEventId}\n` +
                            `event: arena.replay.event\n` +
                            `data: ${JSON.stringify(event)}\n\n`);
                    }
                    heartbeatAt = Date.now();
                } else if (Date.now() - heartbeatAt >= 5_000) {
                    writeEvent(`event: arena.replay.heartbeat\n` +
                        `data: ${JSON.stringify({ fixtureId, at: new Date().toISOString(), lastEventId })}\n\n`);
                    heartbeatAt = Date.now();
                }
                await new Promise((resolve) => setTimeout(resolve, Math.max(intervalMs, 500)));
            }
            return;
        }

        if (!closed) {
            writeEvent(`event: arena.replay.end\n` +
                `data: ${JSON.stringify({ fixtureId, count: events.length })}\n\n`);
            res.end();
        }
    } catch (error: any) {
        if (!res.headersSent) {
            sendError(res, error, 'Failed to stream TxLINE replay timeline');
            return;
        }
        res.write(`event: arena.replay.error\n`);
        res.write(`data: ${JSON.stringify({ error: error?.message || 'Failed to stream TxLINE replay timeline' })}\n\n`);
        res.end();
    }
});

router.get('/v1/txline/replay/:fixtureId', async (req: Request, res: Response) => {
    try {
        const latest = String(req.query.latest || '').toLowerCase() === 'true';
        const replay = await getReplayTimeline(pathParam(req.params.fixtureId), parseLimit(req.query.limit, 500), {
            window: latest ? 'latest' : 'earliest',
        });
        res.json({ success: true, data: replay });
    } catch (error: any) {
        sendError(res, error, 'Failed to get TxLINE replay timeline');
    }
});

router.get('/v1/txline/strategy/config', (_req: Request, res: Response) => {
    res.json({ success: true, data: strategyRuntimeConfig() });
});

router.post('/v1/txline/strategy/signals/:signalId/offer', authenticateSolana, async (req: Request, res: Response) => {
    try {
        const signalId = pathParam(req.params.signalId);
        const result = await createOfferFromStrategySignal(signalId, req.wallet || '', {
            asset: typeof req.body?.asset === 'string' ? req.body.asset : undefined,
            price: optionalNumber(req.body?.price),
            amount: optionalNumber(req.body?.amount),
            collateral: optionalNumber(req.body?.collateral),
            mode: req.body?.mode === 'buy' || req.body?.mode === 'sell' ? req.body.mode : undefined,
        });
        res.status((result as any).created === false ? 200 : 201).json({ success: true, data: result });
    } catch (error: any) {
        sendError(res, error, 'Failed to create AIR OTC offer from TxLINE strategy signal');
    }
});

router.post('/v1/txline/strategy/run/:fixtureId', requireTxlineAdmin, async (req: Request, res: Response) => {
    try {
        const fixtureId = pathParam(req.params.fixtureId);
        const result = await runStrategyForFixture(fixtureId, {
            minOddsChangePct: optionalNumber(req.body?.minOddsChangePct),
            minImpliedProbabilityDelta: optionalNumber(req.body?.minImpliedProbabilityDelta),
            maxStakeSol: optionalNumber(req.body?.maxStakeSol),
            limit: optionalNumber(req.body?.limit),
        });
        res.json({ success: true, data: result });
    } catch (error: any) {
        sendError(res, error, 'Failed to run TxLINE strategy');
    }
});

router.get('/v1/txline/strategy/signals/:fixtureId', async (req: Request, res: Response) => {
    try {
        const result = await listStrategySignals(pathParam(req.params.fixtureId), parseLimit(req.query.limit));
        res.json({ success: true, data: result });
    } catch (error: any) {
        sendError(res, error, 'Failed to list TxLINE strategy signals');
    }
});

router.post('/v1/txline/outcomes/sync/:fixtureId', requireTxlineAdmin, async (req: Request, res: Response) => {
    try {
        const result = await syncOutcomeForFixture(pathParam(req.params.fixtureId));
        res.json({ success: true, data: result });
    } catch (error: any) {
        sendError(res, error, 'Failed to sync TxLINE outcome');
    }
});

router.post('/v1/txline/outcomes/derive', requireTxlineAdmin, async (req: Request, res: Response) => {
    try {
        const fixtureId = typeof req.body?.fixtureId === 'string' ? req.body.fixtureId : undefined;
        const result = await deriveOutcomesFromStoredScores(fixtureId);
        res.json({ success: true, data: result });
    } catch (error: any) {
        sendError(res, error, 'Failed to derive TxLINE outcomes');
    }
});

router.get('/v1/txline/outcomes', async (req: Request, res: Response) => {
    try {
        const result = await listOutcomes(parseLimit(req.query.limit));
        res.json({ success: true, data: result });
    } catch (error: any) {
        sendError(res, error, 'Failed to list TxLINE outcomes');
    }
});

router.get('/v1/txline/outcomes/:fixtureId', async (req: Request, res: Response) => {
    try {
        const result = await getOutcomeForFixture(pathParam(req.params.fixtureId));
        res.json({ success: true, data: result });
    } catch (error: any) {
        sendError(res, error, 'Failed to get TxLINE outcome');
    }
});

router.get('/v1/txline/backtest', async (req: Request, res: Response) => {
    try {
        const result = await runBacktest({
            fixtureId: typeof req.query.fixtureId === 'string' ? req.query.fixtureId : undefined,
            minSampleSize: optionalNumber(req.query.minSampleSize),
            limit: optionalNumber(req.query.limit),
        });
        res.json({ success: true, data: result });
    } catch (error: any) {
        sendError(res, error, 'Failed to run TxLINE backtest');
    }
});

router.post('/v1/txline/demo-replay/seed', requireTxlineAdmin, async (req: Request, res: Response) => {
    try {
        const result = await seedSettledDemoReplay({
            reset: req.body?.reset !== false,
            minSampleSize: optionalNumber(req.body?.minSampleSize),
        });
        res.json({ success: true, data: result });
    } catch (error: any) {
        sendError(res, error, 'Failed to seed TxLINE demo replay proof');
    }
});

router.get('/v1/txline/demo-replay/proof', async (req: Request, res: Response) => {
    try {
        const result = await getSettledDemoReplayProof({
            minSampleSize: optionalNumber(req.query.minSampleSize),
        });
        res.json({ success: true, data: result });
    } catch (error: any) {
        sendError(res, error, 'Failed to generate TxLINE demo replay proof');
    }
});

router.get('/v1/txline/proof/:fixtureId', async (req: Request, res: Response) => {
    try {
        const proof = await getTxlineSnapshotProof(pathParam(req.params.fixtureId));
        res.json({ success: true, data: proof });
    } catch (error: any) {
        sendError(res, error, 'Failed to get TxLINE snapshot proof');
    }
});

export default router;
