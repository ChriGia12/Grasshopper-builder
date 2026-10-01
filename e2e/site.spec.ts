// UI tests: the site as a user drives it, in a real browser (headless Chromium).
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/** ASCII STL of a box sx × sy × sz (mm). */
function boxStl(sx: number, sy: number, sz: number): Buffer {
  const v = (i: number) => [i & 1 ? sx : 0, i & 2 ? sy : 0, i & 4 ? sz : 0];
  const faces = [[0, 2, 3], [0, 3, 1], [4, 5, 7], [4, 7, 6], [0, 1, 5], [0, 5, 4], [2, 6, 7], [2, 7, 3], [0, 4, 6], [0, 6, 2], [1, 3, 7], [1, 7, 5]];
  let s = 'solid b\n';
  for (const f of faces) s += 'facet normal 0 0 0\nouter loop\n' + f.map((i) => `vertex ${v(i).join(' ')}`).join('\n') + '\nendloop\nendfacet\n';
  return Buffer.from(s + 'endsolid b\n');
}

const addPart = (page: Page, name: string, sx = 80, sy = 60, sz = 20) =>
  page.setInputFiles('#file', { name, mimeType: 'model/stl', buffer: boxStl(sx, sy, sz) });

/** A robot-settings or print-settings field by the start of its label. */
const field = (page: Page, label: string) => page.locator('#robotFields label, #printFields label').filter({ hasText: label }).first().locator('input, select');

const stat = (page: Page, label: string) => page.locator('.stat').filter({ hasText: label }).locator('.v');

async function setField(page: Page, label: string, value: string) {
  // Like a user: type, then leave the field (the browser fires "change" once).
  const f = field(page, label);
  await f.fill(value);
  await f.blur();
}

const download = (page: Page) => page.locator('#download');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
});

test('a part becomes a .src the robot can run', async ({ page }) => {
  await addPart(page, 'blocco.stl');
  await expect(download(page)).toBeEnabled();
  await expect(page.locator('#partList li')).toHaveCount(1);
  await expect(page.locator('#warnings li.blocked')).toHaveCount(0);
  const [dl] = await Promise.all([page.waitForEvent('download'), download(page).click()]);
  expect(dl.suggestedFilename()).toBe('blocco.src');
  const src = readFileSync((await dl.path())!, 'utf8');
  expect(src).toContain('$TOOL=TOOL_DATA[11]');
  expect(src).toContain('$BASE=BASE_DATA[1]');
  expect(src.match(/^LIN \{/gm)?.length).toBeGreaterThan(10);
  expect(src.trimEnd().endsWith('END')).toBe(true);
});

test('an empty number field blocks the download until it is fixed', async ({ page }) => {
  await addPart(page, 'blocco.stl');
  await expect(download(page)).toBeEnabled();
  await setField(page, 'Altezza strato', '');
  await expect(download(page)).toBeDisabled();
  await expect(page.locator('#exportState')).toContainText('inserisci un numero valido');
  await setField(page, 'Altezza strato', '2');
  await expect(download(page)).toBeEnabled();
});

test('a part off the table needs a confirmation, reset by any change', async ({ page }) => {
  await addPart(page, 'blocco.stl');
  await expect(download(page)).toBeEnabled();
  await page.locator('#step-robot summary').click();
  await setField(page, 'Centro X', '330');
  await expect(page.locator('#offBedRow')).toBeVisible();
  await expect(download(page)).toBeDisabled();
  await page.locator('#offBedOk').check();
  await expect(download(page)).toBeEnabled();
  await setField(page, 'Centro X', '331');
  await expect(page.locator('#offBedOk')).not.toBeChecked();
  await expect(download(page)).toBeDisabled();
});

test('the mandrino laid down near the plate is a collision that blocks the export', async ({ page }) => {
  await addPart(page, 'blocco.stl');
  await expect(download(page)).toBeEnabled();
  await page.locator('#step-robot summary').click();
  await setField(page, 'C (°)', '100');
  await expect(page.locator('#warnings')).toContainText('Collisione');
  await expect(download(page)).toBeDisabled();
  await setField(page, 'C (°)', '180');
  await expect(download(page)).toBeEnabled();
});

test('several parts are printed together; a part can be removed', async ({ page }) => {
  await addPart(page, 'primo.stl');
  await expect(download(page)).toBeEnabled();
  const one = await stat(page, 'Punti LIN').innerText();
  await addPart(page, 'secondo.stl', 40, 40, 20);
  await expect(page.locator('#partList li')).toHaveCount(2);
  await expect(download(page)).toBeEnabled();
  await expect(stat(page, 'Punti LIN')).not.toHaveText(one);
  const two = Number((await stat(page, 'Punti LIN').innerText()).replace(/\D/g, ''));
  expect(two).toBeGreaterThan(Number(one.replace(/\D/g, '')));
  await page.locator('#partList li').nth(1).getByRole('button').click();
  await expect(page.locator('#partList li')).toHaveCount(1);
  await expect(download(page)).toBeEnabled();
  await expect(stat(page, 'Punti LIN')).toHaveText(one);
});

test('a saved project opens again exactly as it was', async ({ page }) => {
  await addPart(page, 'primo.stl');
  await expect(download(page)).toBeEnabled();
  await addPart(page, 'secondo.stl', 40, 40, 20);
  await expect(page.locator('#partList li')).toHaveCount(2);
  await expect(download(page)).toBeEnabled();
  const before = await stat(page, 'Punti LIN').innerText();
  const extent = await stat(page, 'Estensione').innerText();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#saveProject').click()]);
  expect(dl.suggestedFilename()).toMatch(/\.kinepath$/);
  const project = readFileSync((await dl.path())!);

  await page.reload();
  await expect(page.locator('#partList li')).toHaveCount(0);
  await page.setInputFiles('#projectFile', { name: 'prova.kinepath', mimeType: 'application/json', buffer: project });
  await expect(page.locator('#partList li')).toHaveCount(2);
  await expect(download(page)).toBeEnabled();
  await expect(stat(page, 'Punti LIN')).toHaveText(before);
  await expect(stat(page, 'Estensione')).toHaveText(extent);
});

test('the PDF sheet lists the checks of the result', async ({ page }) => {
  await addPart(page, 'blocco.stl');
  await expect(download(page)).toBeEnabled();
  await page.evaluate(() => {
    const open = window.open.bind(window);
    window.open = (...a: Parameters<typeof window.open>) => {
      const w = open(...a);
      if (w) w.print = () => {};
      return w;
    };
  });
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('#reportBtn').click()]);
  await expect(popup.locator('h1')).toHaveText('blocco.src');
  await expect(popup.locator('.checks li')).toHaveCount(8);
  await expect(popup.locator('.checks li.bad')).toHaveCount(0);
});

test('the site switches to English and back', async ({ page }) => {
  await page.locator('#langToggle').click();
  await expect(page.locator('[data-i18n="step.model"]')).toHaveText('Model');
  await page.locator('#langToggle').click();
  await expect(page.locator('[data-i18n="step.model"]')).toHaveText('Modello');
});

test('the browser warning stays hidden when everything works', async ({ page }) => {
  await expect.poll(() => page.evaluate(() => (window as unknown as { kinepathStarted?: boolean }).kinepathStarted)).toBe(true);
  await page.waitForTimeout(9000);
  await expect(page.locator('#browserWarn')).toBeHidden();
});
