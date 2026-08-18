/**
 * 接続確認（指示書 §4.3・§9）。
 *
 * ⚠️ **実送信のテストイベントは作らない（要決定 06）。**
 * 指示書 §4.3 は「production へ影響しないテストイベント送信」を挙げつつ、
 * 末尾で「安全なテスト手段がなければ実送信ボタンを作らない」と定めている。
 * OVEW Wallet 側にテスト用の受け口があるかは、こちらでは確認できていない。
 * 確認がとれるまで、**業務データを 1 バイトも送らない**確認だけを行う。
 *
 * ⚠️ **この確認で分かることと分からないことを、はっきり分けて扱う。**
 *  分かる:   接続先のホストが名前解決でき、TLS が張れ、HTTP の応答が返ること
 *  分からない: 資格情報（API キー・HMAC 鍵）が正しいかどうか
 *              相手が本文を受け取れるかどうか
 * 「テスト成功」の 2 文字だけを画面に出すと、後者まで確かめた気にさせる。
 * 画面には必ず、何を確かめていないかを併記すること。
 */

/** 確認の種別。⚠️ いまは 1 種類だけ。増やすときは要決定 06 の再確認から。 */
export const CONNECTION_CHECK_KINDS = ['reachability'] as const;
export type ConnectionCheckKind = (typeof CONNECTION_CHECK_KINDS)[number];

export function isConnectionCheckKind(value: string): value is ConnectionCheckKind {
  return (CONNECTION_CHECK_KINDS as readonly string[]).includes(value);
}

/**
 * 確認を行ったときの結果。
 *
 * ⚠️ **外部の応答本文を持たない。** 持てるのは HTTP の状態コードまで。
 * 本文には相手の内部情報が入りうるし、こちらで保存する理由も無い。
 */
export type ProbeOutcome =
  | { readonly kind: 'response'; readonly statusCode: number }
  | { readonly kind: 'timeout' }
  /** 接続そのものが張れなかった。`code` は Node が返す短い符号のみ。 */
  | { readonly kind: 'network'; readonly code: string | null };

export interface CheckVerdict {
  readonly succeeded: boolean;
  readonly failureCode: string | null;
  readonly httpStatus: number | null;
}

/**
 * 確認の結果を「成功か失敗か」に落とす。
 *
 * ⚠️ **4xx を失敗にしない。** こちらが送るのは副作用の無い `OPTIONS` で、
 * POST しか受けない経路では 404 や 405 が正しい応答になる。
 * これを失敗にすると、正しく設定されているのに有効化できなくなる。
 * ただし「届いたが応答は 405 だった」ことは画面に出す。パスの綴り違いも
 * 同じ見え方をするため、人が確かめられるようにしておく。
 *
 * ⚠️ **5xx は失敗にする。** 届いてはいるが、相手が壊れている。
 * その状態で本番を有効にすると、有効にした直後から失敗が溜まる。
 */
export function classifyProbe(outcome: ProbeOutcome): CheckVerdict {
  switch (outcome.kind) {
    case 'timeout':
      return { succeeded: false, failureCode: 'timeout', httpStatus: null };
    case 'network':
      return {
        succeeded: false,
        // ⚠️ 符号だけ。ホスト名や URL は載せない。
        failureCode: outcome.code ?? 'network',
        httpStatus: null,
      };
    case 'response': {
      const status = outcome.statusCode;
      if (status >= 500) {
        return { succeeded: false, failureCode: 'http_5xx', httpStatus: status };
      }
      return { succeeded: true, failureCode: null, httpStatus: status };
    }
  }
}

/**
 * 接続確認を行ってよいか。
 *
 * ⚠️ **接続先が無いまま試させない。** 「テストしたが失敗した」と
 * 「そもそも接続先を入れていない」は、直し方がまったく違う。
 */
export function canRunCheck(settings: { readonly endpointUrl: string | null }): boolean {
  return settings.endpointUrl !== null && settings.endpointUrl !== '';
}
