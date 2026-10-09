import * as https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";

const VIDEO = "tI9kSZgMLsc";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function httpsGet(
  url: string,
  family: 4 | 6 | undefined,
  maxBytes: number,
): Promise<{ status: number; bytes: number; type: string; error?: string }> {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { family, timeout: 25000, headers: { "User-Agent": UA, Range: "bytes=0-262143" } },
      (res: IncomingMessage) => {
        let bytes = 0;
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          resolve({
            status: res.statusCode ?? 0,
            bytes,
            type: String(res.headers["content-type"] ?? "-"),
          });
        };
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes >= maxBytes) {
            req.destroy();
            finish();
          }
        });
        res.on("close", finish);
        res.on("end", finish);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, bytes: 0, type: "-", error: "TIMEOUT" });
    });
    req.on("error", (error: Error) => {
      resolve({ status: 0, bytes: 0, type: "-", error: error.message });
    });
  });
}

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  void request;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  const lines: string[] = [];

  const api = await fetch(`https://invidious.f5.si/api/v1/videos/${VIDEO}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  const data = (await api.json()) as { adaptiveFormats?: Array<{ type?: string; url?: string }> };
  const audio = (data.adaptiveFormats ?? []).find((f) => (f.type ?? "").startsWith("audio/"));
  if (!audio?.url) {
    response.end("sem audio");
    return;
  }

  const hop1 = await fetch(audio.url, {
    redirect: "manual",
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(20000),
  });
  const location = hop1.headers.get("location") ?? "";
  lines.push(`hop1=${hop1.status} loc=${location.length} chars`);

  if (location) {
    lines.push(`v4 :: ${JSON.stringify(await httpsGet(location, 4, 262144))}`);
    lines.push(`auto :: ${JSON.stringify(await httpsGet(location, undefined, 262144))}`);
    lines.push(`v6 :: ${JSON.stringify(await httpsGet(location, 6, 262144))}`);
  }

  response.statusCode = 200;
  response.end(lines.join("\n"));
}
