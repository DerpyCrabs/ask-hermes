import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('renders common Markdown', () => {
    const html = renderMarkdown('**bold**\n\n- one\n- two\n\n`code`')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<code>code</code>')
  })

  it('does not execute raw HTML or javascript links', () => {
    const html = renderMarkdown('<script>alert(1)</script> [bad](javascript:alert(1)) ![bad](javascript:alert(2))')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('src="javascript:')
  })
})
