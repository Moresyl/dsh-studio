/**
 * What the user pays for a million tokens, per model.
 *
 * This is the one number the machine cannot find out for itself. The logs record
 * what was spent down to the token, but nothing on the disk records what that
 * costs — the price depends on a contract, a region, a discount, a prepaid
 * balance, and a public price list would be wrong for some users on the day it
 * shipped and wrong for everybody within a year. So the rate is asked for once
 * and remembered, and a model nobody has priced is reported as unpriced rather
 * than counted as free.
 *
 * The currency is a label, not a conversion. Nothing here converts between
 * currencies, because that would need a rate that changes hourly and an
 * assumption about which currency the number was typed in.
 */
import { create } from 'zustand'

import type { Rate, Rates } from '@/lib/usage'

/** Versioned, so a later shape can be recognised rather than half-read. */
const KEY = 'dsh-studio:usage:rates:v1'

export type Currency = 'CNY' | 'USD'

/** What to put in front of the number. */
export const SYMBOL: Record<Currency, string> = { CNY: '¥', USD: '$' }

interface RateState {
  rates: Rates
  currency: Currency
  /** Optional local monthly ceiling in the same user-labelled currency. */
  monthlyBudget: number | null
  /** Set one model's price, or drop it when every field is zero. */
  price: (model: string, rate: Rate) => void
  forget: (model: string) => void
  choose: (currency: Currency) => void
  setBudget: (budget: number | null) => void
}

export const useRates = create<RateState>((set, get) => ({
  ...remembered(),

  price: (model, rate) => {
    const rates = { ...get().rates }
    // An all-zero rate is how somebody clears a price they typed by mistake.
    // Keeping it would report the model as free, which is a different claim
    // from having no price for it, and the wrong one.
    if (rate.input || rate.output || rate.cacheRead || rate.cacheWrite) rates[model] = rate
    else delete rates[model]

    set({ rates })
    save({ rates, currency: get().currency, monthlyBudget: get().monthlyBudget })
  },

  forget: (model) => {
    const rates = { ...get().rates }
    delete rates[model]
    set({ rates })
    save({ rates, currency: get().currency, monthlyBudget: get().monthlyBudget })
  },

  choose: (currency) => {
    set({ currency })
    save({ rates: get().rates, currency, monthlyBudget: get().monthlyBudget })
  },

  setBudget: (budget) => {
    const monthlyBudget = validBudget(budget) ? budget : null
    set({ monthlyBudget })
    save({ rates: get().rates, currency: get().currency, monthlyBudget })
  },
}))

export interface SavedPricing {
  rates: Rates
  currency: Currency
  monthlyBudget: number | null
}

/**
 * What was priced last time, or nothing.
 *
 * Every field is checked rather than trusted: this is JSON from a store any
 * other page in the webview could have written, and a rate that is a string
 * would turn every total into `NaN` silently.
 */
function remembered(): SavedPricing {
  try {
    return decodePricing(window.localStorage.getItem(KEY))
  } catch {
    // Unreadable storage, or JSON that is not JSON. Either way there are no
    // prices, which the statement already knows how to say.
    return decodePricing(null)
  }
}

/** Decode untrusted local storage without allowing malformed money into totals. */
export function decodePricing(raw: string | null): SavedPricing {
  const empty: SavedPricing = { rates: {}, currency: 'CNY', monthlyBudget: null }
  if (!raw) return empty
  try {
    const saved: unknown = JSON.parse(raw)
    if (typeof saved !== 'object' || saved === null) return empty
    const { rates, currency, monthlyBudget } = saved as Partial<SavedPricing>
    return {
      rates: typeof rates === 'object' && rates !== null ? sane(rates) : {},
      currency: currency === 'USD' ? 'USD' : 'CNY',
      monthlyBudget: validBudget(monthlyBudget) ? monthlyBudget : null,
    }
  } catch {
    return empty
  }
}

/** Only the entries that are four real, non-negative numbers. */
function sane(rates: Record<string, unknown>): Rates {
  const kept: Rates = {}

  for (const [model, rate] of Object.entries(rates)) {
    if (typeof rate !== 'object' || rate === null) continue
    const { input, output, cacheRead, cacheWrite } = rate as Partial<Rate>
    if (![input, output, cacheRead, cacheWrite].every(money)) continue
    kept[model] = {
      input: input as number,
      output: output as number,
      cacheRead: cacheRead as number,
      cacheWrite: cacheWrite as number,
    }
  }

  return kept
}

const money = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const validBudget = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

function save(saved: SavedPricing): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(saved))
  } catch {
    // Then the prices last for this run, which is still what was typed.
  }
}
