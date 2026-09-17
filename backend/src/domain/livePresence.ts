/**
 * How long a viewer counts as watching after their player last checked in.
 *
 * Wider than the player's ping interval (LiveRoomPage pings every 20s) so one
 * dropped request does not make someone vanish from the count, and narrow enough
 * that a closed tab disappears within a minute rather than lingering as a number
 * nobody is behind. This is the whole definition of "N menonton" — there is no
 * other source for it.
 */
export const VIEWER_PRESENCE_WINDOW_SECONDS = 45;
