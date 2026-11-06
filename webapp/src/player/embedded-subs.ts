// The subtitle tracks inside the video file, as text tracks of the player's `<video>`: they show in
// the Subtitles menu beside a file from the device and MSone's, and their lines are read (mkvsubs.ts)
// from the clusters around the moment playing, a minute ahead, only while one of them is shown.
import { kvRead, kvRemove, kvWrite } from '../store'
import { t } from '../i18n'
import type { TgFile } from '../stream/reader'
import { clustersFor, readCluster, readMkvIndex, type MkvIndex, type MkvSubTrack, type SubLine } from './mkvsubs'

/** Seconds of lines kept ready behind and ahead of the moment playing. */
const BEHIND = 3
const AHEAD = 60
/** Clusters read at once: playback's own reads go first (TgFile.peek). */
const PARALLEL = 2
/** The language last chosen from a file's own tracks ("" for off), so the next video starts with it. */
const LANGUAGE_KEY = 'player:subtitle-language'

let names: Intl.DisplayNames | null | undefined

/** "eng", "en" or "pt-BR" as a name ("English"), or "" when the browser does not know it. */
export function languageName(code: string | null | undefined): string {
    if (!code || code === 'und' || code === 'mul' || code === 'zxx') return ''
    if (names === undefined) {
        try {
            names = new Intl.DisplayNames(['en'], { type: 'language' })
        } catch {
            names = null
        }
    }
    try {
        const name = names?.of(code)
        return name && name.toLowerCase() !== code.toLowerCase() ? name : code.toUpperCase()
    } catch {
        return code.toUpperCase()
    }
}

/** The primary language of a tag ("en-US" and "eng" both "en" when the browser maps them), for matching. */
function baseLanguage(code: string): string {
    try {
        return new Intl.Locale(code).language
    } catch {
        return code.split(/[-_]/)[0].toLowerCase()
    }
}

/** A track's name less what the label says already (the language, SDH, Forced), so a group's tag stays and noise goes. */
function extraName(track: MkvSubTrack, language: string): string {
    let rest = track.name
    if (language) rest = rest.replace(new RegExp(`\\b${language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), '')
    rest = rest.replace(/[[(]?\b(sdh|cc|hi|forced)\b[\])]?/gi, '').replace(/^[\s\-.,:|·]+|[\s\-.,:|·]+$/g, '').replace(/\s{2,}/g, ' ')
    return rest
}

export function subLabel(track: MkvSubTrack, index: number): string {
    const language = languageName(track.language)
    const head = [language || track.name || t('player.track_number', { number: index + 1 }), track.hearingImpaired ? 'SDH' : '', track.forced ? t('tracks.forced') : ''].filter(Boolean).join(' ')
    const extra = language ? extraName(track, language) : ''
    return extra ? `${head} · ${extra}` : head
}

/** A line's text as WebVTT cue text: a bare `&` or `<` would be read as markup. */
function cueText(text: string): string {
    return text.replace(/&(?![a-z]+;|#\d+;)/gi, '&amp;').replace(/<(?!\/?[biu]>)/gi, '&lt;')
}

export class EmbeddedSubtitles {
    private readonly elements = new Map<number, HTMLTrackElement>()
    private readonly done = new Set<number>()
    private readonly busy = new Set<number>()
    private closed = false
    private lastPump = 0
    /** Until when a mode change is our own (the tracks loading, the first pick), not the viewer's choice. */
    private settling = 0
    /** An empty WebVTT file each track loads, so the browser never empties the cues added to it later. */
    private blank = ''

    private constructor(
        private readonly file: TgFile,
        private readonly video: HTMLVideoElement,
        private readonly index: MkvIndex,
        private readonly onCues: () => void,
    ) {}

    /** The text tracks of a Matroska file, or null for any other file or one without them. */
    static async open(file: TgFile, video: HTMLVideoElement, onCues: () => void): Promise<EmbeddedSubtitles | null> {
        const index = await readMkvIndex((s, e) => file.peek(s, e), file.size).catch((e) => {
            console.warn('[subs] could not read the track list', e)
            return null
        })
        if (!index) return null
        const text = index.tracks.filter((tr) => tr.kind !== 'picture')
        if (!text.length) return null
        const subs = new EmbeddedSubtitles(file, video, index, onCues)
        await subs.attach(text)
        return subs
    }

    get count(): number {
        return this.elements.size
    }

    /** The picture subtitle tracks the file has (PGS, VobSub), which only the app shows. */
    get pictureOnly(): boolean {
        return this.index.tracks.every((tr) => tr.kind === 'picture')
    }

    private async attach(tracks: MkvSubTrack[]) {
        // A track with no file is "failed to load", and Chrome empties a track's cues when it
        // loads or fails: each loads an empty file first, and cues are added only after that.
        this.blank = URL.createObjectURL(new Blob(['WEBVTT\n\n'], { type: 'text/vtt' }))
        this.settling = Infinity
        await Promise.all(
            tracks.map(
                (tr, i) =>
                    new Promise<void>((resolve) => {
                        const el = document.createElement('track')
                        el.kind = 'subtitles'
                        el.label = subLabel(tr, i)
                        if (tr.language) el.srclang = tr.language
                        el.dataset.embedded = String(tr.number)
                        el.src = this.blank
                        el.addEventListener('load', () => resolve(), { once: true })
                        el.addEventListener('error', () => resolve(), { once: true })
                        window.setTimeout(resolve, 3000)
                        this.video.append(el)
                        this.elements.set(tr.number, el)
                        // A disabled track is never loaded.
                        el.track.mode = 'hidden'
                    }),
            ),
        )
        if (this.closed) return
        for (const el of this.elements.values()) el.track.mode = 'disabled'
        const wanted = await kvRead<string>(LANGUAGE_KEY).catch(() => undefined)
        if (this.closed) return
        const pick = this.choose(tracks, wanted)
        if (pick) this.show(pick.number)
        this.settling = performance.now() + 300
        this.video.textTracks.addEventListener('change', this.onChange)
        this.video.addEventListener('timeupdate', this.onTime)
        this.video.addEventListener('seeked', this.onSeeked)
        this.pump(true)
    }

    /** The track to start with: the language chosen last time, else one the file marks forced or default. */
    private choose(tracks: MkvSubTrack[], wanted: string | undefined): MkvSubTrack | null {
        const plain = (list: MkvSubTrack[]) => list.find((tr) => !tr.forced && !tr.hearingImpaired) ?? list.find((tr) => !tr.forced) ?? null
        if (wanted) {
            const same = tracks.filter((tr) => tr.language && baseLanguage(tr.language) === baseLanguage(wanted))
            const found = plain(same)
            if (found) return found
        }
        const forced = tracks.find((tr) => tr.forced)
        if (forced) return forced
        // Turned off last time: only what the file says must show.
        if (wanted === '') return null
        return wanted === undefined ? (tracks.find((tr) => tr.isDefault && tracks.length === 1) ?? null) : null
    }

    private show(number: number) {
        for (const tt of Array.from(this.video.textTracks)) if (tt.kind === 'subtitles' || tt.kind === 'captions') tt.mode = 'disabled'
        const el = this.elements.get(number)
        if (el) el.track.mode = 'showing'
    }

    private showing(): MkvSubTrack | null {
        for (const [number, el] of this.elements) if (el.track.mode === 'showing') return this.index.tracks.find((tr) => tr.number === number) ?? null
        return null
    }

    private readonly onChange = () => {
        if (this.closed) return
        const shown = this.showing()
        if (performance.now() > this.settling) {
            // The viewer picked one of the file's tracks, or turned subtitles off: remembered for the next video.
            const anyShown = Array.from(this.video.textTracks).some((tt) => tt.mode === 'showing')
            if (shown?.language) kvWrite(LANGUAGE_KEY, shown.language)
            else if (!anyShown) kvWrite(LANGUAGE_KEY, '')
        }
        if (shown) this.pump(true)
    }

    private readonly onTime = () => this.pump(false)
    private readonly onSeeked = () => this.pump(true)

    /** Reads the clusters of the next minute that are not read yet, a couple at a time, while a track of the file shows. */
    private pump(now: boolean) {
        if (this.closed || !this.showing()) return
        const at = performance.now()
        if (!now && at - this.lastPump < 1000) return
        this.lastPump = at
        const time = this.video.currentTime || 0
        const todo = clustersFor(this.index, Math.max(0, time - BEHIND), time + AHEAD).filter((c) => !this.done.has(c.pos) && !this.busy.has(c.pos))
        for (const c of todo) {
            if (this.busy.size >= PARALLEL) break
            this.busy.add(c.pos)
            void this.readOne(c.pos)
        }
    }

    private async readOne(pos: number) {
        const wanted = new Map(this.index.tracks.filter((tr) => this.elements.has(tr.number)).map((tr) => [tr.number, tr]))
        try {
            const lines = await readCluster((s, e) => this.file.peek(s, e), pos, this.file.size, this.index, wanted)
            if (this.closed) return
            this.done.add(pos)
            this.add(lines)
        } catch (e) {
            // A seek dropped the read, or Telegram failed it: tried again on the next tick.
            if ((e as Error)?.name !== 'AbortError') console.debug('[subs] cluster', pos, e)
        } finally {
            this.busy.delete(pos)
        }
        if (!this.closed) this.pump(true)
    }

    private add(lines: SubLine[]) {
        if (!lines.length) return
        for (const line of lines) {
            const tt = this.elements.get(line.track)?.track
            if (!tt) continue
            try {
                tt.addCue(new VTTCue(line.start, Math.max(line.end, line.start + 0.1), cueText(line.text)))
            } catch {
                // A cue the browser refuses (an odd time) is skipped.
            }
        }
        this.onCues()
    }

    /** Takes the tracks off the video: on a new source and on closing. */
    destroy() {
        if (this.closed) return
        this.closed = true
        this.video.textTracks.removeEventListener('change', this.onChange)
        this.video.removeEventListener('timeupdate', this.onTime)
        this.video.removeEventListener('seeked', this.onSeeked)
        for (const el of this.elements.values()) {
            el.track.mode = 'disabled'
            el.remove()
        }
        this.elements.clear()
        if (this.blank) URL.revokeObjectURL(this.blank)
    }
}

/** Forgets the language chosen from files' own tracks (Settings' clear, signing out). */
export const forgetSubtitleLanguage = () => kvRemove(LANGUAGE_KEY)
