import { request as https } from "node:https";
import { SoftwareAuthenticator } from "./software-authenticator.js";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";

/** Actual loopback HTTPS; no Fastify injection or authentication bypass. */
export function httpClient(
  origin: string,
  cert: string,
  authorization?: string,
) {
  let cookies: Record<string, string> = {},
    csrf = "";
  async function call(
    path: string,
    body?: unknown,
    overrides: { method?: string; headers?: Record<string, string>; bytes?:Buffer } = {},
  ) {
    const encoded = overrides.bytes ?? (body === undefined ? undefined : JSON.stringify(body));
    const headers: Record<string, string> = {
      ...(authorization ? { authorization: "Bearer " + authorization } : {}),
      ...(Object.keys(cookies).length
        ? {
            cookie: Object.entries(cookies)
              .map(([key, value]) => key + "=" + value)
              .join("; "),
          }
        : {}),
      ...(encoded
        ? {
            "content-type": overrides.bytes ? "application/octet-stream" : "application/json",
            "content-length": String(Buffer.byteLength(encoded)),
            origin,
            ...(csrf ? { "x-loom-csrf": csrf } : {}),
          }
        : {}),
      ...overrides.headers,
    };
    return new Promise<{
      status: number;
      body: any;
      bytes: number;
      headers: Record<string, unknown>;
    }>((resolve, reject) => {
      const req = https(
        new URL(path, origin),
        {
          ca: cert,
          // Fixtures restart at the same origin; a pooled socket can still be closing.
          // Each call owns its connection so writes need no transport retry.
          agent: false,
          method: overrides.method ?? (encoded ? "POST" : "GET"),
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            for (const cookie of res.headers["set-cookie"] ?? []) {
              const [key, ...value] = cookie.split(";")[0]!.split("=");
              cookies[key!] = value.join("=");
            }
            const text = Buffer.concat(chunks).toString("utf8");
            let body: unknown;
            try {
              body = JSON.parse(text);
            } catch {
              body = text;
            }
            resolve({
              status: res.statusCode!,
              body,
              bytes: Buffer.byteLength(text),
              headers: res.headers,
            });
          });
        },
      );
      req.on("error", reject);
      req.end(encoded);
    });
  }
  return {
    call,
    async enroll(ticket: string) {
      const authenticator = new SoftwareAuthenticator(origin);
      const start = await call("/api/v1/identity/register/start", { ticket });
      if (start.status !== 200)
        throw new Error(
          "Registration start failed: " + JSON.stringify(start.body),
        );
      const bound = await call("/api/v1/identity/register/finish", {
        challenge_id: start.body.challenge_id,
        response: authenticator.registration(
          start.body.options as PublicKeyCredentialCreationOptionsJSON,
        ),
      });
      if (bound.status !== 200)
        throw new Error(
          "Registration finish failed: " + JSON.stringify(bound.body),
        );
      const signin = await call("/api/v1/identity/signin/start", {});
      const signed = await call("/api/v1/identity/signin/finish", {
        challenge_id: signin.body.challenge_id,
        response: authenticator.assertion(
          signin.body.options as PublicKeyCredentialRequestOptionsJSON,
        ),
      });
      if (signed.status !== 200)
        throw new Error("Sign-in failed: " + JSON.stringify(signed.body));
      const self = await call("/api/v1/identity/self");
      csrf = self.body.csrf;
      return self.body;
    },
  };
}
