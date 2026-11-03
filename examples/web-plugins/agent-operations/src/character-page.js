import {CHARACTER, OUTFITS} from './character.js';
import {EMOTIONS,mountCompanion} from './companion.js';

export function mountCharacterPage(container,store,asset){
  container.innerHTML=`<div class="character-header"><div><span class="eyebrow">PERSONNEL / PM-01</span><h2>${CHARACTER.name}<small>${CHARACTER.role}</small></h2></div><span class="tiny-label">WARDROBE & INTERACTION</span></div>
  <div class="character-layout"><section class="wardrobe-stage"><img class="outfit-image" alt=""><div class="wardrobe-caption"><small></small><h3></h3><p></p></div><span class="wardrobe-number"></span></section>
  <div class="character-info"><section class="character-card"><span class="eyebrow">PERSONALITY</span><h3>相处的方式</h3><p>${CHARACTER.intro}</p><div class="preferences-pair"><div><h4>喜欢</h4><ul>${CHARACTER.likes.map(x=>`<li>${x}</li>`).join('')}</ul></div><div><h4>不喜欢</h4><ul>${CHARACTER.dislikes.map(x=>`<li>${x}</li>`).join('')}</ul></div></div></section>
  <section class="character-card wardrobe-controls"><div class="section-head"><h3>衣装图鉴</h3><span class="tiny-label">05 LOOKS</span></div><div class="outfit-list">${OUTFITS.map((x,i)=>`<button data-outfit="${x.id}" aria-pressed="false"><span>${String(i+1).padStart(2,'0')}</span><b>${x.name}</b><small>${x.subtitle}</small></button>`).join('')}</div><p class="subtle">选择立绘衣装。互动模型与立绘分别展示。</p></section>
  <section class="character-card interaction-card"><div class="section-head"><h3>一起待一会儿</h3><button data-interaction="quiet">安静陪伴</button></div><div class="character-companion"></div><div class="interaction-actions"><button data-interaction="greeting">打个招呼</button><button data-interaction="thinking">一起想想</button><button data-interaction="encourage">需要鼓励</button><button data-interaction="sleepy">休息一下</button></div><p class="interaction-feedback" role="status"></p></section></div></div>`;
  const q=s=>container.querySelector(s),companion=mountCompanion(q('.character-companion'),store,asset);
  let current='',disposed=false;
  function render(){
    const outfit=OUTFITS.find(x=>x.id===store.state.outfit)||OUTFITS[0];
    if(current!==outfit.id){current=outfit.id;container.style.setProperty('--wardrobe-accent',outfit.color);const img=q('.outfit-image');img.src=asset(`wardrobe/${outfit.file}`);img.alt=`维瑟兰 · ${outfit.name}全身立绘`;q('.wardrobe-caption small').textContent=outfit.subtitle;q('.wardrobe-caption h3').textContent=outfit.name;q('.wardrobe-caption p').textContent=outfit.description;q('.wardrobe-number').textContent=String(OUTFITS.indexOf(outfit)+1).padStart(2,'0');}
    container.querySelectorAll('[data-outfit]').forEach(b=>{const active=b.dataset.outfit===current;b.setAttribute('aria-pressed',String(active));b.classList.toggle('active',active);});
    q('[data-interaction="quiet"]').setAttribute('aria-pressed',String(store.state.quiet));
  }
  function click(e){const b=e.target.closest('button');if(!b||disposed)return;
    if(b.dataset.outfit){store.state.outfit=b.dataset.outfit;store.notify();q('.interaction-feedback').textContent=`正在展示${OUTFITS.find(x=>x.id===b.dataset.outfit).name}。`;}
    const action=b.dataset.interaction;if(action==='quiet'){store.state.quiet=!store.state.quiet;store.notify();q('.interaction-feedback').textContent=store.state.quiet?'已进入安静陪伴。':'已恢复互动回应。';}
    else if(EMOTIONS[action]){companion.trigger(action);q('.interaction-feedback').textContent=EMOTIONS[action].line;}
  }
  container.addEventListener('click',click);const off=store.subscribe(render);render();
  return ()=>{disposed=true;off();companion.dispose();container.removeEventListener('click',click);container.replaceChildren();};
}
