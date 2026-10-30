// @clickroom/sdk-js — DOM `elements_chain` serialization.
//
// Serializes a click/submit/change target and its ancestors into a single
// compact string that ClickHouse materializes into `elements_chain_text` /
// `elements_chain_href` via `extract(elements_chain, 'text="([^"]*)"')` and the
// equivalent `href="..."`. The literal `text="` and `href="` tokens must appear
// verbatim for those extractors to match, and values must not contain a raw `"`
// (the `[^"]*` capture stops at the first quote) — so we backslash-escape.

// Cap how far up the tree we walk, to bound the serialized size.
const MAX_DEPTH = 15
// Truncate captured text to keep the chain compact on the wire.
const MAX_TEXT_LEN = 255

// Elements that are inherently "interesting" click targets for autocapture.
const INTERESTING_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'label'])

// Class / attribute opt-out markers: skip capture for these subtrees.
const OPT_OUT_CLASS = 'ch-no-capture'
const OPT_OUT_ATTR = 'data-ch-no-capture'

// Escape a value so it survives inside `attr="<value>"` and stays parseable:
// backslash and double-quote are escaped; separators (`;` `|`) and newlines are
// escaped so they never terminate a pair or an element boundary.
function escapeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/;/g, '\\;')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim()
}

// 1-indexed position among *all* siblings.
function nthChild(el: Element): number {
  let n = 1
  let sib = el.previousElementSibling
  while (sib) {
    n += 1
    sib = sib.previousElementSibling
  }
  return n
}

// 1-indexed position among siblings sharing the same tag name.
function nthOfType(el: Element): number {
  let n = 1
  const tag = el.tagName
  let sib = el.previousElementSibling
  while (sib) {
    if (sib.tagName === tag) {
      n += 1
    }
    sib = sib.previousElementSibling
  }
  return n
}

// Best-effort trimmed text for an element, truncated to MAX_TEXT_LEN.
function elementText(el: Element): string {
  const raw = (el as HTMLElement).innerText ?? el.textContent ?? ''
  const trimmed = raw.replace(/\s+/g, ' ').trim()
  return trimmed.length > MAX_TEXT_LEN ? trimmed.slice(0, MAX_TEXT_LEN) : trimmed
}

// Serialize a single element into `tag:attr="v";attr2="v2"`.
function serializeElement(el: Element): string {
  const tag = el.tagName.toLowerCase()
  const pairs: string[] = []

  const id = el.getAttribute('id')
  if (id) {
    pairs.push(`attr__id="${escapeValue(id)}"`)
  }

  const className = typeof el.className === 'string' ? el.className : ''
  if (className) {
    pairs.push(`attr__class="${escapeValue(className)}"`)
  }

  if (tag === 'a') {
    const href = el.getAttribute('href')
    if (href) {
      pairs.push(`href="${escapeValue(href)}"`)
    }
  }

  const text = elementText(el)
  if (text) {
    pairs.push(`text="${escapeValue(text)}"`)
  }

  pairs.push(`nth-child="${nthChild(el)}"`)
  pairs.push(`nth-of-type="${nthOfType(el)}"`)

  // data-* attributes as attr__data-*.
  const attrs = el.attributes
  for (let i = 0; i < attrs.length; i += 1) {
    const attr = attrs.item(i)
    if (attr?.name.startsWith('data-')) {
      pairs.push(`attr__${attr.name}="${escapeValue(attr.value)}"`)
    }
  }

  return `${tag}:${pairs.join(';')}`
}

/**
 * Serialize `target` and its ancestors (up to <body>, capped at MAX_DEPTH) into
 * an `elements_chain` string: each element as `tag:attr="v";attr2="v2"`, joined
 * by `|` with the target element first and its parents following.
 */
export function serializeElementsChain(target: Element): string {
  const parts: string[] = []
  let el: Element | null = target
  let depth = 0

  while (el && depth < MAX_DEPTH) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'body' || tag === 'html') {
      break
    }
    parts.push(serializeElement(el))
    el = el.parentElement
    depth += 1
  }

  return parts.join('|')
}

// True if any ancestor (inclusive) opts out of capture.
function isOptedOut(el: Element): boolean {
  let node: Element | null = el
  while (node) {
    if (node.classList?.contains(OPT_OUT_CLASS) || node.hasAttribute(OPT_OUT_ATTR)) {
      return true
    }
    node = node.parentElement
  }
  return false
}

// True if the element is an inherently interesting click target.
function isInteresting(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  if (INTERESTING_TAGS.has(tag)) {
    return true
  }
  if (el.hasAttribute('data-ch-capture')) {
    return true
  }
  if (el.getAttribute('role')) {
    return true
  }
  // Inline handler attribute (`onclick="..."`).
  if (el.hasAttribute('onclick')) {
    return true
  }
  return false
}

/**
 * Climb from the raw event target to the nearest "interesting" element to
 * attribute the event to (a, button, input, select, textarea, label, or any
 * element with a role / onclick / [data-ch-capture]). Returns null when nothing
 * meaningful is found or the subtree is opted out of capture.
 */
export function getEventTarget(el: Element): Element | null {
  let node: Element | null = el
  let depth = 0
  while (node && depth < MAX_DEPTH) {
    if (isOptedOut(node)) {
      return null
    }
    if (isInteresting(node)) {
      return node
    }
    node = node.parentElement
    depth += 1
  }
  return null
}
