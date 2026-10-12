import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createController } from '@clawdle/app-core';
import { createDesktopPlatform } from '@clawdle/platform-desktop';
import { mountClawdle } from '@clawdle/ui';
void listen('window-presented',()=>window.dispatchEvent(new Event('clawdle-window-presented')));
void mountClawdle(async()=>createController(createDesktopPlatform({invoke,listen})), {
  isVisible:()=>invoke<boolean>('native_is_visible'),
  doctor:()=>invoke('integration_doctor'),
  install:(scope,project)=>invoke('integration_install',{scope,project}),
  uninstall:()=>invoke('integration_uninstall')
});
