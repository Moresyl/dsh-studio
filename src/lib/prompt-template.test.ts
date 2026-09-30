import { expect, it } from 'vitest'
import { promptVariables, renderPrompt } from '@/lib/prompt-template'
it('deduplicates named placeholders in encounter order without executing input', () => {
  expect(
    promptVariables('Review {{ file }} for {{目标}}. {{file}} {{__proto__}} {{ }} {{evil()}}'),
  ).toEqual(['file', '目标', '__proto__'])
  expect(promptVariables('No variables')).toEqual([])
  expect(
    renderPrompt(
      '{{ file }} {{目标}} {{missing}}',
      new Map([
        ['file', '$& / path'],
        ['目标', 'quality'],
      ]),
    ),
  ).toBe('$& / path quality {{missing}}')
  expect(
    renderPrompt(
      '{{file}} {{__proto__}}',
      new Map([
        ['file', '  '],
        ['__proto__', 'safe'],
      ]),
    ),
  ).toBe('{{file}} safe')
})
