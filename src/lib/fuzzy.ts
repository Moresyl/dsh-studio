/**
 * Finding a command by typing some of its letters.
 *
 * Substring matching is not enough for a palette: people type the initials of a
 * two-word command, or the middle word of a three-word one, and either way they
 * expect it. So the query has to match as a subsequence — the letters in order,
 * with gaps allowed — and then the results have to be ranked, because a
 * subsequence match on its own says almost nothing about relevance.
 *
 * The ranking is where the feel comes from, and it rewards three things a
 * person actually meant: letters that landed at the start of a word, letters
 * that came in an unbroken run, and a match that started early. Everything else
 * is left alone. There is no learning, no history weighting and no cross-session
 * memory — a palette whose order changes underneath the user is a palette they
 * stop trusting to hit blindly.
 *
 * Case is ignored and CJK falls out for free: Chinese has no word boundaries to
 * find, but the subsequence rule still means 会话 matches 跳到会话.
 */

export interface Match {
  /** Higher is a better match. Only comparable between matches on one query. */
  score: number
  /** Where in the text the query landed, ascending. */
  at: number[]
}

/** What counts as the end of a word, so the next character starts one. */
const BREAKS = new Set([' ', '-', '_', '.', '/', '\\', ':', '(', '[', '@', '·', '，', '、'])

/** A letter that begins a word, either after a break or at a camelCase hump. */
function starts(text: string, index: number): boolean {
  if (index === 0) return true

  const before = text[index - 1] ?? ''
  const here = text[index] ?? ''
  if (BREAKS.has(before)) return true

  return before === before.toLowerCase() && here !== here.toLowerCase()
}

/**
 * Where `query` fits inside `text`, and how well.
 *
 * Two alignments are tried and the better-scoring one wins. Taking the first
 * place every letter can go finds "Terminal" before the terminal mentioned at
 * the end of a sentence; taking the last place each can go is what finds the
 * `pl` of "plugin" instead of the `p` in "Stop". Either one alone gets a whole
 * class of queries visibly wrong, and both together are still two linear
 * passes, which is what keeps the list moving under a held-down key.
 *
 * An empty query is a match on everything — it has no letters to disagree with.
 */
export function fuzzy(query: string, text: string): Match | null {
  // Spaces separate the words being aimed at rather than being aimed at
  // themselves, so "cl pl" finds "Clear the plugin list".
  const wanted = query.toLowerCase().replace(/\s+/g, '')
  const against = text.toLowerCase()

  if (wanted === '') return { score: 0, at: [] }

  const early = earliest(wanted, against)
  if (!early) return null

  const late = latest(wanted, against)
  const left = { score: rate(text, early), at: early }
  if (!late) return left

  const right = { score: rate(text, late), at: late }
  return right.score > left.score ? right : left
}

/** The first place every letter can go, taken in order. */
function earliest(wanted: string, against: string): number[] | null {
  const at: number[] = []
  let cursor = 0

  for (const letter of wanted) {
    const found = against.indexOf(letter, cursor)
    if (found < 0) return null
    at.push(found)
    cursor = found + 1
  }

  return at
}

/** The last place every letter can go, taken from the end backwards. */
function latest(wanted: string, against: string): number[] | null {
  const at: number[] = []
  let cursor = against.length - 1

  for (const letter of [...wanted].reverse()) {
    // `lastIndexOf` clamps a negative start to 0 and would match there, which
    // is a position this letter is no longer allowed to take.
    if (cursor < 0) return null

    const found = against.lastIndexOf(letter, cursor)
    if (found < 0) return null
    at.unshift(found)
    cursor = found - 1
  }

  return at
}

/** How much a particular alignment looks like what somebody meant to type. */
function rate(text: string, at: number[]): number {
  let score = 0
  let previous = -2

  for (const index of at) {
    if (index === previous + 1) score += 18
    if (starts(text, index)) score += 12
    previous = index
  }

  // Matching late, or matching a long label with a few scattered letters, is
  // weaker than the same letters landing at the front of a short one.
  score -= Math.min(at[0] ?? 0, 20)
  score += Math.round((at.length / text.length) * 10)

  return score
}

/**
 * Cut `text` into runs, marking which ones the query matched.
 *
 * Returned as segments rather than as markup so the caller decides how a hit
 * looks — and so this file stays something a test can read.
 */
export function segments(text: string, at: number[]): { text: string; hit: boolean }[] {
  if (at.length === 0) return text ? [{ text, hit: false }] : []

  const marked = new Set(at)
  const out: { text: string; hit: boolean }[] = []

  for (let index = 0; index < text.length; index += 1) {
    const hit = marked.has(index)
    const last = out.at(-1)
    if (last && last.hit === hit) last.text += text[index]
    else out.push({ text: text[index] ?? '', hit })
  }

  return out
}
