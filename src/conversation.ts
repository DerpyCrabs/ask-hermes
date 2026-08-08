import type { Capture } from './captures'

export type Exchange = {
  id: string
  prompt: string
  answer: string
  error?: string
  images: Capture[]
  status: 'pending' | 'complete' | 'error' | 'interrupted'
}

export function beginExchange(items: Exchange[], exchange: Omit<Exchange, 'answer' | 'status'>): Exchange[] {
  return [...items, { ...exchange, answer: '', status: 'pending' }]
}

export function appendAnswerDelta(items: Exchange[], id: string, text: string): Exchange[] {
  return items.map(item => item.id === id && item.status === 'pending'
    ? { ...item, answer: item.answer + text }
    : item)
}

export function finishExchange(items: Exchange[], id: string, answer: string): Exchange[] {
  return items.map(item => item.id === id && item.status === 'pending'
    ? { ...item, answer, status: 'complete' }
    : item)
}

export function failExchange(items: Exchange[], id: string, message: string): Exchange[] {
  return items.map(item => item.id === id && item.status === 'pending'
    ? { ...item, error: message, status: 'error' }
    : item)
}

export function interruptExchange(items: Exchange[], id: string): Exchange[] {
  return items.map(item => item.id === id && item.status === 'pending'
    ? { ...item, status: 'interrupted' }
    : item)
}

/** Appends a fresh pending exchange while preserving the stopped/failed attempt. */
export function retryExchange(items: Exchange[], id: string, retryId: string): Exchange[] {
  const source = items.find(item => item.id === id)
  if (!source || (source.status !== 'interrupted' && source.status !== 'error')) return items
  return beginExchange(items, {
    id: retryId,
    prompt: source.prompt,
    images: [...source.images],
  })
}
