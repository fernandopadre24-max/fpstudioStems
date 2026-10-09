import type { IncomingMessage, ServerResponse } from "node:http";

const VIDEO = "tI9kSZgMLsc";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

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
  lines.push(`hop1 http=${hop1.status}`);
  const location = hop1.headers.get("location") ?? "";
  lines.push(`loc len=${location.length} ipbypass=${location.includes("ipbypass=yes")} mip=${location.includes("mip=")}`);
  lines.push(`loc=${location.slice(0, 700)}`);

  if (!location) {
    response.end(lines.join("\n"));
    return;
  }

  const hop2variants: Array<{ label: string; init: RequestInit }> = [
    { label: "hop2 manual+UA", init: { redirect: "manual", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25000) } },
    { label: "hop2 auto+UA", init: { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25000) } },
    { label: "hop2 auto+range", init: { headers: { "User-Agent": UA, Range: "bytes=0-65535" }, signal: AbortSignal.timeout(25000) } },
  ];

  for (const variant of hop2variants) {
    try {
      const res = await fetch(location, variant.init);
      let note = "";
      if (res.status === 200 || res.status === 206) {
        const buf = new Uint8Array(await res.arrayBuffer());
        note = ` bytes=${buf.length}`;
      } else if (res.status >= 300 && res.status < 400) {
        note = ` loc2=${(res.headers.get("location") ?? "").slice(0, 200)}`;
      } else {
        const text = await res.text();
        note = ` body=${text.slice(0, 250).replace(/\s+/g, " ")}`;
      }
      lines.push(`${variant.label} http=${res.status} type=${res.headers.get("content-type")}${note}`);
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause;
      lines.push(
        `${variant.label} ERR ${error instanceof Error ? error.message : String(error)} cause=${cause?.code ?? "-"}`,
      );
    }
  }

  response.statusCode = 200;
  response.end(lines.join("\n"));
}
