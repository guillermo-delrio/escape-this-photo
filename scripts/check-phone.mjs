// Phone check (needs `npm run dev -- --port 5291` and chromium). At 360 and 390 px with mobile emulation it plays the
// Van Gogh room through by tapping, fails if any screen is wider than the phone or the room doesn't end won, follows the won screen's link to the
// gallery (every picture must load), and saves
// a screenshot of each stage to local/phone-<width>-<stage>.png.
// usage: node scripts/check-phone.mjs [--base http://localhost:5291]
import { mkdirSync, writeFileSync } from 'node:fs'
import { browser, sleep } from './browser.mjs'

const args = process.argv.slice(2)
const BASE = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://localhost:5291'
const OUT = new URL('../local/', import.meta.url)
const WIDTHS = [360, 390]

const click = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'missing ' + ${JSON.stringify(sel)}; e.dispatchEvent(new MouseEvent('click', { bubbles: true })); return '' })()`
const button = (text) => `(() => { const e = [...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(text)})); if (!e) return 'missing button ' + ${JSON.stringify(text)}; e.click(); return '' })()`
// A close-up covers the room; a player taps it away before the next tap, so the script does too.
const closeZoom = `(() => { document.querySelector('.zoom')?.click(); return '' })()`
const STAGES = [
  ['intro', []],
  ['key', [button('Start'), click('[aria-label="straw chair"]')]],
  ['note', [closeZoom, button('small brass key'), click('[aria-label="table drawer"]'), click('[aria-label="pictures"]')]],
  ['read', [closeZoom, button("Vincent's note")]],
  ['lock', [closeZoom, click('[aria-label="pillows"]'), closeZoom, click('[aria-label="door"]'), ...Array(5).fill(click('[aria-label="Digit 1 up"]')), ...Array(2).fill(click('[aria-label="Digit 2 up"]'))]],
  ['won', [button('Turn the handle')]],
]
const WIDE = `(() => { const de = document.documentElement; return de.scrollWidth > de.clientWidth + 1 ? 'page is ' + de.scrollWidth + 'px wide' : '' })()`

mkdirSync(OUT, { recursive: true })
let failures = 0
for (const w of WIDTHS) {
  const b = await browser({ width: w, height: 800 })
  try {
    await b.send('Page.enable')
    await b.send('Page.navigate', { url: BASE + '/' })
    await sleep(2500)
    for (const [stage, steps] of STAGES) {
      for (const s of steps) {
        const err = await b.evaluate(`return ${s}`)
        if (err) console.log(`${w}px ${stage}: ${err}`), failures++
        await sleep(150)
      }
      await sleep(600) // let the close-up's lift and fade (0.38 s) finish, or the shot shows it half transparent
      const wide = await b.evaluate(`return ${WIDE}`)
      if (wide) console.log(`${w}px ${stage}: ${wide}`), failures++
      const shot = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      writeFileSync(new URL(`phone-${w}-${stage}.png`, OUT), Buffer.from(shot.result.data, 'base64'))
    }
    if (!(await b.evaluate(`return !!document.querySelector('.card.won')`))) console.log(`${w}px: the room did not end won`), failures++
    // The gallery: reached from the won screen's link, every room hung, nothing wider than the phone.
    const err = await b.evaluate(`return ${click('a[href="/rooms"]')}`)
    if (err) console.log(`${w}px gallery: ${err}`), failures++
    await sleep(1500)
    // Pictures load lazily, so walk down the hang the way a thumb would before counting them.
    const n = await b.evaluate(`return document.querySelectorAll('.hang li').length`)
    for (let i = 0; i < n; i++) await b.evaluate(`document.querySelectorAll('.hang li')[${i}].scrollIntoView(); return ''`), await sleep(300)
    await sleep(1500)
    const hung = await b.evaluate(`return [...document.querySelectorAll('.hang img')].filter((i) => i.complete && i.naturalWidth).length + '/' + document.querySelectorAll('.hang li').length`)
    if (!/^([2-9]|\d\d+)\/\1$/.test(hung)) console.log(`${w}px gallery: pictures loaded ${hung}`), failures++
    const wide = await b.evaluate(`return ${WIDE}`)
    if (wide) console.log(`${w}px gallery: ${wide}`), failures++
    const shot = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    writeFileSync(new URL(`phone-${w}-gallery.png`, OUT), Buffer.from(shot.result.data, 'base64'))
  } finally {
    b.close()
  }
}
console.log(failures ? `\n${failures} problem(s)` : `phone ok: played through and opened the gallery at ${WIDTHS.join(', ')} px`)
process.exit(failures ? 1 : 0)
