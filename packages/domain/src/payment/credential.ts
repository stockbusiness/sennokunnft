import { err, ok, type Result } from '../shared/result';
import { domainError, type DomainError } from '../shared/errors';
import type { IntegrationEnvironment } from '../integration/service';

/**
 * 決済資格情報の世代（`UD-118`・`docs/PAYMENT_CREDENTIAL_ROTATION.md`）。
 *
 * ⚠️ **鍵の入れ替えと運営会社の変更は別物。** 同じアカウントで鍵を作り直す
 * だけなら上書きでよい。会社が変わると**アカウントごと変わる**ので、
 * 過去の決済の識別子（session / charge）は新しい鍵では引けない。
 * 上書きすると、**過去の注文が返金不能**になる。だから世代で持つ。
 *
 * ⚠️ **古い世代を消さない。** 返金と照会に要る。消せる口を作ると、いつか
 * 「もう使っていないから」と消される。
 *
 * ⚠️ **二者承認は行わない**（2026-08-19 決定）。オーナーが 1 人の運営で
 * 締め出しが起きるため。代わりに「戻せる状態を経由する」「接続確認を
 * 通らないと有効化できない」「本番では再認証と確認入力を求める」で守る。
 */

export const PAYMENT_CREDENTIAL_STATUSES = ['pending', 'active', 'retired'] as const;
export type PaymentCredentialStatus = (typeof PAYMENT_CREDENTIAL_STATUSES)[number];

/**
 * 署名検証で試す世代の数の上限。
 *
 * ⚠️ **世代が増えるほど検証の回数が増える。** 上限を決めておかないと、
 * 何年も運用したあとに Webhook の処理が重くなる。超えた分は運用で
 * `retired` を整理する（**削除ではなく、検証対象からの除外**）。
 */
export const CREDENTIAL_VERIFICATION_LIMIT = 5;

/**
 * 世代の姿。
 *
 * ⚠️ **鍵そのものを持たない。** 復号は送信アダプタだけが行う。ここへ
 * 平文を載せると、一覧や画面向けの経路から秘密へ手が届く。
 */
export interface PaymentCredentialGeneration {
  readonly id: string;
  readonly provider: string;
  readonly environment: IntegrationEnvironment;
  readonly generation: number;
  readonly status: PaymentCredentialStatus;
  /** 決済事業者側のアカウント識別子。⚠️ **秘密ではない。** */
  readonly accountRef: string | null;
  readonly label: string | null;
  readonly apiVersion: string | null;
  /** 直近の接続確認の成否。まだ確かめていなければ `null`。 */
  readonly lastCheckSucceeded: boolean | null;
  readonly lastCheckAt: Date | null;
  readonly lastWebhookReceivedAt: Date | null;
  readonly acceptsNewPayments: boolean;
  readonly activatedAt: Date | null;
  readonly retiredAt: Date | null;
  readonly createdAt: Date;
}

/**
 * いま新規の支払い口を作る世代。
 *
 * ⚠️ **`active` の中でいちばん新しい、ではない。** 受付の印
 * （`acceptsNewPayments`）で選ぶ。切り替えの途中で「有効だが受付はしない」
 * 世代ができるので、新しさで選ぶと入金先が変わってしまう。
 */
export function acceptingGeneration(
  generations: readonly PaymentCredentialGeneration[],
): PaymentCredentialGeneration | null {
  const accepting = generations.filter((row) => row.status === 'active' && row.acceptsNewPayments);
  /*
    ⚠️ **2 つあったら選ばない。** DB の部分UNIQUE が防いでいるが、
       万一そこが外れていたときに「たまたま先頭のほう」で入金先が
       決まるのは最悪。分からないなら止める。
  */
  return accepting.length === 1 ? (accepting[0] ?? null) : null;
}

/**
 * 署名検証で試す順序。
 *
 * ⚠️ **`retired` も含める。** 切り替え後も、旧アカウントで発生した決済の
 * 知らせは届き続ける。新しい世代だけ試すと、旧世代の決済が
 * 「署名が違う」として捨てられる。
 *
 * ⚠️ **順序は速さのためで、判定には影響しない。** 通るか通らないかだけを
 * 見る。新しい世代を先に試すのは、大半がそれで通るから。
 *
 * ⚠️ **上限を超えた古い世代は外れる。** 外れた世代の知らせは 400 になる。
 * それが困る間は `retired` にしないこと（運用の判断）。
 */
export function verificationOrder(
  generations: readonly PaymentCredentialGeneration[],
  limit: number = CREDENTIAL_VERIFICATION_LIMIT,
): readonly PaymentCredentialGeneration[] {
  return [...generations].sort((a, b) => b.generation - a.generation).slice(0, limit);
}

export interface ActivateGenerationInput {
  readonly target: PaymentCredentialGeneration;
  /** いま受付中の世代。無ければ `null`（最初の 1 本目）。 */
  readonly currentlyAccepting: PaymentCredentialGeneration | null;
  readonly now: Date;
}

/**
 * 有効化したあとの、2 つの世代の姿。
 *
 * ⚠️ **1 トランザクションで書く。** 分けると、受付世代が 2 つある瞬間か
 * 0 の瞬間ができる。前者は入金先が不定になり、後者は販売が止まる。
 * どちらも気づきにくい。
 */
export interface ActivatedGenerations {
  readonly activated: PaymentCredentialGeneration;
  /** 受付を降りた旧世代。無ければ `null`。⚠️ `retired` にはしない。 */
  readonly steppedDown: PaymentCredentialGeneration | null;
}

/**
 * 世代を有効化し、新規受付を引き継ぐ。
 *
 * ⚠️ **接続確認を通っていない世代は有効化しない。** 二者承認をやめた
 * 代わりの守り。鍵の打ち間違いをここで止める。
 */
export function activateGeneration(
  input: ActivateGenerationInput,
): Result<ActivatedGenerations, DomainError> {
  const { target, currentlyAccepting, now } = input;

  if (target.status === 'retired') {
    return err(domainError('PAYMENT_CREDENTIAL_NOT_ACTIVATABLE', 'retired generation'));
  }
  if (target.lastCheckSucceeded !== true) {
    /*
      ⚠️ 「まだ確かめていない」と「確かめて失敗した」を区別しない。
         どちらも有効化させない。
    */
    return err(domainError('PAYMENT_CREDENTIAL_CHECK_REQUIRED', 'connection check not passed'));
  }
  if (target.accountRef === null) {
    // 接続確認が通っていればアカウント識別子が入っているはず。
    return err(domainError('PAYMENT_CREDENTIAL_CHECK_REQUIRED', 'account ref is unknown'));
  }
  if (currentlyAccepting !== null && currentlyAccepting.id === target.id) {
    return err(domainError('PAYMENT_CREDENTIAL_NOT_ACTIVATABLE', 'already accepting'));
  }

  return ok({
    activated: {
      ...target,
      status: 'active',
      acceptsNewPayments: true,
      activatedAt: target.activatedAt ?? now,
    },
    steppedDown:
      currentlyAccepting === null
        ? null
        : /*
            ⚠️ **`retired` にしない。** 返金と照会は旧世代の鍵で続く。
               ここで退役させると、切り替えた瞬間に過去の注文が
               返金不能になる。退役は人が別途判断する。
          */
          { ...currentlyAccepting, acceptsNewPayments: false },
  });
}

/**
 * 世代を退役させる。
 *
 * ⚠️ **鍵は消さない。** 「新規受付をしない」に加えて「署名検証の対象から
 * 外す候補になる」だけ。過去の決済を照会する経路は残る。
 */
export function retireGeneration(
  generation: PaymentCredentialGeneration,
  now: Date,
): Result<PaymentCredentialGeneration, DomainError> {
  if (generation.acceptsNewPayments) {
    /*
      ⚠️ 受付中の世代を退役させない。させると販売が止まり、
         しかも「なぜ止まったか」が画面から読み取りにくい。
    */
    return err(domainError('PAYMENT_CREDENTIAL_IN_USE', 'still accepting new payments'));
  }
  if (generation.status === 'retired') {
    return ok(generation);
  }
  return ok({ ...generation, status: 'retired', acceptsNewPayments: false, retiredAt: now });
}

/**
 * 販売を続けられる状態か。
 *
 * ⚠️ **受付世代が無ければ売れない。** 「どこかに有効な世代がある」では
 * 足りない。入金先が定まらないまま支払い口を作らせない。
 */
export function canAcceptPayments(generations: readonly PaymentCredentialGeneration[]): boolean {
  return acceptingGeneration(generations) !== null;
}
