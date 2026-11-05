// Drives the real interface through first-run setup, scan and apply, saving frames
// for render_gif.py plus stills. This also proves the whole flow works in a browser.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const out = process.argv[2];
mkdirSync(out, { recursive: true });
const projects = path.join(process.env.HOME, 'projects');

const server = spawn('node', ['/app/bin/nm-manager.js', 'ui', '--no-open'], { env: { ...process.env, NO_COLOR: '1' } });
const url = await new Promise((resolve, reject) => {
  server.stdout.on('data', (data) => {
    const match = /http:\S+/.exec(String(data));
    if (match) resolve(match[0]);
  });
  server.on('exit', () => reject(new Error('server exited')));
});

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--no-sandbox', '--lang=en-US'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1040, height: 700 });
const problems = [];
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('console', (message) => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });

const frames = [];
async function frame(hold) {
  const file = `frame-${String(frames.length).padStart(3, '0')}.png`;
  await page.screenshot({ path: path.join(out, file) });
  frames.push({ file, hold });
}
const idle = () => page.waitForFunction(() => document.getElementById('progress').hidden);

async function waitFilming(hold = 350) {
  await page.waitForFunction(() => !document.getElementById('progress').hidden, { timeout: 5000 }).catch(() => {});
  for (;;) {
    await frame(hold);
    if (await page.evaluate(() => document.getElementById('progress').hidden)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

await page.goto(url);
await page.waitForSelector('.store-pick');
await frame(1800);
await page.screenshot({ path: path.join(out, 'still-setup.png') });
await page.click('#setup-save');
await page.waitForSelector('#target:not([hidden])');

await page.type('#dir', projects, { delay: 25 });
await frame(900);
await page.click('#scan');
await waitFilming();
await idle();
await page.waitForFunction(() => /\d/.test(document.getElementById('selection').textContent));
await frame(2800);
await page.screenshot({ path: path.join(out, 'still-results.png') });

const beforeRows = await page.$$eval('#rows tr', (rows) => rows.length);
await page.click('#apply');
await page.waitForSelector('dialog[open]');
await frame(2200);
await page.click('#confirm-yes');
await waitFilming();
await page.waitForFunction(() => !document.getElementById('notice').hidden, { timeout: 120000 });
await page.waitForFunction(() => /\d/.test(document.getElementById('selection').textContent));
await frame(4500);
await page.screenshot({ path: path.join(out, 'still-done.png') });
const notice = await page.$eval('#notice', (box) => box.textContent);

// Stills that check other layouts; they are not part of the animation.
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await page.screenshot({ path: path.join(out, 'still-dark.png') });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await page.setViewport({ width: 375, height: 800 });
await page.screenshot({ path: path.join(out, 'still-mobile.png') });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

const turkish = await browser.newPage();
await turkish.setViewport({ width: 1040, height: 500 });
await turkish.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'language', { get: () => 'tr-TR' }));
await turkish.goto(url);
await turkish.waitForSelector('#target:not([hidden])');
await turkish.screenshot({ path: path.join(out, 'still-tr.png') });

writeFileSync(path.join(out, 'frames.json'), JSON.stringify({ frames, beforeRows, notice, overflow, problems }, null, 2));
console.log({ frames: frames.length, beforeRows, notice, overflow, problems });
await browser.close();
server.kill();
