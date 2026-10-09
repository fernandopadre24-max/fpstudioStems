import type { IncomingMessage, ServerResponse } from "node:http";

const VIDEO = "tI9kSZgMLsc";
const TIMEOUT = AbortSignal.timeout(10000);

async function probeJson(label: string, url: string): Promise<string[]> {
  const lines: string[] = [];
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: TIMEOUT });
    const text = await res.text();
    lines.push(`${label} http=${res.status} len=${text.length}`);
    if (res.status !== 200) {
      lines.push(`${label} body=${text.slice(0, 150).replace(/\s+/g, " ")}`);
      return lines;
    }
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      const audio =
        (data.audioStreams as Array<{ url?: string }> | undefined) ??
        ((data.adaptiveFormats as Array<{ mimeType?: string; url?: string }> | undefined) ?? []).filter(
          (f) => (f.mimeType ?? "").startsWith("audio/"),
        );
      if (!audio || audio.length === 0) {
        lines.push(`${label} sem audioStreams; chaves=${Object.keys(data).slice(0, 12).join(",")}`);
        if (typeof data.error === "string") lines.push(`${label} error=${data.error.slice(0, 120)}`);
        if (typeof data.message === "string") lines.push(`${label} message=${data.message.slice(0, 120)}`);
        return lines;
      }
      const first = audio[audio.length - 1];
      const streamUrl = first.url ?? "";
      lines.push(`${label} audio host=${streamUrl ? new URL(streamUrl).host : "?"} qtd=${audio.length}`);
      if (streamUrl) {
        const dl = await fetch(streamUrl, { headers: { Range: "bytes=0-65535" }, signal: TIMEOUT });
        const buf = new Uint8Array(await dl.arrayBuffer());
        lines.push(
          `${label} stream http=${dl.status} bytes=${buf.length} type=${dl.headers.get("content-type")}`,
        );
      }
    } catch (error) {
      lines.push(`${label} parse ERR ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    lines.push(`${label} ERR ${error instanceof Error ? error.message : String(error)}`);
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

  const piped = [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.adminforge.de",
    "https://api.piped.private.coffee",
    "https://pipedapi.reallyaweso.me",
    "https://pipedapi.ducks.party",
  ];
  for (const base of piped) {
    lines.push(...(await probeJson(`piped ${new URL(base).host}`, `${base}/streams/${VIDEO}`)));
  }

  const invidious = [
    "https://inv.nadeko.net",
    "https://yewtu.be",
    "https://invidious.nerdvpn.de",
    "https://iv.melmac.space",
    "https://invidious.jing.rocks",
  ];
  for (const base of invidious) {
    lines.push(...(await probeJson(`inv ${new URL(base).host}`, `${base}/api/v1/videos/${VIDEO}`)));
  }

  try {
    const res = await fetch("https://api.cobalt.tools/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${VIDEO}`, downloadMode: "audio" }),
      signal: TIMEOUT,
    });
    const text = await res.text();
    lines.push(`cobalt http=${res.status} :: ${text.slice(0, 300).replace(/\s+/g, " ")}`);
  } catch (error) {
    lines.push(`cobalt ERR ${error instanceof Error ? error.message : String(error)}`);
  }

  response.statusCode = 200;
  response.end(lines.join("\n"));
}
