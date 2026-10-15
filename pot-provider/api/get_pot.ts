import type { VercelRequest, VercelResponse } from '@vercel/node'
import { strerror } from "../src/utils.js";
import initSession from "../src/init_session.js";


export default async function handler(req: VercelRequest, res: VercelResponse) {
    const body = req.body || {};
    if (body.data_sync_id)
        return res.status(400).send({
            error: "data_sync_id is deprecated, use content_binding instead",
        });
    if (body.visitor_data)
        return res.status(400).send({
            error: "visitor_data is deprecated, use content_binding instead",
        });
    if (body.disable_innertube)
        return res.status(400).send({
            error: "disable_innertube is deprecated because the /Create endpoint doesn't work anymore",
        });

    const { sessionManager } = await initSession();

    const contentBinding: string | undefined = body.content_binding;
    const proxy: string = body.proxy;
    const bypassCache: boolean = body.bypass_cache || false;
    const sourceAddress: string | undefined = body.source_address;
    const disableTlsVerification: boolean =
        body.disable_tls_verification || false;

    try {
        const sessionData = await sessionManager.generatePoToken(
            contentBinding,
            proxy,
            bypassCache,
            sourceAddress,
            disableTlsVerification,
            body.challenge,
            body.innertube_context,
        );

        res.send(sessionData);
    } catch (e: any) {
        const msg = strerror(e, /*update=*/ true);
        console.error(e.stack);
        res.status(500).send({ error: msg });
    }

}