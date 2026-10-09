import { zip } from "fflate";

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

export async function createZip(entries: ZipEntry[]): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    files[entry.name] = new Uint8Array(await entry.blob.arrayBuffer());
  }

  const result = await new Promise<Uint8Array>((resolve, reject) => {
    zip(files, { level: 0 }, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });

  return new Blob([result as unknown as BlobPart], { type: "application/zip" });
}

export function totalSize(entries: ZipEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.blob.size, 0);
}

export function downloadSequentially(entries: ZipEntry[]) {
  entries.forEach((entry, index) => {
    window.setTimeout(() => downloadBlob(entry.blob, entry.name), index * 600);
  });
}
