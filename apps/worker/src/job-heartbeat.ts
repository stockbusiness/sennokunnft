import type { JobHandler, RunnerLogger } from './runner';

/**
 * worker が自分で掃く仕事の「心拍」を残す包み（2026-08-22）。
 *
 * ⚠️ **これが無いと、動いている処理が画面では「まだ一度も成功して
 * いません」のままになる。** 心拍を書いていたのは API 側の内部ジョブの
 * 入口だけで、worker が待ち行列を直接掃く分は誰も記録していなかった。
 * 結果、運営の画面には**永久に消えない黄色**が並ぶ。
 *
 * ⚠️ **永久に消えない警告は、警告として働かない。** 消えない色があると、
 * 運営はその行を読み飛ばすようになり、**本当に止まった日にも気づけない**。
 * 直すべきは色のしきい値ではなく、心拍を書いていないことのほうである。
 *
 * ⚠️ **心拍を「入口」ではなく「仕事」に結びつける。** 入口ごとに書くと、
 * 同じ仕事に入口が 2 つある（API の口と worker の巡回）いま、片方から
 * 動かしたときだけ記録が残らない。種別（`jobKey`）は
 * `WATCHED_JOB_KEYS` と同じ言葉を使う——違う言葉を使うと、画面には
 * 見張られていない行と、誰も見ていない行が同時にできる。
 *
 * ⚠️ **API の口を worker から叩いて済ませない。** 叩けば心拍は残るが、
 * 同じ待ち行列を 2 経路から掃くことになり、HTTP を 1 往復ぶん無駄に
 * する。掃くのは worker、記録も worker、で揃える。
 */
/**
 * worker が自分で掃く仕事と、画面が見張っている種別名の対応。
 *
 * ⚠️ **ここを唯一の出どころにする。** 配線のなかに文字列を直接書くと、
 * 打ち間違えても誰も気づけない——ジョブは動き、控えも増えるのに、画面が
 * 見ている種別には何も入らないので、**直したはずの黄色がそのまま残る**。
 * 名前が `JOB_LABELS` に載っていることをテストで縛ってある。
 */
export const WORKER_JOB_KEYS = {
  /** 期限切れのお取り置きの解放（worker の `reservation-release`）。 */
  reservationRelease: 'release-expired-reservations',
  /** ウォレットへのお届け（worker の `wallet-delivery`）。 */
  walletDelivery: 'deliver-entitlements',
} as const;

export interface JobRunRecorderPort {
  recordJobRun(input: {
    readonly jobKey: string;
    readonly outcome: 'succeeded' | 'failed';
    readonly pickedCount?: number | undefined;
    readonly errorCode?: string | undefined;
    readonly now: Date;
  }): Promise<void>;
}

export interface JobHeartbeatOptions {
  /** 包む相手。 */
  readonly handler: JobHandler;
  /**
   * `job_runs` の種別。
   *
   * ⚠️ **`WATCHED_JOB_KEYS`（API 側）と同じ言葉にする。** worker 内部の
   * ハンドラ名（`reservation-release`）ではない。内部名で書くと、画面が
   * 見ている種別には何も入らず、直したはずの黄色が残る。
   */
  readonly jobKey: string;
  readonly recorder: JobRunRecorderPort;
  readonly now: () => Date;
  readonly logger: RunnerLogger;
}

/**
 * ジョブを心拍つきにする。
 *
 * ⚠️ **記録に失敗しても仕事は止めない。** 見張りの控えが書けないことを
 * 理由に、お取り置きの解放やお届けまで止めるのは本末転倒。握りつぶす
 * のはここだけで、**仕事そのものの例外は必ず投げ直す**（ランナーの
 * 隔離とログがそちらに掛かっている）。
 *
 * ⚠️ **失敗しても `last_succeeded_at` は消えない。** 消さないのは
 * リポジトリ側の作り。ここで「失敗したから成功を消す」を足さない。
 */
export function withJobHeartbeat(options: JobHeartbeatOptions): JobHandler {
  return {
    name: options.handler.name,

    async runOnce(): Promise<number> {
      let picked: number;
      try {
        picked = await options.handler.runOnce();
      } catch (error) {
        await safelyRecord(options, {
          jobKey: options.jobKey,
          outcome: 'failed',
          /*
            ⚠️ **例外の本文を控えへ入れない。** 外部 API の応答や
               DB のメッセージには、購入者や接続先が混じりうる。
               分類できる名前までにする。
          */
          errorCode: error instanceof Error ? error.name : 'UnknownError',
          now: options.now(),
        });
        throw error;
      }
      await safelyRecord(options, {
        jobKey: options.jobKey,
        outcome: 'succeeded',
        pickedCount: picked,
        now: options.now(),
      });
      return picked;
    },
  };
}

async function safelyRecord(
  options: JobHeartbeatOptions,
  input: Parameters<JobRunRecorderPort['recordJobRun']>[0],
): Promise<void> {
  try {
    await options.recorder.recordJobRun(input);
  } catch (error) {
    /*
      ⚠️ **黙って飲み込まない。** 握りつぶすのは処理を止めないためで
         あって、無かったことにするためではない。控えが書けない状態が
         続くと画面は「止まっている」と読み、運営が実体のない障害を
         追うことになる。ログには残す。
    */
    options.logger.error(
      { jobKey: input.jobKey, error: error instanceof Error ? error.name : 'UnknownError' },
      '時計仕掛けの控えを書けませんでした',
    );
  }
}
