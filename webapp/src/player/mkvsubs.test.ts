// The Matroska subtitle reader (mkvsubs.ts) against e2e/media/tracks.mkv, and against garbage:
// nothing it is given may throw past it or loop. `node --test "src/player/*.test.ts"`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { clustersFor, lineText, readCluster, readMkvIndex, type Read } from './mkvsubs.ts'

const media = (name: string) => new Uint8Array(readFileSync(new URL(`../../e2e/media/${name}`, import.meta.url)))
const reader = (bytes: Uint8Array): Read => async (start, end) => bytes.subarray(start, Math.min(end, bytes.length))

test('the subtitle tracks of a Matroska file and their lines', async () => {
    const bytes = media('tracks.mkv')
    const index = await readMkvIndex(reader(bytes), bytes.length)
    assert.ok(index)
    assert.deepEqual(
        index.tracks.map((t) => [t.kind, t.language, t.name]),
        [
            ['srt', 'eng', ''],
            ['ass', 'spa', 'Spanish'],
        ],
    )
    assert.ok(index.clusters.length > 0)
    const wanted = new Map(index.tracks.map((t) => [t.number, t]))
    const lines = []
    for (const c of clustersFor(index, 0, 10)) lines.push(...(await readCluster(reader(bytes), c.pos, bytes.length, index, wanted)))
    assert.deepEqual(
        lines.map((l) => [l.start, l.end, l.text]),
        [
            [0.5, 2, 'First test line'],
            [1, 3, 'Primera linea\nde prueba'],
            [2.5, 4, 'Second <i>test</i> line'],
            [4, 6, 'Segunda linea'],
            [5, 7.5, 'Third test line'],
        ],
    )
})

test('files without subtitle tracks, or not Matroska, give nothing', async () => {
    for (const name of ['h264-aac.mkv', 'h264-aac.mp4', 'vp9-opus.webm', 'mpeg4.avi']) {
        const bytes = media(name)
        assert.equal(await readMkvIndex(reader(bytes), bytes.length), null, name)
    }
})

test('garbage, cut and random input never throws', async () => {
    const bytes = media('tracks.mkv')
    const inputs: Uint8Array[] = [new Uint8Array(0), new Uint8Array(64).fill(0xff), bytes.subarray(0, 40), bytes.subarray(0, 4096), bytes.subarray(0, bytes.length >> 1)]
    let seed = 7
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff
    for (let n = 0; n < 50; n++) {
        const noisy = bytes.slice(0, 8192)
        for (let k = 0; k < 40; k++) noisy[64 + ((random() << 5) % 8000)] = random()
        inputs.push(noisy)
    }
    for (const b of inputs) {
        const index = await readMkvIndex(reader(b), b.length).catch((e) => assert.fail(e))
        if (!index) continue
        const wanted = new Map(index.tracks.map((t) => [t.number, t]))
        for (const c of clustersFor(index, 0, 1e9).slice(0, 20)) await readCluster(reader(b), c.pos, b.length, index, wanted).catch((e) => assert.fail(e))
    }
})

test('a line as WebVTT text', () => {
    assert.equal(lineText('ass', '3,0,Default,,0,0,0,,{\\an8\\i1}Up{\\i0}\\Nthere'), 'Up\nthere')
    assert.equal(lineText('ass', '1,0,Sign,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}'), '')
    assert.equal(lineText('srt', '<font color="#ff0">Hi</font> <b>there</b>\r\n--> next'), 'Hi <b>there</b>\n-> next')
    assert.equal(lineText('picture', 'x'), '')
})
