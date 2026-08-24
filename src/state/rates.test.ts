import { beforeEach, describe, expect, it, vi } from 'vitest'

import { decodePricing, useRates } from '@/state/rates'

const stored = new Map<string, string>()
const localStorage = {
  getItem: vi.fn((key: string) => stored.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
}

beforeEach(() => {
  vi.clearAllMocks()
  stored.clear()
  vi.stubGlobal('window', { localStorage })
  useRates.setState({ rates: {}, currency: 'CNY', monthlyBudget: null })
})

describe('usage rate persistence', () => {
  it('rejects a corrupted stored budget while retaining sane rates', () => {
    const restored = decodePricing(
      JSON.stringify({
        currency: 'USD',
        monthlyBudget: 'unlimited',
        rates: { model: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
      }),
    )

    expect(restored).toEqual({
      currency: 'USD',
      monthlyBudget: null,
      rates: { model: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
    })
  })

  it('falls back safely for absent, malformed and non-object storage', () => {
    expect(decodePricing(null)).toEqual({ rates: {}, currency: 'CNY', monthlyBudget: null })
    expect(decodePricing('{no')).toEqual({ rates: {}, currency: 'CNY', monthlyBudget: null })
    expect(decodePricing('[]')).toEqual({ rates: {}, currency: 'CNY', monthlyBudget: null })
  })

  it('keeps only complete non-negative numeric rates from storage', () => {
    expect(
      decodePricing(
        JSON.stringify({
          currency: 'EUR',
          monthlyBudget: 40,
          rates: {
            text: 'bad',
            partial: { input: 1 },
            negative: { input: -1, output: 1, cacheRead: 1, cacheWrite: 1 },
            good: { input: 0, output: 2, cacheRead: 0, cacheWrite: 3 },
          },
        }),
      ),
    ).toEqual({
      currency: 'CNY',
      monthlyBudget: 40,
      rates: { good: { input: 0, output: 2, cacheRead: 0, cacheWrite: 3 } },
    })
  })

  it('adds, clears and forgets model prices without mutating another model', () => {
    const rate = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }
    useRates.getState().price('one', rate)
    useRates.getState().price('two', rate)
    useRates.getState().price('one', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(useRates.getState().rates).toEqual({ two: rate })

    useRates.getState().forget('two')
    expect(useRates.getState().rates).toEqual({})
  })

  it('changes only the currency label and degrades to in-memory state if storage fails', () => {
    localStorage.setItem.mockImplementationOnce(() => {
      throw new Error('storage disabled')
    })

    expect(() => useRates.getState().choose('USD')).not.toThrow()
    expect(useRates.getState().currency).toBe('USD')
  })

  it('stores a positive local monthly budget with the current rates', () => {
    useRates.getState().setBudget(125.5)

    expect(useRates.getState().monthlyBudget).toBe(125.5)
    expect(JSON.parse([...stored.values()][0] ?? '{}')).toMatchObject({ monthlyBudget: 125.5 })
  })

  it('treats zero, negative and non-finite budgets as no budget', () => {
    useRates.getState().setBudget(10)
    useRates.getState().setBudget(Number.POSITIVE_INFINITY)
    expect(useRates.getState().monthlyBudget).toBeNull()
    useRates.getState().setBudget(-1)
    expect(useRates.getState().monthlyBudget).toBeNull()
    useRates.getState().setBudget(0)
    expect(useRates.getState().monthlyBudget).toBeNull()
  })
})
