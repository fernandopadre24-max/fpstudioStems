import { promises as dns } from "node:dns";
import * as https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";

const HOSTS = ["api.cobalt.tools", "pipedapi.adminforge.de", "inv.nadeko.net", "solr.sscdn.co"];

function probeHttps(host: string): Promise<string> {
  return new Promise((resolve) => {
    const req = https.get(
      { host, path: "/", timeout: 12000, family: 4, headers: { "User-Agent": "Mozilla/5.0" } },
      (res: IncomingMessage) => {
        res.resume();
        resolve(`https v4 http=${res.statusCode}`);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve("https v4 TIMEOUT");
    });
    req.on("error", (error: Error) => resolve(`https v4 ERR ${error.message}`));
  });
}

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  void request;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  const lines: string[] = [];

  for (const host of HOSTS) {
    try {
      const addresses = await dns.lookup(host, { all: true });
      lines.push(`dns ${host} = ${addresses.map((a) => `${a.family}:${a.address}`).join(" ")}`);
    } catch (error) {
      lines.push(`dns ${host} ERR ${error instanceof Error ? error.message : String(error)}`);
    }

    const start = Date.now();
    try {
      const res = await fetch(`https://${host}/`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(12000),
        redirect: "manual",
      });
      res.body?.cancel().catch(() => undefined);
      lines.push(`fetch ${host} http=${res.status} ${Date.now() - start}ms`);
    } catch (error) {
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      lines.push(
        `fetch ${host} ERR ${error instanceof Error ? error.message : String(error)} :: cause=${cause?.code ?? cause?.message ?? "-"} ${Date.now() - start}ms`,
      );
    }

    lines.push(`probe ${host} :: ${await probeHttps(host)}`);
  }

  response.statusCode = 200;
  response.end(lines.join("\n"));
}
