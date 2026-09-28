import fs from 'fs';
import path from 'path';
import Redis from 'ioredis';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const { Client } = pg;
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const GATEWAY_URL = 'http://localhost:3000/v1/query';
const DELAY_MS = 300;

const CONFIGS = {
    baseline: { alpha: 1.0, threshold: 0.85 },
    hybridFixed: { alpha: 0.7, threshold: 0.85 },
    hybridAdaptive: null
};

const flushCaches = async () => {
    // Flush Redis (exact-match + semantic search caches)
    await redis.flushdb();
    // Truncate cached_responses in Postgres (keeps telemetry_logs intact)
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query('TRUNCATE "cached_responses"');
    await client.end();
    console.log('  [flush] Redis + CachedResponse cleared');
};


const loadQuerySet = (file) => {
    const data = fs.readFileSync(path.join('./query_set', file), 'utf-8');
    return JSON.parse(data);
};

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const sendQuery = async (query, shouldHit) => {
    const start = Date.now();
    const res = await fetch(GATEWAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, shouldHit })
    });
    const data = await res.json();
    const latency = Date.now() - start;
    return { query, shouldHit, cacheHit: data.source !== 'llm', source: data.source, latency };
};

const runAllPairs = async (paraphrases, trapPairs, unrelated) => {
    const results = [];

    for (const group of paraphrases) {
        for (const query of group.pairs) {
            results.push(await sendQuery(query, group.shouldHit));
            await sleep(DELAY_MS);
        }
    }

    for (const group of [...trapPairs, ...unrelated]) {
        const [first, second] = group.pairs;
        results.push(await sendQuery(first, true));
        await sleep(DELAY_MS);
        results.push(await sendQuery(second, group.shouldHit));
        await sleep(DELAY_MS);
    }

    return results;
};

const computeMetrics = (results) => {
    const totalHits = results.filter(r => r.cacheHit).length;
    const falsePositives = results.filter(r => r.cacheHit && r.shouldHit === false).length;
    const avgLatency = results.reduce((sum, r) => sum + r.latency, 0) / results.length;

    return {
        total: results.length,
        hitRate: totalHits / results.length,
        fpRate: totalHits > 0 ? falsePositives / totalHits : 0,
        avgLatencyMs: Math.round(avgLatency)
    };
};

const runConfig = async (name, config, querySets) => {
    console.log(`\nrunning config: ${name}`);

    // Start each config run with a clean cache for fair comparison
    await flushCaches();

    if (config) {
        await redis.set('cache:config', JSON.stringify(config));
    }


    const results = await runAllPairs(...querySets);
    const metrics = computeMetrics(results);

    console.log(`${name}:`, metrics);
    return { name, config: config || 'live-adaptive', metrics, results };
};

const main = async () => {
    const paraphrases = loadQuerySet('paraphrases.json');
    const trapPairs = loadQuerySet('trap_pairs.json');
    const unrelated = loadQuerySet('unrelated.json');
    const querySets = [paraphrases, trapPairs, unrelated];

    const allResults = [];
    for (const [name, config] of Object.entries(CONFIGS)) {
        allResults.push(await runConfig(name, config, querySets));
    }

    fs.mkdirSync('./results', { recursive: true });
    fs.writeFileSync(
        './results/comparison.json',
        JSON.stringify(allResults, null, 2)
    );

    console.log('\ndone, results written to results/comparison.json');
    redis.disconnect();
};

main();