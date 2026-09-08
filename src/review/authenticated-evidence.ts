import { createHmac, timingSafeEqual } from "node:crypto";

interface TextSandbox {
  readTextFile(options: { readonly path: string }): PromiseLike<string | null>;
  writeTextFile(options: { readonly path: string; readonly content: string }): PromiseLike<void>;
}

const prefix = "known-good-review-signed-v1 ";

export function evidenceSigningKey(secret: string | undefined): Buffer {
  if (!secret || !/^[a-f0-9]{64}$/i.test(secret)) {
    throw new Error("KNOWN_GOOD_REVIEW_EVIDENCE_KEY must contain 64 hexadecimal characters");
  }
  return Buffer.from(secret, "hex");
}

/** Authenticate application artifacts without putting the key in the sandbox. */
export function authenticatedEvidenceSandbox<T extends TextSandbox>(
  sandbox: T,
  scope: string,
  secret: string | undefined,
): T {
  const key = evidenceSigningKey(secret);
  if (!scope) throw new Error("Evidence authentication requires a root session");
  const signature = (path: string, content: string) => createHmac("sha256", key)
    .update(JSON.stringify([scope, path])).update("\0").update(content).digest();
  const managed = (path: string) => path.startsWith("/tmp/known-good-review/");
  return new Proxy(sandbox, {
    get(target, property) {
      if (property === "readTextFile") return async (options: { path: string }) => {
        const source = await target.readTextFile(options);
        if (source === null || !managed(options.path)) return source;
        const header = source.slice(0, prefix.length + 65);
        const mac = header.slice(prefix.length, -1);
        const content = source.slice(header.length);
        if (!header.startsWith(prefix) || !header.endsWith("\n") ||
            !/^[a-f0-9]{64}$/.test(mac) ||
            !timingSafeEqual(Buffer.from(mac, "hex"), signature(options.path, content))) {
          throw new Error("Review evidence authentication failed");
        }
        return content;
      };
      if (property === "writeTextFile") return (options: { path: string; content: string }) =>
        target.writeTextFile(managed(options.path) ? {
          ...options,
          content: `${prefix}${signature(options.path, options.content).toString("hex")}\n${options.content}`,
        } : options);
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
