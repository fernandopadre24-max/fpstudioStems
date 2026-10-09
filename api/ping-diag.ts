import { readdirSync } from "node:fs";

export async function GET(): Promise<Response> {
  const lines: string[] = [];

  try {
    lines.push("cwd=" + process.cwd());
  } catch (error) {
    lines.push("cwd err " + String(error));
  }

  for (const dir of [".", "./server", "./api"]) {
    try {
      lines.push(`${dir} = ${readdirSync(dir).join(", ")}`);
    } catch (error) {
      lines.push(`${dir} ERR ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const mod = await import("../server/http");
    lines.push(`import sem extensao -> ok (${typeof mod.sendJson})`);
  } catch (error) {
    lines.push(
      `import sem extensao -> ERR ${error instanceof Error ? `${error.message} :: ${error.stack?.split("\n")[1] ?? ""}` : String(error)}`,
    );
  }

  try {
    const mod = await import("../server/http.ts");
    lines.push(`import com .ts -> ok (${typeof mod.sendJson})`);
  } catch (error) {
    lines.push(
      `import com .ts -> ERR ${error instanceof Error ? `${error.message} :: ${error.stack?.split("\n")[1] ?? ""}` : String(error)}`,
    );
  }

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
