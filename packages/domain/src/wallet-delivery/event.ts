import { isCommonUserId } from '../identity/common-user';
import { domainError, type DomainError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';

/**
 * OVEW Wallet へ送るイベントの組み立て。
 *
 * ⚠️ **ここで作った本文が、そのまま署名対象・保存対象になる。**
 * 送信直前に組み立て直したり、再試行のたびに作り直したりしない。
 * 作り直すと、そのあいだにマスタが変わった場合に
 * **1 回目と 2 回目で別の内容が同じイベントIDで送られる**。
 *
 * ⚠️ **個人情報を入れない。**
 * 入れてよいのは `common_user_id` まで。氏名・メール・住所・購入金額は
 * 一切載せない。イベントは相手のログ・再送記録・障害調査を経由する。
 */

/** 送るイベントの種別。DB の CHECK 制約と同じ 2 つ。 */
export const WALLET_DELIVERY_EVENT_TYPES = ['entitlement.granted', 'entitlement.revoked'] as const;
export type WalletDeliveryEventType = (typeof WALLET_DELIVERY_EVENT_TYPES)[number];

/**
 * 契約の固定値（PR-NW04 §12）。
 *
 * ⚠️ 旧 `sengoku-market` を新規送信で使わない。相手は宛先の判定に使う。
 */
export const SOURCE_SYSTEM_KEY = 'sennokuni-nft-market';
export const TARGET_SITE_KEY = 'ovew-wallet';

/**
 * イベント構造のバージョン。
 *
 * ⚠️ **ヘッダ `X-Event-Version` と本文 `event_version` は必ず同じ値**（§14）。
 * 片方だけ上げると、相手はヘッダで分岐して本文を読み違える。
 * 同じ定数から両方を組み立て、食い違いを作れないようにする。
 */
export const WALLET_EVENT_VERSION = '1.0';

/** Blockchain 未発行であることの明示。オフチェーン先行の MVP では常にこれ。 */
export const BLOCKCHAIN_STATUS_NOT_MINTED = 'NOT_MINTED';

/** 受取物の種別。現状はデジタル収蔵品のみ。 */
export const ENTITLEMENT_TYPE_DIGITAL_COLLECTIBLE = 'DIGITAL_COLLECTIBLE';

/** 内容ハッシュの形式（`sha256:` + 64桁hex）。DB の CHECK 制約と同じ規則。 */
const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isContentHash(value: string): boolean {
  return CONTENT_HASH_PATTERN.test(value);
}

/**
 * シリアル番号の表記（PR-NW04 §5）。
 *
 * DB は整数のまま持ち、**送信時だけ**文字列にする。
 * 「最低 4 桁」であって固定 4 桁ではない。10000 は切り詰めずに 10000 と送る。
 *
 * ⚠️ **あとから規則を変えない。**
 * 既に Wallet へ送った Holding の表示と食い違い、
 * 同じ 1 枚が別の番号で 2 通りに見える。
 */
export function formatSerialNumber(serialNo: number): string {
  return String(serialNo).padStart(4, '0');
}

/**
 * Wallet が長期表示に使える画像 URL かどうか（PR-NW04 §4-2）。
 *
 * ⚠️ **短期の署名付き URL を通さない。**
 * Wallet は受け取った URL を Holding に保存して表示に使う。
 * 期限が切れた時点で、**過去に受け取った分の画像がまとめて壊れる**。
 * 壊れるのは配信の瞬間ではなく数日後なので、誰も原因に気づけない。
 *
 * ここで弾くのは「明らかに外から取れないもの」と「期限付きの印」。
 * 完全な判定はできないので、運用の取り決めと二重に持つ。
 */
export function isLongLivedImageUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') {
    return false;
  }
  if (isNonPublicHost(url.hostname)) {
    return false;
  }
  // 署名付き URL の代表的なクエリ。付いていたら期限があるとみなす。
  const signedParams = ['x-amz-signature', 'x-amz-expires', 'signature', 'expires', 'token', 'sig'];
  for (const key of url.searchParams.keys()) {
    if (signedParams.includes(key.toLowerCase())) {
      return false;
    }
  }
  return true;
}

/** ループバック・プライベートアドレス・名前解決できない相手。 */
function isNonPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4 === null) {
    // ホスト名にドットが無い（`wallet` 等）のは社内名の可能性が高い。
    return !host.includes('.');
  }
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Wallet へ送る表示情報のスナップショット（§24）。
 *
 * ⚠️ **送信時点で固定する。**
 * あとで作品名や画像を差し替えても、既に渡した Holding の表示は変わらない。
 * マスタを参照して都度組み立てると、利用者が受け取ったはずのものが
 * 黙って別物になる。
 */
export interface WalletEventMetadata {
  readonly entitlement_type: string;
  readonly asset_code: string;
  readonly name: string;
  readonly description: string;
  readonly image_url: string;
  readonly thumbnail_url: string | null;
  readonly image_hash: string;
  readonly rarity: string | null;
  readonly serial_number: string;
  readonly blockchain_status: string;
}

export interface WalletEventData {
  readonly entitlement_id: string;
  readonly order_id: string;
  readonly order_item_id: string;
  readonly artwork_id: string;
  /**
   * 商品コード。
   *
   * MVP では採番しない（§6）。カードの識別は `metadata.asset_code` を使う。
   * ⚠️ 新しい商品コード体系を MVP で作らない。
   */
  readonly product_code: null;
}

/** `entitlement.granted` の本文。 */
export interface WalletGrantedEvent {
  readonly event_id: string;
  readonly event_type: 'entitlement.granted';
  readonly event_version: string;
  readonly occurred_at: string;
  readonly source_system_key: string;
  readonly target_site_key: string;
  readonly correlation_id: string;
  readonly common_user_id: string;
  readonly data: WalletEventData;
  readonly metadata: WalletEventMetadata;
}

/**
 * `entitlement.revoked` の本文。
 *
 * ❓ **未決定（UD-1010）:** 取り消しイベントの本文は Wallet 側と未合意。
 * ここでは封筒と `data` のみを送り、表示情報（`metadata`）は載せていない。
 * 取り消しに必要なのは「どの受取権が無効になったか」だけであり、
 * 表示情報を再送すると、相手がそれで Holding を書き換える余地が生まれる。
 * 先方の契約確定後に見直す。
 */
export interface WalletRevokedEvent {
  readonly event_id: string;
  readonly event_type: 'entitlement.revoked';
  readonly event_version: string;
  readonly occurred_at: string;
  readonly source_system_key: string;
  readonly target_site_key: string;
  readonly correlation_id: string;
  readonly common_user_id: string;
  readonly data: WalletEventData;
}

export type WalletDeliveryEvent = WalletGrantedEvent | WalletRevokedEvent;

/** 相関ID の字種。受信側（`X-Correlation-Id`）と同じ規則にそろえる。 */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export interface WalletEventEnvelopeInput {
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
  readonly commonUserId: string;
  readonly entitlementId: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly artworkId: string;
}

export interface WalletGrantedEventInput extends WalletEventEnvelopeInput {
  readonly artworkTitle: string;
  readonly artworkDescription: string;
  readonly imageUrl: string;
  readonly thumbnailUrl: string | null;
  readonly imageHash: string;
  readonly serialNo: number;
}

/**
 * `entitlement.granted` を組み立てる。
 *
 * 検証の順序に意味がある。**送れない値を先に落とす**。
 * 組み立ててから相手に弾かれると、原因が 400 の応答文にしか残らない。
 */
export function buildGrantedEvent(
  input: WalletGrantedEventInput,
): Result<WalletGrantedEvent, DomainError> {
  const envelope = validateEnvelope(input);
  if (!envelope.ok) {
    return envelope;
  }
  if (!Number.isInteger(input.serialNo) || input.serialNo < 1) {
    return err(domainError('WALLET_EVENT_INVALID', 'serial number must be a positive integer'));
  }
  if (input.artworkTitle.trim().length === 0) {
    return err(domainError('WALLET_EVENT_INVALID', 'artwork title is required'));
  }
  if (!isContentHash(input.imageHash)) {
    return err(domainError('WALLET_EVENT_INVALID', 'image hash must be sha256:<hex>'));
  }
  if (!isLongLivedImageUrl(input.imageUrl)) {
    return err(domainError('WALLET_EVENT_INVALID', 'image url must be a long-lived https url'));
  }
  if (input.thumbnailUrl !== null && !isLongLivedImageUrl(input.thumbnailUrl)) {
    return err(domainError('WALLET_EVENT_INVALID', 'thumbnail url must be a long-lived https url'));
  }

  return ok({
    ...baseEnvelope(input),
    event_type: 'entitlement.granted',
    data: eventData(input),
    metadata: {
      entitlement_type: ENTITLEMENT_TYPE_DIGITAL_COLLECTIBLE,
      // ⚠️ 商品コードは採番しない。識別はこの `asset_code` で行う（§6）。
      asset_code: input.artworkId,
      name: input.artworkTitle,
      description: input.artworkDescription,
      image_url: input.imageUrl,
      thumbnail_url: input.thumbnailUrl,
      image_hash: input.imageHash,
      // 希少度は MVP で扱わない。列も概念も作らない。
      rarity: null,
      serial_number: formatSerialNumber(input.serialNo),
      // オフチェーン先行。Mint していないものを MINTED と名乗らない。
      blockchain_status: BLOCKCHAIN_STATUS_NOT_MINTED,
    },
  });
}

/** `entitlement.revoked` を組み立てる。 */
export function buildRevokedEvent(
  input: WalletEventEnvelopeInput,
): Result<WalletRevokedEvent, DomainError> {
  const envelope = validateEnvelope(input);
  if (!envelope.ok) {
    return envelope;
  }
  return ok({
    ...baseEnvelope(input),
    event_type: 'entitlement.revoked',
    data: eventData(input),
  });
}

function validateEnvelope(input: WalletEventEnvelopeInput): Result<true, DomainError> {
  if (input.eventId.trim().length === 0) {
    return err(domainError('WALLET_EVENT_INVALID', 'event id is required'));
  }
  if (!CORRELATION_ID_PATTERN.test(input.correlationId)) {
    return err(domainError('WALLET_EVENT_INVALID', 'correlation id has an unexpected shape'));
  }
  // ⚠️ 形の確認は「取り違えた値」を止めるため。
  //    自社の account id をそのまま入れると、相手は別人の Holding を作る。
  if (!isCommonUserId(input.commonUserId)) {
    return err(domainError('WALLET_EVENT_INVALID', 'common user id has an unexpected shape'));
  }
  if (Number.isNaN(input.occurredAt.getTime())) {
    return err(domainError('WALLET_EVENT_INVALID', 'occurred at is not a valid date'));
  }
  return ok(true);
}

function baseEnvelope(input: WalletEventEnvelopeInput): {
  event_id: string;
  event_version: string;
  occurred_at: string;
  source_system_key: string;
  target_site_key: string;
  correlation_id: string;
  common_user_id: string;
} {
  return {
    event_id: input.eventId,
    event_version: WALLET_EVENT_VERSION,
    occurred_at: input.occurredAt.toISOString(),
    source_system_key: SOURCE_SYSTEM_KEY,
    target_site_key: TARGET_SITE_KEY,
    correlation_id: input.correlationId,
    common_user_id: input.commonUserId,
  };
}

function eventData(input: WalletEventEnvelopeInput): WalletEventData {
  return {
    entitlement_id: input.entitlementId,
    order_id: input.orderId,
    order_item_id: input.orderLineId,
    artwork_id: input.artworkId,
    product_code: null,
  };
}
