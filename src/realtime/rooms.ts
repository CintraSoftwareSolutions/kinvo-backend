/**
 * Room naming (spec §7, Batch 9).
 *
 * Three kinds, and the distinction matters:
 *
 *   user:{id}          every socket that user has open. DELIVERY targets this,
 *                      so a message reaches their phone and their tablet.
 *   conversation:{id}  joined only while a chat is open on screen. Typing
 *                      indicators go here so they are not fanned out to devices
 *                      with the thread closed.
 *   device:{user}:{device}
 *                      the sockets of one install. Nothing is delivered here;
 *                      it exists so signing a device out can close them.
 *
 * Naming them through these functions rather than by hand is what stops a
 * mistyped room silently delivering to nobody — a bug with no error, only
 * silence.
 */

export function userRoom(userId: string): string {
  return `user:${userId}`;
}

export function conversationRoom(conversationId: string): string {
  return `conversation:${conversationId}`;
}

export function deviceRoom(userId: string, deviceId: string): string {
  return `device:${userId}:${deviceId}`;
}
