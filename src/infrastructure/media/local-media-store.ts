import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { AppError } from '../../common/errors.js';
import type { MediaStore } from '../../domain/ports.js';

export class LocalMediaStore implements MediaStore {
  private readonly root: string;

  public constructor(directory: string) {
    this.root = resolve(directory);
  }

  public async put(key: string, data: Uint8Array): Promise<string> {
    const target = this.resolveKey(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    return key;
  }

  public async get(key: string): Promise<Uint8Array> {
    try {
      return await readFile(this.resolveKey(key));
    } catch (error) {
      throw new AppError('MEDIA_NOT_FOUND', `Stored media '${key}' is unavailable.`, 404, {
        cause: error instanceof Error ? error.message : 'Unknown media read error.'
      });
    }
  }

  private resolveKey(key: string): string {
    if (!key || key.includes('..') || key.startsWith('/') || key.startsWith('\\')) {
      throw new AppError('INVALID_MEDIA_KEY', 'Invalid media storage key.', 400);
    }
    const target = resolve(this.root, ...key.split('/'));
    if (!target.startsWith(`${this.root}${sep}`) && target !== this.root) {
      throw new AppError('INVALID_MEDIA_KEY', 'Invalid media storage key.', 400);
    }
    return target;
  }
}
