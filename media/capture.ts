/**
 * Direction for the pictures in the README.
 *
 * The two things worth showing are actions rather than screens — a plugin going
 * from a registry search into the profile, and a phone taking over a session —
 * and an action needs an animation. A screen recording of it would be a video of
 * whatever the machine happened to be doing that minute: a different npm
 * duration each take, a countdown at a different second, a stray tooltip.
 *
 * So the animation is assembled from frames instead, and this file is the shot
 * list. Every frame is one call to `window.dsh.step()` followed by one
 * screenshot, and nothing moves in between — the world in `media/world.ts` parks
 * at each point a real command would be waiting, so the frame after a spinner is
 * the same pixels plus one more line of npm output. Run it twice and you get the
 * same frames.
 *
 * The pointer is drawn here because a screenshot has no cursor in it. It is the
 * only thing on screen that is not the application.
 *
 * To rebuild the pictures:
 *
 *     pnpm dev
 *     # then, at 1120x700 and DPR 1:
 *     #   http://localhost:1420/media/?scene=plugins&lang=en&theme=dark
 *     #   http://localhost:1420/media/?scene=remote&lang=en&theme=dark
 *     # step with window.dsh.step(), shooting once per step, until done
 *     node media/apng.mjs <frame-dir> <out.png>
 *
 * and for the stills, `?pose=console|plugins|remote|about` with no pointer.
 */
import { answerCommands, free, hold, pair, pass, serve, settle, tick } from './world'

import { t } from '@/lib/i18n'

answerCommands()

const options = new URLSearchParams(window.location.search)

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/* -------------------------------------------------------------------------- */
/* Finding things                                                             */
/* -------------------------------------------------------------------------- */

const seek = <T extends Element>(root: ParentNode, selector: string): T[] => [
  ...root.querySelectorAll<T>(selector),
]

const need = <T extends HTMLElement>(root: ParentNode, selector: string, index = 0): T => {
  const found = seek<T>(root, selector)[index]
  if (!found) throw new Error(`capture: nothing at ${selector}[${index}]`)
  return found
}

/**
 * A pane, by the title in its header.
 *
 * Looked up through the application's own dictionary rather than by class name,
 * so the same shot list drives the English and the Chinese capture, and so a
 * restyled pane does not silently change what gets pointed at.
 */
const pane = (title: string): HTMLElement => {
  const heading = seek<HTMLElement>(document, 'h2').find((node) => node.textContent === title)
  const section = heading?.closest('section')
  if (!section) throw new Error(`capture: no pane titled ${title}`)
  return section
}

/** Rail order is `VIEWS`: console, plugins, remote, about. */
const rail = (index: number) => need(document, 'nav[aria-label] > button', index)

const market = () => pane(t('plugins.title'))
const doorPane = () => pane(t('remote.title'))

const row = (name: string): HTMLElement => {
  const found = seek<HTMLElement>(market(), 'li').find((node) => node.textContent?.startsWith(name))
  if (!found) throw new Error(`capture: no row for ${name}`)
  return found
}

/** Each discover row has exactly one button, and it is the one that says Install. */
const rowAction = (name: string) => need(row(name), 'button')

/** Discover, then Installed. */
const tab = (index: number) => need(market(), 'header button[aria-pressed]', index)

const dialog = () => need(document, '[role="dialog"]')
/** The footer is Close, then the action — install or remove. */
const dialogClose = () => need(dialog(), 'footer button', 0)
const dialogAction = () => need(dialog(), 'footer button', 1)

/** Open access, or Close access once it is open. */
const doorButton = () => need(doorPane(), 'header button')

/* -------------------------------------------------------------------------- */
/* The pointer                                                                */
/* -------------------------------------------------------------------------- */

interface Point {
  x: number
  y: number
}

/** Drawn edge of the arrow, and where its tip sits inside that square. */
const ARROW = 27
const TIP: Point = { x: (3 / 24) * ARROW, y: (1 / 24) * ARROW }

let cursor: Point = { x: 0, y: 0 }
let arrow: HTMLElement | null = null
let ring: HTMLElement | null = null

const drawPointer = () => {
  const stage = document.createElement('div')
  stage.style.cssText = 'position:fixed;inset:0;z-index:9999;pointer-events:none'

  ring = document.createElement('div')
  ring.style.cssText =
    'position:absolute;left:0;top:0;border:2px solid var(--color-brand);border-radius:9999px;opacity:0'

  arrow = document.createElement('div')
  arrow.style.cssText = `position:absolute;left:0;top:0;width:${ARROW}px;height:${ARROW}px;filter:drop-shadow(0 2px 4px rgb(0 0 0 / 0.45))`
  // White with a dark edge, so it reads on either palette without knowing which
  // one is on — the same trick a real cursor uses.
  arrow.innerHTML = `<svg viewBox="0 0 24 24" width="${ARROW}" height="${ARROW}" aria-hidden="true">
    <path d="M3 1 L3 20.2 L8.3 15.2 L11.7 22.7 L14.9 21.2 L11.5 13.8 L18.6 13.6 Z"
      fill="#fff" stroke="rgb(10 14 30 / 0.88)" stroke-width="1.15" stroke-linejoin="round" />
  </svg>`

  stage.append(ring, arrow)
  document.body.append(stage)
}

const place = (at: Point) => {
  cursor = at
  if (arrow) arrow.style.transform = `translate(${at.x - TIP.x}px, ${at.y - TIP.y}px)`
}

const halo = (radius: number, opacity: number) => {
  if (!ring) return
  ring.style.width = `${radius * 2}px`
  ring.style.height = `${radius * 2}px`
  ring.style.transform = `translate(${cursor.x - radius}px, ${cursor.y - radius}px)`
  ring.style.opacity = String(opacity)
}

const middle = (element: Element): Point => {
  const box = element.getBoundingClientRect()
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
}

const spot = (fx: number, fy: number): Point => ({
  x: window.innerWidth * fx,
  y: window.innerHeight * fy,
})

/* -------------------------------------------------------------------------- */
/* Frames                                                                     */
/* -------------------------------------------------------------------------- */

interface Frame {
  /** How long this one holds in the finished animation, in milliseconds. */
  delay: number
  act: () => void | Promise<void>
}

const reel: Frame[] = []

const at = (delay: number, act: () => void | Promise<void> = () => {}) => {
  reel.push({ delay, act })
}

/** Fast, then slow — a hand arriving at a target rather than a linear sweep. */
const ease = (progress: number) => 1 - (1 - progress) ** 3

/**
 * Frames that walk the pointer somewhere.
 *
 * Where "somewhere" is resolved on the way past, not while the shot list is
 * being written: half of these targets do not exist yet when this runs.
 */
const walk = (find: () => Point, steps: number, delay: number) => {
  const path = { from: cursor, to: cursor }

  for (let step = 1; step <= steps; step += 1) {
    at(delay, () => {
      if (step === 1) {
        path.from = cursor
        path.to = find()
      }
      const progress = ease(step / steps)
      place({
        x: path.from.x + (path.to.x - path.from.x) * progress,
        y: path.from.y + (path.to.y - path.from.y) * progress,
      })
    })
  }
}

// Three steps and no more. Every frame here is a screenshot taken by hand, and
// a pointer crossing a 1100px window in three eased hops is already smoother
// than the thing it stands in for: a real cursor is not visible between frames
// either.
const glide = (find: () => Element, steps = 3, delay = 70) =>
  walk(() => middle(find()), steps, delay)

const drift = (fx: number, fy: number, steps = 3, delay = 70) =>
  walk(() => spot(fx, fy), steps, delay)

/**
 * A click, in two frames: the press, and then what the press did.
 *
 * Split because those are two different pictures. A pressed control with the
 * old screen behind it says where the click landed; the same control with the
 * new screen says what it was for. One frame showing both would only ever read
 * as the second.
 */
const click = (find: () => Element, after: number) => {
  let target: HTMLElement | null = null

  at(120, () => {
    const element = find()
    target = element instanceof HTMLElement ? element : null
    place(middle(element))
    halo(11, 0.95)
  })

  at(after, async () => {
    target?.click()
    halo(20, 0.34)
    await settle()
  })
}

/* -------------------------------------------------------------------------- */
/* The shot lists                                                             */
/* -------------------------------------------------------------------------- */

const PLUGIN = 'dsh-visual-plugin'

/** Wait for the application to have painted something to point at. */
const mounted = async () => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (document.querySelector('nav[aria-label] > button')) return
    await wait(25)
  }
  throw new Error('capture: the window never mounted')
}

/**
 * Everything true before the first frame.
 *
 * The harness is already up, because both scenes are about what you do once it
 * is, and starting it on camera would spend a third of the animation on a
 * progress line. The world is only held after that, so the setup runs at its own
 * speed and the frames start on a settled window.
 */
const enter = async (view: number) => {
  await mounted()
  await serve()
  rail(view).click()
  await settle()
  hold()
}

const SCENES: Record<string, () => Promise<void>> = {
  /** One click from a registry listing to a layer in the profile. */
  plugins: async () => {
    await enter(1)
    place(spot(0.9, 0.82))

    at(1000)
    glide(() => rowAction(PLUGIN))
    click(() => rowAction(PLUGIN), 520)
    // The manifest is what separates a plugin from a package that merely
    // mentions the harness, so it gets a frame of its own to be read in.
    at(1500, pass)

    glide(() => dialogAction())
    click(() => dialogAction(), 420)
    for (let line = 0; line < 5; line += 1) at(300, pass)
    at(1600, pass)

    glide(() => dialogClose())
    click(() => dialogClose(), 1200)
    glide(() => tab(1))
    click(() => tab(1), 2400)
  },

  /** A door opened on the LAN, a code with a life on it, and a phone that used it. */
  remote: async () => {
    await enter(2)
    place(spot(0.9, 0.8))

    at(1000)
    glide(() => doorButton())
    click(() => doorButton(), 500)
    at(1800, pass)

    // The code visibly running out is the point of the panel, so the animation
    // spends a frame on it rather than only on the symbol.
    at(1300, () => tick(103))
    drift(0.24, 0.42)
    at(2600, () => pair('iPhone 15'))
  },
}

/* -------------------------------------------------------------------------- */
/* Stills                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A pane, arranged and left alone — no pointer, no held commands.
 *
 * Set up by clicking through the application rather than by writing to its
 * stores, so a still cannot show a combination the app would never reach.
 */
const POSES: Record<string, () => Promise<void>> = {
  console: async () => {
    await mounted()
    await serve()
    // Asked for, not implied. A ready harness is what the window puts in front,
    // so reaching the console means clicking Console — exactly as a user does.
    rail(0).click()
    await settle()
  },
  plugins: async () => {
    await mounted()
    await serve()
    rail(1).click()
    await settle()
  },
  remote: async () => {
    await mounted()
    await serve()
    rail(2).click()
    await settle()
    doorButton().click()
    await wait(500)
    tick(96)
    await settle()
  },
  about: async () => {
    await mounted()
    await serve()
    rail(3).click()
    await settle()
  },
}

/* -------------------------------------------------------------------------- */
/* The driver                                                                 */
/* -------------------------------------------------------------------------- */

interface Progress {
  index: number
  total: number
  /** Milliseconds this frame holds for; the encoder reads the same numbers. */
  delay: number
  done: boolean
}

interface Driver {
  /** True once the scene is built and the first frame is on screen. */
  ready: boolean
  /** Advance exactly one frame. */
  step: () => Promise<Progress>
  /** Every frame's hold, in order, for the encoder. */
  plan: () => number[]
  /** Stop holding, for poking at the page by hand. */
  free: () => Promise<void>
}

let index = 0

const driver: Driver = {
  ready: false,

  step: async () => {
    const frame = reel[index]
    if (!frame) return { index, total: reel.length, delay: 0, done: true }

    halo(0, 0)
    await frame.act()
    // Twice: once for the state change React was handed, once for anything that
    // change asked for in an effect.
    await settle()
    await settle()

    index += 1
    return { index, total: reel.length, delay: frame.delay, done: index >= reel.length }
  },

  plan: () => reel.map((frame) => frame.delay),
  free,
}

declare global {
  interface Window {
    dsh: Driver
  }
}

window.dsh = driver

const scene = options.get('scene')
const pose = options.get('pose')

void (async () => {
  if (scene !== null) {
    const build = SCENES[scene]
    if (!build) throw new Error(`capture: no scene called ${scene}`)
    drawPointer()
    await build()
    await driver.step()
  } else if (pose !== null) {
    const arrange = POSES[pose]
    if (!arrange) throw new Error(`capture: no pose called ${pose}`)
    await arrange()
  } else {
    await mounted()
    await serve()
  }
  driver.ready = true
})()
