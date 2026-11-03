import styles from './styles.css';
import characterStyles from './character-page.css';
import {mountCharacterPage} from './character-page.js';
import { ACTIVE, ROOMS, STATUS } from './model.js';
import { sceneLayout } from './scene-layout.js';
import { EMOTIONS, mountCompanion } from './companion.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function mountOperations(container,store,adapter,{asset,compact=false}={}) {
  const host=document.createElement('section');container.append(host);const root=host.attachShadow({mode:'open'});
  root.innerHTML=`<style>${styles}\n${characterStyles}</style><main class="ops ${compact?'compact':''}">
    <aside class="rail"><div class="brand-mark">P<span>↗</span></div><span class="rail-word">PYLON / OPS</span><button class="rail-button active" data-view="base" title="基建总览" aria-label="基建总览">⌘</button><button class="rail-button" data-view="tasks" title="任务队列" aria-label="任务队列">▤</button><button class="rail-button" data-view="studio" title="角色工作室" aria-label="角色工作室">✧</button><button class="rail-button" data-view="character" title="维瑟兰" aria-label="维瑟兰角色页">♧</button><div class="rail-bottom">01<br><span>SECTOR</span></div></aside>
    <div class="workspace"><header class="topbar"><div class="breadcrumb">PYLON <span>/</span> EXTENSIONS <span>/</span> <b>AGENT OPERATIONS</b></div><div class="top-actions"><span class="connection"><i></i><span></span></span><button data-action="expand" class="icon-button" aria-label="展开调度台">⛶</button></div></header>
      <div class="heading"><div><div class="eyebrow">MULTI-AGENT COMMAND CENTER</div><h1>团子调度局<span> OPERATIONS / 01</span></h1><p>让任务有去处，让协作看得见。</p></div><div class="heading-actions"><button data-action="refresh" class="secondary">↻ 刷新</button><button data-action="new" class="primary">＋ 新建任务</button></div></div>
      <div class="notice" role="status"></div><div class="error-banner" role="alert" hidden></div>
      <div class="metrics"></div>
      <div class="content-grid"><div class="main-column"><section class="map-panel"><div class="section-head"><div><span class="index">01</span><h2>基建现场</h2><span class="subtle">BASE OVERVIEW</span></div><div><button data-action="motion" class="tiny">暂停动画</button><span class="live-badge">● LIVE</span></div></div>
      <div class="map-viewport" tabindex="0" role="region" aria-label="基建现场，可滚动查看所有工作区域"><div class="map"><div class="map-grid"></div><div class="corridor horizontal"><span>TRANSFER ROUTE →</span></div><div class="corridor vertical"></div><div class="map-cross">✦</div><div class="rooms">${ROOMS.map((r,i)=>`<button class="room room-${r.id}" data-room="${r.id}" aria-label="${r.name}"><div class="room-heading"><span class="room-number">0${i+1}</span><div><b>${r.name}</b><small>${r.en}</small></div><span class="room-occupancy">0 人</span></div><div class="room-decor ${r.id}"><span class="fixture f1"></span><span class="fixture f2"></span><span class="fixture f3"></span><span class="room-symbol">${r.icon}</span></div><span class="room-floor-label">${r.id==='lounge'?'REST · RECHARGE':'READY FOR OPERATIONS'}</span></button>`).join('')}</div><div class="agents-layer"></div><div class="empty-map" hidden>还没有可见会话<br><small>连接 Pylon 后，会话会出现在这里。</small></div><div class="map-coordinate">SECTOR 01 / X: 024 Y: 018</div></div></div>
      <div class="legend"><span><i class="dot running"></i>工作中</span><span><i class="dot waiting"></i>等待处理</span><span><i class="dot idle"></i>待命</span><span><i class="dot failed"></i>异常</span><span class="legend-hint">点击小人查看状态 · 拖动待办到小人进行派遣</span></div></section>
      <section class="queue-panel"><div class="section-head"><div><span class="index">02</span><h2>任务队列</h2><span class="queue-count subtle"></span></div><div><select class="filter" aria-label="筛选任务"><option value="all">全部任务</option><option value="queued">待派遣</option><option value="running">执行中</option><option value="review">待验收</option><option value="failed">异常</option><option value="done">已完成</option></select><button data-action="auto" class="tiny">启动自动派遣</button></div></div><div class="task-list"></div></section>
      <section class="studio-panel" hidden><div class="section-head"><div><span class="index">03</span><h2>角色工作室</h2></div><span class="subtle">EXPRESSION & MOTION</span></div><p>选择情绪预览，5 秒后恢复任务驱动。当前播放器：二维精灵动作；Cubism 模型制作中。</p><div class="emotion-grid">${Object.entries(EMOTIONS).map(([id,e])=>`<button data-emotion="${id}"><span>✧</span>${e.label}</button>`).join('')}</div><div class="preferences"><label><input type="checkbox" name="quiet"> 安静陪伴</label><label>最大并发 <select name="parallel">${[1,2,3,4,5,6].map(x=>`<option>${x}</option>`).join('')}</select></label><button data-action="export" class="secondary">导出任务记录</button></div></section>
      </div><aside class="side-column"><section class="manager-panel"><div class="section-head"><div><span class="index">PM</span><h2>今日值班</h2></div><span class="tiny-label">ONLINE</span></div><div class="companion"></div><div class="manager-buttons"><button data-action="brief" class="secondary">查看简报 ↗</button><button data-action="studio" class="icon-button" aria-label="产品经理表情动作">✧</button></div></section><section class="detail-panel"><div class="section-head"><h2>Agent 状态</h2><span class="subtle">INSPECT</span></div><div class="agent-detail"></div></section><section class="activity-panel"><div class="section-head"><h2>行动记录</h2><span class="subtle">EVENT LOG</span></div><div class="event-list"></div></section></aside></div>
      <div class="character-mobile-nav"><button data-view="base">调度台</button><button data-view="character">维瑟兰</button><button data-view="studio">动作</button></div><footer><span>PYLON AGENT OPERATIONS <b>●</b> 独立前端插件</span><span class="sync-time"></span></footer>
    </div><dialog class="task-dialog"><form><div class="dialog-head"><h2>创建一项新任务</h2><button type="button" data-action="close-dialog" class="icon-button" aria-label="关闭">×</button></div><p>清晰的任务说明，会让团子少走弯路。</p><label>任务名称<input name="title" required maxlength="100" placeholder="例如：检查登录流程的错误提示"></label><label>执行说明与验收标准<textarea name="content" required maxlength="8000" rows="4" placeholder="描述目标、范围、输出和验收标准…"></textarea></label><div class="form-row"><label>工作区域<select name="room">${ROOMS.filter(r=>r.id!=='lounge').map(r=>`<option value="${r.id}">${r.name}</option>`).join('')}</select></label><label>优先级<select name="priority"><option value="normal">常规</option><option value="high">优先</option><option value="low">稍后</option></select></label></div><label>前置任务<select name="dependency"><option value="">无</option></select></label><p class="form-error" role="alert"></p><button type="submit" class="primary">加入待派遣队列 →</button></form></dialog><div class="toast" role="status" hidden></div></main>`;
  const $=q=>root.querySelector(q),$$=q=>[...root.querySelectorAll(q)];const app=$('.ops');
  const characterView=document.createElement('section');characterView.className='character-view';characterView.hidden=true;$('.content-grid').append(characterView);const disposeCharacter=mountCharacterPage(characterView,store,asset);
  const companion=mountCompanion($('.companion'),store,asset);let filter='all',roomFilter=null,disposed=false,toastTimer,view='base';const agentNodes=new Map();
  function toast(message){$('.toast').textContent=message;$('.toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('.toast').hidden=true,5000);}
  function switchView(next){view=next;characterView.hidden=next!=='character';$('.content-grid').classList.toggle('character-open',next==='character');$('.map-panel').hidden=next!=='base';$('.queue-panel').hidden=next==='studio';$('.studio-panel').hidden=next!=='studio';$$('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===next));}
  function render(){
    if(disposed)return;const s=store.state;app.classList.toggle('still',!s.motion);app.classList.toggle('quiet',s.quiet);
    $('.connection span').textContent=s.demo?'DEMO MODE':s.connected?'CONNECTED':'OFFLINE';$('.connection').classList.toggle('offline',!s.connected);
    $('.notice').textContent=s.demo?'演示沙盘 · 所有任务与状态均为本地演示，不会调用真实 Agent。':s.connected?'实时连接 Pylon · 派遣将向选定会话发送执行说明。':'等待 Pylon 连接 · 当前没有真实会话数据，已暂停派遣。';
    $('.error-banner').hidden=!s.error;$('.error-banner').textContent=s.error;$('.live-badge').textContent=s.demo?'◇ DEMO':s.connected?'● LIVE':'○ OFFLINE';
    const metrics=[['可见会话',s.agents.length,'AGENTS','01'],['正在执行',s.agents.filter(a=>['running','dispatching'].includes(a.status)).length,'ACTIVE','02'],['待处理',s.tasks.filter(t=>['queued','review','failed'].includes(t.status)).length,'ATTENTION','03'],['已验收',s.tasks.filter(t=>t.status==='done').length,'COMPLETED','04']];
    $('.metrics').innerHTML=metrics.map(([label,n,en,id])=>`<div class="metric"><span class="metric-index">${id}</span><span>${label}<small>${en}</small></span><strong>${String(n).padStart(2,'0')}</strong><div class="metric-bars">▂▃▂▅▃▆</div></div>`).join('');
    $('.empty-map').hidden=!!s.agents.length;
    const layout=sceneLayout(s.agents,$('.map').clientWidth);
    $('.map').style.height=layout.height+'px';
    for(const a of s.agents){
      let n=agentNodes.get(a.id);if(!n){n=document.createElement('button');n.className='agent';n.dataset.agent=a.id;n.innerHTML=`<span class="agent-bubble"></span><span class="agent-sprite"></span><span class="agent-name"></span><span class="agent-state"></span>`;n.querySelector('.agent-sprite').style.backgroundImage=`url("${asset('worker-states.png')}")`;$('.agents-layer').append(n);agentNodes.set(a.id,n);}
      const {x,y}=layout.positions.get(a.id);
      const cell=({running:2,waiting:3,failed:3,unknown:3,review:4,done:4,dispatching:1,idle:0,cancelled:5})[a.status]??0;
      n.querySelector('.agent-sprite').style.backgroundPosition=`${(cell%3)*50}% ${Math.floor(cell/3)*100}%`;
      if(n.dataset.room&&n.dataset.room!==a.room&&s.motion&&typeof n.animate==='function'){n.getAnimations().forEach(a=>a.cancel());n.classList.add('travelling');const travel=n.animate([{left:n.style.left,top:n.style.top},{left:n.style.left,top:layout.corridorY+'px'},{left:`${x}px`,top:layout.corridorY+'px'},{left:`${x}px`,top:`${y}px`}],{duration:1800,easing:'ease-in-out'});travel.onfinish=()=>n.classList.remove('travelling');}
      n.style.left=`${x}px`;n.style.top=`${y}px`;n.dataset.room=a.room;n.dataset.status=a.status;n.classList.toggle('selected',s.selected===a.id);n.setAttribute('aria-label',`${a.name}，${STATUS[a.status]}`);n.setAttribute('aria-pressed',String(s.selected===a.id));n.querySelector('.agent-name').textContent=a.name;n.querySelector('.agent-state').textContent=STATUS[a.status]||'未知';n.querySelector('.agent-bubble').textContent=({running:'···',waiting:'?',failed:'!',review:'✓',dispatching:'→'})[a.status]||'z';
    }
    for(const [id,n] of agentNodes)if(!s.agents.some(a=>a.id===id)){n.remove();agentNodes.delete(id);}
    for(const room of ROOMS){const n=$(`[data-room="${room.id}"]`);n.querySelector('.room-occupancy').textContent=`${s.agents.filter(a=>a.room===room.id).length} 人`;n.classList.toggle('chosen',roomFilter===room.id);}
    const selected=s.agents.find(a=>a.id===s.selected),task=s.tasks.find(t=>t.sessionId===selected?.id&&t.status!=='done');
    $('.agent-detail').innerHTML=selected?`<div class="agent-identity"><img src="${asset('worker.png')}" alt=""><div><b>${esc(selected.name)}</b><small>${esc(selected.agentId)} / ${esc(STATUS[selected.status])}</small></div><span class="dot ${esc(selected.status)}"></span></div><dl><dt>当前位置</dt><dd>${esc(ROOMS.find(r=>r.id===selected.room)?.name)}</dd><dt>当前任务</dt><dd>${esc(task?.title||'暂无分配')}</dd><dt>会话</dt><dd class="mono">${esc(selected.id)}</dd><dt>观测</dt><dd>${s.demo?'演示状态':selected.observedAt?new Date(selected.observedAt).toLocaleTimeString('zh-CN'):'尚未确认'}</dd></dl>${task?.error?`<p class="detail-error">${esc(task.error)}</p>`:''}`:'<div class="empty-detail"><span>◎</span><p>点击现场的小人<br>查看它的任务与工作状态</p></div>';
    const tasks=s.tasks.filter(t=>(filter==='all'||(filter==='running'?ACTIVE.has(t.status):t.status===filter))&&(!roomFilter||t.room===roomFilter));
    $('.queue-count').textContent=`${tasks.length} TASKS${roomFilter?' · 已按房间筛选':''}`;
    const focused=root.activeElement;const focusKey=focused?.dataset?.taskAction?{id:focused.dataset.id,action:focused.dataset.taskAction}:null;
    $('.task-list').innerHTML=tasks.length?tasks.map((t,i)=>`<article class="task-row" draggable="${t.status==='queued'}" data-task="${esc(t.id)}"><span class="task-number">${String(i+1).padStart(2,'0')}</span><div class="task-text"><b>${esc(t.title)}</b><small>${esc(ROOMS.find(r=>r.id===t.room)?.name)}${t.dependencies.length?' / '+(t.dependencies.every(id=>s.tasks.find(x=>x.id===id)?.status==='done')?'前置已完成':'等待前置验收'):''}</small></div><span class="priority ${t.priority}">${({high:'优先',normal:'常规',low:'稍后'})[t.priority]}</span><span class="status ${t.status}">${esc(STATUS[t.status]||'状态未知')}</span><button class="task-action" data-task-action="${t.status==='queued'?'assign':t.status==='review'?'accept':ACTIVE.has(t.status)?'cancel':['failed','cancelled'].includes(t.status)?'retry':'detail'}" data-id="${esc(t.id)}">${t.status==='queued'?'派遣 ↗':t.status==='review'?'验收 ✓':ACTIVE.has(t.status)?'取消':['failed','cancelled'].includes(t.status)?'重排':'查看'}</button></article>`).join(''):'<div class="empty-list">当前筛选下没有任务。<button data-action="new">＋ 创建任务</button></div>';
    if(focusKey)$$('[data-task-action]').find(b=>b.dataset.id===focusKey.id&&b.dataset.taskAction===focusKey.action)?.focus({preventScroll:true});
    $('.event-list').innerHTML=s.events.slice(0,7).map(e=>`<div class="event ${e.kind}"><time>${new Date(e.time).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time><span>${esc(e.message)}</span></div>`).join('')||'<p class="subtle">等待首个事件。</p>';
    $('[data-action="auto"]').textContent=s.auto?'停止自动派遣':'启动自动派遣';$('[data-action="auto"]').classList.toggle('enabled',s.auto);
    $('[data-action="motion"]').textContent=s.motion?'暂停动画':'恢复动画';$('[name="parallel"]').value=String(s.maxParallel);$('[name="quiet"]').checked=s.quiet;
    $('.sync-time').textContent=s.demo?'LOCAL SIMULATION / NO API':s.lastSync?`最近同步 ${new Date(s.lastSync).toLocaleTimeString('zh-CN')}`:'尚未同步';
  }
  async function dispatch(id,sessionId){
    const t=store.state.tasks.find(t=>t.id===id);let a=store.state.agents.find(a=>a.id===(sessionId||store.state.selected));
    if(!a)a=store.state.agents.find(a=>!store.canAssign(t,a));
    if(!a)throw Error('没有可用会话；请检查并发上限、依赖和 Agent 状态。');
    await adapter.dispatch(id,a.id);companion.trigger('dispatch');
  }
  async function onClick(e){
    const b=e.target.closest('button');if(!b)return;
    try{
      if(b.dataset.view){switchView(b.dataset.view);return;}
      if(b.dataset.agent){store.state.selected=b.dataset.agent;store.notify();return;}
      if(b.dataset.room){roomFilter=roomFilter===b.dataset.room?null:b.dataset.room;render();return;}
      if(b.dataset.emotion){companion.trigger(b.dataset.emotion);return;}
      if(b.dataset.taskAction){
        const t=store.state.tasks.find(t=>t.id===b.dataset.id);
        if(b.dataset.taskAction==='assign')await dispatch(t.id);
        if(b.dataset.taskAction==='accept'){store.accept(t.id);companion.trigger('proud');if(store.state.auto)void adapter.schedule();}
        if(b.dataset.taskAction==='retry')store.requeue(t.id);
        if(b.dataset.taskAction==='cancel')await adapter.cancel(t.id);
        if(b.dataset.taskAction==='detail'){store.state.selected=t.sessionId;toast(`${t.title}：${t.content}`);store.notify();}
        return;
      }
      switch(b.dataset.action){
        case 'new':$('.task-dialog form').reset();$('.form-error').textContent='';$('[name="dependency"]').innerHTML='<option value="">无</option>'+store.state.tasks.map(t=>`<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('');$('.task-dialog').showModal();$('[name="title"]').focus();break;
        case 'close-dialog':$('.task-dialog').close();break;
        case 'refresh':await adapter.poll();toast(store.state.demo?'演示数据在本地运行':store.state.connected?'已同步 Pylon 状态':'连接尚不可用');break;
        case 'motion':store.state.motion=!store.state.motion;store.notify();break;
        case 'studio':switchView('character');break;
        case 'auto':store.state.auto=!store.state.auto;store.log(store.state.auto?'自动派遣已启动 · 按依赖与并发上限调度':'自动派遣已停止 · 已运行任务继续执行');store.notify();if(store.state.auto)void adapter.schedule();break;
        case 'brief':toast(`简报：${store.state.tasks.filter(t=>ACTIVE.has(t.status)).length} 项执行中，${store.state.tasks.filter(t=>t.status==='review').length} 项待验收，${store.state.tasks.filter(t=>t.status==='failed').length} 项异常。`);companion.trigger('thinking');break;
        case 'expand':app.classList.toggle('expanded');host.classList.toggle('expanded',app.classList.contains('expanded'));b.setAttribute('aria-label',app.classList.contains('expanded')?'收起调度台':'展开调度台');break;
        case 'export':{const url=URL.createObjectURL(new Blob([JSON.stringify(store.snapshot(),null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='pylon-operations-tasks.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);break;}
      }
    }catch(error){toast(error.message);}
  }
  function onSubmit(e){e.preventDefault();const data=new FormData(e.target);try{store.addTask({title:data.get('title'),content:data.get('content'),room:data.get('room'),priority:data.get('priority'),dependencies:data.get('dependency')?[data.get('dependency')]:[]});$('.task-dialog').close();if(store.state.auto)void adapter.schedule();}catch(error){$('.form-error').textContent=error.message;}}
  function onChange(e){if(e.target.matches('.filter')){filter=e.target.value;render();}if(e.target.name==='quiet'){store.state.quiet=e.target.checked;store.notify();}if(e.target.name==='parallel'){store.state.maxParallel=Number(e.target.value);store.notify();}}
  function onDrag(e){const t=e.target.closest('[data-task]');if(t?.draggable)e.dataTransfer.setData('application/x-pylon-task',t.dataset.task);}
  function onOver(e){if(e.target.closest('[data-agent]')&&[...e.dataTransfer.types].includes('application/x-pylon-task'))e.preventDefault();}
  function onDrop(e){const a=e.target.closest('[data-agent]');if(!a)return;e.preventDefault();void dispatch(e.dataTransfer.getData('application/x-pylon-task'),a.dataset.agent).catch(error=>toast(error.message));}
  function onKey(e){if(e.key==='Escape'&&app.classList.contains('expanded')){app.classList.remove('expanded');host.classList.remove('expanded');}}
  root.addEventListener('click',onClick);root.addEventListener('submit',onSubmit);root.addEventListener('change',onChange);root.addEventListener('dragstart',onDrag);root.addEventListener('dragover',onOver);root.addEventListener('drop',onDrop);root.addEventListener('keydown',onKey);
  let measuredWidth=0;
  const resize=typeof ResizeObserver==='function'?new ResizeObserver(()=>{const width=$('.map').clientWidth;if(width>0&&width!==measuredWidth){measuredWidth=width;render();}}):null;
  resize?.observe($('.map'));
  const off=store.subscribe(render);render();
  return ()=>{disposed=true;resize?.disconnect();off();companion.dispose();disposeCharacter();clearTimeout(toastTimer);root.removeEventListener('click',onClick);root.removeEventListener('submit',onSubmit);root.removeEventListener('change',onChange);root.removeEventListener('dragstart',onDrag);root.removeEventListener('dragover',onOver);root.removeEventListener('drop',onDrop);root.removeEventListener('keydown',onKey);host.remove();};
}
