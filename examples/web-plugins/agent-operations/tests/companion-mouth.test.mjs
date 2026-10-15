import test from 'node:test';
import assert from 'node:assert/strict';
import {mouthOpenFor} from '../src/companion-pose.js';

test('mouth reactions remain bounded, continuous and settle after the gesture',()=>{
  for(const emotion of ['greeting','encourage','surprised']){
    let previous=0,peak=0;
    for(let t=0;t<=5000;t++){
      const value=mouthOpenFor(emotion,t);
      assert.ok(value>=0&&value<=1,`${emotion} leaves authored range`);
      assert.ok(Math.abs(value-previous)<.01,`${emotion} jumps at ${t}ms`);
      previous=value;peak=Math.max(peak,value);
      if(t>=1800)assert.equal(value,0,'A completed reaction must close the mouth');
    }
    assert.ok(peak>.3,'Reaction should visibly open the mouth');
  }
});

test('quiet states and invalid clocks do not create speech; reduced motion is static',()=>{
  for(const t of [-1,0,250,1000,5000,NaN,Infinity]){
    for(const emotion of ['idle','thinking','focused','sleepy','unknown'])assert.equal(mouthOpenFor(emotion,t),0);
    for(const emotion of ['greeting','encourage'])assert.equal(mouthOpenFor(emotion,t,false),0);
    assert.equal(mouthOpenFor('surprised',t,false),.35);
  }
  for(const t of [-1,NaN,Infinity])assert.equal(mouthOpenFor('greeting',t),0);
});
