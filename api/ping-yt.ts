import type { IncomingMessage, ServerResponse } from "node:http";

const VIDEO = "tI9kSZgMLsc";

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  streamingData?: {
    formats?: Array<{ mimeType?: string; url?: string; signatureCipher?: string }>;
    adaptiveFormats?: Array<{ mimeType?: string; url?: string; signatureCipher?: string }>;
  };
}

async function probeClient(
  name: string,
  clientName: string,
  clientVersion: string,
  extra: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<string[]> {
  const lines: string[] = [];
  try {
    const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Youtube-Client-Name": String(name === "ANDROID" ? 3 : 1),
        "X-Youtube-Client-Version": clientVersion,
        ...headers,
      },
      body: JSON.stringify({
        context: { client: { clientName, clientVersion, hl: "pt", gl: "BR", ...extra } },
        videoId: VIDEO,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    });
    const text = await res.text();
    lines.push(`${name} http=${res.status} len=${text.length}`);
    if (res.status !== 200) {
      lines.push(`${name} body=${text.slice(0, 200).replace(/\s+/g, " ")}`);
      return lines;
    }
    const data = JSON.parse(text) as PlayerResponse;
    lines.push(
      `${name} playability=${data.playabilityStatus?.status ?? "?"} reason=${data.playabilityStatus?.reason ?? "-"}`,
    );
    const adaptive = data.streamingData?.adaptiveFormats ?? [];
    const progressive = data.streamingData?.formats ?? [];
    lines.push(`${name} adaptive=${adaptive.length} formats=${progressive.length}`);
    const audio = [...adaptive, ...progressive].find((f) => (f.mimeType ?? "").startsWith("audio/"));
    if (!audio) {
      const any = [...adaptive, ...progressive][0];
      lines.push(`${name} sample=${any ? any.mimeType : "nenhum formato"}`);
      return lines;
    }
    lines.push(`${name} audio mime=${audio.mimeType?.slice(0, 80)}`);
    if (audio.signatureCipher || !audio.url) {
      lines.push(`${name} CIPHER presente (${(audio.signatureCipher ?? "").slice(0, 80)})`);
      return lines;
    }
    lines.push(`${name} url host=${new URL(audio.url).host} url[0..100]=${audio.url.slice(0, 100)}`);

    try {
      const dl = await fetch(audio.url, {
        headers: { "User-Agent": headers["User-Agent"] ?? "Mozilla/5.0", Range: "bytes=0-65535" },
      });
      const buf = new Uint8Array(await dl.arrayBuffer());
      lines.push(
        `${name} googlevideo http=${dl.status} bytes=${buf.length} type=${dl.headers.get("content-type")} range=${dl.headers.get("content-range")}`,
      );
    } catch (error) {
      lines.push(`${name} googlevideo ERR ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    lines.push(`${name} ERR ${error instanceof Error ? error.message : String(error)}`);
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

  lines.push(
    ...(await probeClient(
      "ANDROID",
      "ANDROID",
      "19.09.37",
      { androidSdkVersion: 30, userAgent: "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip" },
      { "User-Agent": "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip" },
    )),
  );

  lines.push(
    ...(await probeClient(
      "WEB",
      "WEB",
      "2.20250216.01.00",
      { userAgent: undefined as unknown as string },
      { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36" },
    )),
  );

  lines.push(
    ...(await probeClient(
      "MWEB",
      "MWEB",
      "2.20250216.01.00",
      {},
      { "User-Agent": "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36" },
    )),
  );

  response.statusCode = 200;
  response.end(lines.join("\n"));
}
