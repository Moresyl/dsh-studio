import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const css = await readFile(new URL('../../src/styles/app.css', import.meta.url), 'utf8')

function palette(selector) {
  const start = css.indexOf(`${selector} {`)
  assert(start >= 0, `missing palette ${selector}`)
  const body = css.slice(start, css.indexOf('}', start))
  return Object.fromEntries(
    [...body.matchAll(/--color-([\w-]+): (#[a-f\d]{6});/gi)].map(([, key, value]) => [key, value]),
  )
}

function luminance(hex) {
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
  const [red, green, blue] = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  )
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function ratio(left, right) {
  const a = luminance(left)
  const b = luminance(right)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

test('contrast calculation covers black/white, identical colours and symmetry', () => {
  assert.equal(ratio('#000000', '#ffffff'), 21)
  assert.equal(ratio('#ffffff', '#000000'), 21)
  assert.equal(ratio('#737373', '#737373'), 1)
})

const dark = palette('@theme')
const light = palette(":root[data-theme='light']")

test('explicit and system light palettes cannot drift apart', () => {
  assert.deepEqual(light, palette(":root:not([data-theme='dark'])"))
})

// This is a base-token regression gate, not a claim that every composited,
// disabled, transparent or third-party UI state has been audited.
for (const [name, colors] of Object.entries({ dark, light })) {
  test(`${name} small-text tokens remain readable on every base surface`, () => {
    const problems = []
    for (const foreground of [
      'text',
      'muted',
      'faint',
      'brand',
      'brand-cyan',
      'brand-violet',
      'ok',
      'warn',
      'danger',
    ]) {
      for (const background of ['canvas', 'canvas-deep', 'surface', 'surface-2']) {
        assert(colors[foreground] && colors[background], `${foreground}/${background} missing`)
        const actual = ratio(colors[foreground], colors[background])
        if (actual < 4.5)
          problems.push(`${foreground} on ${background}: ${actual.toFixed(2)} < 4.5`)
      }
    }
    assert.deepEqual(problems, [])
  })

  test(`${name} filled actions retain readable labels`, () => {
    for (const action of ['brand', 'danger']) {
      assert(ratio(colors[`on-${action}`], colors[action]) >= 4.5, action)
    }
  })
}
