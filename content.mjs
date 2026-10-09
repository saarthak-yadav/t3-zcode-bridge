import { mkdir, writeFile, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const LIMITS = { count: 100, image: 10 * 1024 * 1024, total: 50 * 1024 * 1024 };
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']);
function invalid(message) { const e = new Error(message); e.code = -32602; throw e; }
function mime(value = 'application/octet-stream') {
  const type = value.split(';', 1)[0].trim().toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)) invalid('Invalid attachment MIME type');
  return type;
}
function decode(data, limit) {
  if (typeof data !== 'string' || data.length > Math.ceil(limit / 3) * 4 || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data)) invalid('Invalid or oversized base64 attachment');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) invalid('Invalid base64 attachment');
  if (!bytes.length || bytes.length > limit) invalid('Empty or oversized binary attachment');
  return bytes;
}
function location(uri) {
  let url; try { url = new URL(uri); } catch { invalid('Attachment URI must be absolute'); }
  if (url.protocol === 'file:') {
    try { return fileURLToPath(url); } catch { invalid('Invalid local file URI'); }
  }
  return undefined;
}
function name(uri, fallback) {
  try { return basename(decodeURIComponent(new URL(uri).pathname)) || fallback; } catch { return fallback; }
}
function inferredMime(uri) {
  const ext = name(uri, '').split('.').pop()?.toLowerCase();
  return ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',bmp:'image/bmp',pdf:'application/pdf',txt:'text/plain',md:'text/markdown',csv:'text/csv',json:'application/json',mp4:'video/mp4',webm:'video/webm'})[ext];
}
function nativeKind(type) { return type.startsWith('image/') ? 'image' : type === 'application/pdf' ? 'pdf' : type.startsWith('video/') ? 'video' : 'file'; }

// Preserve native attachment semantics; never fetch remote resource links.
// Binary resources lacking a native inline representation are saved privately
// so native file tools can read them, including after session resume.
export async function convertPrompt(blocks, { stagingDir } = {}) {
  if (!Array.isArray(blocks) || blocks.length > LIMITS.count) invalid('Too many prompt blocks');
  const text = [], attachments = [], created = [];
  let total = 0;
  const charge = (bytes, type) => {
    if (type.startsWith('image/') && bytes > LIMITS.image) invalid('Images must be at most 10 MiB each');
    total += bytes;
    if (total > LIMITS.total) invalid('Prompt content exceeds 50 MiB');
  };
  const binary = async (data, type, filename) => {
    const bytes = decode(data, type.startsWith('image/') ? LIMITS.image : LIMITS.total);
    charge(bytes.length, type);
    const kind = nativeKind(type);
    if (kind === 'image' && !imageTypes.has(type)) invalid(`Unsupported image format: ${type}`);
    if (kind === 'image' || kind === 'pdf' || kind === 'video') {
      attachments.push({kind, filename, mimeType: type, dataBase64: data, sizeBytes: bytes.length});
    } else {
      if (!stagingDir) invalid('Binary attachment storage is unavailable');
      await mkdir(stagingDir, {recursive: true, mode: 0o700});
      const localPath = join(stagingDir, `${randomUUID()}-${basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0,120) || 'attachment'}`);
      await writeFile(localPath, bytes, {flag: 'wx', mode: 0o600});
      created.push(localPath);
      attachments.push({kind: 'file', filename, mimeType: type, localPath, sizeBytes: bytes.length});
    }
  };
  try {
    for (const block of blocks) {
      if (block.type === 'text') {
        if (typeof block.text !== 'string') invalid('Invalid text block');
        charge(Buffer.byteLength(block.text), 'text/plain'); text.push(block.text);
      } else if (block.type === 'image') {
        const type = mime(block.mimeType);
        if (!type.startsWith('image/')) invalid('Image block requires an image MIME type');
        await binary(block.data, type, name(block.uri, `image-${attachments.length + 1}.${type.split('/')[1]}`));
      } else if (block.type === 'resource') {
        const r = block.resource;
        if (!r || typeof r.uri !== 'string') invalid('Embedded resource requires a URI');
        location(r.uri); // Validate, but use embedded bytes instead of reading the URI.
        const type = mime(r.mimeType || (typeof r.text === 'string' ? 'text/plain' : undefined));
        const filename = name(r.uri, `resource-${attachments.length + 1}`);
        if (typeof r.text === 'string') {
          if (r.blob !== undefined) invalid('Resource must contain text or blob, not both');
          charge(Buffer.byteLength(r.text), type);
          if (r.text) attachments.push({kind: 'file', filename, mimeType: type, textContent: r.text, sizeBytes: Buffer.byteLength(r.text)});
          else text.push(`Empty resource: ${r.uri}`);
        } else await binary(r.blob, type, filename);
      } else if (block.type === 'resource_link') {
        const localPath = location(block.uri);
        const type = mime(block.mimeType || inferredMime(block.uri));
        const filename = block.name || name(block.uri, 'attachment');
        if (localPath) {
          const info = await stat(localPath).catch(() => invalid('Could not access local attachment'));
          if (!info.isFile()) invalid('Local attachment must be a regular file');
          charge(info.size, type);
          if (type.startsWith('image/') && !imageTypes.has(type)) invalid(`Unsupported image format: ${type}`);
          attachments.push({kind: nativeKind(type), filename, mimeType: type, localPath, sizeBytes: info.size});
        } else {
          const ref = `Referenced resource: ${filename} (${type})\n${block.uri}`;
          charge(Buffer.byteLength(ref), 'text/plain'); text.push(ref);
        }
      } else invalid(`Unsupported prompt content type: ${block.type}. Audio transcription is not implemented.`);
    }
    if (!text.some(t => t.trim()) && !attachments.length) invalid('Prompt requires text or attachments');
    return {content: text.join('\n'), ...(attachments.length ? {attachments} : {})};
  } catch (e) {
    await Promise.allSettled(created.map(p => unlink(p))); throw e;
  }
}
