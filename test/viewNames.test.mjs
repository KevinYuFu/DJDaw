/**
 * What a stored view name opens.
 *
 * The name of the view on screen is written to settings, so every name the app
 * has ever stored still has to open something. These check each one, including
 * the two that were renamed and the one that was removed.
 */
import { DEFAULT_VIEW, renameView } from './.build/viewNames.mjs'

const { eq } = globalThis.__t

// ------------------------------------------------------- names in use today

eq('performance opens itself', renameView('performance'), 'performance')
eq('legacy opens itself', renameView('legacy'), 'legacy')

// --------------------------------------------------------- names as renamed

// The stacked view used to be the only edit, and keeps working under its new
// name rather than dropping someone into the arrangement.
eq('the old edit is the stacked view', renameView('edit'), 'legacy')

// The arrangement was V3 and is the plain edit now.
eq('v3 is the arrangement', renameView('v3'), 'edit')

// EDIT V2 is gone, so its readers land on the arrangement.
eq('editv2 lands on the arrangement', renameView('editv2'), 'edit')

// ------------------------------------------------------------ nothing usable

eq('an unknown name falls back', renameView('something-else'), DEFAULT_VIEW)
eq('so does nothing at all', renameView(undefined), DEFAULT_VIEW)
eq('and null', renameView(null), DEFAULT_VIEW)
eq('and a number', renameView(3), DEFAULT_VIEW)
eq('and an empty string', renameView(''), DEFAULT_VIEW)
eq('the fallback is the performance view', DEFAULT_VIEW, 'performance')
