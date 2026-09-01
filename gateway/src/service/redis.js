import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const redis = new Redis(process.env.REDIS_URL);

redis.on('connect', () => console.log('Redis connected'));
redis.on('error', (err) => console.error('Redis error:', err));

export const get = (k) => redis.get(k);

export const set = (k, v, ttl) => redis.set(k, v, 'EX', ttl);

export const getConfig = async () => {
    const cfg = await redis.get('cache:config');
    return cfg ? JSON.parse(cfg) : null;
};

export const setConfig = (cfg) => redis.set('cache:config', JSON.stringify(cfg));

export default redis;