import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';

/**
 * 画像の受け入れ判定。
 *
 * ⚠️ **拡張子とクライアント申告の Content-Type を信用しない。**
 * 実データの先頭バイト（マジックナンバー）で種別を決める。
 * 拡張子だけで判定すると、`.png` という名前の HTML や実行ファイルを
 * そのまま保存してしまう。
 *
 * ここは純粋関数で、ファイルシステムもネットワークも触らない。
 * 実際の保存は `StoragePort` の実装が行う。
 */

/** 受け入れる画像形式。SVG は含めない。 */
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

/**
 * SVG を受け入れない理由。
 *
 * SVG は XML であり、`<script>` や外部参照を含められる。
 * 同一オリジンで配信すると保存型 XSS になる。
 * 「画像」として扱えるからといって安全ではない。
 */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_MIN_BYTES = 64;

/** マジックナンバーによる形式判定。 */
interface Signature {
  readonly type: AllowedImageType;
  readonly matches: (bytes: Uint8Array) => boolean;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) {
    return false;
  }
  return prefix.every((value, index) => bytes[offset + index] === value);
}

const SIGNATURES: readonly Signature[] = [
  {
    // JPEG: FF D8 FF
    type: 'image/jpeg',
    matches: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  },
  {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    type: 'image/png',
    matches: (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    // WebP: "RIFF" ....(4バイト長) "WEBP"
    type: 'image/webp',
    matches: (bytes) =>
      startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8),
  },
];

export interface ImageInspection {
  readonly contentType: AllowedImageType;
  readonly byteSize: number;
}

export interface InspectImageInput {
  readonly bytes: Uint8Array;
  /** クライアントが申告した Content-Type。**判定には使わず、照合のみ**に使う。 */
  readonly declaredContentType?: string | undefined;
}

/**
 * 画像を検査する。
 *
 * 判定順序に意味がある。サイズを先に見るのは、
 * 巨大なデータの中身を走査する前に落とすため。
 */
export function inspectImage(input: InspectImageInput): Result<ImageInspection, DomainError> {
  const { bytes, declaredContentType } = input;

  if (bytes.length < IMAGE_MIN_BYTES) {
    return err(domainError('IMAGE_INVALID', 'file is too small to be a valid image'));
  }
  if (bytes.length > IMAGE_MAX_BYTES) {
    return err(domainError('IMAGE_TOO_LARGE', 'file exceeds the maximum allowed size'));
  }

  const signature = SIGNATURES.find((candidate) => candidate.matches(bytes));
  if (signature === undefined) {
    // SVG・HTML・実行ファイルなどはすべてここで落ちる。
    return err(domainError('IMAGE_UNSUPPORTED_TYPE', 'file content is not a supported image'));
  }

  // 申告と実体が食い違うのは、拡張子偽装か単なる誤りのどちらか。
  // どちらにせよ受け入れない。
  if (declaredContentType !== undefined && declaredContentType !== signature.type) {
    return err(
      domainError('IMAGE_UNSUPPORTED_TYPE', 'declared content type does not match file content'),
    );
  }

  return ok({ contentType: signature.type, byteSize: bytes.length });
}

/** 保存キーの拡張子。**利用者のファイル名は使わない。** */
export function extensionFor(contentType: AllowedImageType): string {
  switch (contentType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
  }
}
