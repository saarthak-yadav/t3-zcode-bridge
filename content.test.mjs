import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { convertPrompt, LIMITS } from './content.mjs';

test('image-only and mixed prompts preserve image bytes in native protocol fields', async () => {
 const data=Buffer.from('image fixture').toString('base64');
 const input=await convertPrompt([{type:'text',text:'Describe it'},{type:'image',mimeType:'image/png',data}]);
 assert.equal(input.content,'Describe it');
 assert.deepEqual(input.attachments,[{kind:'image',filename:'image-1.png',mimeType:'image/png',dataBase64:data,sizeBytes:13}]);
 assert.equal((await convertPrompt([{type:'image',mimeType:'image/png',data}])).content,'');
});
test('embedded text uses supplied content; PDF blobs retain binary bytes', async () => {
 const pdf=Buffer.from('%PDF-1.4 fixture').toString('base64');
 const input=await convertPrompt([{type:'resource',resource:{uri:'file:///does/not/exist.txt',text:'SUPPLIED_CONTEXT'}},{type:'resource',resource:{uri:'file:///report.pdf',mimeType:'application/pdf',blob:pdf}}]);
 assert.equal(input.attachments[0].textContent,'SUPPLIED_CONTEXT');
 assert.equal(input.attachments[1].kind,'pdf');assert.equal(input.attachments[1].dataBase64,pdf);
});
test('local file links preserve path and remote links do not fetch', async () => {
 const dir=await mkdtemp(join(tmpdir(),'zcode-content-'));
 try {
  const path=join(dir,'data.txt');await writeFile(path,'local');
  const input=await convertPrompt([{type:'resource_link',uri:pathToFileURL(path).href,name:'data.txt',mimeType:'text/plain'},{type:'resource_link',uri:'https://example.invalid/file',name:'remote'}]);
  assert.equal(input.attachments[0].localPath,path);assert.equal(input.attachments[0].sizeBytes,5);
  assert.match(input.content,/https:\/\/example.invalid\/file/);
  await assert.rejects(convertPrompt([{type:'resource_link',uri:pathToFileURL(dir).href}]),/regular file/);
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('binary resources stage exact bytes privately and survive conversion', async () => {
 const root=await mkdtemp(join(tmpdir(),'zcode-content-')), stagingDir=join(root,'uploads');
 try {
  const bytes=Buffer.from([0,255,1,128]);
  const input=await convertPrompt([{type:'resource',resource:{uri:'custom:///archive.bin',blob:bytes.toString('base64')}}],{stagingDir});
  assert.deepEqual(await readFile(input.attachments[0].localPath),bytes);
  assert.equal((await stat(input.attachments[0].localPath)).mode & 0o777,0o600);
  assert.equal((await stat(stagingDir)).mode & 0o777,0o700);
  await assert.rejects(convertPrompt([{type:'resource',resource:{uri:'custom:///second.bin',blob:bytes.toString('base64')}},{type:'audio',data:'AAAA',mimeType:'audio/wav'}],{stagingDir}),/Audio/);
  assert.equal((await readdir(stagingDir)).length,1);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('bad base64, unsupported media, size limits and empty prompts fail explicitly', async () => {
 for(const data of ['%%%','a','YQ=','']) await assert.rejects(convertPrompt([{type:'image',mimeType:'image/png',data}]),/attachment/);
 await assert.rejects(convertPrompt([{type:'image',mimeType:'text/plain',data:'YQ=='}]),/image MIME/);
 await assert.rejects(convertPrompt([{type:'image',mimeType:'image/svg+xml',data:'YQ=='}]),/Unsupported image/);
 await assert.rejects(convertPrompt([{type:'image',mimeType:'image/png',data:Buffer.alloc(LIMITS.image+1).toString('base64')}]),/oversized/);
 await assert.rejects(convertPrompt([]),/requires/);
 await assert.rejects(convertPrompt([{type:'resource',resource:{uri:'relative.txt',text:'x'}}]),/absolute/);
 await assert.rejects(convertPrompt([{type:'resource',resource:{uri:'custom:///x',text:'x',blob:'eA=='}}]),/not both/);
});
