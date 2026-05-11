import fs from "node:fs/promises";
import path from "node:path";

const envPath = path.resolve(process.cwd(), ".env");

export async function updateEnvFile(values: Record<string, string>): Promise<void> {
  let current = "";
  try {
    current = await fs.readFile(envPath, "utf8");
  } catch {
    current = "";
  }

  const lines = current.split(/\r?\n/);
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) return line;
    const key = match[1];
    if (!(key in values)) return line;
    seen.add(key);
    return `${key}=${values[key]}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }

  await fs.writeFile(envPath, `${next.filter((line, index, all) => line || index < all.length - 1).join("\n")}\n`, "utf8");
}
