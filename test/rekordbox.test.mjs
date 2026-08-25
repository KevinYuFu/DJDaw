/**
 * rekordbox XML import.
 *
 * The fixture is awkward: non-ASCII filenames, XML entities in titles, a grid
 * marker off the downbeat, a mid-track tempo change, a loop hot cue, several
 * memory cues, and a track with no analysis at all.
 */
import * as X from './.build/rekordboxXml.mjs'
import * as I from './.build/rekordboxImport.mjs'

const { eq, ok } = globalThis.__t

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.1.0" Company="AlphaTheta"/>
  <COLLECTION Entries="4">
    <TRACK TrackID="1" Name="APT. (SABAI Remix)" Artist="ROS&#201; &amp; Bruno Mars"
      Album="Singles" Genre="Dance &amp; EDM" Comments="banger" Kind="MP3 File"
      TotalTime="212" AverageBpm="149.00" SampleRate="44100" Rating="204"
      Tonality="8A" Colour="0xFF007F" DateAdded="2025-04-12"
      Location="file://localhost/Users/dj/Downloads/ROS%C3%89%20&amp;%20Bruno%20Mars%20-%20APT.%20(SABAI%20Remix).mp3">
      <TEMPO Inizio="0.405" Bpm="149.00" Metro="4/4" Battito="1"/>
      <POSITION_MARK Name="" Type="0" Start="0.405" Num="-1"/>
      <POSITION_MARK Name="Drop" Type="0" Start="60.405" Num="0" Red="40" Green="226" Blue="20"/>
      <POSITION_MARK Name="Break" Type="0" Start="120.405" Num="2"/>
      <POSITION_MARK Name="Outro" Type="0" Start="180.405" Num="-1"/>
    </TRACK>
    <TRACK TrackID="2" Name="&#52880;&#52824; &#52880;&#52824;" Artist="YENA"
      TotalTime="190" AverageBpm="128.00" SampleRate="44100" Rating="0" Tonality="11B"
      DateAdded="2025-06-01"
      Location="file://localhost/Users/dj/Downloads/YENA%20-%20%EC%BA%90%EC%B9%98%20%EC%BA%90%EC%B9%98.mp3">
      <TEMPO Inizio="1.250" Bpm="128.00" Metro="4/4" Battito="3"/>
      <POSITION_MARK Name="Loop 8" Type="4" Start="32.0" End="46.999" Num="1" Red="222" Green="68" Blue="207"/>
    </TRACK>
    <TRACK TrackID="3" Name="Tempo Change" Artist="Test" TotalTime="300"
      AverageBpm="120.00" SampleRate="48000" Rating="51" DateAdded="2024-01-01"
      Location="file://localhost/Users/dj/Music/tempo.wav">
      <TEMPO Inizio="0.000" Bpm="120.00" Metro="4/4" Battito="1"/>
      <TEMPO Inizio="60.000" Bpm="140.00" Metro="4/4" Battito="1"/>
    </TRACK>
    <TRACK TrackID="4" Name="Unanalysed" Artist="Nobody" TotalTime="100"
      SampleRate="44100" Rating="0" DateAdded="2024-05-05"
      Location="file://localhost/Users/dj/Music/raw.aiff"/>
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="1">
      <NODE Type="0" Name="Gigs" Count="1">
        <NODE Name="Summer Set" Type="1" KeyType="0" Entries="2">
          <TRACK Key="1"/>
          <TRACK Key="3"/>
        </NODE>
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>`

const col = X.parseRekordboxXml(XML)

eq('reads the producing application', col.producedBy, 'rekordbox 7.1.0')
eq('finds every collection track', col.tracks.length, 4)

const [apt, yena, tempo, raw] = col.tracks

// Percent-decoding and entity expansion: a real collection is full of both.
eq('decodes a percent-encoded accented path', apt.path,
  '/Users/dj/Downloads/ROSÉ & Bruno Mars - APT. (SABAI Remix).mp3')
eq('expands numeric entities in a title', apt.artist, 'ROSÉ & Bruno Mars')
eq('expands named entities', apt.genre, 'Dance & EDM')
eq('decodes a percent-encoded Hangul path', yena.path,
  '/Users/dj/Downloads/YENA - 캐치 캐치.mp3')
eq('decodes Hangul from numeric entities', yena.name, '캐치 캐치')

eq('converts rekordbox star ratings', apt.rating, 4)
eq('a zero rating stays zero', yena.rating, 0)
eq('one star', tempo.rating, 1)
eq('converts the track colour', apt.colour, '#ff007f')
eq('a track with no colour is null', yena.colour, null)

// Grid phase. rekordbox markers may sit on any beat of the bar; DJDaw anchors
// beat 0 on a downbeat, so a Battito of 3 has to walk back two beats.
const aptGrid = I.gridFromTempos(apt)
eq('a Battito=1 marker is already a downbeat', aptGrid.anchors[0].time, 0.405, 1e-9)
eq('and keeps its tempo', aptGrid.anchors[0].bpm, 149)

const yenaGrid = I.gridFromTempos(yena)
eq('a Battito=3 marker walks back two beats', yenaGrid.anchors[0].time, 1.25 - 2 * (60 / 128), 1e-9)
ok('walking back never lands before the file', yenaGrid.anchors[0].time >= 0)

// The real invariant across every Battito: the anchor is a downbeat, and the
// original marker still lands on the beat of the bar rekordbox said it did.
// Walking back can go before t=0, in which case the anchor steps forward whole
// bars — which moves beat 0 but leaves every beat position and bar line intact.
for (const battito of [1, 2, 3, 4]) {
  for (const [bpm, inizio] of [[140, 0.41], [149, 0.42], [128, 3.5], [174, 12.0]]) {
    const g = I.gridFromTempos({
      tempos: [{ inizio, bpm, battito, beatsPerBar: 4 }],
      marks: [],
      averageBpm: bpm
    })
    const spb = 60 / bpm
    const beatsFromAnchor = (inizio - g.anchors[0].time) / spb
    const rounded = Math.round(beatsFromAnchor)
    ok(`Battito=${battito} @${bpm}bpm inizio=${inizio}: marker sits a whole number of beats from the anchor`,
      Math.abs(beatsFromAnchor - rounded) < 1e-9)
    // `rounded` may be negative: when walking back would go before the file,
    // the anchor steps forward a bar and the marker becomes a negative beat
    // index, which the grid maths handles and which leaves bar lines intact.
    eq(`Battito=${battito} @${bpm}bpm inizio=${inizio}: marker keeps its position in the bar`,
      ((rounded % 4) + 4) % 4, battito - 1)
    ok(`Battito=${battito} @${bpm}bpm inizio=${inizio}: anchor is not before the file`, g.anchors[0].time >= 0)
  }
}

const tempoGrid = I.gridFromTempos(tempo)
eq('a tempo change becomes a second anchor', tempoGrid.anchors.length, 2)
eq('second anchor time', tempoGrid.anchors[1].time, 60)
eq('second anchor tempo', tempoGrid.anchors[1].bpm, 140)
eq('a track with no TEMPO has no grid', I.gridFromTempos(raw), null)

// Cue mapping. Num carries hot cue vs memory cue.
const aptCues = I.cuesFromMarks(apt, aptGrid)
eq('hot cues are the marks with a pad number', aptCues.hotCues.length, 2)
eq('pad index is preserved, not renumbered', aptCues.hotCues[1].index, 2)
eq('pad A keeps its rekordbox colour', aptCues.hotCues[0].color, '#28e214')
eq('a pad with no colour falls back to the DJDaw palette', aptCues.hotCues[1].color, I.DEFAULT_HOT_CUE_COLORS[2])
eq('hot cue names survive', aptCues.hotCues[0].name, 'Drop')
eq('the earliest memory cue becomes the CUE point', aptCues.cuePoint, 0.405)
eq('and is not also listed as a memory cue', aptCues.memoryCues.length, 1)
eq('the remaining memory cue is kept', aptCues.memoryCues[0].time, 180.405)

const yenaCues = I.cuesFromMarks(yena, yenaGrid)
eq('a loop mark becomes a loop hot cue', yenaCues.hotCues[0].type, 'loop')
eq('and its length is rounded to a musical value', yenaCues.hotCues[0].loopBeats, 32)
eq('a track with no memory cue has no CUE point', yenaCues.cuePoint, null)

// Whole-track conversion.
const t = I.trackFromRekordbox(apt, 'abc123')
eq('id comes from the caller', t.id, 'abc123')
eq('title', t.title, 'APT. (SABAI Remix)')
eq('bpm', t.bpm, 149)
eq('key', t.key, '8A')
eq('a rekordbox grid counts as analysed', t.analyzed, true)
eq('an ungridded track is not analysed', I.trackFromRekordbox(raw, 'x').analyzed, false)
eq('a missing artist gets a placeholder', I.trackFromRekordbox(raw, 'x').artist, 'Nobody')

// Playlists.
eq('finds the playlist', col.playlists.length, 1)
eq('playlist name', col.playlists[0].name, 'Summer Set')
eq('nested under its folder, without ROOT', col.playlists[0].folders.join('/'), 'Gigs')
eq('playlist track references in order', col.playlists[0].trackIds.join(','), '1,3')

// Re-import must never destroy work done in DJDaw.
{
  const mine = I.trackFromRekordbox(apt, 'abc123')
  mine.grid = { anchors: [{ time: 9.99, bpm: 150 }], beatsPerBar: 4 }
  mine.bpm = 150
  mine.hotCues = [{ index: 0, time: 42, color: '#fff', type: 'cue' }]
  mine.cuePoint = 42
  const merged = I.mergeImported(mine, I.trackFromRekordbox(apt, 'abc123'))
  eq('a re-import keeps my corrected grid', merged.grid.anchors[0].time, 9.99)
  eq('and my corrected tempo', merged.bpm, 150)
  eq('and my own hot cues', merged.hotCues[0].time, 42)
  eq('while still refreshing metadata', merged.genre, 'Dance & EDM')
}
{
  const empty = I.trackFromRekordbox(raw, 'y')
  const merged = I.mergeImported(empty, I.trackFromRekordbox(apt, 'y'))
  eq('an empty track does take the imported grid', merged.grid.anchors[0].time, 0.405, 1e-9)
  eq('and the imported cues', merged.hotCues.length, 2)
}

// Scanner robustness.
eq('handles > inside an attribute value',
  X.parseRekordboxXml('<COLLECTION><TRACK Name="a &gt; b" Location="file:///x.mp3"/></COLLECTION>').tracks[0].name,
  'a > b')
eq('skips comments', X.parseRekordboxXml('<COLLECTION><!-- <TRACK Name="ghost"/> --></COLLECTION>').tracks.length, 0)
eq('an empty document yields nothing', X.parseRekordboxXml('').tracks.length, 0)
eq('a truncated document does not throw', X.parseRekordboxXml('<COLLECTION><TRACK Name="x"').tracks.length, 0)
eq('handles file:/// with no host', X.locationToPath('file:///Users/a/b.mp3'), '/Users/a/b.mp3')
eq('leaves a malformed escape alone rather than failing', X.locationToPath('file://localhost/bad%ZZpath.mp3'), '/bad%ZZpath.mp3')
