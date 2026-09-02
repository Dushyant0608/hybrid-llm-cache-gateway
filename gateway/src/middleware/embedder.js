export const getEmbedding = async (query) => {
    const res = await fetch('http://localhost:5000/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: query })
    });

    const data = await res.json();
    return data.embedding;
};