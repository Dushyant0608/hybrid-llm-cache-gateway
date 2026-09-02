import express from "express"
import { cacheMiddleware } from "./src/middleware/cacheMiddleware";
const app = express();

app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use(cacheMiddleware);

export default app;