import { Marked } from 'marked'

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Project names, descriptions and custom answers can come from imported files, so raw HTML is escaped and only http(s) links survive.
const safeMarked = new Marked({ renderer: { html: ({ text }) => escapeHtml(text) } })

export function renderSafe(markdown: string): string {
  const html = safeMarked.parse(markdown, { async: false }) as string
  return html.replace(/href="(?!https?:\/\/)[^"]*"/gi, 'href="#"')
}
