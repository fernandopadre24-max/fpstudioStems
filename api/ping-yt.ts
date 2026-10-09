import type { IncomingMessage, ServerResponse } from "node:http";

const VIDEO = "tI9kSZgMLsc";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

async function probe(label: string, url: string, init?: RequestInit): Promise<string[]> {
  const lines: string[] = [];
  const start = Date.now();
  try {
    const res = await fetch(url, {
      ...init,
      headers: { "User-Agent": UA, Accept: "application/json, */*", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    lines.push(`${label} http=${res.status} len=${text.length} ${Date.now() - start}ms`);
    if (res.status !== 200) {
      lines.push(`${label} body=${text.slice(0, 150).replace(/\s+/g, " ")}`);
      return lines;
    }
    const data = JSON.parse(text) as Record<string, unknown>;

    const candidates: string[] = [];
    const pipedAudio = data.audioStreams as Array<{ url?: string; mimeType?: string }> | undefined;
    if (Array.isArray(pipedAudio)) {
      for (const s of pipedAudio) if (s.url) candidates.push(s.url);
    }
    const invFormats = data.adaptiveFormats as Array<{ mimeType?: string; url?: string }> | undefined;
    if (Array.isArray(invFormats)) {
      for (const f of invFormats) if ((f.mimeType ?? "").startsWith("audio/") && f.url) candidates.push(f.url);
    }
    if (typeof data.url === "string") candidates.push(data.url);
    if (typeof data.error === "string") lines.push(`${label} error=${data.error.slice(0, 120)}`);
    if (data.status && typeof data.status === "string") lines.push(`${label} status=${data.status}`);

    if (candidates.length === 0) {
      lines.push(`${label} sem urls; chaves=${Object.keys(data).slice(0, 10).join(",")}`);
      return lines;
    }
    const streamUrl = candidates[candidates.length - 1];
    lines.push(`${label} url host=${new URL(streamUrl).host}`);
    try {
      const dl = await fetch(streamUrl, {
        headers: { "User-Agent": UA, Range: "bytes=0-65535" },
        signal: AbortSignal.timeout(15000),
      });
      const buf = new Uint8Array(await dl.arrayBuffer());
      lines.push(
        `${label} stream http=${dl.status} bytes=${buf.length} type=${dl.headers.get("content-type")}`,
      );
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause;
      lines.push(
        `${label} stream ERR ${error instanceof Error ? error.message : String(error)} cause=${cause?.code ?? "-"}`,
      );
    }
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    lines.push(
      `${label} ERR ${error instanceof Error ? error.message : String(error)} cause=${cause?.code ?? "-"} ${Date.now() - start}ms`,
    );
  }
  return lines;
}

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  void request;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  const lines: string[] = [];

  for (const base of [
    "https://pipedapi.adminforge.de",
    "https://pipedapi.reallyaweso.me",
    "https://pipedapi.ducks.party",
    "https://api.piped.private.coffee",
  ]) {
    lines.push(...(await probe(`piped ${new URL(base).host}`, `${base}/streams/${VIDEO}`)));
  }

  for (const base of [
    "https://inv.nadeko.net",
    "https://yewtu.be",
    "https://invidious.nerdvpn.de",
    "https://iv.melmac.space",
    "https://invidious.jing.rocks",
  ]) {
    lines.push(...(await probe(`inv ${new URL(base).host}`, `${base}/api/v1/videos/${VIDEO}`)));
  }

  lines.push(
    ...(
      await probe("cobalt official", "https://api.cobalt.tools/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${VIDEO}`, downloadMode: "audio" }),
      })
    ).map((line) => line),
  );

  lines.push(
    ...(
      await probe("cobalt canine", "https://cobalt-backend.canine.tools/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${VIDEO}`, downloadMode: "audio" }),
      })
    ).map((line) => line),
  );

  response.statusCode = 200;
  response.end(lines.join("\n"));
}
