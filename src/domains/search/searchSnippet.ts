import { segmentGraphemes } from '../../utils/textWidth.ts'

/** Both built-in providers show the matching passage in the original spelling. */
export function createSearchSnippetMatcher(query: string): (text: string) => string | undefined {
  const needle = query.toLocaleLowerCase()
  return text => {
    const folded = text.toLocaleLowerCase()
    const hit = folded.indexOf(needle)
    if (hit < 0) return undefined

    // Case conversion can expand or contract a grapheme. Map match offsets back
    // to the source before slicing, including a match inside an expansion.
    let start = hit
    let end = hit + needle.length
    if (folded.length !== text.length) {
      let offset = 0
      let foldedOffset = 0
      for (const grapheme of segmentGraphemes(text)) {
        const next = foldedOffset + grapheme.toLocaleLowerCase().length
        if (foldedOffset <= hit && hit < next) start = offset
        offset += grapheme.length
        if (next >= hit + needle.length) {
          end = offset
          break
        }
        foldedOffset = next
      }
    }
    start = Math.max(0, start - 40)
    end = Math.min(text.length, end + 40)
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(start))) start--
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text.charAt(end))) end++
    return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
  }
}
