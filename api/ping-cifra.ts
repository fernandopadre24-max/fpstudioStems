const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export async function GET(request: Request): Promise<Response> {
  const lines: string[] = [];
  const query = new URL(request.url).searchParams.get("q") ?? "legiao urbana tempo perdido";

  const solr = new URL("https://solr.sscdn.co/cc/h2/select");
  solr.searchParams.set("q", query);
  solr.searchParams.set("wt", "json");
  solr.searchParams.set("rows", "8");

  try {
    const res = await fetch(solr, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    const body = await res.text();
    lines.push(`solr status=${res.status} len=${body.length}`);
    lines.push(`solr body[0..300]=${body.slice(0, 300)}`);
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const data = JSON.parse(body.slice(start, end + 1)) as {
          response?: { docs?: Array<{ m?: string; a?: string; d?: string; u?: string }> };
        };
        const docs = data.response?.docs ?? [];
        lines.push(`docs=${docs.length}`);
        for (const doc of docs.slice(0, 3)) {
          lines.push(`doc d=${doc.d} u=${doc.u} m=${doc.m}`);
        }
        const doc = docs[0];
        if (doc && doc.d && doc.u) {
          const url = `https://www.cifraclub.com.br/${doc.d}/${doc.u}/`;
          const page = await fetch(url, {
            headers: {
              "User-Agent": USER_AGENT,
              Accept: "text/html,application/xhtml+xml,*/*",
              "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
            },
          });
          const html = await page.text();
          lines.push(`page status=${page.status} len=${html.length}`);
          lines.push(`page has data-chord-content=${html.includes('data-chord-content="true"')}`);
          lines.push(`page has cifra_tom=${html.includes("cifra_tom")}`);
          lines.push(`page has strummings=${html.includes("strummings")}`);
          lines.push(`page[0..200]=${html.slice(0, 200).replace(/\s+/g, " ")}`);
        }
      } catch (error) {
        lines.push(`json ERR ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    lines.push(`solr ERR ${error instanceof Error ? error.message : String(error)}`);
  }

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
