/**
 * The views, and what the stored name of one means.
 *
 * The name of the view on screen is written to settings, so a name that has
 * been retired still has to open something sensible the next time the app
 * starts.
 */

/**
 * Which view is on screen. `performance` is the two-deck rekordbox layout,
 * `edit` is the arrangement, and `legacy` stacks four tracks.
 */
export type ViewName = 'performance' | 'edit' | 'legacy'

/** The view a session opens on when the stored name means nothing. */
export const DEFAULT_VIEW: ViewName = 'performance'

/**
 * View names as they have been stored, mapped to the ones in use.
 *
 * The stacked view was `edit` and is now `legacy`; the arrangement was `v3`
 * and is now `edit`. `editv2` is gone, and its readers land on the
 * arrangement.
 */
const STORED_VIEWS: Record<string, ViewName> = {
  performance: 'performance',
  edit: 'legacy',
  editv2: 'edit',
  v3: 'edit',
  legacy: 'legacy'
}

/** The view a stored name opens, falling back when it names nothing. */
export function renameView(stored: unknown): ViewName {
  return (typeof stored === 'string' ? STORED_VIEWS[stored] : undefined) ?? DEFAULT_VIEW
}
