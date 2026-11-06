// The subtitle tracks inside a Matroska file (MKV, WebM): their names and languages from the
// header, and their lines read from the clusters around the moment playing, so a 2 GB file's
// subtitles show without reading the whole file. mediabunny, which reads the picture and the
// sound, does not read subtitle tracks, so this is a small reader of its own over the same bytes.
//
// Text tracks only: SubRip (S_TEXT/UTF8), SubStation Alpha (S_TEXT/ASS, S_TEXT/SSA) and WebVTT
// (S_TEXT/WEBVTT, D_WEBVTT/SUBTITLES). Picture subtitles (PGS, VobSub) are listed so the menu can
// say they need the app, but never read.
//
// Nothing read here is trusted: a size past the file's end, an absurd count or a broken element
// ends that element and the rest is kept.

export type Read = (start: number, end: number) => Promise<Uint8Array>

export type SubKind = 'srt' | 'ass' | 'vtt' | 'picture'

export interface MkvSubTrack {
    /** The track's number in the file's blocks. */
    number: number
    kind: SubKind
    codecId: string
    /** ISO 639-2 ("eng") or BCP 47 ("pt-BR"), empty when the file does not say ("und"). */
    language: string
    name: string
    isDefault: boolean
    forced: boolean
    hearingImpaired: boolean
    /** Content compression the blocks carry: zlib, or bytes stripped from each block's head. */
    zlib: boolean
    stripped: Uint8Array | null
}

export interface MkvIndex {
    tracks: MkvSubTrack[]
    /** Nanoseconds per tick. */
    scale: number
    /** Cluster start times (seconds) and absolute byte positions, sorted by time. */
    clusters: { time: number; pos: number }[]
    duration: number
}

export interface SubLine {
    track: number
    start: number
    end: number
    text: string
}

const ID = {
    EBML: 0x1a45dfa3,
    Segment: 0x18538067,
    SeekHead: 0x114d9b74,
    Seek: 0x4dbb,
    SeekID: 0x53ab,
    SeekPosition: 0x53ac,
    Info: 0x1549a966,
    TimestampScale: 0x2ad7b1,
    Duration: 0x4489,
    Tracks: 0x1654ae6b,
    TrackEntry: 0xae,
    TrackNumber: 0xd7,
    TrackType: 0x83,
    FlagEnabled: 0xb9,
    FlagDefault: 0x88,
    FlagForced: 0x55aa,
    FlagHearingImpaired: 0x55ab,
    CodecID: 0x86,
    Name: 0x536e,
    Language: 0x22b59c,
    LanguageBCP47: 0x22b59d,
    ContentEncodings: 0x6d80,
    ContentEncoding: 0x6240,
    ContentCompression: 0x5034,
    ContentCompAlgo: 0x4254,
    ContentCompSettings: 0x4255,
    ContentEncryption: 0x5035,
    Cues: 0x1c53bb6b,
    CuePoint: 0xbb,
    CueTime: 0xb3,
    CueTrackPositions: 0xb7,
    CueClusterPosition: 0xf1,
    Cluster: 0x1f43b675,
    Timestamp: 0xe7,
    SimpleBlock: 0xa3,
    BlockGroup: 0xa0,
    Block: 0xa1,
    BlockDuration: 0x9b,
    Tags: 0x1254c367,
} as const

const SUBTITLE_TYPE = 0x11
/** More than any real file carries; past it the file is not trusted. */
const MAX_TRACKS = 256
const MAX_CUES_BYTES = 16 * 1024 * 1024
const MAX_TRACKS_BYTES = 4 * 1024 * 1024
const MAX_CLUSTER_BYTES = 64 * 1024 * 1024
/** A line with no duration (a SimpleBlock) shows until the next one, at most this long. */
const OPEN_LINE_SECONDS = 5

interface Element {
    id: number
    /** Where the element's data starts and ends (absolute); `end` is null for an unknown size. */
    start: number
    end: number | null
}

/** A variable-length integer at `at`: its value and length; `keepMarker` for element ids. */
function vint(b: Uint8Array, at: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } | null {
    if (at >= b.length) return null
    const first = b[at]
    if (first === 0) return null
    let length = 1
    while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++
    if (length > 8 || at + length > b.length) return null
    let value = keepMarker ? first : first & (0xff >> length)
    let allOnes = value === 0xff >> length
    for (let i = 1; i < length; i++) {
        value = value * 256 + b[at + i]
        if (b[at + i] !== 0xff) allOnes = false
    }
    return { value, length, unknown: !keepMarker && allOnes }
}

/** The element whose header starts at `at` of `b` (which begins at `base` in the file). */
function header(b: Uint8Array, at: number, base: number): (Element & { headerEnd: number }) | null {
    const id = vint(b, at, true)
    if (!id || id.length > 4) return null
    const size = vint(b, at + id.length, false)
    if (!size) return null
    const start = base + at + id.length + size.length
    return { id: id.value, start, end: size.unknown ? null : start + size.value, headerEnd: at + id.length + size.length }
}

/** The direct children of a buffer that holds a whole element's data. */
function* children(b: Uint8Array): Generator<{ id: number; data: Uint8Array }> {
    let at = 0
    while (at < b.length) {
        const h = header(b, at, 0)
        if (!h || h.end === null || h.end > b.length) return
        yield { id: h.id, data: b.subarray(h.start, h.end) }
        at = h.end
    }
}

function uint(d: Uint8Array): number {
    let v = 0
    for (let i = 0; i < Math.min(d.length, 8); i++) v = v * 256 + d[i]
    return v
}

function float(d: Uint8Array): number {
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength)
    if (d.length === 4) return view.getFloat32(0)
    if (d.length === 8) return view.getFloat64(0)
    return NaN
}

const utf8 = new TextDecoder('utf-8')
const text = (d: Uint8Array) => utf8.decode(d).replace(/\0+$/, '')

function kindOf(codecId: string): SubKind | null {
    if (codecId === 'S_TEXT/UTF8' || codecId === 'S_TEXT/ASCII') return 'srt'
    if (codecId === 'S_TEXT/ASS' || codecId === 'S_TEXT/SSA' || codecId === 'S_ASS' || codecId === 'S_SSA') return 'ass'
    if (codecId === 'S_TEXT/WEBVTT' || codecId === 'D_WEBVTT/SUBTITLES' || codecId === 'D_WEBVTT/CAPTIONS') return 'vtt'
    if (codecId === 'S_HDMV/PGS' || codecId === 'S_VOBSUB' || codecId === 'S_DVBSUB' || codecId === 'S_IMAGE/BMP' || codecId === 'S_HDMV/TEXTST') return 'picture'
    return null
}

function readTrack(entry: Uint8Array): MkvSubTrack | null {
    let number = 0
    let type = 0
    let codecId = ''
    let language = 'eng'
    let bcp47 = ''
    let name = ''
    let isDefault = true
    let forced = false
    let hearingImpaired = false
    let enabled = true
    let zlib = false
    let stripped: Uint8Array | null = null
    let encrypted = false
    for (const c of children(entry)) {
        switch (c.id) {
            case ID.TrackNumber: number = uint(c.data); break
            case ID.TrackType: type = uint(c.data); break
            case ID.CodecID: codecId = text(c.data); break
            case ID.Language: language = text(c.data); break
            case ID.LanguageBCP47: bcp47 = text(c.data); break
            case ID.Name: name = text(c.data); break
            case ID.FlagDefault: isDefault = uint(c.data) === 1; break
            case ID.FlagForced: forced = uint(c.data) === 1; break
            case ID.FlagHearingImpaired: hearingImpaired = uint(c.data) === 1; break
            case ID.FlagEnabled: enabled = uint(c.data) !== 0; break
            case ID.ContentEncodings:
                for (const enc of children(c.data)) {
                    if (enc.id !== ID.ContentEncoding) continue
                    for (const e of children(enc.data)) {
                        if (e.id === ID.ContentEncryption) encrypted = true
                        if (e.id !== ID.ContentCompression) continue
                        let algo = 0
                        let settings: Uint8Array | null = null
                        for (const x of children(e.data)) {
                            if (x.id === ID.ContentCompAlgo) algo = uint(x.data)
                            if (x.id === ID.ContentCompSettings) settings = x.data.slice()
                        }
                        if (algo === 0) zlib = true
                        else if (algo === 3) stripped = settings
                        else encrypted = true // bzlib, lzo1x: not read here
                    }
                }
                break
        }
    }
    if (type !== SUBTITLE_TYPE || !number || !enabled) return null
    const kind = kindOf(codecId)
    if (!kind) return null
    const lang = (bcp47 || language).trim()
    return {
        number,
        kind: encrypted ? 'picture' : kind,
        codecId,
        language: lang === 'und' ? '' : lang,
        name: name.trim(),
        isDefault,
        forced,
        hearingImpaired: hearingImpaired || /\b(sdh|cc|hi)\b/i.test(name),
        zlib,
        stripped,
    }
}

/** Reads the file's header, track list and cue index; null when it is not Matroska or has no subtitle tracks. */
export async function readMkvIndex(read: Read, size: number): Promise<MkvIndex | null> {
    const head = await read(0, Math.min(size, 64 * 1024))
    const ebml = header(head, 0, 0)
    if (!ebml || ebml.id !== ID.EBML || ebml.end === null) return null
    const seg = header(head, ebml.end, 0)
    if (!seg || seg.id !== ID.Segment) return null
    const segmentStart = seg.start
    const segmentEnd = seg.end === null ? size : Math.min(seg.end, size)

    let scale = 1_000_000
    let duration = 0
    let tracksAt: number | null = null
    let cuesAt: number | null = null
    let infoAt: number | null = null

    // A SeekHead says where the rest is; mkvmerge's first one often points at a second at the end.
    const seekHeads = new Set<number>()
    const readSeekHead = async (pos: number, start: number, end: number) => {
        if (seekHeads.has(pos) || seekHeads.size >= 4 || end - start > 1024 * 1024) return
        seekHeads.add(pos)
        const data = await read(start, end)
        for (const s of children(data)) {
            if (s.id !== ID.Seek) continue
            let id = 0
            let rel = -1
            for (const x of children(s.data)) {
                if (x.id === ID.SeekID) id = uint(x.data)
                if (x.id === ID.SeekPosition) rel = uint(x.data)
            }
            const p = segmentStart + rel
            if (rel < 0 || p >= size) continue
            if (id === ID.Tracks && tracksAt === null) tracksAt = p
            if (id === ID.Cues && cuesAt === null) cuesAt = p
            if (id === ID.Info && infoAt === null) infoAt = p
            if (id === ID.SeekHead) {
                const hb = await read(p, Math.min(p + 16, size))
                const sh = header(hb, 0, p)
                if (sh && sh.id === ID.SeekHead && sh.end !== null && sh.end <= size) await readSeekHead(p, sh.start, sh.end)
            }
        }
    }

    // The top level, element by element, up to the first cluster.
    let at = segmentStart
    for (let guard = 0; guard < 64 && at < segmentEnd; guard++) {
        const buf = await read(at, Math.min(at + 16, segmentEnd))
        const h = header(buf, 0, at)
        if (!h || h.end === null) break
        if (h.id === ID.Cluster) break
        if (h.id === ID.SeekHead) await readSeekHead(at, h.start, h.end)
        if (h.id === ID.Tracks) tracksAt = at
        if (h.id === ID.Cues) cuesAt = at
        if (h.id === ID.Info) infoAt = at
        at = h.end
    }

    const whole = async (pos: number, id: number, max: number): Promise<Uint8Array | null> => {
        if (pos < 0 || pos >= size) return null
        const buf = await read(pos, Math.min(pos + 16, size))
        const h = header(buf, 0, pos)
        if (!h || h.id !== id || h.end === null || h.end > size || h.end - h.start > max) return null
        return read(h.start, h.end)
    }

    if (infoAt !== null) {
        const info = await whole(infoAt, ID.Info, 1024 * 1024)
        if (info)
            for (const c of children(info)) {
                if (c.id === ID.TimestampScale) scale = uint(c.data) || scale
                if (c.id === ID.Duration) duration = float(c.data)
            }
    }
    duration = Number.isFinite(duration) && duration > 0 ? (duration * scale) / 1e9 : 0

    if (tracksAt === null) return null
    const tracksData = await whole(tracksAt, ID.Tracks, MAX_TRACKS_BYTES)
    if (!tracksData) return null
    const tracks: MkvSubTrack[] = []
    for (const c of children(tracksData)) {
        if (c.id !== ID.TrackEntry) continue
        const t = readTrack(c.data)
        if (t) tracks.push(t)
        if (tracks.length >= MAX_TRACKS) break
    }
    if (!tracks.length) return null

    const clusters: { time: number; pos: number }[] = []
    if (cuesAt !== null) {
        const cues = await whole(cuesAt, ID.Cues, MAX_CUES_BYTES).catch(() => null)
        if (cues) {
            const seen = new Set<number>()
            for (const p of children(cues)) {
                if (p.id !== ID.CuePoint) continue
                let time = -1
                const positions: number[] = []
                for (const x of children(p.data)) {
                    if (x.id === ID.CueTime) time = uint(x.data)
                    if (x.id === ID.CueTrackPositions)
                        for (const y of children(x.data)) if (y.id === ID.CueClusterPosition) positions.push(uint(y.data))
                }
                if (time < 0) continue
                for (const rel of positions) {
                    const pos = segmentStart + rel
                    if (pos >= size || seen.has(pos)) continue
                    seen.add(pos)
                    clusters.push({ time: (time * scale) / 1e9, pos })
                }
            }
            clusters.sort((a, b) => a.time - b.time || a.pos - b.pos)
        }
    }
    return { tracks, scale, clusters, duration }
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** A block's frame for one of `wanted`: its track, time offset (ticks) and payload; laced blocks are skipped. */
function block(d: Uint8Array): { track: number; offset: number; payload: Uint8Array } | null {
    const t = vint(d, 0, false)
    if (!t || d.length < t.length + 3) return null
    const offset = (((d[t.length] << 8) | d[t.length + 1]) << 16) >> 16
    const flags = d[t.length + 2]
    if (flags & 0x06) return null
    return { track: t.value, offset, payload: d.subarray(t.length + 3) }
}

/**
 * The subtitle lines of one cluster for the tracks in `wanted`, with times in seconds. The
 * cluster is read in one go (a feature's clusters are 1 to 5 MB), from the same bytes playback
 * reads, so most of it is already in memory.
 */
export async function readCluster(read: Read, pos: number, size: number, index: MkvIndex, wanted: Map<number, MkvSubTrack>): Promise<SubLine[]> {
    const headBuf = await read(pos, Math.min(pos + 16, size))
    const h = header(headBuf, 0, pos)
    if (!h || h.id !== ID.Cluster) return []
    // An unknown size (a live recording): up to the next cue's cluster, or 8 MB.
    const next = index.clusters.find((c) => c.pos > pos)?.pos
    const end = Math.min(size, h.end ?? next ?? h.start + 8 * 1024 * 1024)
    if (end - h.start > MAX_CLUSTER_BYTES) return []
    const data = await read(h.start, end)
    const tick = index.scale / 1e9
    let clusterTime = 0
    const lines: SubLine[] = []
    const pending: { track: MkvSubTrack; start: number; dur: number | null; payload: Uint8Array }[] = []
    let at = 0
    while (at < data.length) {
        const c = header(data, at, 0)
        if (!c) break
        // A cluster of unknown size ends at the next top-level element.
        if (c.id === ID.Cluster || c.id === ID.Cues || c.id === ID.Tags) break
        const cEnd = c.end === null ? data.length : Math.min(c.end, data.length)
        const body = data.subarray(c.start, cEnd)
        if (c.id === ID.Timestamp) clusterTime = uint(body)
        else if (c.id === ID.SimpleBlock) {
            const b = block(body)
            const tr = b && wanted.get(b.track)
            if (b && tr) pending.push({ track: tr, start: (clusterTime + b.offset) * tick, dur: null, payload: b.payload })
        } else if (c.id === ID.BlockGroup) {
            let b: ReturnType<typeof block> = null
            let dur: number | null = null
            for (const x of children(body)) {
                if (x.id === ID.Block) b = block(x.data)
                if (x.id === ID.BlockDuration) dur = uint(x.data) * tick
            }
            const tr = b && wanted.get(b.track)
            if (b && tr) pending.push({ track: tr, start: (clusterTime + b.offset) * tick, dur, payload: b.payload })
        }
        if (c.end === null) break
        at = c.end
    }
    for (const p of pending) {
        let bytes = p.payload
        try {
            if (p.track.stripped) {
                const joined = new Uint8Array(p.track.stripped.length + bytes.length)
                joined.set(p.track.stripped)
                joined.set(bytes, p.track.stripped.length)
                bytes = joined
            }
            if (p.track.zlib) bytes = await inflate(bytes)
        } catch {
            continue
        }
        const line = lineText(p.track.kind, text(bytes))
        if (!line) continue
        const end = p.dur !== null && p.dur > 0 ? p.start + p.dur : p.start + OPEN_LINE_SECONDS
        lines.push({ track: p.track.number, start: p.start, end, text: line })
    }
    return lines
}

/** A block's text as a WebVTT cue's text: ASS fields and override tags dropped, SubRip's tags kept to what WebVTT has. */
export function lineText(kind: SubKind, raw: string): string {
    let s = raw
    if (kind === 'ass') {
        // ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
        let commas = 0
        let i = 0
        for (; i < s.length && commas < 8; i++) if (s[i] === ',') commas++
        s = commas === 8 ? s.slice(i) : s
        // Drawings (\p1 ... \p0) are shapes, not words.
        if (/\{[^}]*\\p[1-9][^}]*\}/.test(s)) return ''
        s = s.replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ')
    } else if (kind === 'srt') {
        s = s.replace(/\r\n?/g, '\n').replace(/<\/?font[^>]*>/gi, '').replace(/\{\\[^}]*\}/g, '')
        // WebVTT knows <b>, <i>, <u>; anything else is shown as text, so it goes.
        s = s.replace(/<(?!\/?[biu]>)[^>]*>/gi, '')
    } else if (kind === 'vtt') {
        s = s.replace(/\r\n?/g, '\n')
    } else return ''
    return s.replace(/-->/g, '->').replace(/\n{2,}/g, '\n').trim()
}

/** The clusters to read for `[from, to)` seconds: the one holding `from` and every one starting before `to`. */
export function clustersFor(index: MkvIndex, from: number, to: number): { time: number; pos: number }[] {
    const list = index.clusters
    if (!list.length) return []
    let lo = 0
    let hi = list.length - 1
    // The last cluster starting at or before `from`.
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (list[mid].time <= from) lo = mid
        else hi = mid - 1
    }
    const out: { time: number; pos: number }[] = []
    for (let i = lo; i < list.length && list[i].time < to; i++) out.push(list[i])
    return out
}
