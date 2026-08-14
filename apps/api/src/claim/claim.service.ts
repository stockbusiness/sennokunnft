import { BadRequestException, Injectable } from '@nestjs/common';
import {
  evaluateWalletClaim,
  toPublicClaimStatus,
  type ClaimLookupResult,
  type ClaimRepositoryPort,
  type ClaimTokenPort,
  type ClockPort,
  type PublicClaimStatus,
} from '@sengoku/domain';
import { currentRequestId } from '@sengoku/observability';
import { DomainErrorException } from '../common/domain-error.filter';
import type { IdempotencyService } from '../common/idempotency';
import type { WalletDeliveryPlanner } from './delivery.planner';

/** 冪等キーの区切り。他の操作と同じキーがぶつからないようにする。 */
export const CLAIM_CONFIRM_SCOPE = 'collectible-claim-confirm';

/** `GET` の応答。✅ **最小形式**（回答書 §11）。画像とシリアルは返さない。 */
export interface ClaimView {
  readonly status: PublicClaimStatus;
  readonly card_name: string;
  readonly expires_at: string | null;
}

/** `POST` の応答。保留のときだけ `reason` が付く。 */
export interface ClaimConfirmation {
  readonly status: PublicClaimStatus;
  readonly reason?: 'common_user_pending';
}

/**
 * Claim（OVEW Wallet 連携）の手続き。
 *
 * ⚠️ **呼び出し元の身元確認は、ここではなく HMAC ガードで行う。**
 * 本サービスへ届く時点で、要求は OVEW Wallet からのものと確かめられている。
 * 本人（購入者）かどうかの判定だけがここの責務。
 */
@Injectable()
export class ClaimService {
  constructor(
    private readonly claims: ClaimRepositoryPort,
    private readonly tokens: ClaimTokenPort,
    private readonly clock: ClockPort,
    private readonly idempotency: IdempotencyService,
    /**
     * Wallet への配送。
     *
     * ⚠️ **`null` は「まだ Wallet へ繋がない」を意味する。**
     * 繋がない構成では行列に載せない。載せておいて送らないと、
     * 送信できない本文（相対パスの画像URL 等）の行が溜まり、
     * 実接続の初日にまとめて失敗する。
     */
    private readonly delivery: WalletDeliveryPlanner | null = null,
  ) {}

  /**
   * `Idempotency-Key` を取り出す。**省略は 400。**
   *
   * ⚠️ 省略時にサーバー側で発番しない。毎回違うキーになり、
   * 再送を見分けられなくなる。それでは付けていないのと同じ。
   */
  requireIdempotencyKey(raw: string | undefined): string {
    const key = this.idempotency.normalizeKey(raw);
    if (key === null) {
      throw new BadRequestException({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Idempotency-Key ヘッダが必要です。',
        },
      });
    }
    return key;
  }

  /** 受取りの状態を返す。 */
  async view(token: string): Promise<ClaimView> {
    const found = await this.claims.findByTokenHash(this.tokens.hash(token));
    if (found === null) {
      // ⚠️ 「無効」と「存在しない」を区別して答えない。
      //    総当たりで有効なトークンを探せてしまう。
      throw new DomainErrorException('CLAIM_TOKEN_INVALID');
    }
    const { entitlement } = found;
    return {
      status: toPublicClaimStatus(entitlement.status, entitlement.deliveryStatus),
      card_name: found.cardName,
      expires_at: entitlement.expiresAt?.toISOString() ?? null,
    };
  }

  /**
   * 受取りを確定する。
   *
   * ⚠️ **`nonce` と `Idempotency-Key` は役割が違う。混同しない。**
   * `nonce` が防ぐのは「同じ署名の要求をそのまま録画・再送された」場合。
   * しかし **DB は更新できたが応答だけが失われた**とき、正規の相手は
   * **新しい nonce で** 送り直す。これは署名としては正当なので nonce では防げない。
   * 業務上の二重実行を止めるのが `Idempotency-Key` の仕事。
   */
  async confirm(
    token: string,
    commonUserId: string,
    idempotencyKey: string,
  ): Promise<ClaimConfirmation> {
    const tokenHash = this.tokens.hash(token);
    const found = await this.claims.findByTokenHash(tokenHash);
    if (found === null) {
      // ⚠️ 冪等キーを占有する**前**に弾く。
      //    知らないトークンでキーを使い潰せてしまうと、正規の要求が
      //    同じキーで送れなくなる。
      throw new DomainErrorException('CLAIM_TOKEN_INVALID');
    }

    // ⚠️ **アクターは購入者のアカウント。**
    //    キーはアクターごとに区切らないと、他人の使ったキーを当てることで
    //    その応答（＝他人のデータ）を読み出せてしまう。
    //    呼び出し元は Wallet だが、Wallet は本システムのアカウントを持たない。
    //    受取権の持ち主である購入者を単位にすれば、契約上も安全に固定できる。
    // ⚠️ ダイジェストに**生のトークンを入れない**。ハッシュを使う。
    const digest = this.idempotency.digest(CLAIM_CONFIRM_SCOPE, {
      tokenHash,
      commonUserId,
    });
    const outcome = await this.idempotency.begin<ClaimConfirmation>(
      found.purchaserAccountId,
      idempotencyKey,
      digest,
    );
    if (outcome.kind === 'replay') {
      return outcome.body;
    }

    let result: ClaimConfirmation;
    try {
      result = await this.execute(tokenHash, commonUserId, found);
    } catch (error) {
      // 本体が失敗したら解放する。解放しないと、一度失敗しただけのキーが
      // 期限切れまで塞がり、相手がやり直せなくなる。
      await outcome.claim.release().catch(() => undefined);
      throw error;
    }

    if (result.reason === 'common_user_pending') {
      // ⚠️ **保留を「結果」として記録しない。**
      //    記録すると、同じキーで送り直したときに解決後も PENDING が返り続ける。
      //    指示書 §7 の「解決後に再実行可能」を満たせなくなる。
      //    保留は状態を変えていないので、解放しても二重実行にならない。
      await outcome.claim.release().catch(() => undefined);
      return result;
    }

    // ⚠️ ここで失敗しても解放しない。本体は既に成功している。
    //    解放すると、やり直しで本体がもう一度走る。
    await outcome.claim.complete(202, result);
    return result;
  }

  private async execute(
    tokenHash: string,
    commonUserId: string,
    found: ClaimLookupResult,
  ): Promise<ClaimConfirmation> {
    const decision = evaluateWalletClaim({
      entitlement: found.entitlement,
      presentedCommonUserId: commonUserId,
      now: this.clock.now(),
    });
    if (!decision.ok) {
      throw new DomainErrorException(decision.error.code);
    }

    // 未解決は失敗ではない。受取権を失効させず、解決後にもう一度受け取れる。
    if (decision.value.kind === 'pending_common_user') {
      return { status: 'PENDING', reason: 'common_user_pending' };
    }

    // 再送。すでに確定しているので、いまの状態をそのまま返す。
    if (decision.value.kind === 'already_claimed') {
      return { status: decision.value.status };
    }

    const now = this.clock.now();
    // ⚠️ 本文の組み立ては確定の**前**に済ませる。
    //    組み立てに失敗する材料（画像が無い等）で確定だけ通すと、
    //    受取済みなのに配送されない行が残る。
    const plan =
      this.delivery === null
        ? undefined
        : this.delivery.plan({
            entitlementId: found.entitlement.id,
            commonUserId,
            // Claim から配送まで同じ相関IDで追える（§17）。
            correlationId: currentRequestId() ?? found.entitlement.id,
            snapshot: found.snapshot,
            now,
          });

    const outcome = await this.claims.confirmClaim({
      entitlementId: found.entitlement.id,
      commonUserId,
      accountId: found.purchaserAccountId,
      now,
      delivery: plan,
    });

    if (outcome.kind === 'raced') {
      // ⚠️ 判定から書き込みまでの隙間で、別の要求が確定させた。
      //    読み直して、確定させたのが同じ本人なら成功として答える。
      //    ここで一律に失敗を返すと、再送しただけの相手を落としてしまう。
      const reread = await this.claims.findByTokenHash(tokenHash);
      if (
        reread !== null &&
        reread.entitlement.claimedByCommonUserId === commonUserId &&
        reread.entitlement.status === 'claimed'
      ) {
        return {
          status: toPublicClaimStatus(reread.entitlement.status, reread.entitlement.deliveryStatus),
        };
      }
      // 本人以外に取られていた、あるいは終端状態へ移っていた。
      throw new DomainErrorException('CLAIM_PROCESSING');
    }

    // 送信そのものは配送ワーカーが行う。ここでは行列に載せたところまで。
    return { status: 'DELIVERY_PENDING' };
  }
}
