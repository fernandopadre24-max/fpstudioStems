import { readdirSync } from "node:fs";

export async function GET(): Promise<Response> {
  const lines: string[] = [];

  try {
    lines.push("cwd=" + process.cwd());
    lines.push(`root = ${readdirSync(".").join(", ")}`);
    lines.push(`server = ${readdirSync("./server").join(", ")}`);
  } catch (error) {
    lines.push("fs ERR " + (error instanceof Error ? error.message : String(error)));
  }

  try {
    const mod = await import("../server/http.js");
    lines.push(`import .js -> ok (${typeof mod.sendJson})`);
  } catch (error) {
    lines.push(`import .js -> ERR ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const mod = await import("../server/youtube-core.js");
    lines.push(`import youtube-core.js -> ok (${typeof mod.handleYouTubeApi})`);
  } catch (error) {
    lines.push(`import youtube-core.js -> ERR ${error instanceof Error ? error.message : String(error)}`);
  }

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
