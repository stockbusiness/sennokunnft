import { z } from 'zod';

/**
 * 作家さまへの精算（`UD-119`。決定 2026-08-20）。
 *
 * ⚠️ **金額を受け取る欄を作らない。** 合計も明細も、集計が決めた値だけ。
 * 人が金額を書き換える口を作らない決定（`SETTLEMENT_AND_REFUND.md` §4）が、
 * 契約の形として現れている。訂正は**次の期間での調整**として行う。
 */

export const PAYOUT_STATUS_VALUES = ['draft', 'confirmed', 'paid'] as const;

/** `2026-08` の形。⚠️ `Date` の解釈に任せない。 */
export const payoutPeriodKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/u, '締め月は 2026-08 の形で指定してください');

export const payoutSchema = z.object({
  id: z.string(),
  /** ⚠️ 氏名やメールではなくアカウントID。画面では短縮して出す。 */
  creatorAccountId: z.string(),
  periodKey: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  /** お支払いの期日。⚠️ 焼き付けた値。設定を変えても動かない。 */
  dueAt: z.string(),
  status: z.enum(PAYOUT_STATUS_VALUES),
  currency: z.string(),
  grossAmount: z.number().int(),
  feeAmount: z.number().int(),
  /** 差し戻した額。⚠️ 正の数。 */
  refundedAmount: z.number().int(),
  /** 前月からの繰越。⚠️ マイナスもありうる。 */
  carriedInAmount: z.number().int(),
  netAmount: z.number().int(),
  /** 翌月への繰越。⚠️ マイナスもありうる。 */
  carriedOutAmount: z.number().int(),
  /**
   * 決着待ちのため今回は載せなかったご注文の数（決定 B・2026-08-22）。
   *
   * ⚠️ **合計には入っていない。** 「なぜ今月は少ないのか」を画面へ出す
   * ためだけの数である。
   */
  deferredDisputeCount: z.number().int().nonnegative(),
  /** 決着待ちで載せなかったぶんの、作家さまの取り分の合計。 */
  deferredDisputeAmount: z.number().int().nonnegative(),
  /** ⚠️ **その時点の**設定。焼き付けてある。 */
  minimumPayoutAmount: z.number().int(),
  transferFeeBearer: z.enum(['creator', 'platform']),
  confirmedAt: z.string().nullable(),
  paidAt: z.string().nullable(),
  paidByAccountId: z.string().nullable(),
  lineCount: z.number().int(),
  createdAt: z.string(),
});
export type PayoutViewDto = z.infer<typeof payoutSchema>;

export const payoutLineSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  orderNumber: z.string(),
  /** ⚠️ 注文時点の作品名。マスタを引き直さない。 */
  artworkTitleSnapshot: z.string(),
  grossAmount: z.number().int(),
  feeRateBps: z.number().int(),
  feeAmount: z.number().int(),
  /** ⚠️ 差し戻しはマイナス。 */
  netAmount: z.number().int(),
  isClawback: z.boolean(),
});
export type PayoutLineViewDto = z.infer<typeof payoutLineSchema>;

export const payoutListResponseSchema = z.object({ items: z.array(payoutSchema) });
export type PayoutListResponse = z.infer<typeof payoutListResponseSchema>;

export const payoutDetailResponseSchema = z.object({
  payout: payoutSchema,
  lines: z.array(payoutLineSchema),
  /**
   * 返金の窓がまだ開いている注文の数。
   *
   * ⚠️ **0 でなければ確定できない**（`SETTLEMENT_AND_REFUND.md` §2-3）。
   * 画面はこれを見て「まだ締められない」ことを先に伝える。
   */
  openRefundWindows: z.number().int(),
  /**
   * お振込先が預かってあるか（決定 2026-08-21）。
   *
   * ⚠️ **値は一切載せない。** 銀行名も名義も番号も含まない——**状態だけ**。
   * 精算の画面を開いただけで口座の手掛かりが流れる形にしない。読むには
   * 別の口（`payout_account.view_full` ＋ 監査）を叩く。
   *
   * ⚠️ **`auditor` にも見える。** 「振込先が無いのに確定した精算」が
   * あるかどうかは、監査の対象そのものである。状態は値ではない。
   *
   * - `registered` … 預かってある
   * - `missing` … 未登録。**このまま確定しても振り込めない**
   * - `unavailable` … この配備では預かる仕組みが無い（暗号鍵が未設定）
   */
  payoutAccountStatus: z.enum(['registered', 'missing', 'unavailable']),
});
export type PayoutDetailResponse = z.infer<typeof payoutDetailResponseSchema>;

/**
 * 振込のために、お振込先を伏せずに読む（決定 2026-08-21）。
 *
 * ⚠️ **精算ごとに読む。** 作家さまを直に指定する口にしていない——
 * そうすると「作家さま一覧から口座を順に開く」ができてしまう。
 * **払う相手の精算があるときだけ**開く形にしてある。
 *
 * ⚠️ **「取れなかった」を 3 つに分けている。** 運営の次の一手が違うため。
 * 同じ顔で出すと、鍵の設定漏れと改ざんの疑いが同じ扱いになる。
 */
export const adminPayoutAccountViewSchema = z.object({
  bankName: z.string(),
  branchName: z.string(),
  accountType: z.enum(['ordinary', 'checking']),
  /** ⚠️ **ここだけが伏せていない値。** 画面から先へ写さない。 */
  accountNumber: z.string(),
  accountHolderKana: z.string(),
  /** ⚠️ **いつ登録された内容か。** 直前に差し替わっていれば疑う手掛かりになる。 */
  updatedAt: z.string(),
});
export type AdminPayoutAccountView = z.infer<typeof adminPayoutAccountViewSchema>;

export const adminPayoutAccountResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('resolved'), account: adminPayoutAccountViewSchema }),
  /** 作家さまがまだ登録していない。⚠️ 待っても変わらない。 */
  z.object({ status: z.literal('missing') }),
  /** この配備では預かる仕組みが無い（暗号鍵が未設定）。 */
  z.object({ status: z.literal('not_configured') }),
  /**
   * 包みが解けなかった。
   *
   * ⚠️ **これは「時間をおけば直る」ではない。** 鍵の入れ替えを誤ったか、
   * 行が差し替えられたかである。**振り込まないこと。**
   */
  z.object({ status: z.literal('undecipherable') }),
  /**
   * まだ下書きの精算である。
   *
   * ⚠️ **確定する前に口座を読む理由が無い。** 読む口を「振り込むため」に
   * 絞っておくと、監査ログの 1 行が何のためだったかを後から説明できる。
   */
  z.object({ status: z.literal('not_payable_yet') }),
]);
export type AdminPayoutAccountResponse = z.infer<typeof adminPayoutAccountResponseSchema>;

/**
 * 締め（下書きの作成）。
 *
 * ⚠️ **作家さまを指定させない。** その期間に売上か繰越のある方を、
 * こちらで洗い出す。指定できると、指定し忘れた方がいつまでも支払われない。
 */
export const closePayoutPeriodRequestSchema = z.object({
  periodKey: payoutPeriodKeySchema,
});
export type ClosePayoutPeriodRequest = z.infer<typeof closePayoutPeriodRequestSchema>;

export const closePayoutPeriodResponseSchema = z.object({
  periodKey: z.string(),
  items: z.array(payoutSchema),
});
export type ClosePayoutPeriodResponse = z.infer<typeof closePayoutPeriodResponseSchema>;

export const payoutListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  periodKey: payoutPeriodKeySchema.optional(),
  creatorAccountId: z.string().optional(),
  status: z.enum(PAYOUT_STATUS_VALUES).optional(),
});
export type PayoutListQuery = z.infer<typeof payoutListQuerySchema>;

/**
 * 繰越がマイナスのまま残っている作家さま（決定 2026-08-22）。
 *
 * ⚠️ **取り立てるための一覧ではない。** 見えるようにするだけである。
 * 差し引ききれなかった分は翌月へ繰り越されるが、その作家さまが二度と
 * 売らなければ**永久に残る**。毎月の下書きには出るが、他の下書きに
 * 埋もれて誰も拾わない——それが本当の欠陥だった。
 *
 * ⚠️ **金額を書き換える口はここにも無い**（`SETTLEMENT_AND_REFUND.md` §4）。
 */
export const negativeCarrySchema = z.object({
  /** ⚠️ 氏名やメールではなくアカウントID。画面では短縮して出す。 */
  creatorAccountId: z.string(),
  periodKey: z.string(),
  /** 残っている額。⚠️ **正の数**（符号は画面が付ける）。 */
  outstandingAmount: z.number().int(),
  /** いつからそうなっているか。⚠️ 放置の長さが読める。 */
  since: z.string(),
});
export type NegativeCarryDto = z.infer<typeof negativeCarrySchema>;

export const negativeCarryListResponseSchema = z.object({
  items: z.array(negativeCarrySchema),
});
export type NegativeCarryListResponse = z.infer<typeof negativeCarryListResponseSchema>;
