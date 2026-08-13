import { describe, expect, it } from 'vitest';
import { ALLOWED_IMAGE_TYPES, IMAGE_MAX_BYTES, extensionFor, inspectImage } from '../src/index';

/** 指定の先頭バイトを持つ、十分な長さのダミーデータを作る。 */
function withSignature(prefix: readonly number[], size = 1024): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(prefix, 0);
  return bytes;
}

const JPEG = withSignature([0xff, 0xd8, 0xff]);
const PNG = withSignature([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = (() => {
  const bytes = new Uint8Array(1024);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  return bytes;
})();

describe('inspectImage（拡張子ではなく中身で判定する）', () => {
  it('JPEG を受け付ける', () => {
    const result = inspectImage({ bytes: JPEG });
    if (!result.ok) throw new Error('expected success');
    expect(result.value.contentType).toBe('image/jpeg');
  });

  it('PNG を受け付ける', () => {
    const result = inspectImage({ bytes: PNG });
    if (!result.ok) throw new Error('expected success');
    expect(result.value.contentType).toBe('image/png');
  });

  it('WebP を受け付ける', () => {
    const result = inspectImage({ bytes: WEBP });
    if (!result.ok) throw new Error('expected success');
    expect(result.value.contentType).toBe('image/webp');
  });

  it('SVG を拒否する', () => {
    // SVG は XML で、script や外部参照を含められる。同一オリジン配信で
    // 保存型 XSS になるため「画像」として扱わない。
    const svg = new TextEncoder().encode(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'.padEnd(
        200,
        ' ',
      ),
    );
    const result = inspectImage({ bytes: svg });
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('IMAGE_UNSUPPORTED_TYPE');
  });

  it('HTML を拒否する', () => {
    const html = new TextEncoder().encode('<html><body>hello</body></html>'.padEnd(200, ' '));
    expect(inspectImage({ bytes: html }).ok).toBe(false);
  });

  it('ELF 実行ファイルを拒否する', () => {
    const elf = withSignature([0x7f, 0x45, 0x4c, 0x46]);
    expect(inspectImage({ bytes: elf }).ok).toBe(false);
  });

  it('Windows 実行ファイルを拒否する', () => {
    const exe = withSignature([0x4d, 0x5a]);
    expect(inspectImage({ bytes: exe }).ok).toBe(false);
  });

  it('GIF を拒否する（許可形式に含めていない）', () => {
    const gif = withSignature([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(inspectImage({ bytes: gif }).ok).toBe(false);
  });

  it('拡張子を偽装したファイルを拒否する', () => {
    // .png と申告された HTML。申告と実体が食い違えば受け入れない。
    const html = new TextEncoder().encode('<html></html>'.padEnd(200, ' '));
    const result = inspectImage({ bytes: html, declaredContentType: 'image/png' });
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('IMAGE_UNSUPPORTED_TYPE');
  });

  it('申告と実体が食い違う画像同士も拒否する', () => {
    const result = inspectImage({ bytes: JPEG, declaredContentType: 'image/png' });
    expect(result.ok).toBe(false);
  });

  it('申告が正しければ受け付ける', () => {
    expect(inspectImage({ bytes: PNG, declaredContentType: 'image/png' }).ok).toBe(true);
  });

  it('サイズ上限を超えるファイルを拒否する', () => {
    const huge = withSignature([0xff, 0xd8, 0xff], IMAGE_MAX_BYTES + 1);
    const result = inspectImage({ bytes: huge });
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('IMAGE_TOO_LARGE');
  });

  it('上限ちょうどは受け付ける（境界）', () => {
    const exact = withSignature([0xff, 0xd8, 0xff], IMAGE_MAX_BYTES);
    expect(inspectImage({ bytes: exact }).ok).toBe(true);
  });

  it('空・極小のファイルを拒否する', () => {
    expect(inspectImage({ bytes: new Uint8Array(0) }).ok).toBe(false);
    expect(inspectImage({ bytes: withSignature([0xff, 0xd8, 0xff], 10) }).ok).toBe(false);
  });

  it('署名が途中にあるだけのファイルを拒否する（先頭で判定する）', () => {
    const bytes = new Uint8Array(1024);
    bytes.set([0xff, 0xd8, 0xff], 100);
    expect(inspectImage({ bytes }).ok).toBe(false);
  });
});

describe('extensionFor', () => {
  it('すべての許可形式に拡張子がある', () => {
    for (const type of ALLOWED_IMAGE_TYPES) {
      expect(extensionFor(type)).toMatch(/^[a-z]+$/);
    }
  });

  it('SVG は許可形式に含まれない', () => {
    expect(ALLOWED_IMAGE_TYPES).not.toContain('image/svg+xml');
  });
});
