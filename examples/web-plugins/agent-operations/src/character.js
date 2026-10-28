// Plugin-only character copy. No novel text, plot, or private background is distributed.
export const CHARACTER = Object.freeze({
  name:'维瑟兰', role:'产品经理',
  intro:'习惯先听完，再把复杂的事情逐项理清。说话简洁，有自己的判断；遇到分歧会说明理由，也愿意修正。熟悉以后，偶尔会用一句轻巧的玩笑让气氛松下来。',
  likes:['目标说清楚，过程留余地','认真听完彼此的意见','整齐但不死板的工作台','完成工作后的安静片刻'],
  dislikes:['反复变更却不解释缘由','把忙碌当作成果','催促代替沟通','忽略同伴的负荷'],
});
export const OUTFITS = [
  {id:'director',name:'日常正装',subtitle:'DAILY DIRECTOR',color:'#bcaad4',scene:'brief',file:'director.png',description:'黑色正装与浅紫内衬。整理目标，也为每一个决定留下理由。'},
  {id:'field',name:'外勤指挥',subtitle:'FIELD COORDINATOR',color:'#b7c7ad',scene:'build',file:'field.png',description:'轻便外勤装。确认路线，将任务交给合适的同伴。'},
  {id:'archive',name:'档案室',subtitle:'QUIET ARCHIVE',color:'#c9b79f',scene:'review',file:'archive.png',description:'卷起袖口，把记录翻到尚未解决的那一页。'},
  {id:'rain',name:'雨夜通勤',subtitle:'AFTER THE RAIN',color:'#91bdd4',scene:'brief',file:'rain.png',description:'合上终端，沿着灯光回去。明天的事情，明天继续。'},
  {id:'lounge',name:'休息室',subtitle:'OFF THE CLOCK',color:'#dfc3b6',scene:'lounge',file:'lounge.png',description:'柔软针织与热饮。允许片刻无事发生。'},
];
