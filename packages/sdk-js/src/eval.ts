// @clickroom/sdk-js — pure, DOM-free flag evaluation surface. Re-exported under the
// `./eval` subpath so non-browser consumers (e.g. @clickroom/sdk-node) can share the canonical
// hash + evaluate implementation without pulling in the browser flag client (localStorage/fetch).

export type {
  Filters,
  Flag,
  FlagMap,
  FlagOperator,
  FlagResult,
  Group,
  Multivariate,
  PropFilter,
  Variant,
} from './flags'
export { evaluate, hashFlag, propMatch } from './flags'
export { sha1 } from './sha1'
