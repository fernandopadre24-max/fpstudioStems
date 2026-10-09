const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const TARGET = "https://www.cifraclub.com.br/legiao-urbana/tempo-perdido/";
const ENC = encodeURIComponent(TARGET);

async function probe(label: string, url: string, headers: Record<string, string>): Promise<string> {
  try {
    const res = await fetch(url, { headers, redirect: "follow" });
    const body = await res.text();
    const chord = body.includes('data-chord-content="true"');
    const tom = body.includes("cifra_tom");
    return `${label} -> status=${res.status} len=${body.length} chord=${chord} tom=${tom} :: ${body
      .slice(0, 140)
      .replace(/\s+/g, " ")}`;
  } catch (error) {
    return `${label} -> ERR ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function GET(): Promise<Response> {
  const lines: string[] = [];

  lines.push(await probe("1 allorigins", `https://api.allorigins.win/raw?url=${ENC}`, {}));
  lines.push(await probe("2 codetabs", `https://api.codetabs.com/v1/proxy/?quest=${ENC}`, {}));
  lines.push(await probe("3 corsproxy.io", `https://corsproxy.io/?url=${ENC}`, {}));
  lines.push(
    await probe("4 thingproxy", `https://thingproxy.freeboard.io/fetch/${TARGET}`, {
      "User-Agent": UA_CHROME,
    }),
  );
  lines.push(
    await probe("5 r.jina.ai html", `https://r.jina.ai/${TARGET}`, {
      "User-Agent": UA_CHROME,
      "x-respond-with": "html",
      Accept: "text/html",
    }),
  );
  lines.push(
    await probe(
      "6 wayback 2024",
      `https://web.archive.org/web/20240601000000id_/${TARGET}`,
      { "User-Agent": UA_CHROME, Accept: "text/html" },
    ),
  );
  lines.push(
    await probe("7 wayback avail", `https://archive.org/wayback/available?url=${ENC}`, {
      Accept: "application/json",
    }),
  );

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
