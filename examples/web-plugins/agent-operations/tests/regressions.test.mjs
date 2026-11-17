import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../src/model.js';
import {createAdapter} from '../src/adapter.js';
function setup(){const s=createStore({demo:true,now:()=>20000});s.state.connected=true;s.syncAgents([{id:'a',name:'A'},{id:'b',name:'B'}]);s.state.agents.forEach(a=>{a.status='idle';a.sequence=5;a.observedAt=19999;});return s;}
test('pinned native cancellation maps protocol_error only after a cancellation request',()=>{
 const s=setup(),t=s.addTask({title:'cancel',content:'wait'});s.assign(t.id,'a');t.cancelRequested=true;
 s.applyEvent('a',{sequence:6,eventType:'turn.failed',typedPayload:{code:'protocol_error',error:'ACP protocol: prompt cancelled'}});
 assert.equal(t.status,'cancelled');assert.equal(t.error,'');
 const other=s.addTask({title:'not cancel',content:'wait'});s.assign(other.id,'b');s.applyEvent('b',{sequence:6,eventType:'turn.failed',typedPayload:{code:'protocol_error',error:'ACP protocol: prompt cancelled'}});assert.equal(other.status,'failed');
});
test('uncertain work consumes capacity and restored baseline rejects previous completion',()=>{
 const s=setup();s.state.maxParallel=1;const t=s.addTask({title:'a',content:'b'});s.assign(t.id,'a');s.setTask(t,'unknown','receipt lost');
 const other=s.addTask({title:'c',content:'d'});assert.match(s.canAssign(other,s.state.agents[1]),/并发/);
 const r=createStore({saved:s.snapshot()});r.syncAgents([{id:'a'}]);r.applyEvent('a',{sequence:5,eventType:'turn.completed'});assert.equal(r.state.tasks[0].status,'unknown');r.applyEvent('a',{sequence:6,eventType:'turn.completed'});assert.equal(r.state.tasks[0].status,'review');
});
test('UTF-8 task storage is capped before the host private storage quota',()=>{
 const s=setup();let count=0;assert.throws(()=>{for(;count<150;count++)s.addTask({title:'中文',content:'文'.repeat(8000)});},/存储上限/);
 assert.ok(count>20&&count<50);assert.ok(new TextEncoder().encode(JSON.stringify(s.snapshot())).length<900000);
});
test('restart preserves pending cancellation, priority and failure evidence',()=>{
 const s=setup(),t=s.addTask({title:'cancel on restart',content:'wait',priority:'low'});
 s.assign(t.id,'a');t.cancelRequested=true;
 const r=createStore({saved:s.snapshot()});r.syncAgents([{id:'a'}]);
 assert.equal(r.state.tasks[0].status,'unknown');assert.equal(r.state.tasks[0].priority,'low');
 r.applyEvent('a',{sequence:6,eventType:'turn.failed',typedPayload:{code:'protocol_error',error:'ACP protocol: prompt cancelled'}});
 assert.equal(r.state.tasks[0].status,'cancelled');
 s.setTask(t,'failed','specific host failure');const f=createStore({saved:s.snapshot()});
 assert.equal(f.state.tasks[0].error,'specific host failure');
});
test('late request error cannot overwrite canonical completion',async()=>{
 const s=setup();s.state.demo=false;const t=s.addTask({title:'a',content:'b'});let fail;
 const adapter=createAdapter(s,{now:()=>20000,getTool:()=>({execute:async({command})=>{
  if(command==='session inspect')return {ok:true,result:{generating:false}};
  if(command==='session messages')return {ok:true,result:{events:[]}};
  return new Promise(resolve=>{fail=()=>resolve({ok:false,error:{message:'late network failure'}});});
 }})});
 const pending=adapter.dispatch(t.id,'a');while(!fail)await new Promise(r=>setTimeout(r,0));s.applyEvent('a',{sequence:6,eventType:'turn.completed'});fail();await pending;assert.equal(t.status,'review');adapter.dispose();
});
test('auto dispatch starts independent sessions while an earlier send is still pending',async()=>{
 const s=setup();s.state.demo=false;s.state.auto=true;s.state.maxParallel=2;
 for(let i=0;i<3;i++)s.addTask({title:`parallel ${i}`,content:'work'});
 const sends=[],release=[];const adapter=createAdapter(s,{now:()=>20000,getTool:()=>({execute:async({command,args})=>{
  if(command==='session inspect')return {ok:true,result:{generating:false}};
  if(command==='session messages')return {ok:true,result:{events:[]}};
  assert.equal(command,'session send');sends.push(args.sessionId);return new Promise(resolve=>release.push(()=>resolve({ok:true,result:{}})));
 }})});
 try{
  await adapter.schedule();await adapter.schedule();
  for(let i=0;i<30&&sends.length<2;i++)await new Promise(r=>setTimeout(r,0));
  assert.deepEqual(sends.sort(),['a','b']);assert.equal(s.state.tasks.filter(t=>t.status==='queued').length,1);
  await adapter.schedule();assert.equal(sends.length,2);
 }finally{adapter.dispose();release.forEach(fn=>fn());}
});
test('permission waits match the remote session ID and the same agent',async()=>{
 const s=setup();s.state.demo=false;const t=s.addTask({title:'permission',content:'work'});s.assign(t.id,'a');
 const adapter=createAdapter(s,{now:()=>20000,getTool:()=>({execute:async({command,args})=>{
  const result=command==='session list'?[{id:'a',agentId:'fixture'},{id:'b',agentId:'other'}]:
   command==='session inspect'?{generating:true,periId:'remote-1',agentId:args.sessionId==='a'?'fixture':'other'}:
   command==='session messages'?{events:[]}:{items:[{sessionId:'remote-1',agentId:'fixture'}]};
  return {ok:true,result};
 }})});
 try{await adapter.poll();assert.equal(t.status,'waiting');assert.equal(s.state.agents[0].room,'brief');assert.equal(s.state.agents[1].status,'running');}
 finally{adapter.dispose();}
});
