const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const PATH = "legiao-urbana/tempo-perdido/";

async function probe(label: string, url: string, headers: Record<string, string>): Promise<string> {
  try {
    const res = await fetch(url, { headers, redirect: "follow" });
    const body = await res.text();
    const chord = body.includes('data-chord-content="true"');
    const tom = body.includes("cifra_tom");
    const len = body.length;
    const head = body.slice(0, 220).replace(/\s+/g, " ");
    return `${label} -> status=${res.status} len=${len} chord=${chord} tom=${tom} :: ${head}`;
  } catch (error) {
    return `${label} -> ERR ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function GET(): Promise<Response> {
  const lines: string[] = [];

  const solr = new URL("https://solr.sscdn.co/cc/h2/select");
  solr.searchParams.set("q", "legiao urbana tempo perdido");
  solr.searchParams.set("wt", "json");
  solr.searchParams.set("rows", "1");
  solr.searchParams.set("fl", "*");
  lines.push(await probe("A solr fl=*", solr.toString(), { Accept: "application/json" }));

  lines.push(
    await probe(
      "B translate.goog pt-pt",
      `https://www-cifraclub-com-br.translate.goog/${PATH}?_x_tr_sl=pt&_x_tr_tl=pt&_x_tr_hl=pt`,
      {
        "User-Agent": UA_CHROME,
        Accept: "text/html",
        "Accept-Language": "pt-BR,pt;q=0.9",
        Cookie: "CONSENT=YES+1",
      },
    ),
  );
  lines.push(
    await probe(
      "C translate.goog pt-en",
      `https://www-cifraclub-com-br.translate.goog/${PATH}?_x_tr_sl=pt&_x_tr_tl=en&_x_tr_hl=en`,
      { "User-Agent": UA_CHROME, Accept: "text/html" },
    ),
  );

  lines.push(
    await probe(
      "D host m.",
      `https://m.cifraclub.com.br/${PATH}`,
      { "User-Agent": UA_CHROME, Accept: "text/html" },
    ),
  );

  lines.push(await probe("E e-chords root", "https://www.e-chords.com/", { "User-Agent": UA_CHROME }));
  lines.push(
    await probe("F acordesweb root", "https://acordesweb.com/", { "User-Agent": UA_CHROME }),
  );

  lines.push(
    await probe(
      "G wayback cdx",
      "https://web.archive.org/cdx/search/cdx?url=www.cifraclub.com.br/legiao-urbana/tempo-perdido/&output=json&limit=5",
      { "User-Agent": UA_CHROME, Accept: "application/json" },
    ),
  );

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
