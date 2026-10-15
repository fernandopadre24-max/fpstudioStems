import type { VercelRequest, VercelResponse } from '@vercel/node'
import initSession from '../src/init_session.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    const { sessionManager } = await initSession();
    return res.send(Array.from(sessionManager.minterCache.keys()));
}