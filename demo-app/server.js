import express from 'express';

const app = express();
app.use(express.json());

const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:3000/v1/query';

app.get('/', (req,res)=> { res.json("Demo app is running")});

app.post('/ask', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    try {
        const r = fetch(GATEWAY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: message })
        });
        const data = r.json();
        res.json({ answer: data.response, source: data.source });
    } catch (e) {
        res.status(502).json({ error: 'gateway unreachable' });
    }
});

app.listen(4000, () => {
    console.log('demo-app on 4000');
});