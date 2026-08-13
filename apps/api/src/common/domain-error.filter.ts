import { Catch, HttpStatus, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import type { DomainErrorCode } from '@sengoku/domain';
import type { ApiError } from '@sengoku/contracts';
import { currentRequestId } from '@sengoku/observability';

/**
 * ドメインエラーコード → HTTP ステータスの対応（API_DESIGN.md §2.1）。
 *
 * この表を api 層に置くのは、ドメイン層に HTTP を知らせないため。
 * ドメイン層は「在庫が足りない」までを表現し、
 * それが 409 なのか 400 なのかは境界層の関心事。
 */
export const DOMAIN_ERROR_HTTP_STATUS: Readonly<Record<DomainErrorCode, number>> = {
  ARTWORK_NOT_AVAILABLE: HttpStatus.NOT_FOUND,
  LISTING_NOT_ACTIVE: HttpStatus.CONFLICT,
  INSUFFICIENT_SUPPLY: HttpStatus.CONFLICT,
  INVALID_QUANTITY: HttpStatus.BAD_REQUEST,
  INVALID_MONEY: HttpStatus.BAD_REQUEST,
  CURRENCY_MISMATCH: HttpStatus.BAD_REQUEST,
  ORDER_NOT_PENDING: HttpStatus.CONFLICT,
  INVALID_STATE_TRANSITION: HttpStatus.CONFLICT,
  ENTITLEMENT_NOT_CLAIMABLE: HttpStatus.CONFLICT,
  ENTITLEMENT_OWNER_MISMATCH: HttpStatus.FORBIDDEN,
  // 403 にしない。有効なトークンが存在するかを攻撃者に教えないため。
  CLAIM_TOKEN_INVALID: HttpStatus.NOT_FOUND,
  MINT_ALREADY_EXISTS: HttpStatus.CONFLICT,
  MINT_ATTEMPTS_EXHAUSTED: HttpStatus.CONFLICT,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
};

/** 利用者に見せる文言。内部実装の詳細を含めない。 */
const USER_MESSAGES: Readonly<Record<DomainErrorCode, string>> = {
  ARTWORK_NOT_AVAILABLE: 'お探しの作品は見つかりませんでした。',
  LISTING_NOT_ACTIVE: 'この作品は現在販売していません。',
  INSUFFICIENT_SUPPLY: '在庫が不足しています。',
  INVALID_QUANTITY: '数量の指定が正しくありません。',
  INVALID_MONEY: '金額の指定が正しくありません。',
  CURRENCY_MISMATCH: '通貨の指定が正しくありません。',
  ORDER_NOT_PENDING: 'このご注文はお支払い待ちの状態ではありません。',
  INVALID_STATE_TRANSITION: 'この操作は現在の状態では行えません。',
  ENTITLEMENT_NOT_CLAIMABLE: 'この受取り権利は現在お受け取りいただけません。',
  ENTITLEMENT_OWNER_MISMATCH: 'この受取り権利をお受け取りいただく権限がありません。',
  CLAIM_TOKEN_INVALID: 'お探しの受取りページは見つかりませんでした。',
  MINT_ALREADY_EXISTS: 'すでに発行済みです。',
  MINT_ATTEMPTS_EXHAUSTED: '発行処理が完了しませんでした。運営までお問い合わせください。',
  IDEMPOTENCY_CONFLICT: '同じ操作が別の内容で送信されました。もう一度お試しください。',
};

/** ドメインエラーを HTTP 境界へ運ぶための例外。 */
export class DomainErrorException extends Error {
  public override readonly name = 'DomainErrorException';
  constructor(public readonly code: DomainErrorCode) {
    super(code);
  }
}

/**
 * ドメインエラーを統一形式の応答へ変換する。
 *
 * ⚠️ 応答にスタックトレース・SQL・内部パスを含めない。
 * 詳細はログにのみ残し、利用者には定型の文言を返す。
 */
@Catch(DomainErrorException)
export class DomainErrorFilter implements ExceptionFilter<DomainErrorException> {
  catch(exception: DomainErrorException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = DOMAIN_ERROR_HTTP_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const requestId = currentRequestId();

    const body: ApiError = {
      error: {
        code: exception.code,
        message: USER_MESSAGES[exception.code] ?? 'エラーが発生しました。',
        ...(requestId === undefined ? {} : { requestId }),
      },
    };

    response.status(status).json(body);
  }
}
