/**
 * The files in a model step's input: found by their declared file type, checked against their hash, and read the way a
 * model reads them. A PDF or an image goes to the model as itself; a text file goes as its text. Any other file stops
 * the step, because a model that gets only a file's path answers as if it had read the file.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { containedFile, hash } from './io.js';
import { fail, shape } from './semantics.js';

// The media type comes from the file's first bytes, not its name.
const signatures = [
  ['application/pdf', bytes => bytes.subarray(0, 5).toString('latin1') === '%PDF-'],
  ['image/png', bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  ['image/gif', bytes => /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))],
  ['image/webp', bytes => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP'],
];
function asText(bytes) {
  if (bytes.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

/** Each file value in the step's input. types are the declared types of the step's in and each names. */
export async function modelFiles(input, types, artifacts) {
  const files = [];
  async function visit(definition, value, at) {
    const def = shape(definition);
    if (value == null) return;
    if (def.type === 'file') {
      const absolute = await containedFile(artifacts, value.path);
      const bytes = await readFile(absolute);
      if (hash(bytes) !== value.sha256) fail('setup', 'File hash mismatch', 'file_mismatch');
      const media = signatures.find(([, matches]) => matches(bytes))?.[0];
      const text = media ? null : asText(bytes);
      if (!media && text === null) fail('method_code', `${at} (${value.path}) is a file that a model cannot read: it is not a PDF, an image, or text.`, 'unreadable_file',
        { fix: 'Add a run step before this step that turns the file into text or a PDF, and give that to this step.' });
      files.push({ at, path: value.path, name: basename(value.path), absolute, sha256: value.sha256, media: media ?? 'text/plain',
        ...(media ? { data: bytes.toString('base64') } : { text }) });
    } else if (def.type === 'record') {
      for (const [name, child] of Object.entries(def.fields ?? {})) await visit(child, value[name], `${at}.${name}`);
    } else if (def.type === 'list') {
      const item = def.fields ? { type: 'record', fields: def.fields } : def.items;
      for (const [index, child] of value.entries()) await visit(item, child, `${at}.${index}`);
    }
  }
  for (const [name, def] of Object.entries(types ?? {})) await visit(def, input[name], name);
  return files;
}

/** For Claude Code and Codex, which open files themselves: where each file is, so the input's relative paths resolve. */
export function fileList(files) {
  return files.length ? ['Files in the step inputs. Read each one before you answer:', ...files.map(file => `- ${file.at}: ${file.absolute} (${file.media})`)].join('\n') : null;
}
