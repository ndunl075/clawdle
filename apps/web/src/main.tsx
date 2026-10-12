import { createController } from '@clawdle/app-core';
import { createWebPlatform } from '@clawdle/platform-web';
import { mountClawdle } from '@clawdle/ui';
void mountClawdle(async()=>{
  if(import.meta.env.DEV&&new URLSearchParams(location.search).get('fixture')==='race') {
    const {createRaceFixture}=await import('./race-fixture');
    return createRaceFixture();
  }
  return createController(await createWebPlatform());
});
