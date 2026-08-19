## Task 2: `MediaStoragePort`, a fake, and the Biznet adapter

**Files:**
- Create: `apps/api/src/application/ports/media-storage.port.ts`
- Create: `apps/api/src/infrastructure/storage/fake-media-storage.adapter.ts`
- Create: `apps/api/src/infrastructure/storage/s3-media-storage.adapter.ts`
- Modify: `apps/api/src/bootstrap.ts`
- Modify: `apps/api/.env.example`
- Test: `apps/api/src/infrastructure/storage/fake-media-storage.adapter.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `MediaStoragePort`, `MediaObject`, `FakeMediaStorageAdapter`, `S3MediaStorageAdapter`, and a `mediaStorage` entry on the bootstrap deps.

- [ ] **Step 1: Write the port**

```ts
/** Bytes plus what the delivery route must send with them. */
export interface MediaObject {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Where image bytes live. Two objects per image — see the spec's §4 for the key
 * layout. Callers pass a media id and a variant; **no caller ever composes a
 * bucket key or a URL**, which is what keeps §5.1 true by construction.
 */
export interface MediaStoragePort {
  put(id: string, variant: "full" | "thumb", bytes: Uint8Array): Promise<void>;
  /** `null` when the object is not there — a media row whose bytes are missing must 404, not 500. */
  get(id: string, variant: "full" | "thumb"): Promise<MediaObject | null>;
  /** Idempotent: removing an absent object is a no-op, matching `softDelete` on posts. */
  remove(id: string): Promise<void>;
}
```

- [ ] **Step 2: Write the failing fake-adapter test**

```ts
import { describe, expect, it } from "bun:test";
import { FakeMediaStorageAdapter } from "./fake-media-storage.adapter";

describe("FakeMediaStorageAdapter", () => {
  it("returns the bytes it was given, per variant", async () => {
    const storage = new FakeMediaStorageAdapter();
    await storage.put("m1", "full", new Uint8Array([1, 2, 3]));
    await storage.put("m1", "thumb", new Uint8Array([9]));

    expect((await storage.get("m1", "full"))?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect((await storage.get("m1", "thumb"))?.bytes).toEqual(new Uint8Array([9]));
  });

  it("answers null for an object that was never stored", async () => {
    expect(await new FakeMediaStorageAdapter().get("nope", "full")).toBe(null);
  });

  it("remove takes both variants, and removing twice is not an error", async () => {
    const storage = new FakeMediaStorageAdapter();
    await storage.put("m1", "full", new Uint8Array([1]));
    await storage.put("m1", "thumb", new Uint8Array([2]));

    await storage.remove("m1");
    await storage.remove("m1");

    expect(await storage.get("m1", "full")).toBe(null);
    expect(await storage.get("m1", "thumb")).toBe(null);
  });
});
```

- [ ] **Step 3: Run it, watch it fail, then implement the fake**

An in-memory `Map` keyed on `` `${id}:${variant}` ``, `contentType: "image/webp"`. Expose `size` for tests that want to assert nothing leaked.

- [ ] **Step 4: Implement the S3 adapter**

Bun has an S3 client built in — **no dependency to add**. Biznet Gio NEO is S3-compatible, so it needs an explicit endpoint.

```ts
import { S3Client } from "bun";
import type { MediaObject, MediaStoragePort } from "../../application/ports/media-storage.port";

/**
 * Biznet Gio NEO Object Storage, or any S3-compatible bucket. Bun ships the
 * client, so this adds no dependency.
 *
 * The key layout lives HERE and nowhere else. Nothing outside this file knows
 * that media is stored as `posts/<id>/full.webp` — the port takes an id and a
 * variant — which is what makes a bucket URL structurally unable to escape into
 * a response (spec §5.1).
 */
export class S3MediaStorageAdapter implements MediaStoragePort {
  private readonly client: S3Client;

  constructor(config: {
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    endpoint: string;
    region: string;
  }) {
    this.client = new S3Client(config);
  }

  private key(id: string, variant: "full" | "thumb"): string {
    return `posts/${id}/${variant}.webp`;
  }

  async put(id: string, variant: "full" | "thumb", bytes: Uint8Array): Promise<void> {
    await this.client.write(this.key(id, variant), bytes, { type: "image/webp" });
  }

  async get(id: string, variant: "full" | "thumb"): Promise<MediaObject | null> {
    const file = this.client.file(this.key(id, variant));
    if (!(await file.exists())) return null;
    return { bytes: new Uint8Array(await file.arrayBuffer()), contentType: "image/webp" };
  }

  async remove(id: string): Promise<void> {
    // Both variants, and absent objects are not an error.
    await Promise.all([
      this.client.file(this.key(id, "full")).delete().catch(() => {}),
      this.client.file(this.key(id, "thumb")).delete().catch(() => {}),
    ]);
  }
}
```

- [ ] **Step 5: Wire it into `bootstrap.ts`**

Follow the messaging/payments pattern exactly: read the five env vars, and when any is missing fall back to the fake **only** in a relaxed `NODE_ENV`, logging which adapter was chosen and why. Copy the shape of the payments block at `bootstrap.ts:690`.

Env vars: `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`.

The log line, when real:

```
[bootstrap] media storage: S3MediaStorageAdapter (bucket <name> at <endpoint>) — uploads are REAL
```

and when fake:

```
[bootstrap] media storage: FakeMediaStorageAdapter — uploads are kept IN MEMORY and vanish on restart
(S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_BUCKET/S3_ENDPOINT/S3_REGION not all set, and NODE_ENV is
development/test). Set all five to store real images.
```

Unlike messaging, a missing bucket in production **must block boot** — an API that accepts uploads and silently drops them into memory is worse than one that refuses to start.

- [ ] **Step 6: Document the five vars in `.env.example`**

With a comment naming Biznet Gio NEO and pointing at the portal's Access page. **Never commit a real key** — the example file carries names and empty values only.

- [ ] **Step 7: Run the api suite and commit**

```bash
cd apps/api && bun test
git add apps/api/src/application/ports apps/api/src/infrastructure/storage apps/api/src/bootstrap.ts apps/api/.env.example
git commit -m "feat(api): a media storage port, a fake, and the Biznet S3 adapter"
```

---

