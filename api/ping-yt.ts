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
  const data = (await api.json()) as {
    adaptiveFormats?: Array<{ type?: string; url?: string }>;
  };
  const audio = (data.adaptiveFormats ?? []).find((f) => (f.type ?? "").startsWith("audio/"));
  if (!audio?.url) {
    response.end("sem audio");
    return;
  }
  lines.push(`url[0..160]=${audio.url.slice(0, 160)}`);

  const attempts: Array<{ label: string; init: RequestInit }> = [
    { label: "A sem headers", init: { signal: AbortSignal.timeout(20000) } },
    {
      label: "B range+UA",
      init: { headers: { "User-Agent": UA, Range: "bytes=0-65535" }, signal: AbortSignal.timeout(20000) },
    },
    {
      label: "C UA+referer",
      init: {
        headers: { "User-Agent": UA, Referer: "https://www.youtube.com/", Origin: "https://www.youtube.com" },
        signal: AbortSignal.timeout(20000),
      },
    },
    {
      label: "D range so",
      init: { headers: { Range: "bytes=0-65535" }, signal: AbortSignal.timeout(20000) },
    },
    {
      label: "E redirect manual",
      init: { redirect: "manual", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) },
    },
  ];

  for (const attempt of attempts) {
    try {
      const res = await fetch(audio.url, attempt.init);
      const ct = res.headers.get("content-type");
      let bodyNote = "";
      if (res.status !== 200 && res.status !== 206 && res.status !== 302) {
        const text = await res.text();
        bodyNote = ` :: ${text.slice(0, 200).replace(/\s+/g, " ")}`;
      } else if (res.status === 302) {
        bodyNote = ` :: loc=${(res.headers.get("location") ?? "").slice(0, 140)}`;
      } else {
        const buf = new Uint8Array(await res.arrayBuffer());
        bodyNote = ` :: bytes=${buf.length}`;
      }
      lines.push(
        `${attempt.label} http=${res.status} type=${ct} loc=${res.headers.get("content-location") ?? "-"}${bodyNote}`,
      );
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause;
      lines.push(
        `${attempt.label} ERR ${error instanceof Error ? error.message : String(error)} cause=${cause?.code ?? "-"}`,
      );
    }
  }

  response.statusCode = 200;
  response.end(lines.join("\n"));
}
