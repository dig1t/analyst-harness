import { expect, test, type Page } from '@playwright/test';
import { buildFixture } from './fixture';

let file: string;

test.beforeAll(async () => {
  file = await buildFixture();
});

async function open(page: Page, errors: string[]) {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`file://${file}`);
  await expect(page.locator('.hx-kpi-value').first()).toHaveText('180');
}

const kpis = (page: Page) => page.locator('.hx-kpi-value').allTextContents();

test('renders every component without console errors or horizontal scroll', async ({ page }) => {
  const errors: string[] = [];
  await open(page, errors);
  await expect(page.locator('h1')).toHaveText('E2E releases');
  expect(await kpis(page)).toEqual(['180', '3']);
  await expect(page.locator('svg.hx-svg')).toHaveCount(3);
  await expect(page.locator('.hx-legend-item')).toHaveText(['HTTP client', 'Parser']);
  await expect(page.locator('.hx-table tbody tr')).toHaveCount(25);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
  expect(errors).toEqual([]);
});

test('facets, bar clicks and search cross-filter the page and persist in the link', async ({ page }) => {
  const errors: string[] = [];
  await open(page, errors);
  await page.locator('.hx-facet', { hasText: 'Parser' }).first().click();
  await expect(page.locator('.hx-facet.on', { hasText: 'Parser' })).toHaveCount(1);
  expect(await kpis(page)).toEqual(['60', '1']);
  // The facet keeps the alternatives visible with their counts.
  await expect(page.locator('.hx-facet', { hasText: 'HTTP client' })).toContainText('120');
  await expect(page.locator('.hx-filter-btn', { hasText: 'Category' })).toContainText('Parser');
  // The link updates shortly after the last change.
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#f=/);

  await page.getByRole('button', { name: 'Clear all filters' }).click();
  expect(await kpis(page)).toEqual(['180', '3']);

  await page.locator('.hx-chart-bar .hx-hit').first().click();
  await expect(page.locator('.hx-chip')).toHaveCount(1);
  expect(await kpis(page)).toEqual(['60', '1']);
  await page.locator('.hx-chip-remove').click();
  expect(await kpis(page)).toEqual(['180', '3']);

  await page.keyboard.press('/');
  await page.keyboard.type('httpx');
  await expect.poll(() => kpis(page)).toEqual(['60', '1']);
  expect(errors).toEqual([]);
});

test('a reloaded link restores the filters', async ({ page }) => {
  const errors: string[] = [];
  await open(page, errors);
  await page.locator('.hx-facet', { hasText: 'lxml' }).first().click();
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#f=/);
  const hash = await page.evaluate(() => location.hash);
  await page.goto(`file://${file}${hash}`);
  await expect(page.locator('.hx-kpi-value').first()).toHaveText('60');
  expect(errors).toEqual([]);
});

test('tooltips, brushing, table sort, row details and the table view', async ({ page }) => {
  const errors: string[] = [];
  await open(page, errors);
  const overlay = page.locator('.hx-chart-line .hx-overlay');
  const box = (await overlay.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect(page.locator('.hx-tooltip')).toBeVisible();
  await expect(page.locator('.hx-tooltip')).toContainText('HTTP client');

  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.hx-filter-btn', { hasText: 'Released' })).not.toContainText('All time');
  const filtered = Number((await kpis(page))[0]);
  expect(filtered).toBeGreaterThan(0);
  expect(filtered).toBeLessThan(180);
  await page.getByRole('button', { name: 'Clear all filters' }).click();

  const sizeHeader = page.locator('.hx-table thead th', { hasText: 'Size' });
  await sizeHeader.locator('button').click();
  await expect(sizeHeader).toHaveAttribute('aria-sort', 'descending');
  await expect(page.locator('.hx-table tbody tr').first()).toContainText('lxml');
  await page.locator('.hx-table tbody tr').first().click();
  await expect(page.locator('.hx-drawer')).toContainText('Parser');
  await expect(page.locator('.hx-drawer a').first()).toHaveAttribute(
    'href',
    /^https:\/\/pypi\.org\/project\/lxml\//,
  );
  await page.keyboard.press('Escape');
  await expect(page.locator('.hx-drawer')).toHaveCount(0);

  const histogram = page.locator('.hx-chart-histogram');
  await histogram.getByRole('button', { name: 'Show as table' }).click();
  await expect(histogram.locator('.hx-card-table table')).toBeVisible();
  await histogram.getByRole('button', { name: 'Show as chart' }).click();
  await expect(histogram.locator('svg.hx-svg')).toBeVisible();
  expect(errors).toEqual([]);
});

test('dark mode, the theme switch and phone width', async ({ browser }) => {
  const dark = await browser.newPage({ colorScheme: 'dark', viewport: { width: 400, height: 860 } });
  const errors: string[] = [];
  await open(dark, errors);
  const bg = await dark.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(13, 13, 13)');
  const overflow = await dark.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
  await dark.getByRole('button', { name: 'Light theme' }).click();
  expect(await dark.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
  expect(await dark.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
    'rgb(249, 249, 247)',
  );
  expect(errors).toEqual([]);
  await dark.close();
});
