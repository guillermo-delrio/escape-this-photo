// Blind play-through harness (fix 1b). A phone-sized headless browser holds one room; a player who has never seen the
// room's JSON drives it with commands and sees only what a phone shows: a screenshot and the words on screen. Taps on
// the room are real pointer events at screen points, so an object a finger can't reach can't be tapped here either.
// Wrong codes are capped per lock (MAX_TRIES), so a count that doesn't match its code fails instead of being brute-forced.
//
//   node scripts/blind.mjs serve <room id> --base http://localhost:8093 --out <dir> --port 7701   (keeps running)
//   node scripts/blind.mjs <port> start | look | tap <x> <y> | swipe left|right | turn left|right | item <n> | dial <digits> | back
// Every command prints the screenshot's path and the screen's text. The log of commands is <dir>/log.jsonl, and
// <dir>/result.json says whether the room was escaped.
import { appendFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { browser, sleep } from './browser.mjs'

const MAX_TRIES = 3 // wrong codes per lock before the harness refuses more
const W = 390
const H = 844
const args = process.argv.slice(2)
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)

if (args[0] === 'serve') await serve(args[1])
else await client(args[0], args.slice(1))

async function client(port, cmd) {
  const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: JSON.stringify(cmd) })
  console.log(await r.text())
}

// The local server serves dist/, so a player on a build older than src/ tests yesterday's game.
function staleBuild() {
  const newest = (d) => readdirSync(d, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).reduce((m, e) => Math.max(m, statSync(`${e.parentPath}/${e.name}`).mtimeMs), 0)
  let built = 0
  try { built = statSync('dist/index.html').mtimeMs } catch {}
  return newest('src') > built
}

async function serve(id) {
  if (staleBuild() && !args.includes('--stale-ok')) {
    console.error('dist/ is older than src/: run npx vite build first (or pass --stale-ok)')
    process.exit(1)
  }
  const base = opt('--base', 'http://localhost:8093')
  const out = resolve(opt('--out', `local/blind/${id}`))
  const port = Number(opt('--port', 7701))
  mkdirSync(out, { recursive: true })
  const b = await browser({ width: W, height: H })
  await b.send('Page.enable')
  await b.send('Page.navigate', { url: `${base}/r/${id}` })
  await sleep(3000)
  let step = 0
  const tries = new Map()
  let won = false
  let lastSaid

  const text = () =>
    b.evaluate(`
      const t = (s) => [...document.querySelectorAll(s)].map((e) => e.innerText.trim()).filter(Boolean)
      const lock = document.querySelector('.lock')
      const pan = document.querySelector('.pan')
      const scene = document.querySelector('svg.scene')
      return JSON.stringify({
        title: t('.bar-title')[0],
        card: t('.card').join(' | ') || undefined,
        said: t('[aria-live="polite"].sr-only')[0],
        bubble: t('.bubble')[0],
        closeup: document.querySelector('.zoom') ? t('.zoom').join(' | ') : undefined,
        lock: lock ? lock.querySelector('.lock-name')?.innerText + ', ' + lock.querySelectorAll('.reel').length + ' digits' : undefined,
        pocket: t('.pocket .item').map((s, i) => (i + 1) + ': ' + s),
        wall: scene?.getAttribute('aria-label')?.match(/wall \\d+ of \\d+/)?.[0],
        wallButtons: !!document.querySelector('.turn'),
        view: pan && pan.scrollWidth > pan.clientWidth + 8
          ? 'the screen shows ' + Math.round(pan.scrollLeft / pan.scrollWidth * 100) + '–' + Math.round((pan.scrollLeft + pan.clientWidth) / pan.scrollWidth * 100) + '% of the wall, from its left edge'
            + (pan.scrollLeft > 8 ? '; more to the left (swipe right)' : '; this is the left edge')
            + (pan.scrollLeft < pan.scrollWidth - pan.clientWidth - 8 ? '; more to the right (swipe left)' : '; this is the right edge')
          : undefined,
        selected: t('.pocket .item.on')[0],
        escaped: !!document.querySelector('.card.won'),
      })`)

  async function shot() {
    const name = `${out}/step-${String(++step).padStart(3, '0')}.png`
    const s = await b.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(name, Buffer.from(s.result.data, 'base64'))
    return name
  }
  const clickText = (sel, txt) =>
    b.evaluate(`const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.innerText.includes(${JSON.stringify(txt)})); if (!e) return 'no such button'; e.click(); return ''`)
  const pointer = async (x, y) => {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
      await b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  }

  async function act([cmd, a1, a2]) {
    switch (cmd) {
      case 'look':
        return ''
      case 'start':
        return clickText('button', 'Start')
      case 'tap': {
        const x = Number(a1), y = Number(a2)
        if (!(x >= 0 && x < W && y >= 0 && y < H)) return `tap needs a point on the ${W}×${H} screen`
        await pointer(x, y)
        return ''
      }
      case 'swipe': {
        if (a1 !== 'left' && a1 !== 'right') return 'swipe left|right'
        // A finger swiping left moves the view right.
        return b.evaluate(`const p = document.querySelector('.pan'); if (!p) return 'nothing to swipe'; p.scrollBy({ left: ${a1 === 'left' ? 1 : -1} * p.clientWidth * 0.6 }); return ''`)
      }
      case 'turn':
        if (a1 !== 'left' && a1 !== 'right') return 'turn left|right'
        return b.evaluate(`const e = document.querySelector('[aria-label="Turn ${a1}"]'); if (!e) return 'this room has one wall'; e.click(); return ''`)
      case 'item':
        return b.evaluate(`const e = document.querySelectorAll('.pocket .item')[${Number(a1) - 1}]; if (!e) return 'no item ${a1} in the pocket'; e.click(); return ''`)
      case 'back':
        return b.evaluate(`const z = document.querySelector('.zoom'); if (z) { z.click(); return '' } const s = [...document.querySelectorAll('.lock button')].find((x) => x.innerText.includes('Step back')); if (s) { s.click(); return '' } return 'nothing to step back from'`)
      case 'dial': {
        const lock = await b.evaluate(`return document.querySelector('.lock .lock-name')?.innerText ?? ''`)
        if (!lock) return 'no lock is open; tap the thing with the lock first'
        const reels = await b.evaluate(`return document.querySelectorAll('.lock .reel').length`)
        if (!/^\d+$/.test(a1 ?? '') || a1.length !== reels) return `this lock takes ${reels} digits`
        const used = tries.get(lock) ?? 0
        if (used >= MAX_TRIES) return `REFUSED: ${MAX_TRIES} wrong codes already tried on this lock`
        for (let i = 0; i < reels; i++) {
          const cur = Number(await b.evaluate(`return document.querySelectorAll('.lock .digit')[${i}].innerText`))
          const n = (Number(a1[i]) - cur + 10) % 10
          for (let k = 0; k < n; k++) await b.evaluate(`document.querySelector('[aria-label="Digit ${i + 1} up"]').click(); return ''`)
        }
        await clickText('.lock button', 'Turn the handle')
        await sleep(600)
        const still = await b.evaluate(`return !!document.querySelector('.lock')`)
        if (still) {
          tries.set(lock, used + 1)
          return `Wrong code (${used + 1} of ${MAX_TRIES} wrong tries on this lock used)`
        }
        return 'The lock opened.'
      }
      default:
        return 'commands: start | look | tap <x> <y> | swipe left|right | turn left|right | item <n> | dial <digits> | back'
    }
  }

  createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const cmd = JSON.parse(body || '[]')
    const note = await act(cmd)
    await sleep(900) // close-ups lift in over 0.38 s; bubbles appear at once
    const screen = JSON.parse(await text())
    // The screen-reader line keeps the last thing said; report it only when it changed, or it reads like a new answer.
    if (screen.said === lastSaid) delete screen.said
    else lastSaid = screen.said
    won ||= screen.escaped
    const path = await shot()
    appendFileSync(`${out}/log.jsonl`, JSON.stringify({ step, cmd, note, screen }) + '\n')
    writeFileSync(`${out}/result.json`, JSON.stringify({ id, escaped: won, steps: step, wrongTries: Object.fromEntries(tries) }))
    const lines = [note && `Result: ${note}`, `Screenshot: ${path}`]
    for (const [k, v] of Object.entries(screen)) if (v !== undefined && v !== false && !(Array.isArray(v) && !v.length)) lines.push(`${k}: ${Array.isArray(v) ? v.join('; ') : v}`)
    res.end(lines.filter(Boolean).join('\n'))
  }).listen(port, '127.0.0.1', () => console.log(`blind harness for ${id} on :${port}, screenshots in ${out}`))
}
