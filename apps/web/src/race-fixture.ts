// Development-only synthetic platform. Vite removes this import from release builds.
import { createController, emptyState, type Platform, type JournalEntry, type Checkpoint, type AppController } from '@clawdle/app-core';
import { wordFromId } from '@clawdle/game';
declare global {interface Window {clawdleFixture:{answer:()=>string;stop:(scope?:'root'|'child')=>Promise<void>;outcome:()=>string|null;results:()=>number}}}
export async function createRaceFixture():Promise<AppController> {
  const runtimeEpoch=crypto.randomUUID();
  const state=emptyState();state.settings.autoRace=true;
  let checkpoint:Checkpoint={stateVersion:0,processedSeq:0,state};
  const journal:JournalEntry[]=[];
  const listeners=new Set<()=>void>();
  const append=(kind:JournalEntry['kind'],eventId:string,payload:unknown)=>{
    const old=journal.find(entry=>entry.eventId===eventId);if(old)return old;
    const entry={seq:journal.length+1,eventId,runtimeEpoch,receivedAtUtc:new Date().toISOString(),receivedMonoMs:performance.now(),kind,payload};journal.push(entry);return entry;
  };
  const platform:Platform={
    snapshot:async()=>({runtimeEpoch,receivedMonoMs:performance.now(),receivedAtUtc:new Date().toISOString(),latestSeq:journal.length,checkpoint:structuredClone(checkpoint)}),
    append:async(id,command)=>append('command',id,command),read:async after=>journal.filter(entry=>entry.seq>after),
    commit:async(expected,next)=>{if(expected!==checkpoint.stateVersion)throw new Error('Checkpoint conflict');checkpoint={stateVersion:expected+1,processedSeq:next.processedSeq,state:structuredClone(next)};return structuredClone(checkpoint);},
    subscribe:async listener=>{listeners.add(listener);return()=>listeners.delete(listener);},id:()=>crypto.randomUUID(),randomUnit:()=>0.25
  };
  append('agent',crypto.randomUUID(),{provider:'claude',sessionId:'synthetic-session',turnId:'synthetic-turn',scope:'root',type:'agent.started'});
  const controller=await createController(platform);
  window.clawdleFixture={
    answer:()=>wordFromId(controller.state.games[controller.state.activeGameId!]!.wordId),
    stop:async(scope='root')=>{append('agent',crypto.randomUUID(),{provider:'claude',sessionId:'synthetic-session',turnId:'synthetic-turn',scope,type:'agent.turn_completed'});for(const listener of listeners)listener();await controller.refresh();},
    outcome:()=>controller.state.races[controller.state.activeRaceId!]?.outcome??null,
    results:()=>controller.state.results.length
  };
  return controller;
}
