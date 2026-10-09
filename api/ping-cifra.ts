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
    const preAt = html.indexOf("<pre");
    if (preAt >= 0) {
      const preEnd = html.indexOf("</pre>", preAt);
      const pre = html.slice(preAt, preEnd > 0 ? preEnd + 6 : preAt + 6000);
      lines.push(`PRE total=${pre.length}`);
      lines.push(`PRE[0..4000]=${pre.slice(0, 4000).replace(/\n/g, "\\n")}`);
    }

    const partAt = html.indexOf("Primeira Parte");
    if (partAt >= 0) {
      lines.push(
        `CTX parte = ${html.slice(Math.max(0, partAt - 500), partAt + 500).replace(/\n/g, "\\n")}`,
      );
    }
  }

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
