import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PresentationSlideView } from './PresentationSlideView'
import { fixture } from '@/lib/presentation/fixtures.test-support'

it('renders editable objects as bounded DOM/SVG content without interpreting source markup', () => {
  const document = fixture()
  const html = renderToStaticMarkup(
    <PresentationSlideView slide={document.slides[0]!} aspect="wide" />,
  )
  expect(html).toContain('viewBox="0 0 1280 720"')
  expect(html).toContain('Editable 中文 &amp; &lt;text&gt; 😀')
  expect(html).toContain('<table')
  expect(html).toContain('北区')
  expect(html).not.toContain('NaN')
  expect(html).not.toContain('role="button"')
})

it('supports element selection and native line, ellipse and pie previews including a single nonzero slice', () => {
  const document = fixture()
  const slide = document.slides[0]!
  for (const element of slide.elements) {
    if (element.kind === 'shape') element.shape = 'ellipse'
    if (element.kind === 'chart') {
      element.chart = 'pie'
      element.series[0]!.values = [4, 0]
    }
  }
  let html = renderToStaticMarkup(
    <PresentationSlideView slide={slide} aspect="standard" selected="title" onSelect={() => {}} />,
  )
  expect(html).toContain('aria-pressed="true"')
  expect(html).toContain('<ellipse')
  expect(html).toContain('<circle')
  expect(html).not.toContain('NaN')
  for (const element of slide.elements) {
    if (element.kind === 'shape') element.shape = 'line'
    if (element.kind === 'chart') element.chart = 'line'
  }
  html = renderToStaticMarkup(<PresentationSlideView slide={slide} aspect="wide" />)
  expect(html).toContain('<polyline')
})
