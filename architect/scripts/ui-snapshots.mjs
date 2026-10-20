// Renders the running dev server (npm run dev -- --port 5174) in six UI states and saves static HTML with inlined CSS,
// so file-based accessibility gates can measure the real UI. Usage: node scripts/ui-snapshots.mjs <dir with playwright> <out dir>
import { createRequire } from 'node:module'
import { writeFileSync, mkdirSync } from 'node:fs'
const require = createRequire(process.argv[2] + '/')
const { chromium } = require('playwright')
const out = process.argv[3]
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch())
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto('http://localhost:5174', { waitUntil: 'networkidle' })
const dump = async (name) => {
  const html = await page.evaluate(() => {
    const css = [...document.styleSheets].map((s) => { try { return [...s.cssRules].map((r) => r.cssText).join('\n') } catch { return '' } }).join('\n')
    const clone = document.documentElement.cloneNode(true)
    clone.querySelectorAll('script, link[rel=stylesheet], style, canvas').forEach((n) => n.remove())
    const style = document.createElement('style'); style.textContent = css
    clone.querySelector('head').appendChild(style)
    return '<!doctype html>' + clone.outerHTML
  })
  writeFileSync(`${out}/${name}.html`, html)
}
await page.evaluate(() => localStorage.clear()); await page.reload({ waitUntil: 'networkidle' })
await dump('welcome')
await page.evaluate(() => [...document.querySelectorAll('.scenario')].find((b) => b.textContent.includes('E-commerce store')).click()); await page.waitForTimeout(800)
await dump('question')
await page.getByText('Auto-design the rest with recommendations').click(); await page.waitForTimeout(1500)
await dump('workspace')
await page.getByRole('button', { name: 'Cost', exact: true }).click(); await page.waitForTimeout(1200)
await dump('cost')
await page.getByRole('button', { name: 'Close', exact: true }).first().click()
await page.getByRole('button', { name: 'Explore and versions', exact: true }).click(); await page.waitForTimeout(1500)
await dump('explore')
await page.getByRole('button', { name: 'Documentation', exact: true }).click(); await page.waitForTimeout(800)
await dump('docs')
await page.getByRole('button', { name: 'Close', exact: true }).first().click()
await page.getByRole('tab', { name: /Findings/ }).click(); await page.waitForTimeout(300)
await dump('findings')
await browser.close()
console.log('ok')
