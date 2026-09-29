import { expect, it } from 'vitest'
import { moveFrame } from './movement'
const frame = { id: 'text', x: 80, y: 100, width: 400, height: 100, rotation: 0 }
const canvas = { width: 1280, height: 720 }

it('moves in document coordinates and clamps to the slide edges', () => {
  expect(moveFrame(frame, canvas, 10.126, -15)).toEqual({ x: 90.13, y: 85 })
  expect(moveFrame(frame, canvas, -1000, 1000)).toEqual({ x: 0, y: 620 })
  expect(moveFrame(frame, canvas, 10000, -10000)).toEqual({ x: 880, y: 0 })
})

it('accounts for rotated visible bounds without violating the source frame', () => {
  expect(moveFrame({ ...frame, rotation: 90 }, canvas, -1000, -1000)).toEqual({ x: 0, y: 150 })
  expect(moveFrame({ ...frame, rotation: 90 }, canvas, 10000, 10000)).toEqual({ x: 880, y: 470 })
  const large = { ...frame, width: 1200, height: 700, rotation: 45 }
  expect(moveFrame(large, canvas, 10000, 10000)).toEqual({ x: 80, y: 20 })
  expect(moveFrame({ ...frame, width: 0 }, canvas, -1000, -1000)).toEqual({ x: 0, y: 0 })
})

it('rejects invalid coordinates instead of introducing NaN into a draft', () => {
  expect(() => moveFrame(frame, canvas, NaN, 0)).toThrow()
  expect(() => moveFrame(frame, { width: Infinity, height: 720 }, 0, 0)).toThrow()
})
