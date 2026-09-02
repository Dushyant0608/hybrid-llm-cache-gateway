import crypto from 'crypto';
import { get, set } from '../service/redis.js';

const hash = (query) => crypto.createHash('md5').update(query.trim().toLowerCase()).digest('hex');

export const checkExactMatch = async (query) => {
    const cached = await get(hash(query));
    return cached || null;
};

export const storeExact = async (query, response) => {
    await set(hash(query), response, 86400);
};