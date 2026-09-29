import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

test('recovery quit requires an explicit discard confirmation and carries its receipt', async () => {
  const source = await readFile('public/recovery.js', 'utf8')
  for (const language of ['zh-CN', 'en-US']) {
    const elements = new Map()
    const calls = []
    const confirmations = []
    let accept = false
    const context = {
      navigator: { language },
      document: {
        getElementById(id) {
          if (!elements.has(id))
            elements.set(id, {
              addEventListener(event, callback) {
                this[event] = callback
              },
            })
          return elements.get(id)
        },
      },
      window: {
        confirm(message) {
          confirmations.push(message)
          return accept
        },
        __TAURI_INTERNALS__: {
          async invoke(command, args) {
            calls.push({ command, args })
            return null
          },
        },
      },
    }
    vm.runInNewContext(source, context)
    const button = elements.get('quit')
    button.click({ currentTarget: button })
    assert.equal(calls.filter((call) => call.command === 'recovery_quit').length, 0)
    accept = true
    button.click({ currentTarget: button })
    await Promise.resolve()
    const quit = calls.filter((call) => call.command === 'recovery_quit')
    assert.equal(quit.length, 1)
    assert.equal(quit[0].args.discard, true)
    assert.match(confirmations[0], language === 'zh-CN' ? /未保存/ : /unsaved/)
  }
})
