import type { Capture } from './captures'

export type Exchange = {
  id: string
  prompt: string
  answer: string
  images: Capture[]
  status: 'pending' | 'complete' | 'error'
}

export function beginExchange(items: Exchange[], exchange: Omit<Exchange, 'answer' | 'status'>): Exchange[] {
  return [...items, { ...exchange, answer: '', status: 'pending' }]
}

export function appendAnswerDelta(items: Exchange[], id: string, text: string): Exchange[] {
  return items.map(item => item.id === id ? { ...item, answer: item.answer + text } : item)
}

export function finishExchange(items: Exchange[], id: string, answer: string): Exchange[] {
  return items.map(item => item.id === id ? { ...item, answer, status: 'complete' } : item)
}
