const fs = require('fs');
const path = require('path');
const axios = require('axios');
const child_process = require('child_process');
const puppeteer = require('puppeteer');
const dayjs = require('dayjs');

const ANIMESATURN_DOMAIN = 'animesaturn.it';
const ANIMESATURN_URL = `https://${ANIMESATURN_DOMAIN}`;
const OUTPUT_DIR = path.join(__dirname, '..', 'filters');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'animesaturn.txt');
const DELAY_MS = 10 * 60 * 1000;
const FILTER_OPTIONS = '$subdocument,third-party';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function staticDomainScan(domainBase) {
  const domainLower = domainBase.toLowerCase();
  const domainsSet = new Set();
  let html;
  try {
    const resp = await axios.get(ANIMESATURN_URL, { timeout: 15000 });
    html = resp.data;
  } catch {
    return domainsSet;
  }
  const urlRegex = /(?:(?:https?:)?\/\/[^\s"'<>]+)/gi;
  let match;
  while ((match = urlRegex.exec(html)) !== null) {
    let candidate = match[0];
    if (candidate.startsWith('//')) {
      candidate = 'https:' + candidate;
    } else if (!/^https?:\/\//.test(candidate)) {
      candidate = 'https://' + candidate;
    }
    try {
      const urlObj = new URL(candidate);
      const host = urlObj.hostname.toLowerCase();
      if (!host.endsWith(domainLower)) {
        domainsSet.add(host);
      }
    } catch {}
  }
  return domainsSet;
}

async function dynamicDomainScan(domainBase) {
  const domainLower = domainBase.toLowerCase();
  const detected = new Set();
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 800 }
  });
  try {
    const page = await browser.newPage();
    page.on('request', request => {
      const reqUrl = request.url();
      let host;
      try {
        host = new URL(reqUrl).hostname.toLowerCase();
      } catch {
        return;
      }
      if (!host.endsWith(domainLower)) {
        if (/ads?/.test(host) || /redirect/.test(reqUrl) || /click/.test(reqUrl)) {
          detected.add(host);
        }
        if (reqUrl.includes('/redirect.php?url=')) {
          try {
            const u = new URL(reqUrl);
            const destEnc = u.searchParams.get('url');
            if (destEnc) {
              const realDest = decodeURIComponent(destEnc);
              const realHost = new URL(realDest).hostname.toLowerCase();
              if (!realHost.endsWith(domainLower)) {
                detected.add(realHost);
              }
            }
          } catch {}
          detected.add(host);
        } else if (reqUrl.includes('/adserve?dest=')) {
          try {
            const u = new URL(reqUrl);
            const destEnc = u.searchParams.get('dest');
            if (destEnc) {
              const realDest = decodeURIComponent(destEnc);
              const realHost = new URL(realDest).hostname.toLowerCase();
              if (!realHost.endsWith(domainLower)) {
                detected.add(realHost);
              }
            }
          } catch {}
          detected.add(host);
        }
      }
    });
    page.on('popup', async newPage => {
      const popupUrl = newPage.url();
      try {
        const host = new URL(popupUrl).hostname.toLowerCase();
        if (!host.endsWith(domainLower)) {
          detected.add(host);
        }
      } catch {}
      try { await newPage.close(); } catch {}
    });
    const targetURL = `https://${domainBase}`;
    try {
      await page.goto(targetURL, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch {}
    try {
      await page.click('body', { delay: 100 });
    } catch {}
    const viewport = page.viewport();
    for (let i = 0; i < 5; i++) {
      const x = Math.floor(Math.random() * viewport.width);
      const y = Math.floor(Math.random() * viewport.height);
      await page.mouse.click(x, y, { delay: 100 });
      await page.waitForTimeout(500 + Math.random() * 500);
    }
    const playBtn = await page.$('.btn-play, .play-button, #play-button');
    if (playBtn) {
      try {
        await playBtn.click({ delay: 100 });
        await page.waitForTimeout(2000);
      } catch {}
    }
    await page.waitForTimeout(5000);
  } catch {
  } finally {
    await browser.close();
  }
  return detected;
}

function mergeAndWriteFilters(staticSet, dynamicSet, domainBase) {
  const merged = new Set();
  for (const d of staticSet) merged.add(d);
  for (const d of dynamicSet) merged.add(d);
  const WHITELIST_HOSTS = [
    'cdnjs.cloudflare.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'maxcdn.bootstrapcdn.com'
  ];
  for (const w of WHITELIST_HOSTS) {
    if (merged.has(w)) {
      merged.delete(w);
    }
  }
  const domainsArray = Array.from(merged).sort((a, b) => a.localeCompare(b));
  const ts = dayjs().format('YYYY-MM-DD HH:mm:ss');
  const headerLines = [
    `! ============================================`,
    `! Lista dinamica filtri Animesaturn`,
    `! Dominio base: ${domainBase}`,
    `! Generata: ${ts} (UTC+02:00)`,
    `! ============================================`,
    ``
  ];
  const extraLines = [
    `||${domainBase}/redirect.php?url=^$third-party`,
    `||${domainBase}/adserve?dest=^$third-party`
  ];
  const ruleLines = domainsArray.map(d => `||${d}^${FILTER_OPTIONS}`);
  const allLines = [
    ...headerLines,
    ...extraLines,
    ``,
    ...ruleLines,
    ``
  ];
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  const content = allLines.join('\n');
  fs.writeFileSync(OUTPUT_FILE, content, 'utf-8');
}

function gitCommitAndPush() {
  return new Promise((resolve, reject) => {
    const commitMsg = `Auto-aggiorno filtri Animesaturn [${ dayjs().format('YYYY-MM-DD HH:mm') }]`;
    const cmd = [
      'git add ' + OUTPUT_FILE,
      'git commit -m "' + commitMsg + '"',
      'git push origin main'
    ].join(' && ');
    child_process.exec(cmd, { cwd: path.join(__dirname, '..') }, (err, stdout, stderr) => {
      if (err) {
        if (/nothing to commit/.test(stderr)) {
          return resolve();
        }
        return reject(err);
      }
      resolve();
    });
  });
}

async function mainLoop() {
  while (true) {
    try {
      const staticSet = await staticDomainScan(ANIMESATURN_DOMAIN);
      const dynamicSet = await dynamicDomainScan(ANIMESATURN_DOMAIN);
      mergeAndWriteFilters(staticSet, dynamicSet, ANIMESATURN_DOMAIN);
      await gitCommitAndPush();
    } catch {}
    await sleep(DELAY_MS);
  }
}

mainLoop().catch(() => process.exit(1));