import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..', '..')

const tagName = (node) => node.tagName.getText()

const attribute = (node, name) =>
  node.attributes.properties.find(
    (candidate) => ts.isJsxAttribute(candidate) && candidate.name.getText() === name,
  )

const literalAttribute = (node, name) => {
  const found = attribute(node, name)
  if (!found?.initializer || !ts.isStringLiteral(found.initializer)) return null
  return found.initializer.text
}

const isHidden = (node) => literalAttribute(node, 'aria-hidden') === 'true'

/** A conservative static answer: visible text/expression or an explicit ARIA name. */
function hasAccessibleName(opening, children) {
  if (attribute(opening, 'aria-label') || attribute(opening, 'aria-labelledby')) return true
  return children.some((child) => {
    if (ts.isJsxText(child)) return child.text.trim().length > 0
    if (ts.isJsxExpression(child)) return child.expression !== undefined
    if (ts.isJsxElement(child)) {
      return !isHidden(child.openingElement) && hasAccessibleName(child.openingElement, child.children)
    }
    return false
  })
}

/** Validate the interaction contracts that regress most easily in JSX refactors. */
export function validateAccessibilitySource(path, source) {
  const problems = []
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const labelledIds = new Set()

  const collectLabels = (node) => {
    if (ts.isJsxElement(node) && tagName(node.openingElement) === 'label') {
      const target = literalAttribute(node.openingElement, 'htmlFor')
      if (target) labelledIds.add(target)
    }
    ts.forEachChild(node, collectLabels)
  }
  collectLabels(file)

  const wrappedByLabel = (node) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isJsxElement(parent) && tagName(parent.openingElement) === 'label') return true
      if (ts.isJsxElement(parent) || ts.isJsxFragment(parent)) continue
      break
    }
    return false
  }

  const validateFormControl = (node) => {
    const tag = tagName(node)
    if (!['input', 'select', 'textarea'].includes(tag)) return
    if (tag === 'input' && literalAttribute(node, 'type') === 'hidden') return
    const id = literalAttribute(node, 'id')
    if (
      attribute(node, 'aria-label') ||
      attribute(node, 'aria-labelledby') ||
      (id && labelledIds.has(id)) ||
      wrappedByLabel(node)
    ) {
      return
    }
    const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1
    problems.push(`${path}:${line} ${tag} has no associated label`)
  }

  const visit = (node) => {
    if (ts.isJsxElement(node)) {
      const opening = node.openingElement
      validateFormControl(opening)
      const tag = tagName(opening)
      const role = literalAttribute(opening, 'role')
      const named = hasAccessibleName(opening, node.children)

      if ((tag === 'button' || tag === 'Button') && !named) {
        problems.push(`${path}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1} button has no accessible name`)
      }
      if (role === 'button') {
        const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1
        if (!attribute(opening, 'tabIndex')) problems.push(`${path}:${line} role=button has no tabIndex`)
        if (!attribute(opening, 'onKeyDown')) problems.push(`${path}:${line} role=button has no keyboard handler`)
        if (!named) problems.push(`${path}:${line} role=button has no accessible name`)
      }
      if (role === 'dialog' || role === 'alertdialog') {
        const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1
        if (literalAttribute(opening, 'aria-modal') !== 'true') {
          problems.push(`${path}:${line} ${role} is not aria-modal`)
        }
        if (!attribute(opening, 'aria-label') && !attribute(opening, 'aria-labelledby')) {
          problems.push(`${path}:${line} ${role} has no accessible name`)
        }
      }
    }
    if (ts.isJsxSelfClosingElement(node)) validateFormControl(node)
    ts.forEachChild(node, visit)
  }

  visit(file)
  return problems
}

async function tsxFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await tsxFiles(path)))
    else if (entry.isFile() && entry.name.endsWith('.tsx')) files.push(path)
  }
  return files
}

/** Verify source semantics plus the three desktop accessibility media contracts. */
export async function verifyAccessibility(root = DEFAULT_ROOT) {
  const files = await tsxFiles(join(root, 'src'))
  const problems = []
  for (const path of files) {
    const display = relative(root, path).replaceAll('\\', '/')
    problems.push(...validateAccessibilitySource(display, await readFile(path, 'utf8')))
  }

  const styles = await readFile(join(root, 'src/styles/app.css'), 'utf8')
  for (const marker of [':focus-visible', 'prefers-reduced-motion: reduce', 'forced-colors: active']) {
    if (!styles.includes(marker)) problems.push(`src/styles/app.css is missing ${marker}`)
  }

  if (problems.length > 0) {
    throw new Error(`accessibility verification failed:\n- ${problems.join('\n- ')}`)
  }
  return { files: files.length }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) {
  const result = await verifyAccessibility(process.argv[2] ? resolve(process.argv[2]) : DEFAULT_ROOT)
  console.log(`verified accessibility contracts across ${result.files} TSX files`)
}
