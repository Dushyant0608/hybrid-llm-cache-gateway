const tokenize = (text) =>
    text.toLowerCase().trim().split(/\s+/);

const termFreq = (tokens) => {
    const freq = {};
    for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
    return freq;
};

export const lexicalScore = (a, b) => {
    const fa = termFreq(tokenize(a));
    const fb = termFreq(tokenize(b));

    const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);

    let inter = 0, union = 0;
    for (const k of keys) {
        const wa = fa[k] || 0;
        const wb = fb[k] || 0;
        inter += Math.min(wa, wb);
        union += Math.max(wa, wb);
    }

    return union === 0 ? 0 : inter / union;
};