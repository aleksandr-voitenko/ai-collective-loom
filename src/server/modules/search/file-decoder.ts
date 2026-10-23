import { fileTextLimits, supportedTextFormat } from '../../../contracts/file-text.js';

export type DecodedFile = {
  state: 'complete' | 'partial' | 'unsupported';
  reason: string | null;
  text: string;
};
export function decodeFileText(bytes: Uint8Array, path: string, mediaType: string): DecodedFile {
  const unsupported = (reason: string): DecodedFile => ({ state: 'unsupported', reason, text: '' });
  if (!supportedTextFormat(path, mediaType)) return unsupported('format');
  let text: string;
  try {
    // Validate the entire admitted input, including the unretained suffix. Preserve
    // BOM and CR/LF exactly; replacement decoding would misrepresent extraction.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return unsupported('invalid_utf8');
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text))
    return unsupported('binary_controls');
  if (bytes.length <= fileTextLimits.outputBytes) return { state: 'complete', reason: null, text };
  let end = fileTextLimits.outputBytes;
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return {
    state: 'partial',
    reason: 'output_limit',
    text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end)),
  };
}
