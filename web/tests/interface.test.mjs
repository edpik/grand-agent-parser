import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { convert } from '../src/converter.js';

test('DOM integration: demo → preview → filters → CSV download; failed GSF and filenames render as text', async () => {
  const window = new Window({ url:'https://converter.test/', settings:{ disableJavaScriptEvaluation:true,
    disableJavaScriptFileLoading:true, disableCSSFileLoading:true } });
  window.document.write(await readFile(new URL('../src/index.html', import.meta.url), 'utf8'));
  const document = window.document, nativeTimeout = globalThis.setTimeout;
  const saved = Object.fromEntries(['window','document','Option','Worker','fetch','requestAnimationFrame','setTimeout'].map(k=>[k,globalThis[k]]));
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  const blobs = new Map(), downloads = [], requests = [];
  const example = await readFile(new URL('../../examples/synthetic_estimate.gsfx', import.meta.url));
  globalThis.window = window; globalThis.document = document;
  globalThis.Option = function(text,value) { const option=document.createElement('option');option.textContent=text;option.value=value;return option; };
  globalThis.setTimeout = (...args) => { const timer=nativeTimeout(...args);if(args[1]>1000)timer.unref();return timer; };
  globalThis.requestAnimationFrame = fn => nativeTimeout(fn,0);
  globalThis.fetch = async url => {
    requests.push(String(url));assert.equal(url,'./examples/synthetic_estimate.gsfx');return new Response(example);
  };
  globalThis.Worker = class {
    postMessage(data) { convert(new Uint8Array(data.buffer),data.name).then(result=>this.onmessage?.({data:{id:data.id,result}}),error=>this.onmessage?.({data:{id:data.id,error:{code:error.code,message:error.message}}})); }
    terminate() {}
  };
  URL.createObjectURL = blob => { const url=`blob:test-${blobs.size}`;blobs.set(url,blob);return url; };
  URL.revokeObjectURL = url => blobs.delete(url);
  window.HTMLAnchorElement.prototype.click = function() { if(this.download)downloads.push({name:this.download,blob:blobs.get(this.href)}); };
  const $ = id=>document.getElementById(id);
  const wait = async predicate => {
    for(let i=0;i<150;i++){if(predicate())return;await new Promise(r=>nativeTimeout(r,20));}
    assert.fail('UI did not reach expected state: '+$('status').textContent);
  };
  const inputFiles = value => {Object.defineProperty($('file-input'),'files',{value,configurable:true});$('file-input').dispatchEvent(new window.Event('change'));};
  try {
    await import('../src/app.js');
    assert.equal($('download').disabled,true);
    inputFiles([new File(['x'],'not-supported.csv')]);
    assert.equal($('queue').children.length,0);
    assert.match($('status').textContent,/GSF, GSFX/);
    $('demo').click();
    await wait(()=>$('table-body').children.length===2 && !$('convert').textContent.includes('Преобразование'));
    assert.match($('table-body').textContent,/2\.500000/);
    assert.equal($('download').disabled,false);
    $('dataset').value='fields';$('dataset').dispatchEvent(new window.Event('change'));
    assert.equal($('table-head').firstElementChild.children.length,6);
    assert.match($('table-body').textContent,/XML|Chapters|Document/);
    $('dataset').value='positions';$('dataset').dispatchEvent(new window.Event('change'));
    $('search').value='нет-такого-значения';$('search').dispatchEvent(new window.Event('input'));
    $('download').click();
    await new Promise(r=>nativeTimeout(r,20));
    assert.equal(downloads.length,0,'Immediate download must apply the current search, not stale rows');
    assert.equal($('download').disabled,true);
    $('search').value='';$('search').dispatchEvent(new window.Event('input'));
    await wait(()=>$('download').disabled===false);
    $('download').click();
    await wait(()=>downloads.length===1);
    const bytes = new Uint8Array(await downloads[0].blob.arrayBuffer());
    assert.deepEqual([...bytes.slice(0,3)],[239,187,191]);
    const csv=await downloads[0].blob.text();
    assert.match(csv,/2\.500000/);assert.match(csv,/TEST-001/);
    assert.ok(downloads[0].name.endsWith('.csv'));
    inputFiles([new File([new Uint8Array([71,83,72,3,0])],'binary.gsf')]);
    $('convert').click();
    await wait(()=>$('queue').textContent.includes('двоичные данные'));
    assert.match($('queue').textContent,/Repair/);
    assert.equal($('download').disabled,false,'A failed new file must not remove the successful previous result');
    $('clear').click();
    assert.equal($('queue').children.length,0);assert.equal($('download').disabled,true);
    inputFiles([new File(['binary'],'<img data-xss="1">.gsfx')]);
    assert.equal(document.querySelector('[data-xss]'),null);
    assert.ok($('queue').textContent.includes('<img data-xss="1">.gsfx'));
    assert.deepEqual(requests,['./examples/synthetic_estimate.gsfx'],'Local uploads must not generate network requests');
  } finally {
    for(const [key,value] of Object.entries(saved))globalThis[key]=value;
    URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;
    await window.happyDOM.abort();
  }
});
