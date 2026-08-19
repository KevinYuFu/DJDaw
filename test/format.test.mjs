import * as F from './.build/format.mjs'

const { eq } = globalThis.__t

eq('CDJ elapsed time', F.formatTime(221.34), '3:41.3')
eq('elapsed time without tenths', F.formatTime(221.34, false), '3:41')
eq('negative remaining time', F.formatTime(-12.5), '-0:12.5')
eq('non-finite time does not crash the display', F.formatTime(NaN), '0:00.0')
eq('browser duration column', F.formatDuration(221.9), '03:41')
eq('unknown duration', F.formatDuration(NaN), '--:--')
eq('tempo readout', F.formatBpm(128), '128.00')
eq('tempo readout before analysis', F.formatBpm(null), '--.--')
eq('pitch readout is always signed', F.formatPitch(2.5), '+2.50%')
eq('negative pitch readout', F.formatPitch(-2.5), '-2.50%')
eq('bar.beat counter is 1-based', F.formatBarBeat(3, 2), '4.3')
eq('whole beat-jump sizes', F.formatBeats(16), '16')
eq('fractional beat-jump sizes', F.formatBeats(0.25), '1/4')
