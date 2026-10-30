// Screenshots a room's walls at phone width: the intro, each wall with its outlines shown (?outlines), the text after a
// plain tap on the first object that has a painted close-up, and the first note read from the pocket. Saves
// local/walls-<id>-<width>-<n>.png.
// usage: node scripts/shoot-walls.mjs <room id> [--base http://localhost:8080] [--width 390]
import { writeFileSync } from 'node:fs'
import { browser, sleep } from './browser.mjs'

const args = process.argv.slice(2)
const opt = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d)
const [id] = args
const BASE = opt('--base', 'http://localhost:8080')
const W = Number(opt('--width', 390))
const OUT = new URL('../local/', import.meta.url)
const b = await browser({ width: W, height: 844 })
const shot = async (name) => {
  const s = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(new URL(`walls-${id}-${W}-${name}.png`, OUT), Buffer.from(s.result.data, 'base64'))
}
const WIDE = `const de = document.documentElement; return de.scrollWidth > de.clientWidth + 1 ? 'page is ' + de.scrollWidth + 'px wide' : ''`
try {
  await b.send('Page.enable')
  await b.send('Page.navigate', { url: `${BASE}/r/${id}?outlines` })
  await sleep(3000)
  await shot('intro')
  await b.evaluate(`[...document.querySelectorAll('button')].find((x) => x.textContent.includes('Start'))?.click()`)
  const walls = await b.evaluate(`return document.querySelectorAll('.walls span').length || 1`)
  for (let w = 0; w < walls; w++) {
    await sleep(1200)
    await shot(`wall${w + 1}`)
    const wide = await b.evaluate(WIDE)
    if (wide) console.log(`wall ${w + 1}: ${wide}`)
    await b.evaluate(`document.querySelector('[aria-label="Turn right"]')?.click()`)
  }
  const room = await (await fetch(`${BASE}/api/rooms/${id}`)).json()
  const o = room.objects.find((x) => x.detail)
  if (o) {
    for (let w = 0; w < ((o.wall ?? 0) + walls) % walls; w++) await b.evaluate(`document.querySelector('[aria-label="Turn right"]').click()`), await sleep(400)
    await b.evaluate(`document.querySelector('[aria-label=${JSON.stringify(o.label)}]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await sleep(1500)
    await shot('detail')
  }
  // The first note, read from the pocket (?pocket= starts the room holding it).
  const note = room.items.find((x) => x.text)
  if (note) {
    await b.send('Page.navigate', { url: `${BASE}/r/${id}?pocket=${note.id}` })
    await sleep(3000)
    await b.evaluate(`[...document.querySelectorAll('button')].find((x) => x.textContent.includes('Start'))?.click()`)
    await sleep(800)
    await b.evaluate(`[...document.querySelectorAll('.pocket button')].find((x) => x.textContent.includes(${JSON.stringify(note.name)}))?.click()`)
    await sleep(1200)
    await shot('note')
  }
  console.log(`${walls} wall(s); detail: ${o?.label ?? 'none'}; note: ${note?.name ?? 'none'}`)
} finally {
  b.close()
}
