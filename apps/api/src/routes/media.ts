import { Hono } from "hono";
import { ValidationError } from "../application/errors";
import { UnsupportedImageError } from "../domain/image";
import {
  requireUserAuth,
  type UserAuthVariables,
} from "../http/user-auth.middleware";
import type { Dependencies } from "../bootstrap";

const NO_FILE_MESSAGE = "berkas foto wajib disertakan";

export function mediaRoutes(
  deps: Pick<Dependencies, "userTokenIssuer" | "userRepository" | "uploadMedia">
) {
  const app = new Hono<{ Variables: UserAuthVariables }>();
  const requireAuth = requireUserAuth(deps.userTokenIssuer, deps.userRepository);

  app.post("/media", requireAuth, async (c) => {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ValidationError(NO_FILE_MESSAGE);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());

    // `UploadMedia` lets `UnsupportedImageError` (a plain `Error`, not an
    // `AppError`) through unswallowed — only this route layer knows to turn
    // it into the 400 `errorHandler` can render, reusing the SAME Bahasa
    // message `processUpload` already carries rather than inventing a
    // second one.
    try {
      const result = await deps.uploadMedia.execute({ ownerId: c.get("userId"), bytes });
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof UnsupportedImageError) {
        throw new ValidationError(err.message);
      }
      throw err;
    }
  });

  return app;
}
