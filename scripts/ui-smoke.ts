/**
 * UI smoke test (Playwright + Chromium) against a running studio
 * (API serving the built web app + a worker). Drives the real UI end-to-end,
 * reloads the browser mid-job to prove state survives, and saves screenshots.
 *
 *   BASE_URL=http://127.0.0.1:8787 npx tsx scripts/ui-smoke.ts
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const OUT = path.resolve(process.env.SCREENSHOT_DIR ?? 'screenshots');
const executablePath = process.env.CHROMIUM_PATH ?? (await fs.access('/opt/pw-browsers/chromium').then(() => '/opt/pw-browsers/chromium').catch(() => undefined));

const log = (m: string) => console.log(`[ui-smoke] ${m}`);
let shot = 0;
async function snap(page: Page, name: string) {
  shot++;
  await page.screenshot({ path: path.join(OUT, `${String(shot).padStart(2, '0')}-${name}.png`), fullPage: false });
}

async function api<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(`${BASE}/api${url}`);
  if (!res.ok()) throw new Error(`GET ${url} → ${res.status()}`);
  return res.json() as Promise<T>;
}

async function waitStatus(page: Page, id: string, statuses: string[], timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await api<{ project: { status: string; lastError: string | null; busy: boolean } }>(page, `/projects/${id}`);
    if (statuses.includes(s.project.status)) return s;
    if (s.project.lastError && !s.project.busy && s.project.status !== 'producing') throw new Error(`Project error: ${s.project.lastError}`);
    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for ${statuses.join('|')}`);
}

async function clickNext(page: Page, label: RegExp) {
  const btn = page.locator('header').getByRole('button', { name: label });
  await btn.waitFor({ state: 'visible', timeout: 30_000 });
  await btn.click();
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const consoleErrors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  log('dashboard');
  await page.goto(BASE);
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await snap(page, 'dashboard');

  log('create project');
  await page.getByRole('link', { name: 'Create', exact: true }).click();
  await page.getByPlaceholder('e.g. The Lost Library of Alexandria').fill('Deep Sea Vents (UI smoke)');
  await page.getByPlaceholder('What is the video about?').fill('hydrothermal vents in the deep ocean');
  await page.getByRole('button', { name: /Faceless Shorts/ }).click();
  await snap(page, 'create');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]+\/script/);
  const id = page.url().split('/projects/')[1].split('/')[0];
  log(`project ${id}`);
  await waitStatus(page, id, ['scripted']);
  await page.getByText('Save edits').waitFor();
  await snap(page, 'script');

  log('narration (with browser reload mid-job)');
  await clickNext(page, /Generate narration/);
  await page.waitForTimeout(300);
  await page.reload();
  await page.getByRole('link', { name: 'Storyboard' }).waitFor();
  const afterReload = await api<{ project: { status: string }; jobs: { type: string }[] }>(page, `/projects/${id}`);
  if (!['narrating', 'narrated'].includes(afterReload.project.status)) throw new Error(`State lost after reload: ${afterReload.project.status}`);
  await waitStatus(page, id, ['narrated']);
  await page.goto(`${BASE}/projects/${id}/audio`);
  await page.getByText(/Measured/).waitFor();
  await snap(page, 'audio-narration');

  log('segment + plan');
  await clickNext(page, /Split into scenes/);
  await waitStatus(page, id, ['segmented']);
  await clickNext(page, /Plan visuals/);
  await waitStatus(page, id, ['planned']);

  log('generate visuals (reload during generation)');
  await clickNext(page, /Generate all visuals/);
  await page.waitForURL(/storyboard/);
  await page.getByText(/Generating|Queued/).first().waitFor({ timeout: 20_000 });
  await snap(page, 'storyboard-generating');
  await page.reload();
  await page.getByText(/Scene 01/).waitFor();
  await waitStatus(page, id, ['assets_ready'], 180_000);
  await page.waitForTimeout(1200);
  await snap(page, 'storyboard-ready');

  log('regenerate scene 2 via UI');
  const card = page.locator('article#scene-2');
  await card.getByRole('button', { name: 'Regenerate' }).click();
  await card.getByText(/Generating|Queued/).first().waitFor({ timeout: 10_000 });
  await waitStatus(page, id, ['assets_ready'], 60_000);

  log('scene preview');
  await page.locator('article#scene-1').getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Play scene/ }).click();
  await page.waitForTimeout(1200);
  await snap(page, 'scene-preview');
  await page.keyboard.press('Escape');

  log('captions + music');
  await page.goto(`${BASE}/projects/${id}/audio`);
  await page.getByRole('button', { name: 'Generate captions' }).click();
  await page.getByRole('button', { name: 'Generate mock music' }).click();
  const start = Date.now();
  for (;;) {
    const s = await api<{ project: { musicAssetId: string | null; captions: { cues: unknown[] } } }>(page, `/projects/${id}`);
    if (s.project.musicAssetId && s.project.captions.cues.length) break;
    if (Date.now() - start > 60_000) throw new Error('captions/music did not complete');
    await page.waitForTimeout(500);
  }
  await page.reload();
  await page.getByText('Rebuild captions').waitFor();
  await snap(page, 'audio-complete');

  log('assemble timeline');
  await clickNext(page, /Assemble timeline/);
  await waitStatus(page, id, ['assembled']);
  await page.goto(`${BASE}/projects/${id}/timeline`);
  await page.getByText('Assembled · up to date').waitFor();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForTimeout(1500);
  await snap(page, 'timeline');

  log('QA');
  await clickNext(page, /Run QA/);
  await waitStatus(page, id, ['qa_passed', 'qa_failed']);
  await page.goto(`${BASE}/projects/${id}/qa`);
  await page.getByText(/pass ·/).waitFor();
  await snap(page, 'qa');

  log('render');
  await clickNext(page, /Render video/);
  await page.waitForURL(/publish/);
  await page.getByText(/Rendering/).first().waitFor({ timeout: 20_000 });
  await snap(page, 'publish-rendering');
  await waitStatus(page, id, ['rendered'], 300_000);
  await page.reload();
  await page.getByRole('button', { name: 'Build package' }).click();
  await page.getByRole('button', { name: /Download \(/ }).waitFor({ timeout: 60_000 });
  await snap(page, 'publish-done');

  log('global pages');
  for (const [route, name] of [['/projects', 'projects'], ['/templates', 'templates'], ['/assets', 'assets'], ['/voices', 'voices'], ['/providers', 'providers'], ['/jobs', 'jobs'], ['/costs', 'costs'], ['/settings', 'settings'], ['/', 'dashboard-after']] as const) {
    await page.goto(`${BASE}${route}`);
    await page.waitForLoadState('networkidle');
    await snap(page, name);
  }

  log('reopen project from projects list');
  await page.goto(`${BASE}/projects`);
  await page.getByText('Deep Sea Vents (UI smoke)').first().click();
  await page.getByText(/Rendered/).first().waitFor();

  await browser.close();
  const relevant = consoleErrors.filter((e) => !/favicon|net::ERR_ABORTED|Range Not Satisfiable|play\(\) request was interrupted/i.test(e));
  if (relevant.length) {
    console.error('[ui-smoke] console errors:\n' + relevant.join('\n'));
    process.exit(1);
  }
  log(`OK — screenshots in ${OUT}`);
}

main().catch((e) => { console.error('[ui-smoke] FAILED', e); process.exit(1); });
