import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeFileText} from '../../src/server/modules/search/file-decoder.js';
import {supportedTextFormat,textFormats,fileTextLimits} from '../../src/contracts/file-text.js';
import {FileTokens} from '../../src/server/modules/search/file-tokens.js';

test('literal text policy is an explicit MIME/extension pairing, including active text as inert bytes',()=>{
  for(const [ext,types] of Object.entries(textFormats)){
    for(const type of ['text/plain','application/octet-stream',...types])assert.equal(supportedTextFormat('nested/FILE.'+ext.toUpperCase(),type),true);
    assert.equal(supportedTextFormat('x.'+ext,'text/html'),false);
  }
  for(const ext of ['html','svg','pdf','zip','ipynb','docx','exe','unknown'])assert.equal(decodeFileText(Buffer.from('text'),'x.'+ext,'text/plain').state,'unsupported');
  for(const path of ['txt','md','json','.txt','chapter.txt.zip','x.constructor','x.__proto__'])assert.equal(decodeFileText(Buffer.from('text'),path,'text/plain').state,'unsupported');
  const hostile='<script>fetch("https://invalid.test")</script>\n@nickname $(touch /tmp/never)';
  assert.deepEqual(decodeFileText(Buffer.from(hostile),'x.txt','text/plain'),{state:'complete',reason:null,text:hostile});
});
test('strict full-input UTF-8 preserves BOM, CRLF, tabs, Unicode and empty text, rejecting binary controls and invalid suffixes',()=>{
  for(const text of ['', '\ufeffcafé\r\n雪\t🙂\rline\n'])assert.deepEqual(decodeFileText(Buffer.from(text),'x.md','text/markdown'),{state:'complete',reason:null,text});
  for(const byte of [0,1,7,11,12,14,31,127])assert.equal(decodeFileText(Buffer.from([65,byte]),'x.txt','text/plain').reason,'binary_controls');
  for(const bytes of [[0xc0,0xaf],[0xed,0xa0,0x80],[0xf4,0x90,0x80,0x80],[0xe2,0x82]])assert.equal(decodeFileText(Buffer.from(bytes),'x.txt','text/plain').reason,'invalid_utf8');
  assert.equal(decodeFileText(Buffer.concat([Buffer.alloc(65536,65),Buffer.from([0xff])]),'x.txt','text/plain').reason,'invalid_utf8');
});
test('retained prefixes cut only at valid multibyte boundaries and disclose the unprocessed suffix',()=>{
  for(const char of ['é','雪','🙂'])for(let edge=1;edge<Buffer.byteLength(char);edge++){
    const input='x'.repeat(fileTextLimits.outputBytes-edge)+char+' suffixonly';
    const result=decodeFileText(Buffer.from(input),'x.py','text/plain');
    assert.equal(result.state,'partial');assert.equal(result.reason,'output_limit');
    assert.equal(result.text,'x'.repeat(fileTextLimits.outputBytes-edge));assert.ok(!result.text.includes('�'));
  }
  assert.equal(decodeFileText(Buffer.alloc(65536,65),'x.txt','text/plain').state,'complete');
});
test('file cursors reject other owners, generations, modes, expiry, tampering and process-local custody',()=>{
  const tokens=new FileTokens(),value=tokens.encode('owner/mode','generation',1,Date.now()+1000);
  assert.equal(tokens.decode(value,'owner/mode','generation',2).offset,1);
  for(const [v,b,g,m] of [[value,'other','generation',2],[value,'owner/mode','other',2],[value,'owner/mode','generation',1],['broken','owner/mode','generation',2],['x'.repeat(2049),'owner/mode','generation',2],[tokens.encode('a','b',0,0),'a','b',2]] as const)assert.throws(()=>tokens.decode(v,b,g,m));
  assert.throws(()=>new FileTokens().decode(value,'owner/mode','generation',2));
});
