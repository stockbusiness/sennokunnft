import type { JobHandler, RunnerLogger } from './runner';

/**
 * API の内部ジョブの口を、決めた間隔で叩く。
 *
 * ⚠️ **口はあったが、叩き手がいなかった。** 内部ジョブは 7 本あるのに、
 * 定時に叩く仕掛けがリポジトリのどこにも無かった（`vercel.json` にも
 * GitHub Actions にも `fly.*.toml` にも）。**設定しただけで動くと
 * 思われるのがいちばん困る**ので、叩き手をコードとして置く。
 *
 * ⚠️ **worker の中で処理を組み直さない。** 発行も知らせも、既に API 側で
 * 組み上がっている。同じ配線を worker にもう一組作ると、必ず片方が古くなる。
 * ここは**呼ぶだけ**にする。
 *
 * ⚠️ **`job_runs` への記録は API 側が行う。** ここで二重に記録しない。
 * 記録が 2 か所にあると、どちらが正か読めなくなる。
 */
export interface InternalJobCallerOptions {
  /** `https://api.example/api/v1/internal/jobs` まで。⚠️ 末尾のスラッシュは不要。 */
  readonly baseUrl: string;
  /** ⚠️ ログにも例外にも出さない。 */
  readonly token: string;
  /** 口の名前（`issue-entitlements` など）。**そのまま `job_runs` の種別になる。** */
  readonly path: string;
  /** 人が読むための名前。ログに出す。 */
  readonly label: string;
  /** この間隔より短くは叩かない。 */
  readonly everyMs: number;
  readonly logger: RunnerLogger;
  readonly now: () => Date;
  /** 応答を待つ上限。⚠️ 待ち続けると、ほかの仕事まで止まる。 */
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export function createInternalJobCaller(options: InternalJobCallerOptions): JobHandler {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastAttemptedAt: number | null = null;

  return {
    name: `internal-job:${options.path}`,

    async runOnce(): Promise<number> {
      const now = options.now().getTime();
      if (lastAttemptedAt !== null && now - lastAttemptedAt < options.everyMs) {
        return 0;
      }
      /*
        ⚠️ **「試みた時刻」で数える。成功した時刻ではない。**
           成功でしか進めないと、落ち続けている口を巡回のたびに叩き、
           相手が復旧しかけたところへ集中して押し寄せる。

        ⚠️ **投げる前に進める。** あとで進めると、投げている最中に
           次の巡回が来たときに二重に叩く。
      */
      lastAttemptedAt = now;

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      try {
        const response = await fetchImpl(`${options.baseUrl}/${options.path}`, {
          method: 'POST',
          headers: {
            // ⚠️ 合言葉。ログにも例外にも出さない。
            'x-internal-job-token': options.token,
            'content-type': 'application/json',
          },
          body: '{}',
          signal: controller.signal,
        });

        if (!response.ok) {
          /*
            ⚠️ **応答の本文を読まない。** 内部の口とはいえ、返るのは
               運用の数値である。ログへ流すと、そこから先はこちらの
               管理が及ばない。**状態コードまで**にする。
          */
          options.logger.error(
            { job: options.path, status: response.status },
            `${options.label}の内部ジョブが失敗を返しました`,
          );
          return 0;
        }
        return 1;
      } catch (error) {
        /*
          ⚠️ **例外の中身をログへ出さない。** URL に合言葉は載せていないが、
             接続先の姿は運用の秘密である。名前と、打ち切りかどうかまで。
        */
        const aborted = error instanceof Error && error.name === 'AbortError';
        options.logger.error(
          { job: options.path, aborted },
          `${options.label}の内部ジョブを呼べませんでした`,
        );
        return 0;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * worker が受け持つ内部ジョブと、その間隔。
 *
 * ⚠️ **`release-expired-reservations` と `deliver-entitlements` を入れて
 * いない。** worker が同じ待ち行列を直接掃いており、ここからも叩くと
 * 同じ仕事を 2 経路から呼ぶことになる（条件付き更新が守るので壊れは
 * しないが、無駄に往復する）。
 */
export const SCHEDULED_INTERNAL_JOBS: readonly {
  readonly path: string;
  readonly label: string;
  readonly everyMs: number;
}[] = [
  /*
    ⚠️ **これは取りこぼしの受け皿であって、主たる経路ではない。** ふだんは
       決済確定の直後にその場で発行される。短くしても意味は薄いが、
       落ちた直後の注文を長く待たせない程度には短くする。
  */
  { path: 'issue-entitlements', label: '受取権の発行', everyMs: 5 * 60_000 },
  { path: 'reconcile-revocations', label: '取消の知らせの補完', everyMs: 15 * 60_000 },
  /*
    ⚠️ **知らせは短い間隔で。** 「お支払いが済みました」が 1 時間後に
       届くと、買った方は届く前に問い合わせを始める。
  */
  { path: 'send-notifications', label: '知らせの送信', everyMs: 60_000 },
  /*
    ⚠️ **法務の改定は日次でよい。** 公開の直後にその場で積まれるので、
       ここが拾うのは取りこぼしだけ。
  */
  { path: 'enqueue-legal-notices', label: '改定のお知らせの積み込み', everyMs: 24 * 3_600_000 },
  /*
    ⚠️ **巡回は短く、鳴らす間隔は設定で決まる。** 巡回を長くすると、
       設定した `repeat_after_minutes` より粗くしか鳴らせなくなる。
  */
  { path: 'notify-operations-alerts', label: '運営への異常の知らせ', everyMs: 5 * 60_000 },
];
