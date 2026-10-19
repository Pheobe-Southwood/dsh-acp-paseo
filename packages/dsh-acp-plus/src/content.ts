/**
 * Content conversion between ACP prompt blocks and DSH message blocks.
 * @module dsh-acp-plus/content
 */
import { jsonSafe } from './dsh-types.js';

export const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

export class ContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentError';
  }
}

export interface ImageAdmission {
  saveImages(inputs: ReadonlyArray<{ data: Uint8Array; mediaType: string; name?: string }>): Promise<readonly any[]>;
  imageLimits?: { mediaTypes?: readonly string[] } | undefined;
}

export function isCanonicalBase64(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}

/** DSH text/reasoning block list to plain text (used for replay and tool output). */
export function blocksToText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const value = block as Record<string, unknown>;
    if ((value.type === 'text' || value.type === 'reasoning') && typeof value.text === 'string') {
      parts.push(value.text);
    } else if (value.type === 'image') {
      parts.push('[image]');
    }
  }
  return parts.join('');
}

export interface AcpContentBlock {
  type: string;
  [key: string]: unknown;
}

/**
 * Convert an ACP prompt into DSH message content, admitting images through the
 * attachment service. Throws {@link ContentError} for anything unsupported.
 */
export async function promptToDshContent(
  blocks: readonly AcpContentBlock[],
  attachments: ImageAdmission | undefined,
  imageEnabled: boolean,
): Promise<{ content: any[]; hasImages: boolean }> {
  const content: any[] = [];
  const images: Array<{ data: Uint8Array; mediaType: string }> = [];
  const placeholders: Array<{ index: number; part: any }> = [];

  for (const block of blocks) {
    if (!block || typeof block !== 'object') throw new ContentError('invalid prompt content block');
    switch (block.type) {
      case 'text': {
        const text = typeof block.text === 'string' ? block.text : '';
        if (text.length > 0) content.push({ type: 'text', text });
        break;
      }
      case 'image': {
        if (!imageEnabled || !attachments) {
          throw new ContentError('image prompts are not supported by this deployment');
        }
        const mimeType = String(block.mimeType ?? '');
        if (!IMAGE_MEDIA_TYPES.has(mimeType)) {
          throw new ContentError(`unsupported image media type: ${mimeType}`);
        }
        const data = String(block.data ?? '');
        if (!isCanonicalBase64(data)) throw new ContentError('image data must be canonical base64');
        const part: any = { type: 'image', pending: images.length };
        images.push({ data: Buffer.from(data, 'base64'), mediaType: mimeType });
        placeholders.push({ index: images.length - 1, part });
        content.push(part);
        break;
      }
      case 'resource_link': {
        const name = JSON.stringify(block.name ?? null);
        const uri = JSON.stringify(block.uri ?? null);
        content.push({ type: 'text', text: `\n[resource_link name=${name} uri=${uri}]\n` });
        break;
      }
      default:
        throw new ContentError(`unsupported prompt content block: ${block.type}`);
    }
  }

  if (images.length > 0) {
    const refs = await attachments!.saveImages(images.map((image) => ({ data: image.data, mediaType: image.mediaType })));
    if (refs.length !== images.length) throw new ContentError('attachment service returned an unexpected image count');
    for (const placeholder of placeholders) {
      const ref = refs[placeholder.index];
      delete placeholder.part.pending;
      placeholder.part.attachment = ref;
    }
  }

  const hasText = content.some((part) => part.type === 'text' && String(part.text).trim().length > 0);
  const hasImage = content.some((part) => part.type === 'image');
  if (!hasText && !hasImage) throw new ContentError('prompt must contain non-empty text or an image');
  return { content, hasImages: hasImage };
}

export interface AcpChunk {
  sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' | 'user_message_chunk';
  content: Record<string, unknown>;
  messageId?: string;
}

/** DSH message blocks to ACP content chunks. Tool-call blocks are skipped. */
export function blocksToChunks(blocks: unknown, role: 'assistant' | 'user', messageId?: string): AcpChunk[] {
  if (!Array.isArray(blocks)) return [];
  const chunks: AcpChunk[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const value = block as Record<string, unknown>;
    if (value.type === 'text' && typeof value.text === 'string' && value.text.length > 0) {
      chunks.push({
        sessionUpdate: role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
        content: { type: 'text', text: value.text },
        ...(messageId ? { messageId } : {}),
      });
      continue;
    }
    if (value.type === 'reasoning' && typeof value.text === 'string' && value.text.length > 0) {
      chunks.push({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: value.text },
        ...(messageId ? { messageId } : {}),
      });
      continue;
    }
    if (value.type === 'image') {
      chunks.push({
        sessionUpdate: role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
        content: { type: 'text', text: '[image]' },
        ...(messageId ? { messageId } : {}),
      });
    }
  }
  return chunks;
}

/** JSON-safe image/attachment summary for `_meta` (never inline bytes). */
export function summarizeAttachment(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value ?? null;
  const record = value as Record<string, unknown>;
  const { data: _data, ...rest } = record;
  return jsonSafe(rest);
}
