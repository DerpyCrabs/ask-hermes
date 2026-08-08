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

const PHYSICAL_CODES = new Set([
  'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp',
  'Backquote', 'Backslash', 'Backspace', 'BracketLeft', 'BracketRight',
  'CapsLock', 'Comma', 'Delete', 'End', 'Enter', 'Equal', 'Escape',
  'Home', 'Insert', 'Minus', 'NumLock',
  'NumpadAdd', 'NumpadDecimal', 'NumpadDivide', 'NumpadEnter', 'NumpadEqual',
  'NumpadMultiply', 'NumpadSubtract',
  'PageDown', 'PageUp', 'Pause', 'Period', 'PrintScreen', 'Quote',
  'ScrollLock', 'Semicolon', 'Slash', 'Space', 'Tab',
])

type ShortcutKeyboardEvent =
  Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>
  & Partial<Pick<KeyboardEvent, 'code'>>

function shortcutKeyFromCode(code?: string) {
  if (!code) return undefined
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F(?:[1-9]|1\d|2[0-4])$/.test(code)) return code
  if (/^Numpad[0-9]$/.test(code)) return code
  return PHYSICAL_CODES.has(code) ? code : undefined
}

export function shortcutFromKeyboardEvent(event: ShortcutKeyboardEvent) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return undefined
  const key = shortcutKeyFromCode(event.code)
    ?? SPECIAL_KEYS[event.key]
    ?? (event.key.length === 1
      ? event.key.toUpperCase()
      : (/^F(?:[1-9]|1\d|2[0-4])$/.test(event.key) ? event.key : undefined))
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
