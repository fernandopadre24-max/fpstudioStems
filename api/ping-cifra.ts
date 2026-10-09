const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const TARGET_PATH = "www.cifraclub.com.br/legiao-urbana/tempo-perdido/";

async function probe(label: string, url: string, headers: Record<string, string>): Promise<string> {
  try {
    const res = await fetch(url, { headers, redirect: "follow" });
    const body = await res.text();
    const chord = body.includes('data-chord-content="true"');
    return `${label} -> status=${res.status} len=${body.length} chord=${chord} :: ${body
      .slice(0, 240)
      .replace(/\s+/g, " ")}`;
  } catch (error) {
    return `${label} -> ERR ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function GET(): Promise<Response> {
  const lines: string[] = [];

  let collection = "";
  try {
    const res = await fetch("https://index.commoncrawl.org/collinfo.json", {
      headers: { "User-Agent": UA_CHROME },
    });
    const data = (await res.json()) as Array<{ id: string }>;
    collection = data[0]?.id ?? "";
    lines.push(`collinfo status=${res.status} latest=${collection}`);
  } catch (error) {
    lines.push(`collinfo ERR ${error instanceof Error ? error.message : String(error)}`);
  }

  if (collection) {
    let filename = "";
    let offset = 0;
    let length = 0;
    try {
      const res = await fetch(
        `https://index.commoncrawl.org/${collection}-index?url=${encodeURIComponent(TARGET_PATH)}&output=json`,
        { headers: { "User-Agent": UA_CHROME } },
      );
      const text = await res.text();
      lines.push(`index status=${res.status} :: ${text.slice(0, 300).replace(/\s+/g, " ")}`);
      const first = text.split("\n").find((line) => line.trim().startsWith("{"));
      if (first) {
        const row = JSON.parse(first) as {
          filename?: string;
          offset?: string;
          length?: string;
          status?: string;
        };
        filename = row.filename ?? "";
        offset = Number(row.offset ?? 0);
        length = Number(row.length ?? 0);
      }
    } catch (error) {
      lines.push(`index ERR ${error instanceof Error ? error.message : String(error)}`);
    }

    if (filename) {
      try {
        const res = await fetch(`https://data.commoncrawl.org/${filename}`, {
          headers: {
            "User-Agent": UA_CHROME,
            Range: `bytes=${offset}-${offset + length - 1}`,
          },
        });
        const buf = new Uint8Array(await res.arrayBuffer());
        const { gunzipSync } = await import("node:zlib");
        const raw = gunzipSync(Buffer.from(buf)).toString("utf8");
        const splitAt = raw.indexOf("\r\n\r\n");
        const header = splitAt > 0 ? raw.slice(0, splitAt) : raw.slice(0, 400);
        const body = splitAt > 0 ? raw.slice(splitAt + 4) : raw;
        const body2 = body.indexOf("\r\n\r\n") > 0 ? body.slice(body.indexOf("\r\n\r\n") + 4) : body;
        lines.push(`warc status=${res.status} gunzip=${raw.length} :: ${header.slice(0, 200).replace(/\s+/g, " ")}`);
        lines.push(
          `warc body len=${body2.length} chord=${body2.includes('data-chord-content="true"')} tom=${body2.includes("cifra_tom")} :: ${body2.slice(0, 200).replace(/\s+/g, " ")}`,
        );
      } catch (error) {
        lines.push(`warc ERR ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  lines.push(
    await probe(
      "arquivo.pt",
      `https://arquivo.pt/wayback/cdx?url=${encodeURIComponent("cifraclub.com.br/legiao-urbana/tempo-perdido/")}&output=json`,
      { "User-Agent": UA_CHROME },
    ),
  );
  lines.push(
    await probe("cifraclub.com", "https://www.cifraclub.com/legiao-urbana/tempo-perdido/", {
      "User-Agent": UA_CHROME,
      Accept: "text/html",
    }),
  );

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
