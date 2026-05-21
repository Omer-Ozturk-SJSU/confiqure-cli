import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface LanguageScan {
  extensions: string[];
  tokenPattern: string;
}

export interface ProjectConfig {
  scanPaths: string[];
  ignore: string[];
  languages: Record<string, LanguageScan>;
}

export const CONFIG_FILE = "confiqure.config.json";

/**
 * Default scan + token-pattern config covering the 9 V1 annotation-native
 * languages. Swift V1 uses `Confiqurable` protocol (macro support deferred).
 */
export const DEFAULT_CONFIG: ProjectConfig = {
  scanPaths: ["src/**", "lib/**", "app/**"],
  ignore: [
    "node_modules",
    ".git",
    "target",
    "build",
    "dist",
    ".nuxt",
    ".output",
    ".venv",
    "__pycache__",
    "bin",
    "obj",
  ],
  languages: {
    java:       { extensions: [".java"],   tokenPattern: "@Confiqure" },
    kotlin:     { extensions: [".kt"],     tokenPattern: "@Confiqure" },
    scala:      { extensions: [".scala"],  tokenPattern: "@Confiqure" },
    python:     { extensions: [".py"],     tokenPattern: "@Confiqure" },
    typescript: { extensions: [".ts", ".tsx", ".js", ".jsx"], tokenPattern: "@Confiqure" },
    csharp:     { extensions: [".cs"],     tokenPattern: "[Confiqure" },
    rust:       { extensions: [".rs"],     tokenPattern: "#[confiqure" },
    php:        { extensions: [".php"],    tokenPattern: "#[Confiqure" },
    swift:      { extensions: [".swift"],  tokenPattern: "Confiqurable" },
  },
};

export async function loadConfig(cwd: string): Promise<ProjectConfig> {
  const path = join(cwd, CONFIG_FILE);
  if (!existsSync(path)) {
    return DEFAULT_CONFIG;
  }
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<ProjectConfig>;
  return {
    scanPaths: parsed.scanPaths ?? DEFAULT_CONFIG.scanPaths,
    ignore: parsed.ignore ?? DEFAULT_CONFIG.ignore,
    languages: parsed.languages ?? DEFAULT_CONFIG.languages,
  };
}

export async function saveConfig(cwd: string, config: ProjectConfig): Promise<void> {
  const path = join(cwd, CONFIG_FILE);
  await writeFile(path, JSON.stringify(config, null, 2), { encoding: "utf8" });
}
