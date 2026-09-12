(() => {
  const input = document.querySelector('[data-doc-search]')
  const status = document.querySelector('[data-doc-search-status]')
  const cards = [...document.querySelectorAll('.doc-card')]
  if (!input || !status || !cards.length) return
  const chinese = document.documentElement.lang.startsWith('zh')
  const update = () => {
    const query = input.value.trim().toLocaleLowerCase()
    let visible = 0
    for (const card of cards) {
      const match = !query || card.textContent.toLocaleLowerCase().includes(query)
      card.hidden = !match
      if (match) visible += 1
    }
    status.textContent = query
      ? chinese ? `找到 ${visible} 篇文档` : `${visible} guide${visible === 1 ? '' : 's'} found`
      : ''
  }
  input.addEventListener('input', update)
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault(); input.focus(); input.select()
    }
  })
})()
