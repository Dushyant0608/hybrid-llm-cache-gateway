const VERIFIER_URL = 'http://localhost:5050/verify';

export const verify = async (Query, candidate) => {
    const res = await fetch(VERIFIER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, candidate })
    });
    const data = await res.json();

    return data;
};