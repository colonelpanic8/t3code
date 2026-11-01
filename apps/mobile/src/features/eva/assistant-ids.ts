function uuidShaped(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Server identities derived from the journal key (a SHA-256 of caller and
 * invocation ID). The server keeps a receipt per command ID, so replaying a
 * plan after a lost reply or process death returns the first outcome.
 */
export function assistantRequestIds(key: string) {
  return {
    commandId: `eva:${key}`,
    threadId: uuidShaped(key.slice(0, 32)),
    messageId: uuidShaped(key.slice(32, 64)),
  };
}
