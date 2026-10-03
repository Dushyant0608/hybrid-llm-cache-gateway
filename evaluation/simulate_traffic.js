import fs from 'fs';
import path from 'path';

const GATEWAY_URL = 'http://localhost:3000/v1/query';
const DELAY_MS = 500;

const loadQuerySet = (file) => {
    const data = fs.readFileSync(path.join('./query_set', file), 'utf-8');
    return JSON.parse(data);
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const sendQuery = async (query, shouldHit) => {
    try {
        const res = await fetch(GATEWAY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, shouldHit })
        });
        const data = await res.json();
        console.log(`[${shouldHit}] "${query}" -> ${data.source}`);
    } catch (e) {
        console.log(`[${shouldHit}] "${query}" -> FAILED (${e.message})`);
    }
};

const runParaphrases = async (groups) => {
    for (const group of groups) {
        for (let i = 0; i < group.pairs.length; i++) {
            const query = group.pairs[i];
            // First query seeds the cache — no prior entry to match, so shouldHit is unknown
            const label = i === 0 ? null : group.shouldHit;
            await sendQuery(query, label);
            await sleep(DELAY_MS);
        }
    }
};

const runPairs = async (groups) => {
    for (const group of groups) {
        const [first, second] = group.pairs;
        await sendQuery(first, true);
        await sleep(DELAY_MS);
        await sendQuery(second, group.shouldHit);
        await sleep(DELAY_MS);
    }
};

const main = async () => {
    const paraphrases = loadQuerySet('paraphrases.json');
    const trapPairs = loadQuerySet('trap_pairs.json');
    const unrelated = loadQuerySet('unrelated.json');

    console.log('running paraphrases');
    await runParaphrases(paraphrases);

    console.log('running trap pairs');
    await runPairs(trapPairs);

    console.log('running unrelated');
    await runPairs(unrelated);

    console.log('done');
};

main();