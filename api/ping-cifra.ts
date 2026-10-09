const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const TARGET_PATH = "www.cifraclub.com.br/legiao-urbana/tempo-perdido/";

async function probe(label: string, url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA_CHROME, Accept: "*/*" } });
    const body = await res.text();
    return `${label} -> status=${res.status} len=${body.length} :: ${body
      .slice(0, 160)
      .replace(/\s+/g, " ")}`;
  } catch (error) {
    return `${label} -> ERR ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function GET(): Promise<Response> {
  const lines: string[] = [];

  for (const collection of ["CC-MAIN-2026-39", "CC-MAIN-2026-33", "CC-MAIN-2026-26"]) {
    lines.push(
      await probe(
        `cc ${collection}`,
        `https://index.commoncrawl.org/${collection}-index?url=${encodeURIComponent(TARGET_PATH)}&output=json&limit=1&matchType=exact`,
      ),
    );
  }

  lines.push(await probe("adonay", "https://www.adonay.com.br/"));
  lines.push(await probe("cifras.com", "https://cifras.com/"));
  lines.push(await probe("tudocifra", "https://www.tudocifra.com/"));
  lines.push(
    await probe(
      "acordesweb busca",
      `https://acordesweb.com/resultados.php?busca=tempo%20perdido%20legiao%20urbana`,
    ),
  );

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
