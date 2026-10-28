export const ACTIVE = new Set(['dispatching','running','waiting']);
export const TRACKED = new Set([...ACTIVE,'unknown']);
export const STATUS = {idle:'待命',unknown:'状态未知',dispatching:'派遣中',running:'工作中',waiting:'等待处理',review:'等待验收',done:'已完成',failed:'异常',cancelled:'已取消',queued:'待派遣'};
export const ROOMS = [
  {id:'brief',name:'需求作战室',en:'BRIEFING',icon:'◇',x:22,y:24},
  {id:'build',name:'开发工坊',en:'ENGINEERING',icon:'⌘',x:73,y:24},
  {id:'review',name:'测试与验收',en:'VERIFICATION',icon:'✓',x:73,y:74},
  {id:'lounge',name:'补给休息室',en:'STANDBY',icon:'☕',x:22,y:74},
];
export const object = x => x && typeof x==='object' && !Array.isArray(x) ? x : {};
export function text(x, max=240) {return typeof x==='string' ? x.slice(0,max) : '';}
export function roomFor(status) {return ({running:'build',dispatching:'build',waiting:'brief',failed:'brief',review:'review',done:'review'})[status]||'lounge';}
export function createStore({demo=false, saved, now=Date.now}={}) {
  let counter=0;
  const listeners=new Set();
  const state={demo,connected:false,connection:'等待连接 Pylon',agents:[],tasks:[],events:[],selected:null,auto:false,maxParallel:2,motion:true,quiet:false,outfit:'director',lastSync:0,error:'', revision:0};
  function notify(){state.revision++; for(const fn of listeners)fn(state);}
  function log(message,kind='info'){state.events.unshift({id:`event-${now()}-${counter++}`,time:now(),message:text(message,280),kind});state.events.length=Math.min(120,state.events.length);}
  function addTask(input) {
    if(state.tasks.length>=150)throw Error('任务上限为 150，请先导出并清理已完成任务。');
    const title=text(input.title,100).trim(),content=text(input.content,8000).trim();
    if(!title||!content)throw Error('请填写任务名称与明确的执行说明。');
    const dependencies=Array.isArray(input.dependencies)?[...new Set(input.dependencies)].filter(x=>typeof x==='string'):[];
    if(dependencies.some(id=>!state.tasks.some(t=>t.id===id)))throw Error('前置任务不存在。');
    const room=ROOMS.some(r=>r.id===input.room)?input.room:'build';
    const task={id:`task-${now()}-${counter++}`,title,content,dependencies,room,priority:['high','normal','low'].includes(input.priority)?input.priority:'normal',status:'queued',sessionId:null,createdAt:now(),updatedAt:now(),error:''};
    if(new TextEncoder().encode(JSON.stringify([...state.tasks,task])).length>850000)throw Error('任务记录接近存储上限，请先导出并清理已完成任务。');
    state.tasks.push(task);log(`新任务 · ${title}`);notify();return task;
  }
  function canAssign(task,agent) {
    if(!task||task.status!=='queued')return '仅待派遣任务可以分配';
    if(task.dependencies.some(id=>state.tasks.find(t=>t.id===id)?.status!=='done'))return '前置任务尚未验收';
    if(!agent||!['idle','done'].includes(agent.status))return '该会话目前不可派遣';
    if(state.tasks.some(t=>t.sessionId===agent.id && (TRACKED.has(t.status)||t.status==='review')))return '该会话已有未完成任务';
    if(state.tasks.filter(t=>TRACKED.has(t.status)).length>=state.maxParallel)return '已达到并发上限';
    if(!state.demo&&!state.connected)return '宿主连接不可用';
    return '';
  }
  function assign(taskId,sessionId){
    const task=state.tasks.find(t=>t.id===taskId),agent=state.agents.find(a=>a.id===sessionId);
    const reason=canAssign(task,agent);if(reason)throw Error(reason);
    task.status='dispatching';task.sessionId=sessionId;task.updatedAt=now();task.startedAt=now();task.baselineSequence=agent.sequence??0;
    agent.status='dispatching';agent.room=task.room;agent.updatedAt=now();log(`${agent.name} → ${task.title}`,'dispatch');notify();return task;
  }
  function setTask(task,status,error='') {
    if(!task)return;task.status=status;task.error=text(error,500);task.updatedAt=now();
    const a=state.agents.find(x=>x.id===task.sessionId);
    if(a){a.status=status==='done'?'idle':status;a.room=ACTIVE.has(status)?task.room:roomFor(status);a.updatedAt=now();}
    log(`${task.title} · ${STATUS[status]||status}${error?' · '+text(error):''}`,status==='failed'?'error':'info');notify();
  }
  function applyEvent(sessionId,event,{historical=false}={}) {
    const agent=state.agents.find(a=>a.id===sessionId);if(!agent)return false;
    const seq=Number(event.sequence);
    if(!Number.isSafeInteger(seq)||seq<0||seq<=(agent.sequence??-1))return false;
    agent.sequence=seq;
    const type=text(event.eventType), p=object(event.typedPayload);
    const map={'user.message':'running','turn.started':'running','tool.call.started':'running','turn.completed':'review','turn.failed':'failed','turn.cancelled':'cancelled'};
    const task=state.tasks.find(t=>t.sessionId===sessionId&&TRACKED.has(t.status));
    // Pinned host reports ACP cancellation as protocol_error; require our own
    // cancellation request plus the exact error, rather than broad string matching.
    const cancelled=p.stopReason==='cancelled'||(task?.cancelRequested&&p.code==='protocol_error'&&p.error==='ACP protocol: prompt cancelled');
    const status=cancelled&&['turn.failed','turn.completed'].includes(type)?'cancelled':map[type];if(!status)return false;
    if(task && (historical||seq<=(task.baselineSequence??-1)))return false;
    agent.status=!task&&['review','cancelled'].includes(status)?'idle':status;agent.room=task&&ACTIVE.has(status)?task.room:roomFor(agent.status);agent.updatedAt=now();
    if(task){task.status=status;task.updatedAt=now();task.error=status==='failed'?text(p.error||p.message)||'宿主报告回合失败':'';}
    if(!historical)log(`${agent.name} · ${STATUS[status]}`,status==='failed'?'error':'info');
    notify();return true;
  }
  function syncAgents(rows) {
    const ids=new Set();
    for(const row of rows.slice(0,48)) {
      const id=text(row.id,180);if(!id||ids.has(id))continue;ids.add(id);
      let agent=state.agents.find(a=>a.id===id);
      if(!agent){agent={id,name:text(row.title||row.name,64)||text(row.agentId,64)||'Agent',agentId:text(row.agentId,120),status:'unknown',room:'lounge',sequence:-1,updatedAt:now()};state.agents.push(agent);}
      agent.name=text(row.title||row.name,64)||agent.name;
    }
    for(const a of state.agents)if(!ids.has(a.id)){a.status='unknown';a.room='lounge';}
    notify();
  }
  function accept(id){const task=state.tasks.find(t=>t.id===id);if(task?.status!=='review')throw Error('仅已结束的任务可以验收。');setTask(task,'done');}
  function requeue(id){const task=state.tasks.find(t=>t.id===id);if(!task||!['failed','cancelled','review'].includes(task.status))throw Error('当前任务不能重新排队。');const agent=state.agents.find(a=>a.id===task.sessionId);if(agent){agent.status='unknown';agent.observedAt=0;}task.sessionId=null;task.cancelRequested=false;setTask(task,'queued');}
  function snapshot(){return {version:1,tasks:state.tasks.map(t=>({...t})),maxParallel:state.maxParallel,motion:state.motion,quiet:state.quiet,outfit:state.outfit};}
  if(saved?.version===1 && Array.isArray(saved.tasks)) {
    for(const raw of saved.tasks.slice(0,150)) {
      if(!raw||typeof raw.id!=='string'||typeof raw.title!=='string'||typeof raw.content!=='string')continue;
      state.tasks.push({id:text(raw.id,180),title:text(raw.title,100),content:text(raw.content,8000),dependencies:Array.isArray(raw.dependencies)?raw.dependencies.filter(x=>typeof x==='string').slice(0,150):[],room:ROOMS.some(r=>r.id===raw.room)?raw.room:'build',priority:['high','normal','low'].includes(raw.priority)?raw.priority:'normal',status:['done','queued','review','failed','cancelled'].includes(raw.status)?raw.status:'unknown',sessionId:text(raw.sessionId,180)||null,baselineSequence:Number.isSafeInteger(raw.baselineSequence)?raw.baselineSequence:-1,cancelRequested:raw.cancelRequested===true,startedAt:Number(raw.startedAt)||0,createdAt:Number(raw.createdAt)||now(),updatedAt:now(),error:TRACKED.has(raw.status)?'插件重启，需重新核验会话状态':text(raw.error,500)});
    }
    state.maxParallel=Math.max(1,Math.min(6,Number(saved.maxParallel)||2));state.motion=saved.motion!==false;state.quiet=saved.quiet===true;state.outfit=['director','field','archive','rain','lounge'].includes(saved.outfit)?saved.outfit:'director';
  }
  return {state,notify,log,addTask,canAssign,assign,setTask,applyEvent,syncAgents,accept,requeue,snapshot,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
}

export function seedDemo(store){
  const {state}=store;state.connected=true;state.connection='演示沙盘 · 不会执行真实任务';
  store.syncAgents([{id:'demo-1',title:'团子 01',agentId:'规划'},{id:'demo-2',title:'团子 02',agentId:'开发'},{id:'demo-3',title:'团子 03',agentId:'测试'},{id:'demo-4',title:'团子 04',agentId:'审查'}]);
  state.agents.forEach(a=>{a.status='idle';a.room='lounge'});
  const a=store.addTask({title:'梳理交互验收标准',content:'明确任务派遣、阻塞提示与验收的验收标准。',room:'brief',priority:'high'});
  const b=store.addTask({title:'实现调度面板',content:'实现任务列表、角色移动与状态显示。',room:'build'});
  store.addTask({title:'检查派遣与回收流程',content:'覆盖异常、断连、取消和重复派遣。',room:'review',dependencies:[b.id]});
  store.addTask({title:'整理美术交付包',content:'校验角色素材、动作预设和透明边缘。',room:'build'});
  store.assign(a.id,'demo-1');store.setTask(a,'running');state.agents[0].room='brief';
  store.assign(b.id,'demo-2');store.setTask(b,'running');
  store.log('产品经理已到岗 · 先确认目标，再开始派遣。');store.notify();
}
