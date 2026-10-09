const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const TARGET = "https://www.cifraclub.com.br/legiao-urbana/tempo-perdido/";

async function probe(label: string, url: string, headers: Record<string, string>): Promise<string> {
  try {
    const res = await fetch(url, { headers, redirect: "follow" });
    const body = await res.text();
    const chord = body.includes('data-chord-content="true"');
    const tom = body.includes("cifra_tom");
    const sm = body.includes("strummings");
    return `${label} -> status=${res.status} len=${body.length} chord=${chord} tom=${tom} sm=${sm} :: ${body
      .slice(0, 220)
      .replace(/\s+/g, " ")}`;
  } catch (error) {
    return `${label} -> ERR ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function GET(): Promise<Response> {
  const lines: string[] = [];

  const cdx =
    "https://arquivo.pt/wayback/cdx?url=" +
    encodeURIComponent("cifraclub.com.br/legiao-urbana/tempo-perdido/") +
    "&output=json";
  const stamps: string[] = [];
  try {
    const res = await fetch(cdx, { headers: { "User-Agent": UA_CHROME } });
    const text = await res.text();
    if (text.trim().startsWith("[")) {
      try {
        const rows = JSON.parse(text.trim()) as Array<{ timestamp?: string }>;
        for (const row of rows) if (row.timestamp) stamps.push(row.timestamp);
      } catch {
        /* ignore */
      }
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const row = JSON.parse(trimmed) as { timestamp?: string };
        if (row.timestamp) stamps.push(row.timestamp);
      } catch {
        /* ignore */
      }
    }
    lines.push(`cdx status=${res.status} snapshots=${stamps.length} last=${stamps.slice(-3).join(",")}`);
  } catch (error) {
    lines.push(`cdx ERR ${error instanceof Error ? error.message : String(error)}`);
  }

  const latest = stamps[stamps.length - 1] ?? "";
  const oldest = stamps[0] ?? "";

  for (const [label, stamp] of [
    ["latest", latest],
    ["oldest", oldest],
  ] as const) {
    if (!stamp) continue;
    lines.push(
      await probe(
        `A ${label} ${stamp} id_`,
        `https://arquivo.pt/wayback/${stamp}id_/${TARGET}`,
        { "User-Agent": UA_CHROME, Accept: "text/html" },
      ),
    );
    lines.push(
      await probe(
        `B ${label} ${stamp} plain`,
        `https://arquivo.pt/wayback/${stamp}/${TARGET}`,
        { "User-Agent": UA_CHROME, Accept: "text/html" },
      ),
    );
  }

  try {
    const res = await fetch(
      "https://index.commoncrawl.org/CC-MAIN-2026-39-index?url=" +
        encodeURIComponent("www.cifraclub.com.br/legiao-urbana/tempo-perdido/") +
        "&output=json&limit=1",
      { headers: { "User-Agent": UA_CHROME } },
    );
    const text = await res.text();
    lines.push(`cc index status=${res.status} :: ${text.slice(0, 300).replace(/\s+/g, " ")}`);
  } catch (error) {
    lines.push(`cc index ERR ${error instanceof Error ? error.message : String(error)}`);
  }

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
