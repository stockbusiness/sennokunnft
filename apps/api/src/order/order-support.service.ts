import { Injectable } from '@nestjs/common';
import type {
  AdminOrderNotesResponse,
  AdminOrderTimelineResponse,
  OrderNoteView,
} from '@sengoku/contracts';
import {
  buildOrderTimeline,
  normalizeOrderSearch,
  validateOrderNote,
  type AuditLogPort,
  type ClockPort,
  type EmailHashPort,
  type IdGeneratorPort,
  type OrderNoteEntry,
  type OrderNoteRepository,
  type OrderRepository,
  type OrderSearchCriteria,
  type OrderSearchInput,
  type PaymentRepository,
} from '@sengoku/domain';
import { DomainErrorException } from '../common/domain-error.filter';

/**
 * 注文の検索と問い合わせ対応（`UD-121`）。
 *
 * ⚠️ **状態を変える処理をここへ足さない。** ここが担うのは
 * 「探す」「経過を読む」「対応を書き残す」の 3 つだけである。
 * 返金も再送も、この層の仕事ではない（§9.3 の禁止事項）。
 *
 * ⚠️ **購入者の平文メールを保持しない**（`UD-503`）。入口で照合値へ
 * 変換し、それ以降は平文をどこへも渡さない。ログにも監査ログにも出さない。
 */
@Injectable()
export class OrderSupportService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly notes: OrderNoteRepository,
    /** 決済を繋いでいない配備では `null`。経過から決済の行が消えるだけ。 */
    private readonly payments: PaymentRepository | null,
    private readonly emailHasher: EmailHashPort,
    private readonly clock: ClockPort,
    private readonly ids: IdGeneratorPort,
    private readonly audit: AuditLogPort,
  ) {}

  /**
   * 入力を検索条件へそろえる。
   *
   * ⚠️ 矛盾した条件は 0 件ではなく**誤り**として返す。0 件で返すと、
   * 探し方が悪いのか本当に無いのかが利用者に区別できない。
   */
  normalizeSearch(input: OrderSearchInput): OrderSearchCriteria {
    const normalized = normalizeOrderSearch(input);
    if (!normalized.ok) {
      throw new DomainErrorException(normalized.error.code);
    }
    return normalized.value;
  }

  /**
   * 聞き取ったメールアドレスを照合値へ変換する。
   *
   * ⚠️ **戻り値に平文を含めない。** ここを通ったあと、平文は捨てられる。
   * ⚠️ **鍵の無い配備では「見つからない」ではなく「引けない」を返す。**
   * 同じ扱いにすると、鍵を入れ忘れた配備で問い合わせてきた方に
   * 「そのご注文はありません」と、事実でないことを答えることになる。
   */
  hashEmailForLookup(email: string): string {
    const hashed = this.emailHasher.hash(email);
    if (hashed === null) {
      throw new DomainErrorException('EMAIL_LOOKUP_UNAVAILABLE');
    }
    return hashed;
  }

  /**
   * 注文の経過を組み立てる（古い順）。
   *
   * ⚠️ 注文が無ければ `null`。存在しない注文と、見る権限が無い注文を
   * 呼び出し側で区別しない（区別すると総当たりで存在を確かめられる）。
   */
  async timeline(orderId: string): Promise<AdminOrderTimelineResponse | null> {
    const order = await this.orders.findById(orderId);
    if (order === null) {
      return null;
    }

    const [attempts, webhooks, notes] = await Promise.all([
      this.payments === null ? Promise.resolve([]) : this.payments.listAttempts(orderId),
      this.payments === null ? Promise.resolve([]) : this.payments.listWebhookReceipts(orderId),
      this.notes.listByOrder(orderId),
    ]);

    const entries = buildOrderTimeline({ order, attempts, webhooks, notes });
    return {
      entries: entries.map((entry) => ({
        kind: entry.kind,
        at: entry.at.toISOString(),
        detail: entry.detail,
      })),
    };
  }

  async listNotes(orderId: string): Promise<AdminOrderNotesResponse | null> {
    const order = await this.orders.findById(orderId);
    if (order === null) {
      return null;
    }
    const notes = await this.notes.listByOrder(orderId);
    return { notes: notes.map(toNoteView) };
  }

  /**
   * 対応メモを 1 件足す。
   *
   * ⚠️ **注文の状態は変えない。** メモは記録であって操作ではない。
   * ⚠️ **監査ログへ本文を入れない。** 運営の自由文で、何が書かれているかを
   * 前提にできない。証跡に要るのは「誰がいつ書いたか」までである。
   */
  async addNote(input: {
    readonly orderId: string;
    readonly authorAccountId: string;
    readonly body: string;
  }): Promise<OrderNoteView | null> {
    const order = await this.orders.findById(input.orderId);
    if (order === null) {
      return null;
    }

    const validated = validateOrderNote(input);
    if (!validated.ok) {
      throw new DomainErrorException(validated.error.code);
    }

    const now = this.clock.now();
    const created = await this.notes.append({
      id: this.ids.generate(),
      orderId: validated.value.orderId,
      authorAccountId: validated.value.authorAccountId,
      body: validated.value.body,
      now,
    });

    await this.audit.record({
      actorAccountId: input.authorAccountId,
      action: 'order.note_added',
      targetType: 'order',
      targetId: input.orderId,
      // ⚠️ 本文も文字数も入れない。文字数から中身は分からないが、
      //    入れると「短いから読まなくてよい」といった扱いを生む。
      summary: { noteId: created.id },
    });

    return toNoteView(created);
  }

  /**
   * メールからの照合を証跡へ残す。
   *
   * ⚠️ **アドレスも照合値も残さない。** 照合値は元へ戻せないが、
   * 手元のアドレスを同じ鍵で変換すれば一致を確かめられる。
   * 監査ログは閲覧範囲が広く、長く残る。残してよいのは
   * 「誰が、いつ、メールからの照合を使ったか」までである。
   */
  async recordEmailLookup(input: {
    readonly actorAccountId: string;
    readonly matchedCount: number;
  }): Promise<void> {
    await this.audit.record({
      actorAccountId: input.actorAccountId,
      action: 'order.buyer_lookup',
      targetType: 'order',
      targetId: null,
      summary: { matchedCount: input.matchedCount },
    });
  }
}

function toNoteView(note: OrderNoteEntry): OrderNoteView {
  return {
    id: note.id,
    authorAccountId: note.authorAccountId,
    body: note.body,
    createdAt: note.createdAt.toISOString(),
  };
}
