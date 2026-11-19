/** @jsxImportSource solid-js */
import { type JSX } from 'solid-js'

/** Marks literal search matches while preserving the original spelling and text nodes. */
export function HighlightedText(props: { text: string; query: string }): JSX.Element {
  const parts = () => {
    const keyword = props.query.trim()
    if (!keyword) return props.text
    const literal = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp('(' + literal + ')', 'giu')
    return props.text.split(pattern).map((part, index) => index % 2 ? <mark>{part}</mark> : part)
  }
  return <>{parts()}</>
}
