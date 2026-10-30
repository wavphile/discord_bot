import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type ReadinessChecks = Readonly<{
  discordReady: () => boolean;
  databaseReady: () => boolean;
}>;

export type ReadinessServer = Readonly<{
  listen: () => Promise<void>;
  close: () => Promise<void>;
  address: () => AddressInfo | string | null;
}>;

export function createReadinessServer(
  checks: ReadinessChecks,
  options: Readonly<{ host?: string; port?: number }> = {},
): ReadinessServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3000;
  const server: Server = createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
      return;
    }
    if (request.url !== "/readyz") {
      response.writeHead(404).end();
      return;
    }

    let ready = false;
    try {
      ready = checks.discordReady() && checks.databaseReady();
    } catch {
      ready = false;
    }

    response
      .writeHead(ready ? 200 : 503, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      })
      .end(JSON.stringify({ status: ready ? "ready" : "not_ready" }));
  });

  return {
    listen: () =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.removeListener("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    address: () => {
      const address = server.address();
      return typeof address === "object" ? (address as AddressInfo) : address;
    },
  };
}
