import type { AlertMessage, AlertWebhookPort } from '@sengoku/domain';

/**
 * 外部の受け口へ知らせを送る（Slack の受け口など）。
 *
 * ⚠️ **失敗しても投げない。** 知らせが送れないことで、知らせようとした
 * 異常の対応が止まってはいけない。返すのは成否だけ。
 *
 * ⚠️ **URL をログへ出さない。** URL 自体が合言葉である（Slack の受け口が
 * そう）。失敗したときも、出すのはホスト名までにする。
 *
 * ⚠️ **応答の本文を読まない。** 相手の応答に何が入っているか分からない。
 * 読んで記録すると、そこから外の値がこちらのログへ入る。
 */
export class HttpAlertWebhook implements AlertWebhookPort {
  constructor(
    private readonly timeoutMs = 5_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async post(url: string, message: AlertMessage): Promise<{ readonly ok: boolean }> {
    /*
      ⚠️ **必ず打ち切る。** 相手が応答を返さないと、時計仕掛けの巡回が
         そこで止まる。止まると、ほかの異常にも気づけなくなる。
    */
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        /*
          ⚠️ **`text` と構造の両方を入れる。** Slack は `text` を読み、
             ほかの受け口は構造を読む。受け口ごとに実装を分けない。
          ⚠️ **個人情報は入っていない**（ドメインが項目名と件数までに
             している）。ここで足さないこと。
        */
        body: JSON.stringify({
          text: `${message.subject}\n\n${message.body}`,
          severity: message.payload.severity,
          reason: message.payload.reason,
          items: message.payload.items,
        }),
        signal: controller.signal,
      });
      return { ok: response.ok };
    } catch {
      // ⚠️ 例外の中身を返さない。URL が載っていることがある。
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  }
}
