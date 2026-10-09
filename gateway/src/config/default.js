import { getConfig, setConfig } from "../service/redis.js";

const DEFAULTS = { mode: 'veto', lowCutoff: 0.5, nliThreshold: 0.5, baselineThreshold: 0.85 };

export const initConfig = async () => {
    const existing = await getConfig();
    if(!existing){
        await setConfig(DEFAULTS);
        console.log('Config initialized with defaults:', DEFAULTS);
    } else {
        console.log('Config already exists:', existing);
    }
};