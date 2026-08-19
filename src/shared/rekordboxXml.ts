/**
 * rekordbox XML collection parser.
 *
 * rekordbox 6/7 keeps its live library in an SQLCipher-encrypted `master.db`,
 * but it exports the whole collection — including beat grids and hot cues — as
 * XML, which is the format every other DJ tool interchanges through. That is
 * what this reads.
 *
 * Dependency-free and environment-free on purpose: it runs in the Electron main
 * process (so a large collection never crosses IPC as a string) and under plain
 * Node in the tests, with no DOM.
 */

export interface RekordboxTempo {
  /** Seconds. Position of the beat this marker sits on. */
  inizio: number
  bpm: number
  /** Which beat of the bar `inizio` lands on, 1-4. */
  battito: number
  /** Beats per bar, from the `Metro` attribute. */
  beatsPerBar: number
}

export interface RekordboxMark {
  name: string
  /** 0 cue, 1 fade-in, 2 fade-out, 3 load, 4 loop. */
  type: number
  start: number
  /** Only present for loops. */
  end: number | null
  /** -1 for a memory cue, 0-7 for hot cues A-H. */
  num: number
  color: string | null
}

export interface RekordboxTrack {
  trackId: string
  name: string
  artist: string
  album: string
  genre: string
  comments: string
  /** Absolute filesystem path, decoded from the `Location` URL. */
  path: string
  totalTimeSec: number
  averageBpm: number | null
  sampleRate: number
  /** rekordbox's key notation, e.g. '8A' or 'Am'. */
  tonality: string
  /** 0-5, converted from rekordbox's 0/51/102/153/204/255. */
  rating: number
  /** Hex colour, or null when the track has no colour tag. */
  colour: string | null
  dateAdded: number
  tempos: RekordboxTempo[]
  marks: RekordboxMark[]
}

export interface RekordboxPlaylist {
  name: string
  /** Path of parent folder names, outermost first. */
  folders: string[]
  /** rekordbox TrackID values, in playlist order. */
  trackIds: string[]
}

export interface RekordboxCollection {
  /** rekordbox version that produced the file, when stated. */
  producedBy: string
  tracks: RekordboxTrack[]
  playlists: RekordboxPlaylist[]
}

// ---------------------------------------------------------------------------
// A very small XML scanner
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

/** Expand the entities rekordbox emits inside attribute values. */
export function decodeEntities(value: string): string {
  if (value.indexOf('&') === -1) return value
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    const named = NAMED_ENTITIES[body]
    return named === undefined ? whole : named
  })
}

export interface XmlTag {
  name: string
  attrs: Record<string, string>
  selfClosing: boolean
}

const ATTR_RE = /([A-Za-z_][-A-Za-z0-9_.:]*)\s*=\s*("([^"]*)"|'([^']*)')/g

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  ATTR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR_RE.exec(source))) {
    attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4])
  }
  return attrs
}

/**
 * Walk the document, reporting element opens and closes. rekordbox XML is
 * machine-generated and attribute-only, so there is no text content to collect;
 * comments, the prolog, DOCTYPE and CDATA are skipped rather than reported.
 */
export function scanXml(
  text: string,
  onOpen: (tag: XmlTag) => void,
  onClose: (name: string) => void
): void {
  let i = 0
  const n = text.length
  while (i < n) {
    const lt = text.indexOf('<', i)
    if (lt === -1) break
    i = lt + 1

    if (text.startsWith('!--', i)) {
      const end = text.indexOf('-->', i)
      i = end === -1 ? n : end + 3
      continue
    }
    if (text.startsWith('![CDATA[', i)) {
      const end = text.indexOf(']]>', i)
      i = end === -1 ? n : end + 3
      continue
    }
    if (text[i] === '?' || text[i] === '!') {
      const end = text.indexOf('>', i)
      i = end === -1 ? n : end + 1
      continue
    }
    if (text[i] === '/') {
      const end = text.indexOf('>', i)
      if (end === -1) break
      onClose(text.slice(i + 1, end).trim())
      i = end + 1
      continue
    }

    // An attribute value may legally contain '>', so find the real tag end.
    let j = i
    let quote = ''
    while (j < n) {
      const c = text[j]
      if (quote) {
        if (c === quote) quote = ''
      } else if (c === '"' || c === "'") {
        quote = c
      } else if (c === '>') {
        break
      }
      j++
    }
    if (j >= n) break

    let body = text.slice(i, j)
    const selfClosing = body.endsWith('/')
    if (selfClosing) body = body.slice(0, -1)

    const spaceAt = body.search(/[\s]/)
    const name = spaceAt === -1 ? body : body.slice(0, spaceAt)
    const attrs = spaceAt === -1 ? {} : parseAttrs(body.slice(spaceAt))
    onOpen({ name, attrs, selfClosing })
    i = j + 1
  }
}

// ---------------------------------------------------------------------------
// Field decoding
// ---------------------------------------------------------------------------

/**
 * Turn a rekordbox `Location` into a filesystem path.
 *
 * rekordbox writes `file://localhost/Users/...` with the path percent-encoded
 * as UTF-8, so anything non-ASCII in a filename — which is most of a real
 * collection — arrives escaped.
 */
export function locationToPath(location: string): string {
  if (!location) return ''
  let rest = location
  for (const prefix of ['file://localhost', 'file://127.0.0.1', 'file://']) {
    if (rest.startsWith(prefix)) {
      rest = rest.slice(prefix.length)
      break
    }
  }
  if (!rest.startsWith('/')) rest = '/' + rest
  try {
    return decodeURIComponent(rest)
  } catch {
    // A malformed escape should cost one track, not the whole import.
    return rest
  }
}

function num(value: string | undefined, fallback = 0): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** rekordbox stores star ratings as 0/51/102/153/204/255. */
export function ratingToStars(raw: string | undefined): number {
  const value = num(raw, 0)
  if (value <= 5) return Math.max(0, Math.round(value))
  return Math.max(0, Math.min(5, Math.round(value / 51)))
}

/** `0xFF007F` -> `#ff007f`. */
export function colourToHex(raw: string | undefined): string | null {
  if (!raw) return null
  const m = /^(?:0x|#)?([0-9a-fA-F]{6})$/.exec(raw.trim())
  return m ? `#${m[1].toLowerCase()}` : null
}

function markColour(attrs: Record<string, string>): string | null {
  const { Red, Green, Blue } = attrs
  if (Red === undefined || Green === undefined || Blue === undefined) return null
  const hex = (v: string): string =>
    Math.max(0, Math.min(255, Math.round(num(v)))).toString(16).padStart(2, '0')
  return `#${hex(Red)}${hex(Green)}${hex(Blue)}`
}

function parseMetro(metro: string | undefined): number {
  if (!metro) return 4
  const beats = parseInt(metro.split('/')[0], 10)
  return Number.isFinite(beats) && beats > 0 ? beats : 4
}

// ---------------------------------------------------------------------------
// Document -> collection
// ---------------------------------------------------------------------------

export function parseRekordboxXml(text: string): RekordboxCollection {
  const tracks: RekordboxTrack[] = []
  const playlists: RekordboxPlaylist[] = []
  let producedBy = ''

  let current: RekordboxTrack | null = null
  let inCollection = false
  let inPlaylists = false
  /** Folder names of the open PLAYLISTS nodes, outermost first. */
  const folderStack: string[] = []
  let openPlaylist: RekordboxPlaylist | null = null

  const finishPlaylist = (): void => {
    if (openPlaylist) {
      playlists.push(openPlaylist)
      openPlaylist = null
    }
  }

  scanXml(
    text,
    (tag) => {
      const a = tag.attrs
      switch (tag.name) {
        case 'PRODUCT':
          producedBy = [a.Name, a.Version].filter(Boolean).join(' ')
          break
        case 'COLLECTION':
          inCollection = true
          break
        case 'PLAYLISTS':
          inPlaylists = true
          break
        case 'NODE': {
          if (!inPlaylists) break
          // Type 0 is a folder, type 1 a playlist. The ROOT folder is not a
          // real folder and must not appear in the path.
          if (a.Type === '1') {
            finishPlaylist()
            // ROOT and any unnamed node push a placeholder to keep the stack
            // balanced against their close tag; they are not real folders.
            openPlaylist = { name: a.Name ?? '', folders: folderStack.filter(Boolean), trackIds: [] }
            if (tag.selfClosing) finishPlaylist()
          } else {
            if (!tag.selfClosing && a.Name !== undefined && a.Name !== 'ROOT') folderStack.push(a.Name)
            else if (!tag.selfClosing) folderStack.push('')
          }
          break
        }
        case 'TRACK': {
          if (inPlaylists) {
            // Inside a playlist a TRACK is only a reference by TrackID.
            if (openPlaylist && a.Key !== undefined) openPlaylist.trackIds.push(a.Key)
            break
          }
          if (!inCollection) break
          const added = a.DateAdded ? Date.parse(a.DateAdded) : NaN
          current = {
            trackId: a.TrackID ?? '',
            name: a.Name ?? '',
            artist: a.Artist ?? '',
            album: a.Album ?? '',
            genre: a.Genre ?? '',
            comments: a.Comments ?? '',
            path: locationToPath(a.Location ?? ''),
            totalTimeSec: num(a.TotalTime, 0),
            averageBpm: a.AverageBpm ? num(a.AverageBpm, 0) || null : null,
            sampleRate: num(a.SampleRate, 44100),
            tonality: a.Tonality ?? '',
            rating: ratingToStars(a.Rating),
            colour: colourToHex(a.Colour),
            dateAdded: Number.isFinite(added) ? added : Date.now(),
            tempos: [],
            marks: []
          }
          if (tag.selfClosing) {
            tracks.push(current)
            current = null
          }
          break
        }
        case 'TEMPO':
          if (current) {
            current.tempos.push({
              inizio: num(a.Inizio, 0),
              bpm: num(a.Bpm, 0),
              battito: num(a.Battito, 1) || 1,
              beatsPerBar: parseMetro(a.Metro)
            })
          }
          break
        case 'POSITION_MARK':
          if (current) {
            current.marks.push({
              name: a.Name ?? '',
              type: num(a.Type, 0),
              start: num(a.Start, 0),
              end: a.End !== undefined && a.End !== '' ? num(a.End, 0) : null,
              num: a.Num !== undefined ? num(a.Num, -1) : -1,
              color: markColour(a)
            })
          }
          break
      }
    },
    (name) => {
      if (name === 'TRACK') {
        if (current) {
          tracks.push(current)
          current = null
        }
      } else if (name === 'COLLECTION') {
        inCollection = false
      } else if (name === 'PLAYLISTS') {
        finishPlaylist()
        inPlaylists = false
        folderStack.length = 0
      } else if (name === 'NODE' && inPlaylists) {
        if (openPlaylist) finishPlaylist()
        else folderStack.pop()
      }
    }
  )

  return { producedBy, tracks, playlists }
}
