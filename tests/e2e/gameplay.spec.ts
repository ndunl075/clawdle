import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { selectDailyWord, wordFromId } from '../../packages/game/src/index';

async function typeWord(page:Page,word:string) {
  const game=page.getByRole('main',{name:'Clawdle word game'});
  await game.focus();await page.keyboard.type(word);await page.keyboard.press('Enter');
}
test('daily solves, shares without answer, survives reload, and cannot restart',async({page})=>{
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'One word. A new day.'})).toBeVisible();
  const answer=wordFromId(selectDailyWord(Date.now()));
  await typeWord(page,answer);
  await expect(page.getByText('Solved in 1 guess.')).toBeVisible();
  await page.getByRole('button',{name:'Share result'}).click();
  const share=page.getByRole('textbox',{name:'Share result'});
  await expect(share).toHaveValue(/🟩🟩🟩🟩🟩/);
  expect(await share.inputValue()).not.toContain(answer);
  await page.getByRole('button',{name:'Close dialog'}).click();
  await page.reload();await expect(page.getByText('Solved in 1 guess.')).toBeVisible();
  await page.getByRole('button',{name:'Daily',exact:true}).click();
  await expect(page.getByText('Solved in 1 guess.')).toBeVisible();
});
test('invalid guesses consume no row; accepted guesses persist; mouse input works',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'Endless',exact:true}).click();
  await typeWord(page,'ZZZZZ');
  await expect(page.getByRole('status')).not.toBeEmpty();
  await page.getByRole('main',{name:'Clawdle word game'}).focus();
  for(let i=0;i<5;i++)await page.keyboard.press('Backspace');
  for(const letter of 'APPLE')await page.getByRole('button',{name:letter,exact:true}).click();
  await page.getByRole('button',{name:'Submit guess'}).click();
  const first=page.getByRole('group',{name:'Guess 1',exact:true});
  await expect(first.locator('.tile > span:first-child')).toHaveText([... 'APPLE']);
  await page.reload();await expect(page.getByRole('group',{name:'Guess 1',exact:true}).locator('.tile > span:first-child')).toHaveText([... 'APPLE']);
});
test('help traps focus, settings persist and narrow game remains usable',async({page})=>{
  await page.setViewportSize({width:340,height:700});await page.goto('/');
  await page.getByRole('button',{name:'How to play'}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('checkbox',{name:/High contrast/}).check();
  await page.getByRole('checkbox',{name:/Show Speedrun/}).check();
  await page.getByRole('button',{name:'Close dialog'}).click();
  await expect(page.getByRole('button',{name:'Speedrun',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.reload();await page.getByRole('button',{name:'Settings',exact:true}).click();
  await expect(page.getByRole('checkbox',{name:/High contrast/})).toBeChecked();
});
test('standalone does not probe agent endpoints',async({page})=>{
  const external:string[]=[];page.on('request',request=>{const url=new URL(request.url());if(url.hostname!=='127.0.0.1'||url.port!=='18173')external.push(request.url());});
  await page.goto('/');await page.getByRole('button',{name:'Beat Claude',exact:true}).click();
  await page.getByRole('button',{name:'Connect Claude',exact:true}).click();
  await expect(page.getByText('Agent races are available in the Windows desktop app.')).toBeVisible();
  expect(external).toEqual([]);
});
test('player-first race stays won after a later Stop',async({page})=>{
  await page.goto('/?fixture=race');
  await expect(page.getByRole('heading',{name:'Can you beat Claude?'})).toBeVisible();
  const answer=await page.evaluate(()=>window.clawdleFixture.answer());
  await typeWord(page,answer);await expect(page.getByRole('status')).toHaveText('You beat Claude.');
  await page.evaluate(()=>window.clawdleFixture.stop());
  expect(await page.evaluate(()=>window.clawdleFixture.outcome())).toBe('player_win');
  expect(await page.evaluate(()=>window.clawdleFixture.results())).toBe(1);
});
test('agent-first race keeps remaining guesses and never reverses its outcome',async({page})=>{
  await page.goto('/?fixture=race');await expect(page.getByRole('heading',{name:'Can you beat Claude?'})).toBeVisible();
  await page.evaluate(()=>window.clawdleFixture.stop('child'));
  expect(await page.evaluate(()=>window.clawdleFixture.outcome())).toBeNull();
  await page.evaluate(()=>window.clawdleFixture.stop());
  await expect(page.getByRole('status')).toHaveText('Claude finished first.');
  const answer=await page.evaluate(()=>window.clawdleFixture.answer());await typeWord(page,answer);
  await expect(page.getByText('Solved in 1 guess.')).toBeVisible();
  expect(await page.evaluate(()=>window.clawdleFixture.outcome())).toBe('agent_first');
  expect(await page.evaluate(()=>window.clawdleFixture.results())).toBe(1);
});

test('a turn that ends before presentation is explained as too short to race',async({page})=>{
  await page.goto('/?fixture=race&short=1');
  await expect(page.getByRole('status')).toHaveText('That turn was too short to race.');
  expect(await page.evaluate(()=>window.clawdleFixture.outcome())).toBe('agent_first');
});
test('Enter activates focused buttons and focus returns to the opener after a dialog closes',async({page})=>{
  await page.goto('/');
  const settings=page.getByRole('button',{name:'Settings',exact:true});
  await settings.focus();await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('A');await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(settings).toBeFocused();
  await expect(page.locator('.grid .tile').first()).toHaveText('');
});
test('UTC rollover offers a new daily without replacing the unfinished board',async({page})=>{
  await page.clock.install({time:new Date('2026-10-12T23:59:55Z')});
  await page.goto('/');await typeWord(page,'APPLE');
  await page.clock.fastForward(6000);
  await expect(page.getByText(/NO. 1 · Oct 12 UTC/)).toBeVisible();
  await page.getByRole('button',{name:/Today.s puzzle is ready/}).click();
  await expect(page.getByText(/NO. 2 · Oct 13 UTC/)).toBeVisible();
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:/Resume a saved puzzle/}).click();
  await expect(page.getByRole('button',{name:/Daily · 2026-10-12 · 1\/6 guesses/})).toBeVisible();
});
test('compact desktop viewport keeps the complete keyboard visible',async({page})=>{
  await page.setViewportSize({width:420,height:619});await page.goto('/');
  const lastKey=page.getByRole('button',{name:'Delete letter'});
  await expect(lastKey).toBeVisible();
  const bounds=await lastKey.boundingBox();expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(619);
});

test('unsupported saved profile is preserved and offers explicit private recovery export',async({page})=>{
  await page.goto('/');await typeWord(page,'APPLE');
  await expect(page.getByRole('group',{name:'Guess 1',exact:true}).locator('.tile > span:first-child')).toHaveText([...'APPLE']);
  await expect(page.getByRole('button',{name:'Delete letter'})).toBeEnabled();
  await page.evaluate(()=>new Promise<void>((resolve,reject)=>{
    const open=indexedDB.open('clawdle-v1');open.onerror=()=>reject(open.error);
    open.onsuccess=()=>{const db=open.result;const tx=db.transaction('meta','readwrite');const store=tx.objectStore('meta');const get=store.get('checkpoint');get.onsuccess=()=>{const checkpoint=get.result;checkpoint.state.schemaVersion=99;store.put(checkpoint,'checkpoint');};tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};
  }));
  await page.reload();await expect(page.getByRole('heading',{name:/couldn.t open your save/})).toBeVisible();
  page.once('dialog',dialog=>dialog.accept());
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('button',{name:'Export private recovery copy'}).click();
  const download=await downloadPromise;const file=await download.path();
  const copy=JSON.parse(await readFile(file!,'utf8'));
  expect(copy.format).toBe('clawdle-recovery');expect(copy.snapshot.checkpoint.state.schemaVersion).toBe(99);
  expect(Object.values(copy.snapshot.checkpoint.state.games)).toHaveLength(1);
});
