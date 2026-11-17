import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../src/model.js';
import {createAdapter} from '../src/adapter.js';
const task=s=>s.addTask({title:'验证任务',content:'输出通过或失败证据'});
function ready(demo=true){const s=createStore({demo,now:()=>20000});s.state.connected=true;s.syncAgents([{id:'s1',title:'A'},{id:'s2',title:'B'},{id:'s3',title:'C'}]);s.state.agents.forEach(a=>{a.status='idle';a.observedAt=19999;a.sequence=4;});return s;}
test('dependency completes only after human acceptance, not a turn receipt',()=>{
 const s=ready(),a=task(s),b=s.addTask({title:'后置',content:'依赖验收',dependencies:[a.id]});
 s.assign(a.id,'s1');assert.match(s.canAssign(b,s.state.agents[1]),/前置/);
 s.applyEvent('s1',{sequence:5,eventType:'turn.completed'});assert.equal(a.status,'review');assert.match(s.canAssign(b,s.state.agents[1]),/前置/);
 s.accept(a.id);assert.equal(s.canAssign(b,s.state.agents[1]),'');
});
test('concurrency, busy sessions, and repeated assignment are rejected',()=>{
 const s=ready(),a=task(s),b=task(s),c=task(s);s.assign(a.id,'s1');
 assert.throws(()=>s.assign(a.id,'s2'),/仅待派遣/);assert.throws(()=>s.assign(b.id,'s1'),/不可派遣/);
 s.assign(b.id,'s2');assert.throws(()=>s.assign(c.id,'s3'),/并发上限/);
});
test('historical and out-of-order events do not complete a new task',()=>{
 const s=ready(),a=task(s);s.assign(a.id,'s1');
 assert.equal(s.applyEvent('s1',{sequence:4,eventType:'turn.completed'}),false);
 assert.equal(a.status,'dispatching');s.applyEvent('s1',{sequence:6,eventType:'turn.started'});
 s.applyEvent('s1',{sequence:5,eventType:'turn.completed'});assert.equal(a.status,'running');
 s.applyEvent('s1',{sequence:7,eventType:'turn.failed',typedPayload:{message:'Tool crashed'}});assert.equal(a.status,'failed');assert.equal(a.error,'Tool crashed');
});
test('past completion without a tracked task leaves the session assignable',()=>{
 const s=ready();s.applyEvent('s1',{sequence:10,eventType:'turn.completed'},{historical:true});assert.equal(s.state.agents[0].status,'idle');
});
test('restore never replays submitted work or resumes autoplay',()=>{
 const s=ready(),a=task(s);s.assign(a.id,'s1');s.state.auto=true;
 const restored=createStore({saved:s.snapshot()});assert.equal(restored.state.auto,false);assert.equal(restored.state.tasks[0].status,'unknown');
});
test('event retention and task input bounds constrain private storage',()=>{
 const s=ready();for(let i=0;i<300;i++)s.log('x'.repeat(300));assert.equal(s.state.events.length,120);assert.equal(s.state.events[0].message.length,280);
 assert.throws(()=>s.addTask({title:' ',content:'x'}),/填写/);assert.throws(()=>s.addTask({title:'a',content:'b',dependencies:['missing']}),/不存在/);
});
test('missing bridge fails closed and stops automatic dispatch',async()=>{
 const s=ready(false);s.state.auto=true;const a=createAdapter(s,{getTool:()=>undefined});await a.poll();assert.equal(s.state.connected,false);assert.equal(s.state.auto,false);assert.ok(s.state.agents.every(a=>a.status==='unknown'));a.dispose();
});
test('successful send receipt is not completion and fresh event baseline is read',async()=>{
 const s=ready(false),t=task(s),calls=[];
 const a=createAdapter(s,{now:()=>20000,getTool:()=>({execute:async input=>{calls.push(input);return {ok:true,result:input.command==='session inspect'?{generating:false}:input.command==='session messages'?{events:[{sequence:12,eventType:'turn.completed'}]}:{operationId:'op',result:{sent:true}}};}})});
 await a.dispatch(t.id,'s1');assert.equal(t.status,'running');assert.equal(t.baselineSequence,12);assert.equal(calls.at(-1).args.sessionId,'s1');
 s.applyEvent('s1',{sequence:12,eventType:'turn.completed'});assert.equal(t.status,'running');
 s.applyEvent('s1',{sequence:13,eventType:'turn.completed'});assert.equal(t.status,'review');a.dispose();
});
test('send failures stop scheduling and expose the host error',async()=>{
 const s=ready(false),t=task(s);s.state.auto=true;
 const a=createAdapter(s,{now:()=>20000,getTool:()=>({execute:async input=>input.command==='session send'?{ok:false,error:{message:'Permission denied'}}:{ok:true,result:input.command==='session inspect'?{generating:false}:{events:[]}}})});
 await a.dispatch(t.id,'s1');assert.equal(t.status,'unknown');assert.equal(t.error,'Permission denied');assert.equal(s.state.auto,false);a.dispose();
});
test('stale observations prevent mutation',async()=>{
 const s=ready(false),t=task(s);let calls=0;const a=createAdapter(s,{now:()=>999999,getTool:()=>({execute:async()=>{calls++;}})});
 await assert.rejects(a.dispatch(t.id,'s1'),/过期/);assert.equal(calls,0);assert.equal(t.status,'queued');a.dispose();
});
test('close adapter does not abort a user task already submitted',async()=>{
 const s=ready(false),t=task(s);let resolveSend,passedSignal;
 const a=createAdapter(s,{now:()=>20000,getTool:()=>({execute:async(input,options)=>{
  if(input.command==='session send'){passedSignal=options.signal;return new Promise(resolve=>resolveSend=resolve);}
  return {ok:true,result:input.command==='session inspect'?{generating:false}:{events:[]}};
 }})});
 const result=a.dispatch(t.id,'s1');await new Promise(r=>setTimeout(r,0));a.dispose();assert.equal(passedSignal,undefined);resolveSend({ok:true,result:{sent:true}});await result;assert.equal(t.status,'dispatching');
});
