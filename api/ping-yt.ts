import type { IncomingMessage, ServerResponse } from "node:http";

const VIDEO = "tI9kSZgMLsc";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0";

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  void request;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  const lines: string[] = [];

  try {
    const start = Date.now();
    const res = await fetch(`https://invidious.f5.si/api/v1/videos/${VIDEO}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    lines.push(`api http=${res.status} len=${text.length} ${Date.now() - start}ms`);
    if (res.status !== 200) {
      lines.push(`body=${text.slice(0, 200)}`);
      response.end(lines.join("\n"));
      return;
    }
    const data = JSON.parse(text) as {
      title?: string;
      adaptiveFormats?: Array<{ type?: string; mimeType?: string; url?: string }>;
    };
    lines.push(`title=${data.title} formats=${data.adaptiveFormats?.length ?? 0}`);
    const audio = (data.adaptiveFormats ?? []).find((f) => (f.type ?? f.mimeType ?? "").startsWith("audio/"));
    if (!audio?.url) {
      lines.push("sem formato de audio");
      response.end(lines.join("\n"));
      return;
    }
    lines.push(`audio type=${audio.type} host=${new URL(audio.url).host}`);

    const start2 = Date.now();
    const dl = await fetch(audio.url, {
      headers: { "User-Agent": UA, Range: "bytes=0-262143" },
      signal: AbortSignal.timeout(30000),
    });
    const buf = new Uint8Array(await dl.arrayBuffer());
    lines.push(
      `stream http=${dl.status} bytes=${buf.length} type=${dl.headers.get("content-type")} ${Date.now() - start2}ms`,
    );
    lines.push(`primeiros=${[...buf.slice(4, 8)].map((b) => String.fromCharCode(b)).join("")}`);
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    lines.push(
      `ERR ${error instanceof Error ? error.message : String(error)} cause=${cause?.code ?? "-"}`,
    );
  }

  response.statusCode = 200;
  response.end(lines.join("\n"));
}
