import express from "express"
import { cacheMiddleware } from "./src/middleware/cacheMiddleware.js";
const app = express();

app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.post('/v1/query', cacheMiddleware);

export default app;