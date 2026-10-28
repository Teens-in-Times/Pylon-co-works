import {mountLive2D} from './live2d-bridge.js';
export const EMOTIONS = {
  idle:{label:'待命',cell:0,line:'目标明确，就可以出发了。',motion:'breathe'},
  thinking:{label:'思考',cell:1,line:'先理清依赖，再安排下一步。',motion:'tilt'},
  dispatch:{label:'指挥',cell:2,line:'任务已分配。请按验收标准推进。',motion:'point'},
  happy:{label:'开心',cell:3,line:'这次配合得不错，验收一下成果吧。',motion:'bounce'},
  worried:{label:'担心',cell:4,line:'这里需要你做一个决定，我在等你。',motion:'tilt'},
  sleepy:{label:'困倦',cell:5,line:'没有待处理事项，稍微休息一下。',motion:'breathe'},
  focused:{label:'专注',cell:1,line:'正在推进，暂时没有需要打断你的事。',motion:'breathe'},
  proud:{label:'自豪',cell:3,line:'目标达成。让我们把经验留下来。',motion:'nod'},
  surprised:{label:'惊讶',cell:4,line:'出现了新的情况，先核对状态。',motion:'bounce'},
  encourage:{label:'鼓励',cell:3,line:'慢一点也没关系，先解决眼前这一步。',motion:'nod'},
  greeting:{label:'问候',cell:3,line:'欢迎回来。要一起看看今天的进度吗？',motion:'wave'},
  error:{label:'警觉',cell:4,line:'任务出现异常。先查看原因，再决定是否重试。',motion:'shake'},
};

// Original-pixel illustration stays visible until the isolated Cubism player
// has actually rendered. Expression descriptions do not imply finished rigging.
export function mountCompanion(container,store,asset) {
  container.innerHTML=`<div class="companion-stage"><div class="orbit-ring"></div><span class="stage-label">PM / 01</span><button class="manager-character" aria-label="与产品经理打招呼"><span class="manager-sprite"></span></button><span class="stage-shadow"></span></div><div class="manager-copy"><div class="eyebrow">PRODUCT MANAGER</div><h2>维瑟兰 <span class="mood-label"></span></h2><p class="manager-line" aria-live="polite"></p></div>`;
  const character=container.querySelector('.manager-character'),sprite=container.querySelector('.manager-sprite');
  sprite.style.backgroundImage=`url("${asset('manager-original.png')}")`;
  sprite.style.backgroundSize='contain';sprite.style.backgroundPosition='center';
  const live=mountLive2D(container.querySelector('.companion-stage'),character,store,asset,()=>trigger('greeting'));
  let override=null,until=0,current='',lastChange=0;
  function mood() {
    if(override&&Date.now()<until)return override;
    override=null;const s=store.state;
    if(s.tasks.some(t=>t.status==='failed'))return 'error';
    if(s.agents.some(a=>a.status==='waiting'))return 'worried';
    if(s.tasks.some(t=>t.status==='review'))return 'happy';
    if(s.tasks.some(t=>t.status==='dispatching'))return 'dispatch';
    if(s.tasks.some(t=>t.status==='running'))return 'focused';
    if(s.tasks.some(t=>t.status==='queued'))return 'thinking';
    if(s.tasks.length&&s.tasks.every(t=>t.status==='done'))return 'proud';
    return 'idle';
  }
  function update(force=false){
    const next=mood();
    // Quiet mode changes copy even when the task-derived mood is unchanged.
    if(current)container.querySelector('.manager-line').textContent=store.state.quiet?'安静陪伴中':EMOTIONS[current].line;
    if(!force&&next===current)return;
    if(!force&&Date.now()-lastChange<1200&&next!=='error'&&next!=='worried')return;
    current=next;lastChange=Date.now();const e=EMOTIONS[next];
    live.setEmotion(next,force);
    character.dataset.motion=e.motion;character.dataset.emotion=next;
    container.querySelector('.mood-label').textContent=e.label;
    container.querySelector('.manager-line').textContent=store.state.quiet?'安静陪伴中':e.line;
  }
  function trigger(name){if(!EMOTIONS[name])return;override=name;until=Date.now()+5000;update(true);}
  const greet=()=>trigger('greeting');character.addEventListener('click',greet);
  const follow=e=>{if(!store.state.motion)return;const r=character.getBoundingClientRect();character.style.setProperty('--look-x',`${Math.max(-5,Math.min(5,(e.clientX-r.left-r.width/2)/25))}deg`);};
  const leave=()=>character.style.setProperty('--look-x','0deg');character.addEventListener('pointermove',follow);character.addEventListener('pointerleave',leave);
  const off=store.subscribe(()=>update());const tick=setInterval(()=>{if(!document.hidden)update();},1500);update(true);
  return {trigger,dispose(){off();live.dispose();clearInterval(tick);character.removeEventListener('click',greet);character.removeEventListener('pointermove',follow);character.removeEventListener('pointerleave',leave);container.replaceChildren();}};
}
