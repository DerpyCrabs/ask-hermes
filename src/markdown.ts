import { marked } from 'marked'

const escapeHtml = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')

export function renderMarkdown(value: string): string {
  const rendered = marked.parse(escapeHtml(value), { async: false, breaks: true }) as string
  return rendered.replace(/href="([^"]*)"/gi, (attribute, href: string) => {
    if (!/^(https?:|mailto:)/i.test(href)) return ''
    return `${attribute} target="_blank" rel="noreferrer noopener"`
  })
}
