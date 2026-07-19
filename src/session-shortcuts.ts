import type { Exchange } from './conversation'

export type SessionShortcut = { id: string; shortcut: string; sessionId: string }
export type HistoryMessage = { id: number; role: 'user' | 'assistant'; content: string }
export type HistoryPage = { messages: HistoryMessage[]; has_older: boolean }

const SPECIAL_KEYS: Record<string, string> = {
  ' ': 'Space',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ArrowUp: 'ArrowUp',
  Delete: 'Delete',
  End: 'End',
  Enter: 'Enter',
  Home: 'Home',
  Insert: 'Insert',
  PageDown: 'PageDown',
  PageUp: 'PageUp',
  Tab: 'Tab',
}

export function shortcutFromKeyboardEvent(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return undefined
  const key = event.key.length === 1
    ? event.key.toUpperCase()
    : (/^F(?:[1-9]|1\d|2[0-4])$/.test(event.key) ? event.key : SPECIAL_KEYS[event.key])
  if (!key) return undefined
  const modifiers = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super'].filter(Boolean)
  if (modifiers.length === 0) return undefined
  return [...modifiers, key].join('+')
}

export function transcriptFromMessages(messages: HistoryMessage[]): Exchange[] {
  const exchanges: Exchange[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      exchanges.push({
        id: `history-${message.id}`,
        prompt: message.content,
        answer: '',
        images: [],
        status: 'complete',
      })
    } else if (exchanges.length > 0) {
      exchanges[exchanges.length - 1] = { ...exchanges[exchanges.length - 1], answer: message.content }
    }
  }
  return exchanges
}
