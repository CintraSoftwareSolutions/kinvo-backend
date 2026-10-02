
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

export function conversationRoom(conversationId: string): string {
  return `conversation:${conversationId}`;
}

export function deviceRoom(userId: string, deviceId: string): string {
  return `device:${userId}:${deviceId}`;
}
