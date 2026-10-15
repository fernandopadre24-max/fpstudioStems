import type { VercelRequest, VercelResponse } from '@vercel/node'
import init_session from '../src/init_session.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    const { sessionManager } = await init_session();
    sessionManager.invalidateCaches();
    res.status(204).send(null);
}