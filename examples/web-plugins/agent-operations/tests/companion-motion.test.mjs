import test from 'node:test';
import assert from 'node:assert/strict';
import {blinkOpenAt,advanceHeadSpring} from '../src/companion-motion.js';

test('blink and wink close and reopen continuously within the authored range',()=>{
  for(const hold of [24,250]){
    let previous=1;
    for(let ms=-1;ms<=1000;ms++){
      const value=blinkOpenAt(ms,hold);
      assert.ok(value>=0&&value<=1);
      assert.ok(Math.abs(value-previous)<.025,`discontinuity at ${ms}ms`);
      previous=value;
    }
    assert.equal(blinkOpenAt(70,hold),0);
    assert.equal(blinkOpenAt(70+hold/2,hold),0);
    assert.equal(blinkOpenAt(215+hold,hold),1);
  }
  for(const time of [NaN,Infinity,-100])assert.equal(blinkOpenAt(time),1);
});

test('head response is stable across frame rates and returns to neutral after release',()=>{
  const samples=[];
  for(const fps of [30,60,120]){
    const state={x:0,v:0};let peak=0;
    for(let frame=0;frame<fps*4;frame++){
      const result=advanceHeadSpring(state,frame<fps*2?24:0,1/fps);
      assert.ok(Number.isFinite(result)&&Math.abs(result)<=30);
      peak=Math.max(peak,result);
      if(frame===fps/2-1)samples.push(result);
    }
    assert.ok(peak>=23&&peak<27);
    assert.ok(Math.abs(state.x)<.002,'must settle after pointer release');
  }
  assert.ok(Math.max(...samples)-Math.min(...samples)<.03,'frame rate must not change the gesture');
});

test('reduced motion snaps to a static pose and clears residual velocity',()=>{
  const state={x:15,v:100};
  assert.equal(advanceHeadSpring(state,-10,.05,false),-10);
  assert.equal(state.v,0);
  advanceHeadSpring(state,NaN,Infinity);
  assert.ok(Number.isFinite(state.x)&&Number.isFinite(state.v));
});
