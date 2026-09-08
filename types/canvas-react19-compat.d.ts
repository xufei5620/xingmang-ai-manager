import type { JSX as ReactJSX } from 'react'

// Keep the verified canvas engine unchanged while React 19 scopes JSX types.
declare global {
  namespace JSX { type Element = ReactJSX.Element }
}
