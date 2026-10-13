import { createController } from '@clawdle/app-core';
import { createWebPlatform } from '@clawdle/platform-web';
import { mountClawdle } from '@clawdle/ui';
let recoveryPlatform:Awaited<ReturnType<typeof createWebPlatform>>|undefined;
void mountClawdle(async()=>{
  if(import.meta.env.DEV&&new URLSearchParams(location.search).get('fixture')==='race') {
    const {createRaceFixture}=await import('./race-fixture');
    return createRaceFixture({short:new URLSearchParams(location.search).get('short')==='1'});
  }
  recoveryPlatform=await createWebPlatform();
  return createController(recoveryPlatform);
},undefined,async()=>{if(!recoveryPlatform)throw new Error('Browser storage is unavailable.');return recoveryPlatform.snapshot();});
