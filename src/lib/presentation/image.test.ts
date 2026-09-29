import { expect, it } from 'vitest'
import JSZip from 'jszip'
import { validateImage } from './image'
import { imageElement, imageFixture } from './image.test-support'
import { fixture } from './fixtures.test-support'
import { parsePresentation } from './document'
import { exportPresentation } from './export'
import { copyPresentation } from './authoring'

it('validates raster payloads and refuses remote, mismatched and damaged headers', () => {
  const image = imageFixture()
  expect(validateImage(image, image.id)).toEqual(image)
  for (const change of [
    { id: '../file' },
    { width: 0 },
    { height: 8193 },
    { width: 8192, height: 8192 },
    { bytes: 0 },
    { bytes: 8 * 1024 * 1024 + 1 },
    { bytes: image.bytes - 1 },
    { dataUrl: 'https://invalid.test/image.png' },
    { dataUrl: image.dataUrl.replace('png', 'svg+xml') },
    { dataUrl: image.dataUrl.replace('iVBOR', 'AAAAA') },
    { dataUrl: image.dataUrl.replace('iVBOR', 'iV=OR') },
    { width: image.width + 1 },
  ])
    expect(() => validateImage({ ...image, ...change })).toThrow()
  expect(() => validateImage(image, 'a'.repeat(64))).toThrow()
})

it('version-gates image sources and preserves immutable references when copying', () => {
  const source = fixture()
  source.version = 2
  source.slides[0]!.elements = [imageElement()]
  expect(parsePresentation(source)).toEqual(source)
  const copied = copyPresentation(source, 'copy')
  expect(copied.slides[0]!.elements[0]!.id).not.toBe('picture')
  expect(copied.slides[0]!.elements[0]).toMatchObject({ asset: imageFixture().id })
  for (const change of [
    { asset: 'https://invalid.test/a' },
    { alt: '\u0000' },
    { fit: 'invalid' },
  ]) {
    const damaged = structuredClone(source)
    Object.assign(damaged.slides[0]!.elements[0]!, change)
    expect(() => parsePresentation(damaged)).toThrow()
  }
  source.version = 1
  expect(() => parsePresentation(source)).toThrow('version 2')
  source.version = 2
  source.slides[0]!.elements = Array.from({ length: 101 }, (_, index) => ({
    ...imageElement(),
    id: `pic-${index}`,
    asset: index.toString(16).padStart(64, '0'),
  }))
  expect(() => parsePresentation(source)).toThrow('image count')
})

it.each(['contain', 'cover', 'stretch'] as const)(
  'exports %s images as embedded native pictures with rotation and safe descriptions',
  async (fit) => {
    const image = imageFixture(),
      source = fixture(),
      element = imageElement(image)
    element.fit = fit
    source.version = 2
    source.slides[0]!.elements = [element]
    const zip = await JSZip.loadAsync(await exportPresentation(source, { [image.id]: image }))
    const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
    expect(slide).toContain('<p:pic>')
    expect(slide).toContain('rot="900000"')
    expect(slide).toContain('Original &lt;picture&gt; &amp; &quot;label&quot;')
    if (fit === 'cover') expect(slide).toMatch(/<a:srcRect l="16667" r="16667"/)
    if (fit === 'contain') expect(slide).toContain('cx="2857500" cy="1905000"')
    const embedded = Object.values(zip.files).find(
      (file) => file.name.startsWith('ppt/media/') && !file.dir,
    )!
    expect(await embedded.async('base64')).toBe(image.dataUrl.split(',')[1])
    expect(await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')).not.toContain(
      'TargetMode="External"',
    )
    await expect(exportPresentation(source)).rejects.toThrow('image')
  },
)
