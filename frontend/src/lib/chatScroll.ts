import type { ApiMessage } from "./api";

/**
 * Deciding when a chat thread should jump to the newest message.
 *
 * Pulled out of FloatingChat because it is the part with rules rather than DOM:
 * a poll that scrolls unconditionally yanks the view out from under someone
 * reading older messages, and a poll that never scrolls hides the message that
 * just arrived.
 */

export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

/**
 * How far from the bottom still counts as "following the conversation". Roughly
 * one message bubble, so a half-scrolled line does not count someone out.
 */
export const STICK_THRESHOLD_PX = 80;

export function isNearBottom(m: ScrollMetrics, threshold = STICK_THRESHOLD_PX): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold;
}

/**
 * Whether a refetched thread differs from what is on screen.
 *
 * The poll replaces the array every few seconds. Without this check every tick
 * would be a new object, re-rendering the window and firing the scroll effect
 * even when nothing was said — which is both wasted work and a view that will
 * not stay where the reader put it.
 *
 * Compares length and the last id: messages are append-only and never edited, so
 * those two together are enough. An edit feature would need more.
 */
export function threadChanged(current: ApiMessage[] | undefined, next: ApiMessage[]): boolean {
  if (!current) return true;
  if (current.length !== next.length) return true;
  if (next.length === 0) return false;
  return current[current.length - 1]!.id !== next[next.length - 1]!.id;
}
