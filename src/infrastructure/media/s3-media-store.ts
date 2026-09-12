import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AppError } from '../../common/errors.js';
import type { MediaStore } from '../../domain/ports.js';

export interface S3MediaStoreOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3MediaStore implements MediaStore {
  private readonly client: S3Client;

  public constructor(private readonly options: S3MediaStoreOptions) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey
      },
      forcePathStyle: true
    });
  }

  public async put(key: string, data: Uint8Array, contentType?: string): Promise<string> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
      Body: data,
      ContentType: contentType
    }));
    return key;
  }

  public async get(key: string): Promise<Uint8Array> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
    const body = response.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (!body?.transformToByteArray) {
      throw new AppError('MEDIA_NOT_FOUND', `Stored media '${key}' is unavailable.`, 404);
    }
    return body.transformToByteArray();
  }
}
