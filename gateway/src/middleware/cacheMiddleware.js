import { getConfig } from '../service/redis.js';
import { checkExactMatch, storeExact } from './exactMatch.js';
import { searchSemantic, storeSemantic } from './semanticSearch.js';
import { verify } from './verifier.js';
import { logTelemetry } from '../service/telemetry.js';
import { getEmbedding } from './embedder.js';
import { callLLM } from './llm.js';

const logBase = (query, shouldHit, cfg, latencyMs, extra) => ({
    query,
    shouldHit: shouldHit ?? null,
    lowCutoffUsed: cfg.lowCutoff,
    nliThresholdUsed: cfg.nliThreshold,
    latencyMs,
    candidateQuery: null,
    semanticScore: null,
    nliContradictionScore: null,
    nliEntailmentScore: null,
    verifierLatencyMs: null,
    ...extra
});

export const cacheMiddleware = async (req, res, next) => {
    const { query, shouldHit } = req.body;
    if (!query) return next();

    const start = Date.now();
    const cfg = await getConfig();
    const mode = cfg.mode || 'veto';

    const exact = await checkExactMatch(query);
    if (exact) {
        await logTelemetry(logBase(query, shouldHit, cfg, Date.now() - start, {
            cacheHit: true, decisionPath: 'exact'
        }));
        return res.json({ response: exact, source: 'exact' });
    }

    const embedding = await getEmbedding(query);
    const candidate = await searchSemantic(embedding);

    let decisionPath = 'no_candidate';
    let nli = null;
    let verifierMs = null;

    if (candidate && mode === 'baseline') {
        decisionPath = candidate.score >= cfg.baselineThreshold ? 'hit' : 'below_threshold';
    } else if (candidate && candidate.score >= cfg.lowCutoff) {
        const vStart = Date.now();
        nli = await verify(query, candidate.query);
        verifierMs = Date.now() - vStart;
        decisionPath = nli.contradiction >= cfg.nliThreshold ? 'vetoed' : 'hit';
    } else if (candidate) {
        decisionPath = 'below_cutoff';
    }

    if (decisionPath === 'hit') {
        await logTelemetry(logBase(query, shouldHit, cfg, Date.now() - start, {
            cacheHit: true, decisionPath, candidateQuery: candidate.query,
            semanticScore: candidate.score, nliContradictionScore: nli?.contradiction ?? null,
            nliEntailmentScore: nli?.entailment ?? null, verifierLatencyMs: verifierMs
        }));
        return res.json({ response: candidate.response, source: 'semantic' });
    }



    let response;
    try {
        response = await callLLM(query);
    } catch (e) {
        console.error('llm failed:', e.message);
        return res.status(502).json({ error: 'llm_failed' });
    }


    await storeExact(query, response);
    await storeSemantic(query, embedding, response);
    await logTelemetry(logBase(query, shouldHit, cfg, Date.now() - start, {
        cacheHit: false, decisionPath, candidateQuery: candidate?.query ?? null,
        semanticScore: candidate?.score ?? null, nliContradictionScore: nli?.contradiction ?? null,
        nliEntailmentScore: nli?.entailment ?? null, verifierLatencyMs: verifierMs
    }));

    return res.json({ response, source: 'llm' });
};