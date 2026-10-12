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
