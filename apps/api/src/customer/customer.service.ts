import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CustomerDetailResponse,
  CustomerEmailResponse,
  CustomerSearchRequest,
  CustomerSearchResponse,
  EmailChangeRequestView,
} from '@sengoku/contracts';
import {
  completeEmailChange,
  customerAttentions,
  maskEmail,
  netPaidAmount,
  rankDuplicateCandidates,
  rejectEmailChange,
  verifyIdentity,
  type AccountNotePort,
  type AuditLogPort,
  type ClockPort,
  type CustomerDirectoryPort,
  type CustomerSummary,
  type EmailChangeRequestPort,
  type EmailChangeRequestRecord,
  type EmailHashPort,
  type IdentityVerificationMethod,
  type RecipientResolverPort,
} from '@sengoku/domain';
import type { Actor } from '@sengoku/auth';
import { DomainErrorException } from '../common/domain-error.filter';

/**
 * 顧客サポート（実運営 指示書 P1-1）。
 *
 * ⚠️ **持ち主を付け替える口を作らない。** 注文・受取権・ウォレットの
 * 持ち主を人が変えられる操作は、このクラスに存在しない。本人確認をしていない
 * 付け替えは、他人の持ち物を渡すことと同じである。
 *
 * ⚠️ **救済は既存の口を使う。** Claim の再発行（`UD-1009`）も、ウォレットへの
 * 再配送（P0-6）も、すでにある。ここで作り直すと、規則が 2 か所に散る。
 *
 * ⚠️ **平文のアドレスを持ち回らない。** 受け取ったらその場で照合値と
 * 伏せた表記に変え、元の値は捨てる。
 */
@Injectable()
export class CustomerSupportService {
  constructor(
    private readonly directory: CustomerDirectoryPort,
    private readonly notes: AccountNotePort,
    private readonly emailChanges: EmailChangeRequestPort,
    private readonly emailHasher: EmailHashPort,
    private readonly clock: ClockPort,
    private readonly audit: AuditLogPort,
    /**
     * ご連絡先を取り寄せる口（決定 2026-08-21）。
     *
     * ⚠️ **`null` は「この配備では取り寄せられない」。** 認証基盤への
     * 接続が設定されていない環境がある。**「取れなかった」と混ぜない**
     * ——混ぜると、設定漏れが「たまたま失敗した」に見えて放置される。
     */
    private readonly recipients: RecipientResolverPort | null,
  ) {}

  /**
   * 顧客を探す。
   *
   * ⚠️ **条件無しの全件表示を作らない**（契約の側でも縛ってある）。
   * 顧客の一覧をただ眺められる画面は、業務に要らないうえに、
   * 漏れたときの被害がいちばん大きい。
   */
  async search(criteria: CustomerSearchRequest, actor: Actor): Promise<CustomerSearchResponse> {
    const items = await this.resolve(criteria);

    /*
      ⚠️ **引いたことを記録に残す。** 「このアドレスの方が買ったか」を
         確かめられるのは強い力で、誰がいつ使ったかが残らないと歯止めが無い。
      ⚠️ **引いた値そのものを記録しない。** 記録に平文が残れば、
         `UD-503` を監査ログの側から破ることになる。
    */
    await this.audit.record({
      actorAccountId: actor.accountId,
      action: 'customer.search',
      targetType: 'account',
      targetId: items[0]?.accountId ?? 'none',
      summary: {
        by: criteriaKind(criteria),
        matchCount: items.length,
      },
    });

    return { items: items.map(toSummaryView) };
  }

  /**
   * ご連絡先そのものを取り寄せる（決定 2026-08-21）。
   *
   * ⚠️ **保存しない**（`UD-503` 維持）。認証基盤から取り寄せ、応答に載せて
   * 捨てる。DB にも、この処理のどこにも残らない。次に見るときは、また
   * 取り寄せる。
   *
   * ⚠️ **見たことは必ず記録に残す。** 連絡先を読めるのは強い力で、誰がいつ
   * 使ったかが残らないと歯止めが無い。
   *
   * ⚠️ **アドレスの値を記録に載せない。** 載せれば、監査ログの側から
   * `UD-503` を破ることになる。残すのは「どのアカウントの分を引いたか」と
   * 「取れたかどうか」まで。
   *
   * ⚠️ **ログへも出さない。** 失敗したときほど出したくなるが、そこが
   * 平文アドレスの最大の漏れ口になる。
   */
  async emailOf(accountId: string, actor: Actor): Promise<CustomerEmailResponse> {
    /*
      ⚠️ **居ないアカウントを引けないようにする。** 引けると、この口が
         「そのアカウントが在るか」を確かめる道になる。
    */
    const summary = await this.directory.findByAccountId(accountId);
    if (summary === null) {
      throw new NotFoundException();
    }

    const resolution = this.recipients === null ? null : await this.recipients.resolve(accountId);

    await this.audit.record({
      actorAccountId: actor.accountId,
      action: 'customer.email.view',
      targetType: 'account',
      targetId: accountId,
      // ⚠️ ここにアドレスを入れない。入れた瞬間に `UD-503` が崩れる。
      summary: { result: resolution === null ? 'not_configured' : resolution.kind },
    });

    if (resolution === null) {
      return { status: 'not_configured' };
    }
    if (resolution.kind === 'resolved') {
      return { status: 'resolved', email: resolution.email };
    }
    return { status: resolution.kind };
  }

  async detail(accountId: string): Promise<CustomerDetailResponse> {
    const summary = await this.directory.findByAccountId(accountId);
    if (summary === null) {
      throw new NotFoundException();
    }

    const [orders, entitlements, refunds, notes, candidates, emailChangeRequests] =
      await Promise.all([
        this.directory.orders(accountId, LIST_LIMIT),
        this.directory.entitlements(accountId, LIST_LIMIT),
        this.directory.refunds(accountId, LIST_LIMIT),
        this.notes.list(accountId, LIST_LIMIT),
        this.directory.duplicateCandidates(accountId, DUPLICATE_LIMIT),
        this.emailChanges.list(accountId, LIST_LIMIT),
      ]);

    const attentions = customerAttentions({
      summary,
      entitlements,
      // ⚠️ 「申請中」だけを進行中とみなす。失敗した返金は別の話。
      hasRefundInProgress: refunds.some((row) => row.status === 'requested'),
    });

    return {
      summary: toSummaryView(summary),
      attentions: attentions.map((row) => ({ ...row })),
      orders: orders.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        paidAt: row.paidAt?.toISOString() ?? null,
      })),
      entitlements: entitlements.map((row) => ({
        ...row,
        claimedAt: row.claimedAt?.toISOString() ?? null,
        walletDeliveredAt: row.walletDeliveredAt?.toISOString() ?? null,
      })),
      refunds: refunds.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      notes: notes.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      duplicateCandidates: rankDuplicateCandidates(candidates).map((row) => ({
        ...row,
        signals: [...row.signals],
        createdAt: row.createdAt.toISOString(),
      })),
      emailChangeRequests: emailChangeRequests.map(toEmailChangeView),
      /*
        ⚠️ **代理店・紹介元は、まだ持っていない。** 連携（M0〜M4）が契約待ちで、
           注文に紹介元を残す列が無い。埋まっているふりをしない。
      */
      referralSnapshot: null,
    };
  }

  /** 申し送りを書く。⚠️ 追記のみ。直す口も消す口も無い。 */
  async addNote(accountId: string, body: string, actor: Actor): Promise<void> {
    const authorAccountId = requireAccountId(actor);
    const found = await this.directory.findByAccountId(accountId);
    if (found === null) {
      throw new NotFoundException();
    }
    await this.notes.add({
      accountId,
      authorAccountId,
      body,
      now: this.clock.now(),
    });
    /*
      ⚠️ **本文を監査ログへ写さない。** メモには問い合わせの内容が入る。
         2 か所に増やすと、消せない場所が 2 つになる。
    */
    await this.audit.record({
      actorAccountId: authorAccountId,
      action: 'customer.note',
      targetType: 'account',
      targetId: accountId,
      summary: { length: body.length },
    });
  }

  /**
   * ご連絡先の変更を申し出として受ける。
   *
   * ⚠️ **ここでアドレスは変わらない。** 変えるのは認証基盤側で人が行う。
   * この操作は「申し出があった」ことを残すだけ。
   *
   * ⚠️ **新しいアドレスの平文を保存しない。** 伏せた表記と照合値に変えて捨てる。
   */
  async openEmailChange(accountId: string, newEmail: string, actor: Actor): Promise<string> {
    const openedByAccountId = requireAccountId(actor);
    const found = await this.directory.findByAccountId(accountId);
    if (found === null) {
      throw new NotFoundException();
    }

    /*
      ⚠️ **照合値を作れない配備では受け付けない。** 鍵（`EMAIL_LOOKUP_PEPPER`）
         が無いと、あとから「その申請はどのアドレス宛でしたか」を突き合わせ
         られない。突き合わせられない記録は、本人確認の証拠にならない。
    */
    const requestedEmailHash = this.emailHasher.hash(newEmail);
    if (requestedEmailHash === null) {
      throw new DomainErrorException('EMAIL_CHANGE_NOT_ALLOWED');
    }

    const id = await this.emailChanges.open({
      accountId,
      requestedMaskedEmail: maskEmail(newEmail),
      requestedEmailHash,
      openedByAccountId,
      now: this.clock.now(),
    });

    await this.audit.record({
      actorAccountId: openedByAccountId,
      action: 'customer.email_change_opened',
      targetType: 'account',
      targetId: accountId,
      // ⚠️ 監査ログにも平文を残さない。
      summary: { requestId: id },
    });
    return id;
  }

  /**
   * 本人確認を記録する。
   *
   * ⚠️ **「誰が」を必ず残す。** 確認したことにする圧力は、忙しい日にかかる。
   * 名前が残ると分かっていれば、飛ばしにくくなる。
   */
  async verifyIdentity(
    id: string,
    method: IdentityVerificationMethod,
    note: string | null,
    actor: Actor,
  ): Promise<void> {
    const actorAccountId = requireAccountId(actor);
    const request = await this.requireRequest(id);

    const decision = verifyIdentity({ current: request.status, method, note });
    if (!decision.ok) {
      throw new DomainErrorException(rejectionToCode(decision.reason));
    }

    const now = this.clock.now();
    await this.emailChanges.verify({
      id,
      method: decision.value.method,
      note: decision.value.note,
      actorAccountId,
      now,
    });
    await this.audit.record({
      actorAccountId,
      action: 'customer.email_change_verified',
      targetType: 'account',
      targetId: request.accountId,
      summary: { requestId: id, method: decision.value.method },
    });
  }

  /**
   * 決着させる。
   *
   * ⚠️ **本人確認を飛ばして「済」にできない。** ドメインが断り、DB の
   * CHECK も断る。二重にしてあるのは、アプリを通さない書き込みも
   * 止めるため。
   */
  async settleEmailChange(
    id: string,
    status: 'completed' | 'rejected',
    note: string | null,
    actor: Actor,
  ): Promise<void> {
    const actorAccountId = requireAccountId(actor);
    const request = await this.requireRequest(id);

    const decision =
      status === 'completed'
        ? completeEmailChange({ current: request.status, note })
        : rejectEmailChange({ current: request.status, note });
    if (!decision.ok) {
      throw new DomainErrorException(rejectionToCode(decision.reason));
    }

    const now = this.clock.now();
    await this.emailChanges.settle({
      id,
      status,
      note: decision.value.note,
      actorAccountId,
      now,
    });
    await this.audit.record({
      actorAccountId,
      action: 'customer.email_change_settled',
      targetType: 'account',
      targetId: request.accountId,
      summary: { requestId: id, status },
    });
  }

  private async requireRequest(id: string): Promise<EmailChangeRequestRecord> {
    const request = await this.emailChanges.findById(id);
    if (request === null) {
      throw new NotFoundException();
    }
    return request;
  }

  /**
   * 手がかりから顧客を引く。
   *
   * ⚠️ **平文のアドレスはここで照合値に変えて捨てる。** 先へ持ち回らない。
   */
  private async resolve(criteria: CustomerSearchRequest): Promise<readonly CustomerSummary[]> {
    if (criteria.accountId !== undefined) {
      const found = await this.directory.findByAccountId(criteria.accountId);
      return found === null ? [] : [found];
    }
    if (criteria.orderNumber !== undefined) {
      const found = await this.directory.findByOrderNumber(criteria.orderNumber);
      return found === null ? [] : [found];
    }
    if (criteria.email !== undefined) {
      /*
        ⚠️ **照合値を作れなければ空で返す。** 平文で引き当てにいかない。
           鍵の無い配備では、この手がかりでは探せない——それが正しい姿で、
           代わりに全件を出したりしない。
      */
      const emailHash = this.emailHasher.hash(criteria.email);
      return emailHash === null ? [] : this.directory.findByEmailHash(emailHash, SEARCH_LIMIT);
    }
    if (criteria.commonUserId !== undefined) {
      return this.directory.findByCommonUserId(criteria.commonUserId, SEARCH_LIMIT);
    }
    // ⚠️ 契約が空を弾くので、ここへは来ない。来たら空で返す（全件を出さない）。
    return [];
  }
}

/** ⚠️ ガードが通しているので通常は来ない。来たら開かない側へ倒す。 */
function requireAccountId(actor: Actor): string {
  if (actor.accountId === null || actor.accountId === undefined) {
    throw new ForbiddenException();
  }
  return actor.accountId;
}

/** 1 画面に出す行数の上限。⚠️ 無制限にしない。 */
const LIST_LIMIT = 50;
const SEARCH_LIMIT = 20;
/** 重複候補。⚠️ 多いのは異常なので、少なめで足りる。 */
const DUPLICATE_LIMIT = 10;

function toSummaryView(summary: CustomerSummary) {
  return {
    accountId: summary.accountId,
    maskedEmail: summary.maskedEmail,
    commonUserId: summary.commonUserId,
    status: summary.status,
    orderCount: summary.orderCount,
    paidAmount: summary.paidAmount,
    refundedAmount: summary.refundedAmount,
    // ⚠️ 画面で引き算をさせない。応対中の暗算は間違う。
    netPaidAmount: netPaidAmount(summary),
    entitlementCount: summary.entitlementCount,
    unclaimedCount: summary.unclaimedCount,
    firstOrderAt: summary.firstOrderAt?.toISOString() ?? null,
    lastOrderAt: summary.lastOrderAt?.toISOString() ?? null,
  };
}

function toEmailChangeView(row: EmailChangeRequestRecord): EmailChangeRequestView {
  return {
    id: row.id,
    accountId: row.accountId,
    requestedMaskedEmail: row.requestedMaskedEmail,
    status: row.status,
    verificationMethod: row.verificationMethod,
    verifiedByAccountId: row.verifiedByAccountId,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    settledByAccountId: row.settledByAccountId,
    settledAt: row.settledAt?.toISOString() ?? null,
    note: row.note,
    openedByAccountId: row.openedByAccountId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** どの手がかりで引いたか。⚠️ 値そのものは記録しない。 */
function criteriaKind(criteria: CustomerSearchRequest): string {
  if (criteria.accountId !== undefined) return 'account_id';
  if (criteria.orderNumber !== undefined) return 'order_number';
  if (criteria.email !== undefined) return 'email';
  if (criteria.commonUserId !== undefined) return 'common_user_id';
  return 'none';
}

function rejectionToCode(
  reason: 'NOTE_TOO_LONG' | 'IDENTITY_NOT_VERIFIED' | 'ALREADY_SETTLED' | 'REJECTION_REQUIRES_NOTE',
): 'EMAIL_CHANGE_NOT_ALLOWED' {
  /*
    ⚠️ **符号を 1 つにまとめている。** 断る理由の細かい違いは、
       押した運営には「いまはできない」としか読めない。文言は画面側で
       状態から作る（状態は一覧に出ている）。
  */
  void reason;
  return 'EMAIL_CHANGE_NOT_ALLOWED';
}
