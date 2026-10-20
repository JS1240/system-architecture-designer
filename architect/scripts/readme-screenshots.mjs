// Captures the README screenshots from the running dev server (npm run dev -- --port 5174) into ../docs/images.
// Usage: node scripts/readme-screenshots.mjs
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const out = fileURLToPath(new URL('../../docs/images/', import.meta.url))
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch())
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } })
const shot = (name) => page.screenshot({ path: `${out}${name}.png` })
const open = async (scenario) => {
  await page.goto('http://localhost:5174', { waitUntil: 'networkidle' })
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'networkidle' })
  await page.evaluate((name) => [...document.querySelectorAll('.scenario')].find((b) => b.textContent.includes(name)).click(), scenario)
  await page.waitForTimeout(800)
  await page.getByText('Auto-design the rest with recommendations').click()
  // The change summary toast covers the scene; a screenshot does not need it.
  await page.addStyleTag({ content: '.toast { display: none !important; }' })
  await page.waitForTimeout(3000)
}

await page.goto('http://localhost:5174', { waitUntil: 'networkidle' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle' })
await shot('welcome')

await open('Video streaming (Netflix)')
await shot('architecture-3d')
await page.getByRole('button', { name: 'Cost', exact: true }).click()
await page.waitForTimeout(1200)
await shot('cost')
await page.getByRole('button', { name: 'Close', exact: true }).first().click()

await open('SQL Server reporting database moved into Fabric')
await shot('data-platform-migration')
await page.getByRole('button', { name: 'Explore and versions', exact: true }).click()
await page.waitForTimeout(1500)
await page.getByText('Compare providers').first().scrollIntoViewIfNeeded()
await shot('compare-providers')

await browser.close()
console.log(`saved to ${out}`)
