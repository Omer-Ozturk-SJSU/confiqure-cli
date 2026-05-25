import { Credentials } from "./credentials.js";
import { ChangeEntry } from "./diff.js";

export interface RegistryItem {
  pushHistoryId: number;
  classUniqueId: string;
  className: string;
  filePath: string | null;
  gitVersion: string;
  configEnd: string;
  pushTime: string;
}

export interface UploadStatusItem {
  classUniqueId: string;
  className: string;
  pushHistoryId: number | null;
  status: "ACCEPTED" | "REJECTED" | "DELETED";
  instructionsRunId: number | null;
  error: string | null;
}

export interface UploadResponse {
  workspaceKey: string;
  totalClasses: number;
  accepted: number;
  rejected: number;
  items: UploadStatusItem[];
}

export interface ManifestFileEntry {
  path: string;
  sha: string;
}

export interface Manifest {
  workspaceKey: string;
  gitRef: string;
  headSha: string;
  language: string;
  changes: ChangeEntry[];
  files: ManifestFileEntry[];
  toolFiles?: ManifestFileEntry[];
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface WhoamiResponse {
  workspaceKey: string;
  workspaceName: string;
  role: string;
}

/**
 * Resolve an API token to its workspace identity without requiring the
 * caller to know the workspaceKey upfront. Used by `confiqure login` so
 * the user only has to paste the token.
 */
export async function getWhoami(apiBase: string, token: string): Promise<WhoamiResponse> {
  const res = await fetch(`${apiBase}/api/cli/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new ApiError(res.status, `GET /api/cli/whoami failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as WhoamiResponse;
}

export interface PushStatus {
  pushHistoryId: number;
  className: string;
  configEnd: string;
  pushTime: string;
  playbookReady: boolean;
  tombstoned: boolean;
}

export async function getPushStatus(
  creds: Credentials,
  pushHistoryId: number
): Promise<PushStatus> {
  const res = await fetch(
    `${creds.apiBase}/api/${creds.workspaceKey}/upload/status/${pushHistoryId}`,
    { headers: { Authorization: `Bearer ${creds.token}` } }
  );
  if (!res.ok) {
    throw new ApiError(res.status, `GET /upload/status/${pushHistoryId} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as PushStatus;
}

export async function getRegistry(creds: Credentials): Promise<RegistryItem[]> {
  const res = await fetch(
    `${creds.apiBase}/api/${creds.workspaceKey}/upload`,
    { headers: { Authorization: `Bearer ${creds.token}` } }
  );
  if (!res.ok) {
    throw new ApiError(res.status, `GET /upload failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as RegistryItem[];
}

export interface WorkspaceSettings {
  workspaceId: number;
  urlKey: string;
  name: string;
  defaultCallbackUrl: string | null;
}

export async function getWorkspace(creds: Credentials): Promise<WorkspaceSettings> {
  const res = await fetch(
    `${creds.apiBase}/api/${creds.workspaceKey}/cli/workspace`,
    { headers: { Authorization: `Bearer ${creds.token}` } }
  );
  if (!res.ok) {
    throw new ApiError(res.status, `GET /cli/workspace failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as WorkspaceSettings;
}

export async function updateWorkspace(
  creds: Credentials,
  changes: { defaultCallbackUrl?: string | null }
): Promise<WorkspaceSettings> {
  const res = await fetch(
    `${creds.apiBase}/api/${creds.workspaceKey}/cli/workspace`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(changes),
    }
  );
  if (!res.ok) {
    throw new ApiError(res.status, `PUT /cli/workspace failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as WorkspaceSettings;
}

export interface ToolItem {
  id: number;
  name: string;
  url: string;
  instructions: string | null;
  hasHmacSecret: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listTools(creds: Credentials): Promise<ToolItem[]> {
  const res = await fetch(
    `${creds.apiBase}/api/${creds.workspaceKey}/cli/tools`,
    { headers: { Authorization: `Bearer ${creds.token}` } }
  );
  if (!res.ok) {
    throw new ApiError(res.status, `GET /cli/tools failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ToolItem[];
}

export async function upsertTool(
  creds: Credentials,
  name: string,
  url: string,
  instructions: string | null
): Promise<ToolItem> {
  const res = await fetch(
    `${creds.apiBase}/api/${creds.workspaceKey}/cli/tools/${encodeURIComponent(name)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url, instructions: instructions ?? null }),
    }
  );
  if (!res.ok) {
    throw new ApiError(res.status, `PUT /cli/tools/${name} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ToolItem;
}

export async function deleteTool(creds: Credentials, name: string): Promise<void> {
  const res = await fetch(
    `${creds.apiBase}/api/${creds.workspaceKey}/cli/tools/${encodeURIComponent(name)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${creds.token}` },
    }
  );
  if (!res.ok && res.status !== 404) {
    throw new ApiError(res.status, `DELETE /cli/tools/${name} failed: ${res.status} ${await res.text()}`);
  }
}

export async function postUpload(
  creds: Credentials,
  manifest: Manifest,
  files: Map<string, string>
): Promise<UploadResponse> {
  const form = new FormData();
  form.append("manifest", JSON.stringify(manifest));

  // Paths can contain slashes; URL-encode for the filename slot so the server
  // can decode without the multipart parser dropping directory components.
  for (const [path, content] of files) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    form.append("sources", blob, encodeURIComponent(path));
  }

  const res = await fetch(
    `${creds.apiBase}/api/${creds.workspaceKey}/upload`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.token}` },
      body: form,
    }
  );
  if (!res.ok) {
    throw new ApiError(res.status, `POST /upload failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as UploadResponse;
}
