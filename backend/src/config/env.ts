function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}. Copy backend/.env.example to backend/.env`);
  return value;
}

export const env = {
  PORT: Number(process.env.PORT ?? 3004),
  DATABASE_URL: required("DATABASE_URL"),
  JWT_SECRET: required("JWT_SECRET"),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN ?? "7d",
  CORS_ORIGINS: (process.env.CORS_ORIGINS ?? "http://localhost:5173").split(",").map((s) => s.trim()),
  STORAGE_DIR: process.env.STORAGE_DIR ?? "./storage",
  MEDIAMTX_WEBHOOK_SECRET: process.env.MEDIAMTX_WEBHOOK_SECRET ?? "",

  /**
   * Where a creator's OBS dials in. This is the PUBLIC address of MediaMTX's
   * :1935 — not localhost, because the string is handed to a human to paste into
   * software on their own machine. Defaults to PUBLIC_URL's host, which is right
   * whenever the API and MediaMTX sit on the same box (they do here).
   */
  MEDIAMTX_RTMP_HOST: process.env.MEDIAMTX_RTMP_HOST ?? "",
  MEDIAMTX_RTMP_PORT: Number(process.env.MEDIAMTX_RTMP_PORT ?? 1935),

  // Optional: without a key the API boots fine and only the AI co-builder returns
  // 503. Never expose this to the browser — the SPA calls /api/ai/* instead.
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "",
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini",
  PUBLIC_URL: process.env.PUBLIC_URL ?? "https://diudara2.mhamzah.id",
};

/** `rtmp://<host>:<port>` — the half of an ingest URL that is deployment, not session. */
export function rtmpBaseUrl(): string {
  const host = env.MEDIAMTX_RTMP_HOST || new URL(env.PUBLIC_URL).hostname;
  return `rtmp://${host}:${env.MEDIAMTX_RTMP_PORT}`;
}
