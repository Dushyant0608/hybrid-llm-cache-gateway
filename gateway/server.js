import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

import app from './app.js';
import { initConfig } from './src/config/default.js';

const PORT = process.env.PORT || 3000;

const start = async () => {
    await initConfig();
    app.listen(PORT, () => console.log(`Gateway running on port ${PORT}`));
};

start();