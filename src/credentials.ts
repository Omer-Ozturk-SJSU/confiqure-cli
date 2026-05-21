import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";

export interface Credentials {
  apiBase: string;
  workspaceKey: string;
  token: string;
}

const DEFAULT_API_BASE = "https://api.confiqure.ai";

export function credentialsPath(): string {
  if (platform() === "win32") {
    const base = process.env.APPDATA ?? homedir();
    return join(base, "confiqure", "credentials");
  }
  return join(homedir(), ".confiqure", "credentials");
}

/** Env vars override the file — handy for CI. */
function envCredentials(): Credentials | null {
  const token = process.env.CONFIQURE_API_KEY;
  const workspaceKey = process.env.CONFIQURE_WORKSPACE_KEY;
  if (!token || !workspaceKey) return null;
  return {
    apiBase: process.env.CONFIQURE_API_BASE ?? DEFAULT_API_BASE,
    workspaceKey,
    token,
  };
}

export async function loadCredentials(): Promise<Credentials | null> {
  const fromEnv = envCredentials();
  if (fromEnv) return fromEnv;

  const path = credentialsPath();
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<Credentials>;
    if (!parsed.token || !parsed.workspaceKey) return null;
    return {
      apiBase: parsed.apiBase ?? DEFAULT_API_BASE,
      workspaceKey: parsed.workspaceKey,
      token: parsed.token,
    };
  } catch {
    return null;
  }
}

export async function saveCredentials(creds: Credentials): Promise<void> {
  const path = credentialsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(creds, null, 2), { encoding: "utf8" });
  if (platform() !== "win32") {
    try {
      await chmod(path, 0o600);
    } catch {
      /* best-effort */
    }
  }
}

export async function requireCredentials(): Promise<Credentials> {
  const creds = await loadCredentials();
  if (!creds) {
    throw new Error(
      `Not logged in. Run \`confiqure login\` to set up credentials at ${credentialsPath()}.`
    );
  }
  return creds;
}
