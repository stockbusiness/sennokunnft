/**
 * 認可判定。
 *
 * ここは**純粋関数**であり、HTTP も DB も知らない。
 * NestJS の Guard はこの関数を呼ぶだけにする。
 * 純粋関数にすることで、AUTHORIZATION_DESIGN.md §2.3 の権限マトリクスを
 * 表駆動テストで全セル検証できる。
 */

export const ROLES = ['anonymous', 'buyer', 'operator', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  'artwork.view_public',
  'artwork.view_unpublished',
  'artwork.manage',
  'listing.manage',
  // --- 出品者が「自分の作品」に対して行う操作（UD-102 決定変更 2026-08-18）---
  // ⚠️ **`artwork.manage` を buyer に渡さない。** それは他人の作品も含む権限。
  //    自分のものだけを触れる操作として、別の名前で分ける。
  'artwork.create_own',
  'artwork.manage_own',
  'listing.manage_own',
  'order.create',
  'order.view',
  'order.view_any',
  // --- 問い合わせ対応（`UD-121`）---
  /**
   * 聞き取ったメールアドレスから注文を辿る。
   *
   * ⚠️ **`order.view_any` と分けてある。** 一覧を見ることと、
   * 「このアドレスの方が買ったか」を確かめられることは別の力である。
   * 後者は、注文の有無そのものを人に紐づけて答えられることを意味する。
   * ⚠️ **広げるのは簡単、狭めるのは難しい**（`ADMIN_OPERATIONS_GAP.md` §5）。
   * まず `operator` だけに置く。`auditor` へ広げるかは未決（`UD-121`）。
   */
  'order.lookup_buyer',
  /** 対応メモを書く。⚠️ 追記のみ。直す口も消す口も無い。 */
  'order.note',
  /**
   * 返金する（`UD-104` / `UD-120`）。
   *
   * ⚠️ **オーナー限定にしていない。** 問い合わせ対応の日常業務で、
   * オーナーを待たせると「返金してもらえない」時間が延びる。
   *
   * ⚠️ **`payment_credential.manage` と重さが違う**——あちらは**これからの
   * 売上の振込先**が変わる（乗っ取った本人の口座へ流れる）。返金は
   * **払った本人のカードへ戻る**だけで、攻撃者の利得にならない。
   * 被害の形が違うので、守りの重さも変える。
   *
   * ⚠️ **`auditor` には渡さない。** お金が動く操作である。
   */
  'order.refund',
  /**
   * 顧客の詳細を見る（P1-1）。
   *
   * ⚠️ **`order.view_any` と分けてある。** 注文を一覧で見ることと、
   * 「この方が何を買い、何を受け取り、いくら返金されたか」を 1 人ぶん
   * まとめて見ることは、別の力である。まとめて見えるということは、
   * その方の行動が 1 画面に集まるということでもある。
   */
  'customer.view',
  /**
   * 顧客について申し送りを書く（P1-1）。
   *
   * ⚠️ **追記のみ。** 直す口も消す口も無い（`order.note` と同じ）。
   */
  'customer.note',
  /**
   * ご連絡先の変更申請を扱う（P1-1）。
   *
   * ⚠️ **`auditor` には渡さない。** 本人確認の記録は、乗っ取りを止める
   * 最後の砦である。見るだけの人が「確認した」と押せてはいけない。
   *
   * ⚠️ **この操作でアドレスは変わらない。** 変えるのは認証基盤側で人が行う。
   */
  'customer.email_change',
  'checkout.create',
  'claim.inspect',
  'claim.accept',
  'claim.reissue',
  'collection.view',
  'mint_job.retry',
  'audit_log.view',
  // --- 人事（`UD-803` 決定 2026-08-18）。**オーナーだけ**が行える ---
  // ⚠️ ロール表に載せるだけでは足りない。下の `OWNER_ONLY_ACTIONS` で
  //    オーナーの印を追加で要求する。
  'staff.view',
  'staff.invite',
  'staff.manage',
  // --- 外部連携（管理画面・外部連携 指示書 §8）---
  // ⚠️ 閲覧は運営と閲覧者にも開く。設定と資格情報はオーナーだけ。
  'integration.view',
  'integration.manage',
  'integration.manage_secret',
  'wallet_delivery.retry',
  // --- 運用確認キュー（M3a）---
  // ⚠️ **閲覧は閲覧者にも開く。** 「機械が決められなかったこと」が
  //    何件残っているかは、監査の対象そのものである。
  // ⚠️ **対応済みにできるのは運営だけ。** 状態を動かす操作であり、
  //    「誰が確認したか」が記録に残る。
  'operations_review.view',
  'operations_review.resolve',
  // --- 購入者への知らせ（P0-4）---
  // ⚠️ **閲覧は閲覧者にも開く。** 「送ったつもりで送れていない」件数は、
  //    監査の対象そのもの。ただし出るのは伏せた宛先だけ（`UD-503`）。
  'notification.view',
  // ⚠️ **文面を書けるのは運営。公開はオーナー**（下の `OWNER_ONLY_ACTIONS`）。
  //    公開した文面はそのまま全購入者へ届く。書く人と決める人を分ける。
  'notification.edit',
  'notification.publish',
  // ⚠️ 再送は運営の日常業務。本文は確定済みで、新しく何かを決める操作ではない。
  'notification.resend',
  // --- 運営ダッシュボード（P0-6）---
  // ⚠️ **閲覧は閲覧者にも開く。** 「いま何が滞っているか」は監査の
  //    対象そのもの。出るのは件数と識別子までで、個人情報は含まない。
  'operations.view',
  // ⚠️ **やり直しは運営だけ。** 発行のやり直しも再配送も、外部へ
  //    実際に送る操作である。見るのと動かすのを分ける。
  'operations.retry',
  // --- 法務文書（利用規約・プライバシーポリシー・特商法表記）---
  // ⚠️ 下書きは運営スタッフが書ける。**公開はオーナーだけ**（下の
  //    `OWNER_ONLY_ACTIONS`）。公開した版は取り消せず、そこに書いた
  //    ことは購入者への約束になるため、書く人と決める人を分ける。
  'legal.view',
  'legal.edit',
  'legal.publish',
  /**
   * 自分の同意を確かめ、同意する（`UD-126`）。
   *
   * ⚠️ **会員なら誰でも持つ。** 同意するのは本人で、代理はできない。
   * 運営に免除を与えない（`OWNERSHIP_RULES` の `claim.accept` と同じ考え方）。
   */
  'legal.consent',
  // --- 決済資格情報の世代（`UD-118`）---
  // ⚠️ 見るのは運営と閲覧者にも開く。状態が見えないと、決済が止まった
  //    ときに誰も原因を追えない。
  'payment_credential.view',
  // ⚠️ **オーナー限定**（下の `OWNER_ONLY_ACTIONS`）。入金先が変わる操作。
  'payment_credential.manage',
  // --- 返金と精算の設定（`UD-104` / `UD-119`）---
  // ⚠️ 見るのは運営と閲覧者にも開く。返金の期限が見えないと、
  //    問い合わせに答えられない。
  'settlement.view',
  /**
   * 返金の期限・締め・最低支払額・振込手数料の負担を変える。
   *
   * ⚠️ **オーナー限定**（下の `OWNER_ONLY_ACTIONS`）。購入者への返金と
   * 作家さまへの支払いの**両方**を動かす。運営の 1 人が乗っ取られただけで、
   * 「返金を受け付けない」「支払いを止める」に書き換えられてしまう。
   */
  'settlement.manage',
  /**
   * 精算を見る（`UD-119`）。
   *
   * ⚠️ **`auditor` にも開く。** いくら誰へ払ったかが見えないと監査に
   * ならない。見ることと動かすことは、別の力として分ける。
   */
  'payout.view',
  /**
   * 精算を締める・確定する（`UD-119`）。
   *
   * ⚠️ **`auditor` には渡さない。** 集計そのものは金額を動かさないが、
   * 確定は作家さまへ渡す明細を確定させる操作である。
   */
  'payout.manage',
  /**
   * 支払い済みにする（`UD-119`）。
   *
   * ⚠️ **オーナー限定**（下の `OWNER_ONLY_ACTIONS`）。「振り込んだ」と
   * 記録する操作で、**実際に振り込んだかどうかを機械は確かめられない**。
   * 記録だけ進めれば、作家さまには「支払い済み」と見えたまま入金が無い、
   * という状態を作れてしまう。締める人と、払ったと宣言する人を分ける。
   */
  'payout.mark_paid',
  /**
   * 自分の表示名を決める（決定 2026-08-20）。
   *
   * ⚠️ **`_own` である。** 他人の表示名を書き換える口は作らない。名乗る
   * 名前は本人のもので、運営が勝手に変えるものではない。なりすましへの
   * 対応は、名前の書き換えではなくアカウントの停止（`status`）で行う。
   *
   * ⚠️ **会員なら誰でも持つ。** 出品する前に名前を決めたい方がいる。
   * 「作品を 1 つ作らないと名乗れない」という順序を強いない。
   */
  'profile.manage_own',
] as const;
export type Action = (typeof ACTIONS)[number];

export interface Actor {
  readonly role: Role;
  /** 認証済みなら内部アカウントID、未認証なら `null`。 */
  readonly accountId: string | null;
  /** アカウントが有効か。停止中は認証済みでも操作させない。 */
  readonly isActive: boolean;
  /**
   * 人に権限を配れるか（`UD-803`）。
   *
   * ⚠️ **ロールとは別の軸。** ロールは「作品や注文に何ができるか」、
   * こちらは「人事を触れるか」。4 つ目のロールにすると、`operator` に
   * 許した操作をすべて写す必要が生まれ、写し忘れが
   * 「オーナーだけできない操作」として静かに残る。
   *
   * ⚠️ **正は DB（`accounts.is_owner`）。** トークンからは読まない。
   */
  readonly isOwner: boolean;
}

/**
 * 操作対象。所有者が定まらない操作（一覧など）では `ownerAccountId` を省略する。
 */
export interface Resource {
  readonly ownerAccountId?: string | null;
}

export const ANONYMOUS: Actor = {
  role: 'anonymous',
  accountId: null,
  isActive: false,
  isOwner: false,
};

/**
 * ロールごとに許可される操作。
 *
 * **既定は deny。** ここに書かれていない組み合わせはすべて拒否される。
 * 「印を付け忘れたら公開されてしまう」ではなく
 * 「付け忘れたら閉じる」向きにするための構造。
 */
const ROLE_ACTIONS: Readonly<Record<Role, readonly Action[]>> = {
  anonymous: ['artwork.view_public'],
  buyer: [
    'artwork.view_public',
    // 会員なら誰でも出品できる（`UD-806`、暫定）。
    // ⚠️ 合言葉の門が実質の入場制限として働いていることが前提。
    //    門を外して一般公開する前に、ここを締め直す。
    'artwork.create_own',
    'artwork.manage_own',
    'listing.manage_own',
    'order.create',
    'order.view',
    'checkout.create',
    'claim.inspect',
    'claim.accept',
    'claim.reissue',
    'collection.view',
    'legal.consent',
    // ⚠️ 自分の分だけ。他人の表示名は書き換えられない。
    'profile.manage_own',
  ],
  operator: [
    'artwork.view_public',
    'artwork.view_unpublished',
    'artwork.manage',
    'listing.manage',
    // 運営も自分名義で登録できる。所有権は下の bypass で免除される。
    'artwork.create_own',
    'artwork.manage_own',
    'listing.manage_own',
    'order.view',
    'order.view_any',
    // ⚠️ 問い合わせ対応（`UD-121`）。`auditor` には渡していない。
    'order.lookup_buyer',
    'order.note',
    // ⚠️ お金が動く。`auditor` には渡さない（記録は見られる）。
    'order.refund',
    // 問い合わせ対応（P1-1）。⚠️ 本人確認は `auditor` には渡さない。
    'customer.view',
    'customer.note',
    'customer.email_change',
    'collection.view',
    'mint_job.retry',
    'audit_log.view',
    // ⚠️ ここに載っていても、オーナーの印が無ければ下で拒否される。
    //    ロール表に載せるのは「運営の仕事のひとつである」ことを示すため。
    'staff.view',
    'staff.invite',
    'staff.manage',
    'integration.view',
    // ⚠️ ここに載っていても、オーナーの印が無ければ下で拒否される。
    'integration.manage',
    'integration.manage_secret',
    // ⚠️ 再送はオーナーの印を要らない。運営の日常業務であり、
    //    送る内容は Outbox に確定済みで、新しく何かを決める操作ではない。
    'wallet_delivery.retry',
    // ⚠️ オーナーの印は要らない。金額も権利も動かさず、
    //    「確認した」という印を付けるだけの操作である。
    'operations_review.view',
    'operations_review.resolve',
    'notification.view',
    'notification.edit',
    // ⚠️ ここに載っていても、オーナーの印が無ければ下で拒否される。
    'notification.publish',
    'notification.resend',
    'operations.view',
    'operations.retry',
    'legal.view',
    'legal.edit',
    // ⚠️ ここに載っていても、オーナーの印が無ければ下で拒否される。
    'legal.publish',
    // 運営も利用者として同意する。
    'legal.consent',
    'payment_credential.view',
    // ⚠️ ここに載っていても、オーナーの印が無ければ下で拒否される。
    'payment_credential.manage',
    'settlement.view',
    // ⚠️ ここに載っていても、オーナーの印が無ければ下で拒否される。
    'settlement.manage',
    'payout.view',
    'payout.manage',
    // ⚠️ ここに載っていても、オーナーの印が無ければ下で拒否される。
    'payout.mark_paid',
    // 運営も自分名義で出品できる（`artwork.create_own` と同じ考え方）。
    'profile.manage_own',
  ],
  auditor: [
    'artwork.view_public',
    'artwork.view_unpublished',
    'order.view',
    'order.view_any',
    /*
      ⚠️ **顧客の詳細は渡さない。** 監査は「運営が何をしたか」を見る仕事で、
         「その方が何を買ったか」を 1 画面で見る必要は無い。まとめて
         見えることそのものが力なので、必要のない人には渡さない。
    */
    'collection.view',
    'audit_log.view',
    // 状態と履歴は見られるが、変更も再送もできない（指示書 §8）。
    'integration.view',
    // ⚠️ 見るだけ。対応済みにはできない。
    'operations_review.view',
    // ⚠️ 見るだけ。文面は書けず、送り直しもできない。
    'notification.view',
    // ⚠️ 見るだけ。やり直しはできない。
    'operations.view',
    // ⚠️ 過去の版も見られる。「その時点でどう書いてあったか」を
    //    確かめるのは、まさに監査の仕事。
    'legal.view',
    'legal.consent',
    'payment_credential.view',
    // ⚠️ 監査は返金の条件を確かめられる必要がある。変えることはできない。
    'settlement.view',
    // ⚠️ いくら誰へ払ったかが見えないと監査にならない。締めることはできない。
    'payout.view',
  ],
};

/**
 * 所有権の確認が必要な操作と、その免除条件。
 *
 * ロール判定だけで通すと、他人のIDを指定して閲覧できる脆弱性（IDOR）になる。
 * これらの操作では、対象リソースの所有者とアクターの一致を必ず確認する。
 *
 * `bypass` を持つ操作は、その広域権限を持つロールに限り所有権チェックを免除する。
 * 免除は**操作ごとに明示**する。「管理者だから何でも見てよい」という
 * 包括的な抜け道を作らないため。
 */
/**
 * オーナーの印を追加で要求する操作（`UD-803`）。
 *
 * ⚠️ **ロールの表とは別に持つ。** 「運営ならできる」と
 * 「人事を触れる」を同じ表で表すと、運営に何か足すたびに
 * 人事権まで一緒に配ってしまう危険がある。軸を分けておく。
 *
 * ⚠️ **一覧の閲覧もオーナーに限る。** スタッフ一覧には業務用の
 * 連絡先が並ぶ。見せる相手を、配る相手と同じところまで絞る。
 */
const OWNER_ONLY_ACTIONS: readonly Action[] = [
  'staff.view',
  'staff.invite',
  'staff.manage',
  // ⚠️ 接続先と資格情報はオーナーだけ（指示書 §8）。
  //    運営の 1 人が乗っ取られただけで、送信先ごと差し替えられてしまう。
  'integration.manage',
  'integration.manage_secret',
  // ⚠️ **公開はオーナーだけ。** 公開した版は取り消せない（新しい版を
  //    足すことしかできない）。書いた内容は購入者への約束になるので、
  //    下書き（`legal.edit`）と決裁を分ける。
  'legal.publish',
  // ⚠️ **公開した文面は、そのまま全購入者へ届く。** 直したつもりの 1 文字が
  //    数千通に載る。書く（`notification.edit`）人と決める人を分ける。
  'notification.publish',
  // ⚠️ **入金先が変わる操作。** 運営の 1 人が乗っ取られただけで、
  //    売上の振込先を差し替えられてしまう。
  'payment_credential.manage',
  // ⚠️ **返金と支払いの両方を動かす操作**（`UD-104` / `UD-119`）。
  //    「返金を受け付けない」「支払いを止める」に書き換えられる。
  'settlement.manage',
  /*
    ⚠️ **「振り込んだ」と記録する操作**（`UD-119`）。実際に振り込んだかを
       機械は確かめられないので、記録だけ進めれば「支払い済みなのに入金が
       無い」を作れる。締める（`payout.manage`）人と分ける。
  */
  'payout.mark_paid',
];

const OWNERSHIP_RULES: Readonly<Partial<Record<Action, { readonly bypass?: Action }>>> = {
  'order.view': { bypass: 'order.view_any' },
  // ⚠️ **`artwork.create_own` は所有権を要らない。** まだ作品が無いため。
  //    「作った人が持ち主になる」は作成時に決まる話で、判定ではない。
  'artwork.manage_own': { bypass: 'artwork.manage' },
  'listing.manage_own': { bypass: 'listing.manage' },
  'checkout.create': {},
  // 受取の実行は購入者本人のみ。運営でも代行できない（UD-804 が未決定のため）。
  'claim.accept': {},
  // ⚠️ 受取URLの再発行も**購入者本人のみ**。運営に免除を与えない。
  //    再発行は旧 URL を失効させ、新しい受取口を作る操作であり、
  //    代行できるなら「運営が誰かの受取先を差し替えられる」ことになる。
  //    運営代行の可否は `UD-1009` で未決定。決まるまで経路を作らない。
  'claim.reissue': {},
  // 運営が受取状況を見るときは /admin/entitlements（order.view_any）を使う。
  'collection.view': {},
};

export type AuthorizationDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: DenyReason };

export type DenyReason =
  | 'unauthenticated'
  | 'inactive_account'
  | 'role_not_permitted'
  /** 対象リソースの持ち主ではない。 */
  | 'not_owner'
  /** 人事を触れる印（オーナー）が無い。 */
  | 'not_site_owner';

function allow(): AuthorizationDecision {
  return { allowed: true };
}

function deny(reason: DenyReason): AuthorizationDecision {
  return { allowed: false, reason };
}

/**
 * アクターが対象リソースに対して操作を行えるかを判定する。
 *
 * 判定は 3 段階（AUTHORIZATION_DESIGN.md §2.2）:
 *  1. 認証状態
 *  2. ロールに対する操作の許可
 *  3. 所有権
 */
export function can(actor: Actor, action: Action, resource: Resource = {}): AuthorizationDecision {
  // 1. 認証・アカウント状態
  if (actor.role !== 'anonymous') {
    if (actor.accountId === null) {
      return deny('unauthenticated');
    }
    if (!actor.isActive) {
      return deny('inactive_account');
    }
  }

  // 2. ロール判定
  if (!ROLE_ACTIONS[actor.role].includes(action)) {
    return deny('role_not_permitted');
  }

  // 2.5 オーナーの印（`UD-803`）
  if (OWNER_ONLY_ACTIONS.includes(action) && !actor.isOwner) {
    return deny('not_site_owner');
  }

  // 3. 所有権判定
  const ownershipRule = OWNERSHIP_RULES[action];
  if (ownershipRule !== undefined) {
    const bypass = ownershipRule.bypass;
    const hasBypass = bypass !== undefined && ROLE_ACTIONS[actor.role].includes(bypass);
    if (!hasBypass) {
      if (actor.accountId === null) {
        return deny('unauthenticated');
      }
      if (resource.ownerAccountId == null || resource.ownerAccountId !== actor.accountId) {
        return deny('not_owner');
      }
    }
  }

  return allow();
}

/**
 * 認証とロールだけで判定する（3 段目の所有権を見ない）。
 *
 * ⚠️ **ガードはこちらを使う。**
 * ガードは対象リソースを読み込む前に走るので、所有者が分からない。
 * そこで `can()` を対象なしで呼ぶと、**所有権が要る操作は常に拒否**になり、
 * エンドポイントに永久に到達できない。実際 `claim.reissue` で起きた。
 *
 * ⚠️ **これを使う側には義務がある。**
 * 所有権が要る操作では、対象を読み込んだあとに **`can()` を対象付きで
 * 呼び直す**か、同等の本人確認を行うこと。ここで通ったことは
 * 「入口を通ってよい」までしか意味しない。怠ると、他人のIDを指定して
 * 操作できる穴（IDOR）が残る。
 */
export function canAtRoleLevel(actor: Actor, action: Action): AuthorizationDecision {
  if (actor.role !== 'anonymous') {
    if (actor.accountId === null) {
      return deny('unauthenticated');
    }
    if (!actor.isActive) {
      return deny('inactive_account');
    }
  }
  if (!ROLE_ACTIONS[actor.role].includes(action)) {
    return deny('role_not_permitted');
  }
  // ⚠️ **ここでも印を見る。** 対象を読み込まなくても判定できるため、
  //    ガードの段階で止められる。ハンドラ側の書き漏れに頼らない。
  if (OWNER_ONLY_ACTIONS.includes(action) && !actor.isOwner) {
    return deny('not_site_owner');
  }
  return allow();
}

/** その操作が所有権の確認を要するか。 */
export function requiresOwnership(action: Action): boolean {
  return OWNERSHIP_RULES[action] !== undefined;
}

/** 判定を真偽値だけで使いたい箇所のための薄い糖衣。 */
export function isAllowed(actor: Actor, action: Action, resource: Resource = {}): boolean {
  return can(actor, action, resource).allowed;
}
