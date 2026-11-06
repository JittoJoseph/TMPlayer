// A file's own tracks (e2e/media/tracks.mkv): its two subtitle tracks (English SubRip, Spanish ASS)
// in the Subtitles menu with their lines read from the file, and its two sound tracks by language.
import { expect, test, type Page } from '@playwright/test'
import { choice, noSizeFloor, openCard, openClips, playsPast } from './helpers'

test.beforeEach(async ({ page }) => {
    await noSizeFloor(page)
    await openClips(page)
    await openCard(page, 'Tracks Clip')
    await playsPast(page, 0.2)
})

/** The video's text tracks as the page has them: label, language, mode and how many cues are in. */
const tracks = (page: Page) =>
    page.locator('video').first().evaluate((v: HTMLVideoElement) =>
        Array.from(v.textTracks).map((tt) => ({ label: tt.label, language: tt.language, mode: tt.mode, cues: tt.cues?.length ?? 0, texts: Array.from(tt.cues ?? []).map((c) => (c as VTTCue).text) })),
    )

async function openSubtitles(page: Page) {
    await page.mouse.move(400, 300)
    await page.locator('[data-shot=subtitles]').first().click()
}

async function openAudio(page: Page) {
    await page.mouse.move(400, 300)
    await page.locator('[data-shot=more]').first().click()
    await page.getByRole('menuitem', { name: /^Audio/ }).click()
}

test('the file\'s subtitle tracks are listed and their lines show', async ({ page }) => {
    await expect.poll(async () => (await tracks(page)).map((t) => t.label)).toEqual(['English', 'Spanish'])
    await openSubtitles(page)
    await choice(page, 'English').click()
    await expect.poll(async () => (await tracks(page))[0]).toMatchObject({ mode: 'showing' })
    await expect.poll(async () => (await tracks(page))[0].texts).toEqual(['First test line', 'Second <i>test</i> line', 'Third test line'])
    // Spanish, from ASS: the override tags dropped and \N a new line.
    await openSubtitles(page)
    await choice(page, 'Spanish').click()
    await expect.poll(async () => (await tracks(page))[1]).toMatchObject({ mode: 'showing', texts: ['Primera linea\nde prueba', 'Segunda linea'] })
})

test('the language picked is picked again for the next video', async ({ page }) => {
    await expect.poll(async () => (await tracks(page)).length).toBe(2)
    await openSubtitles(page)
    await choice(page, 'Spanish').click()
    await page.reload()
    await playsPast(page, 0.2)
    await expect.poll(async () => (await tracks(page)).find((t) => t.label === 'Spanish')?.mode).toBe('showing')
})

test('the sound tracks are named by their language', async ({ page }) => {
    await openAudio(page)
    await expect(page.getByRole('menuitemradio', { name: /^Hindi, AAC/ })).toBeVisible()
    await expect(page.getByRole('menuitemradio', { name: /^Tamil, AAC/ })).toBeEnabled()
})
