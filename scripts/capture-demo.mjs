import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const server = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['exec','vite','--config','apps/web/vite.config.ts','--port','18174','--strictPort'], {stdio:'ignore',shell:process.platform === 'win32'});
let browser;
try {
  const deadline = Date.now()+30000;
  while(true) {try {if((await fetch('http://127.0.0.1:18174')).ok)break;}catch{/* Retry until Vite is ready. */} if(Date.now()>deadline)throw new Error('Demo server did not start');await new Promise(resolve=>setTimeout(resolve,250));}
  browser=await chromium.launch();
  const page=await browser.newPage({viewport:{width:420,height:760},deviceScaleFactor:2});
  await page.clock.install({time:new Date('2026-10-12T12:00:00Z')});
  await page.goto('http://127.0.0.1:18174');
  await page.waitForTimeout(500); // Let the initial IndexedDB transaction finish before entering the demo.
  await page.getByRole('main',{name:'Clawdle word game'}).focus();
  await page.keyboard.type('APPLE');await page.keyboard.press('Enter');
  await page.getByRole('group',{name:'Guess 1',exact:true}).locator('.tile.absent').first().waitFor();
  await expect(page.getByRole('button',{name:'Delete letter'})).toBeEnabled();
  await mkdir('docs/images',{recursive:true});
  await page.screenshot({path:'docs/images/clawdle.png',fullPage:true});
  console.log('Saved docs/images/clawdle.png');
} finally {await browser?.close();if(process.platform==='win32'){spawn('taskkill',['/PID',String(server.pid),'/T','/F'],{stdio:'ignore'});}else server.kill();}
