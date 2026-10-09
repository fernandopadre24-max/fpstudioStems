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
      .slice(0, 200)
      .replace(/\s+/g, " ")}`;
  } catch (error) {
    return `${label} -> ERR ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function GET(): Promise<Response> {
  const lines: string[] = [];

  const cdxUrl =
    "https://web.archive.org/cdx/search/cdx?url=www.cifraclub.com.br/legiao-urbana/tempo-perdido/" +
    "&output=json&filter=statuscode:200&from=2022&limit=-3";
  let latest = "";
  try {
    const res = await fetch(cdxUrl, { headers: { "User-Agent": UA_CHROME } });
    const text = await res.text();
    lines.push(`cdx -> status=${res.status} :: ${text.slice(0, 400).replace(/\s+/g, " ")}`);
    const rows = JSON.parse(text) as string[][];
    const last = rows[rows.length - 1];
    if (last && last[1]) latest = last[1];
  } catch (error) {
    lines.push(`cdx ERR ${error instanceof Error ? error.message : String(error)}`);
  }

  if (latest) {
    lines.push(
      await probe(
        `B snapshot id_ ${latest}`,
        `https://web.archive.org/web/${latest}id_/${TARGET}`,
        { "User-Agent": UA_CHROME, Accept: "text/html" },
      ),
    );
    lines.push(
      await probe(`C snapshot plain ${latest}`, `https://web.archive.org/web/${latest}/${TARGET}`, {
        "User-Agent": UA_CHROME,
        Accept: "text/html",
      }),
    );
  }

  lines.push(
    await probe("D archive.ph newest", `https://archive.ph/newest/${TARGET}`, {
      "User-Agent": UA_CHROME,
      Accept: "text/html",
    }),
  );
  lines.push(
    await probe(
      "E cors.isomorphic-git",
      `https://cors.isomorphic-git.org/${TARGET}`,
      { "User-Agent": UA_CHROME },
    ),
  );
  lines.push(
    await probe("F allorigins get", `https://api.allorigins.win/get?url=${ENC}`, {}),
  );
  lines.push(
    await probe("G codetabs retry", `https://api.codetabs.com/v1/proxy/?quest=${ENC}`, {}),
  );

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
