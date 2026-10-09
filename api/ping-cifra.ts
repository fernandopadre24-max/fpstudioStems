const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const TARGET = "https://www.cifraclub.com.br/legiao-urbana/tempo-perdido/";

interface ProbeResult {
  label: string;
  status: number;
  length: number;
  hasChord: boolean;
  server: string;
  note: string;
}

async function probe(
  label: string,
  url: string,
  headers: Record<string, string>,
): Promise<ProbeResult> {
  try {
    const res = await fetch(url, { headers, redirect: "follow" });
    const html = await res.text();
    return {
      label,
      status: res.status,
      length: html.length,
      hasChord: html.includes('data-chord-content="true"'),
      server: res.headers.get("server") ?? "-",
      note: html.slice(0, 120).replace(/\s+/g, " "),
    };
  } catch (error) {
    return {
      label,
      status: 0,
      length: 0,
      hasChord: false,
      server: "-",
      note: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function GET(): Promise<Response> {
  const browserHeaders: Record<string, string> = {
    "User-Agent": UA_CHROME,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "Upgrade-Insecure-Requests": "1",
    "Cache-Control": "max-age=0",
  };

  const results: ProbeResult[] = [];

  results.push(
    await probe("1 chrome simples", TARGET, {
      "User-Agent": UA_CHROME,
      Accept: "text/html,application/xhtml+xml,*/*",
      "Accept-Language": "pt-BR,pt;q=0.9",
    }),
  );
  results.push(await probe("2 chrome completo", TARGET, browserHeaders));
  results.push(await probe("3 sem headers", TARGET, {}));
  results.push(await probe("4 UA curl", TARGET, { "User-Agent": "curl/8.5.0" }));
  results.push(
    await probe(
      "5 googlebot",
      TARGET,
      { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
    ),
  );
  results.push(
    await probe(
      "6 host sem www",
      "https://cifraclub.com.br/legiao-urbana/tempo-perdido/",
      browserHeaders,
    ),
  );
  results.push(
    await probe(
      "7 archive.org",
      "https://web.archive.org/web/2024id_/" + TARGET,
      { "User-Agent": UA_CHROME },
    ),
  );

  const lines = results.map(
    (r) =>
      `${r.label} -> status=${r.status} len=${r.length} chord=${r.hasChord} server=${r.server}\n   ${r.note}`,
  );

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
