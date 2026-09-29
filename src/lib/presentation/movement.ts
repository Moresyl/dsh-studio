import type { Frame } from './document'

/** Constrain both the source frame and, when it fits, its rotated visible bounds. */
export function moveFrame(
  frame: Frame,
  canvas: { width: number; height: number },
  dx: number,
  dy: number,
) {
  if (
    ![
      dx,
      dy,
      frame.x,
      frame.y,
      frame.width,
      frame.height,
      frame.rotation,
      canvas.width,
      canvas.height,
    ].every(Number.isFinite)
  )
    throw new Error('Invalid movement coordinates')
  const angle = (frame.rotation * Math.PI) / 180
  const visibleWidth =
    Math.abs(Math.cos(angle)) * frame.width + Math.abs(Math.sin(angle)) * frame.height
  const visibleHeight =
    Math.abs(Math.sin(angle)) * frame.width + Math.abs(Math.cos(angle)) * frame.height
  const constrain = (value: number, extent: number, visible: number, available: number) => {
    const maximum = Math.max(0, available - extent)
    const margin = Math.max(0, (visible - extent) / 2)
    const minimum = visible <= available ? Math.min(margin, maximum) : 0
    const upper = visible <= available ? Math.max(minimum, maximum - margin) : maximum
    return Math.min(upper, Math.max(minimum, Math.round(value * 100) / 100))
  }
  return {
    x: constrain(frame.x + dx, frame.width, visibleWidth, canvas.width),
    y: constrain(frame.y + dy, frame.height, visibleHeight, canvas.height),
  }
}
