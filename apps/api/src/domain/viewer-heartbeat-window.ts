/**
 * How long a viewer's last heartbeat keeps counting them as "watching" —
 * see `stream_viewer_heartbeat`'s own docstring in `db/schema.ts`. Twenty
 * seconds comfortably survives a normal HLS reload gap while dropping
 * someone within a few reloads of actually leaving.
 *
 * Lives in `domain/`, not in `application/use-cases/stream-views.ts` where it
 * first shipped, because `DrizzleCommunityRepository` (infrastructure) needs
 * it too — to answer "is this community live" the same way `stream-views.ts`
 * answers "how many are watching" — and infrastructure must not import
 * application. One constant, in the one layer both sides may depend on.
 */
export const VIEWER_HEARTBEAT_WINDOW_MS = 20_000;
