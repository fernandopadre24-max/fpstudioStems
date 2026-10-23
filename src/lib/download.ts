import { Zip, ZipDeflate, ZipPassThrough } from "fflate";

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
}

export function sanitizeBaseName(name: string): string {
  const withoutExtension = name.replace(/\.[^.]+$/, "");
  return (
    withoutExtension
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "musica"
  );
}

export interface ZipEntry {
  name: string;
  blob: Blob;
}

/** Texto comprime bem; WAV ganha ~14% rapido; MP3/OGG ja vem comprimido. */
function zipMethodFor(name: string): { level: 0 | 1 | 6 } {
  if (/\.(txt|lrc|csv|json|xml)$/i.test(name)) return { level: 6 };
  if (/\.wav$/i.test(name)) return { level: 1 };
  return { level: 0 };
}

export interface ZipWriter {
  add(entry: ZipEntry): Promise<void>;
  finish(): Promise<Blob>;
}

/**
 * Monta o ZIP em fluxo: cada trilha e codificada, entra no pacote e e liberada
 * antes da proxima. Antes o app juntava TODAS as trilhas em memoria e, acima de
 * 512 MB, desistia e baixava os arquivos soltos — o "Baixar tudo (.zip)" virava
 * uma enxurrada de downloads separados. Agora sai sempre um .zip unico.
 *
 * `onBytes` recebe o total ja processado, para mostrar o andamento.
 */
export function createZipWriter(onBytes?: (bytes: number) => void): ZipWriter {
  const chunks: Uint8Array[] = [];
  let failure: Error | null = null;
  let bytes = 0;
  let reportedMb = 0;
  const archive = new Zip((error, chunk) => {
    if (error) failure = error;
    else chunks.push(chunk);
  });

  return {
    async add({ name, blob }) {
      const { level } = zipMethodFor(name);
      const file = level > 0 ? new ZipDeflate(name, { level }) : new ZipPassThrough(name);
      archive.add(file);

      const push = (data: Uint8Array, final: boolean) => {
        if (!final) bytes += data.byteLength;
        file.push(data, final);
        // Atualiza no maximo uma vez por MB: um render por bloco de 64 KB
        // travaria a interface num pacote grande.
        const mb = Math.floor(bytes / (1024 * 1024));
        if (mb !== reportedMb) {
          reportedMb = mb;
          onBytes?.(bytes);
        }
        if (failure) throw failure;
      };

      if (typeof blob.stream === "function") {
        const reader = blob.stream().getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (failure) throw failure;
          if (done) break;
          const before = Math.floor(bytes / (1024 * 1024));
          push(value, false);
          // Solta a thread uma vez por MB para a interface continuar viva
          // (o deflate roda no thread principal).
          if (Math.floor(bytes / (1024 * 1024)) > before) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
        }
      } else {
        push(new Uint8Array(await blob.arrayBuffer()), false);
      }
      push(new Uint8Array(0), true);
      if (failure) throw failure;
    },

    async finish() {
      archive.end();
      if (failure) throw failure;
      return new Blob(chunks as unknown as BlobPart[], { type: "application/zip" });
    },
  };
}
