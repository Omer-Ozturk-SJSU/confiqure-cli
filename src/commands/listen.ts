import { Command } from "commander";
import chalk from "chalk";
import WebSocket from "ws";
import { requireCredentials } from "../credentials.js";

/**
 * `confiqure listen` — Stripe-CLI-style outbound forwarder for local dev.
 *
 * Dials a long-lived WebSocket OUT to confiqure (authenticated by the developer's
 * API key in the Authorization header), so the laptop needs no inbound port,
 * firewall rule, tailnet, or public IP. confiqure pushes this developer's SANDBOX
 * callbacks (server-side tool dispatches + lifecycle events) down the pipe; the CLI
 * replays each as a local HTTP POST and (for tool dispatches) streams the response
 * back. Per-developer routing means concurrent testers only get their own callbacks.
 */
export function registerListen(program: Command): void {
  program
    .command("listen")
    .description("Forward this workspace's sandbox callbacks to a local URL (no inbound port needed)")
    .option("-f, --forward <url>", "local base URL to replay callbacks to", "http://localhost:9595")
    .action(async (opts: { forward: string }) => {
      const creds = await requireCredentials();
      const forwardBase = opts.forward.replace(/\/+$/, "");
      const wsUrl = `${creds.apiBase.replace(/^http/, "ws")}/api/cli/forward/ws`;

      let backoffMs = 1000;
      let stopped = false;

      const connect = (): void => {
        console.log(chalk.dim(`connecting to ${wsUrl} …`));
        const ws = new WebSocket(wsUrl, {
          headers: { Authorization: `Bearer ${creds.token}` },
        });

        ws.on("open", () => {
          backoffMs = 1000;
          console.log(
            chalk.green("✓"),
            `listening — forwarding sandbox callbacks to ${chalk.bold(forwardBase)}  (Ctrl-C to stop)`
          );
        });

        ws.on("message", async (raw: WebSocket.RawData) => {
          let frame: {
            deliveryId: number;
            kind: string;
            payload: Record<string, unknown> & { path?: string; toolName?: string; event?: string };
            rawBody?: string;
            headers?: Record<string, string>;
            replyExpected: boolean;
          };
          try {
            frame = JSON.parse(raw.toString());
          } catch {
            return;
          }
          const url = localUrl(forwardBase, frame.payload?.path);
          const label = frame.payload?.toolName ?? frame.payload?.event ?? frame.kind;
          console.log(chalk.cyan("→"), `${frame.kind}  ${chalk.bold(String(label))}  →  ${url}`);
          // Prefer the exact bytes confiqure signed (rawBody) + the forwarded headers
          // (incl. X-Confiqure-Signature) so local verification matches production exactly.
          // Fall back to re-serializing the parsed payload for older relay frames.
          const body = frame.rawBody ?? JSON.stringify(frame.payload);
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "X-Confiqure-Event": frame.kind === "tool" ? "tool.dispatch" : String(frame.payload?.event ?? "lifecycle"),
            ...(frame.headers ?? {}),
          };
          try {
            const res = await fetch(url, { method: "POST", headers, body });
            const respBody = await res.text();
            console.log(chalk.dim(`  ${res.ok ? chalk.green(res.status) : chalk.red(res.status)} · ${respBody.length} bytes`));
            if (frame.replyExpected) {
              ws.send(JSON.stringify({ deliveryId: frame.deliveryId, status: res.status, body: respBody }));
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(chalk.red(`  local POST failed: ${msg}`));
            if (frame.replyExpected) {
              ws.send(JSON.stringify({ deliveryId: frame.deliveryId, status: 0, body: msg }));
            }
          }
        });

        ws.on("close", (code: number) => {
          if (stopped) return;
          console.log(chalk.yellow(`disconnected (${code}); reconnecting in ${Math.round(backoffMs / 1000)}s…`));
          setTimeout(connect, backoffMs);
          backoffMs = Math.min(backoffMs * 2, 30000);
        });

        ws.on("error", (err: Error) => {
          // 'close' fires after 'error'; surface the reason (e.g. 401 bad key) once.
          console.log(chalk.red(`✗ ${err.message}`));
        });

        process.on("SIGINT", () => {
          stopped = true;
          try { ws.close(); } catch { /* ignore */ }
          console.log(chalk.dim("\nstopped."));
          process.exit(0);
        });
      };

      connect();
    });
}

/** Join the local forward base with the delivery's target path (absolute paths are reduced to their pathname). */
function localUrl(forwardBase: string, path: string | undefined): string {
  let p = path ?? "/";
  if (p.startsWith("http://") || p.startsWith("https://")) {
    try {
      p = new URL(p).pathname;
    } catch {
      p = "/";
    }
  }
  if (!p.startsWith("/")) p = "/" + p;
  return forwardBase + p;
}
