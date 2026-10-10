import { ACTIVE, TRACKED, object, text, roomFor } from './model.js';

// Existing structured GUI CLI bridge at the pinned Pylon revision. No host imports,
// Tauri invocation, DOM scraping, process spawning, or private store access.
export function createAdapter(store, {getTool=()=>globalThis.window?.__PYLON_CLI_TOOL__, now=Date.now}={}) {
  let disposed=false, polling=false, scheduling=false;
  const pending=new Set(), controllers=new Set(), reservations=new Map();
  async function call(command,args={},signal) {
    const tool=getTool();if(typeof tool?.execute!=='function')throw Error('当前 Pylon 未提供结构化 CLI 连接');
    const out=await tool.execute({command,args,timeoutMs:30000},{signal});
    if(!out?.ok)throw Error(text(out?.error?.message,500)||'Pylon 命令失败');
    const result=out.result;
    return result && typeof result==='object' && 'operationId' in result && 'result' in result ? result.result : result;
  }
  async function poll() {
    if(disposed||polling||store.state.demo)return;polling=true;
    const controller=new AbortController();controllers.add(controller);
    try {
      const rows=await call('session list',{},controller.signal);
      if(disposed)return;
      if(!Array.isArray(rows))throw Error('会话列表格式不兼容');
      store.syncAgents(rows);store.state.connected=true;store.state.connection='Pylon 已连接';
      const selected=store.state.selected;
      const ordered=[...store.state.agents].sort((a,b)=>Number(b.id===selected||store.state.tasks.some(t=>t.sessionId===b.id&&ACTIVE.has(t.status)))-Number(a.id===selected||store.state.tasks.some(t=>t.sessionId===a.id&&ACTIVE.has(t.status))));
      // Bound fanout; rotate the idle tail so large workspaces are not starved.
      const live=ordered.filter(a=>store.state.tasks.some(t=>t.sessionId===a.id&&ACTIVE.has(t.status))||a.id===selected);
      const idle=ordered.filter(a=>!live.includes(a));
      const start=Math.floor(now()/4000)%Math.max(1,idle.length);
      const batch=[...live,...idle.slice(start),...idle.slice(0,start)].slice(0,12);
      for(let i=0;i<batch.length;i+=3) {
        await Promise.all(batch.slice(i,i+3).map(async a=>{
          try {
            const inspect=object(await call('session inspect',{sessionId:a.id},controller.signal));
            a.remoteId=text(inspect.periId,180);a.agentId=text(inspect.agentId,120)||a.agentId;
            const page=object(await call('session messages',{sessionId:a.id,limit:'100'},controller.signal));
            if(disposed)return;
            const historical=a.sequence===-1&&!store.state.tasks.some(t=>t.sessionId===a.id&&TRACKED.has(t.status));
            for(const e of Array.isArray(page.events)?[...page.events].sort((x,y)=>Number(x.sequence)-Number(y.sequence)):[])store.applyEvent(a.id,e,{historical});
            const activeTask=store.state.tasks.find(t=>t.sessionId===a.id&&TRACKED.has(t.status));
            if(inspect.generating===true){a.status='running';if(activeTask&&['dispatching','unknown','waiting'].includes(activeTask.status))activeTask.status='running';}
            else if(inspect.generating===false&&!activeTask&&['unknown','running','dispatching'].includes(a.status))a.status='idle';
            // Absence of generation alone never proves task success.
            else if(inspect.generating===false&&activeTask&&now()-activeTask.updatedAt>15000){a.status='unknown';activeTask.status='unknown';activeTask.error='未观察到回合结束事件，请检查会话。';}
            a.room=activeTask?.room||roomFor(a.status);a.observedAt=now();
          } catch(error) {if(!disposed){a.status='unknown';a.error=text(error.message);}}
        }));
      }
      if(disposed)return;
      // Approvals stay with the host; this plugin only points them out.
      try {
        const interactions=object(await call('interaction list',{},controller.signal));
        if(disposed)return;
        for(const a of store.state.agents){
          const waiting=Array.isArray(interactions.items)&&interactions.items.some(item=>item.agentId===a.agentId&&(item.sessionId===a.id||!!a.remoteId&&item.sessionId===a.remoteId));
          if(waiting){a.status='waiting';a.room='brief';const task=store.state.tasks.find(t=>t.sessionId===a.id&&TRACKED.has(t.status));if(task)task.status='waiting';}
          else if(a.status==='waiting'){a.status='unknown';}
        }
      }catch{/* Older hosts can omit interaction list. */}
      store.state.lastSync=now();store.state.error='';store.notify();
      if(store.state.auto)void schedule();
    }catch(error){
      if(!disposed){store.state.connected=false;store.state.connection='连接不可用';store.state.error=text(error.message,500);store.state.auto=false;for(const a of store.state.agents)a.status='unknown';store.notify();}
    }finally{polling=false;controllers.delete(controller);}
  }
  async function dispatch(taskId,sessionId) {
    if(disposed)throw Error('插件已停用');
    if(pending.has(sessionId))throw Error('该会话派遣请求尚未返回');
    // Validate freshness immediately before any mutation, including after restart.
    if(!store.state.demo){
      const a=store.state.agents.find(x=>x.id===sessionId);
      if(!a?.observedAt||now()-a.observedAt>10000)throw Error('会话状态已过期，请刷新后派遣');
      const check=object(await call('session inspect',{sessionId}));
      if(check.generating!==false)throw Error('会话当前忙碌或状态未知');
      const page=object(await call('session messages',{sessionId,limit:'100'}));
      if(disposed)throw Error('插件已停用');
      if(!Array.isArray(page.events))throw Error('不能确认会话事件序列，请先刷新');
      const sequences=page.events.map(e=>Number(e.sequence)).filter(Number.isSafeInteger);
      a.sequence=Math.max(a.sequence??-1,...sequences);
    }
    if(pending.has(sessionId))throw Error('该会话已有并行派遣请求');
    const task=store.assign(taskId,sessionId);pending.add(sessionId);
    try {
      if(store.state.demo){store.setTask(task,'running');store.state.agents.find(a=>a.id===sessionId).room=task.room;return;}
      // Do not abort a submitted user task just because its panel or plugin closes.
      await call('session send',{sessionId,content:`任务：${task.title}\n\n${task.content}`});
      if(disposed)return;
      if(task.status==='dispatching')store.setTask(task,'running');
      store.log('派遣请求已返回；最终状态由会话事件确认。');store.notify();
    }catch(error){if(!disposed){
      // A rejected/expired request can still have reached the agent. Keep tracking
      // canonical events; never overwrite an already observed terminal event.
      if(TRACKED.has(task.status))store.setTask(task,'unknown',error.message);
      store.state.auto=false;
    }}finally{pending.delete(sessionId);}
  }
  async function schedule(){
    if(disposed||!store.state.auto||scheduling)return;
    scheduling=true;try {
    const tasks=store.state.tasks.filter(t=>t.status==='queued').sort((a,b)=>({high:0,normal:1,low:2}[a.priority]-{high:0,normal:1,low:2}[b.priority]));
    for(const task of tasks){
      if(!store.state.auto||disposed)break;
      if([...reservations.values()].includes(task.id))continue;
      const preflight=[...reservations.values()].filter(id=>store.state.tasks.find(t=>t.id===id)?.status==='queued').length;
      if(store.state.tasks.filter(t=>TRACKED.has(t.status)).length+preflight>=store.state.maxParallel)break;
      const agent=store.state.agents.find(a=>!pending.has(a.id)&&!reservations.has(a.id)&&!store.canAssign(task,a));
      if(agent){reservations.set(agent.id,task.id);void dispatch(task.id,agent.id).catch(error=>{if(!disposed){store.state.auto=false;store.state.error=error.message;store.notify();}}).finally(()=>reservations.delete(agent.id));}
    }
    }finally{scheduling=false;}
  }
  async function cancel(taskId){
    const t=store.state.tasks.find(x=>x.id===taskId);if(!t||!ACTIVE.has(t.status))throw Error('任务当前没有运行');
    t.cancelRequested=true;store.notify();
    if(!store.state.demo)await call('session cancel',{sessionId:t.sessionId});
    if(disposed)return;
    // Request receipt is not a terminal event: make uncertainty visible.
    if(store.state.demo)store.setTask(t,'cancelled');
    else {t.error='已请求取消，等待宿主确认';store.log(`${t.title} · 已请求取消`);store.notify();}
  }
  return {poll,dispatch,schedule,cancel,call,dispose(){disposed=true;store.state.auto=false;for(const c of controllers)c.abort();controllers.clear();}};
}
