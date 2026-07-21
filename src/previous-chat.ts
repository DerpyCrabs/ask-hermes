export function shouldRememberPreviousChat(messageCount: number, openedFromSessionShortcut: boolean) {
  return messageCount > 0 && !openedFromSessionShortcut
}
