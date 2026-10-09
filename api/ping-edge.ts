export const config = { runtime: "edge" };

const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const TARGET = "https://www.cifraclub.com.br/legiao-urbana/tempo-perdido/";

export default async function handler(request: Request): Promise<Response> {
  const lines: string[] = [];

  try {
    const res = await fetch(TARGET, {
      headers: {
        "User-Agent": UA_CHROME,
        Accept: "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "pt-BR,pt;q=0.9",
      },
    });
    const html = await res.text();
    lines.push(`edge cifraclub status=${res.status} len=${html.length}`);
    lines.push(`chord=${html.includes('data-chord-content="true"')} tom=${html.includes("cifra_tom")} sm=${html.includes("strummings")}`);
    lines.push(`head=${html.slice(0, 200).replace(/\s+/g, " ")}`);
  } catch (error) {
    lines.push(`edge ERR ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const res = await fetch("https://solr.sscdn.co/cc/h2/select?q=test&wt=json&rows=1");
    lines.push(`edge solr status=${res.status}`);
  } catch (error) {
    lines.push(`edge solr ERR ${error instanceof Error ? error.message : String(error)}`);
  }

  lines.push(`region=${(request as { geo?: { region?: string } }).geo?.region ?? "?"}`);

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
