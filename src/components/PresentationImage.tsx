import { useEffect, useState } from 'react'
import { readImage } from '@/lib/presentation/media'
import { t } from '@/lib/i18n'
import { describe } from '@/lib/errors'
import type { ImageElement } from '@/lib/presentation/document'

export function PresentationImage({ element }: { element: ImageElement }) {
  const [result, setResult] = useState<{ id: string; url?: string; error?: string } | null>(null)
  useEffect(() => {
    let active = true
    void readImage(element.asset).then(
      (image) => {
        if (active) setResult({ id: element.asset, url: image.dataUrl })
      },
      (cause) => {
        if (active) setResult({ id: element.asset, error: describe(cause) })
      },
    )
    return () => {
      active = false
    }
  }, [element.asset])
  const current = result?.id === element.asset ? result : null
  if (current?.url)
    return (
      <image
        href={current.url}
        width={element.width}
        height={element.height}
        preserveAspectRatio={
          element.fit === 'stretch'
            ? 'none'
            : `xMidYMid ${element.fit === 'cover' ? 'slice' : 'meet'}`
        }
      >
        <title>{element.alt || t('deck.image')}</title>
      </image>
    )
  return (
    <foreignObject width={element.width} height={element.height}>
      <div
        className="flex h-full flex-col items-center justify-center gap-2 bg-canvas text-[12px] text-muted"
        role={current?.error ? 'alert' : 'status'}
        title={current?.error}
      >
        <span>{current?.error ? t('deck.imageFailed') : t('deck.imageLoading')}</span>
      </div>
    </foreignObject>
  )
}
