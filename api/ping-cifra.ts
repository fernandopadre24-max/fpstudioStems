const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const STAMP = "20240511124339";
const TARGET = "https://www.cifraclub.com.br/legiao-urbana/tempo-perdido/";

export async function GET(): Promise<Response> {
  const lines: string[] = [];

  let html = "";
  try {
    const res = await fetch(`https://arquivo.pt/wayback/${STAMP}id_/${TARGET}`, {
      headers: { "User-Agent": UA_CHROME, Accept: "text/html" },
    });
    html = await res.text();
    lines.push(`fetch status=${res.status} len=${html.length}`);
  } catch (error) {
    lines.push(`fetch ERR ${error instanceof Error ? error.message : String(error)}`);
  }

  if (html) {
    const markers = [
      "data-chord-content",
      "cifra_tom",
      "strummings",
      "<pre",
      "pre code",
      "chord-content",
      "letra",
      "main_content",
    ];
    for (const marker of markers) {
      const count = html.split(marker).length - 1;
      lines.push(`marker "${marker}" count=${count}`);
    }

    const tomAt = html.indexOf("cifra_tom");
    if (tomAt >= 0) {
      lines.push(
        `CTX cifra_tom = ${html.slice(Math.max(0, tomAt - 300), tomAt + 700).replace(/\s+/g, " ")}`,
      );
    }

    const preAt = html.indexOf("<pre");
    if (preAt >= 0) {
      lines.push(`CTX pre = ${html.slice(preAt, preAt + 700).replace(/\s+/g, " ")}`);
    }

    const dataAttrs = new Set<string>();
    for (const m of html.matchAll(/data-[a-z-]+=/g)) dataAttrs.add(m[0]);
    lines.push(`data attrs = ${[...dataAttrs].slice(0, 60).join(" ")}`);

    const classes = new Set<string>();
    for (const m of html.matchAll(/class="([^"]*(?:chord|cifra|ct_|tab|letra)[^"]*)"/g)) {
      classes.add(m[1]);
    }
    lines.push(`classes = ${[...classes].slice(0, 40).join(" | ")}`);
  }

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
