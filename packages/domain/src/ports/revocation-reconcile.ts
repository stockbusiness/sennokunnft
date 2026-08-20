/**
 * 取消の知らせの取りこぼしを拾い直す口（M3a）。
 *
 * ⚠️ **これは「あとから埋める」ための道具である。** 通常は返金と同じ
 * トランザクションで取消の知らせを積む。ここが拾うのは、
 * 生成フラグが無効だったあいだに取り消された分と、
 * 何かの拍子に積めなかった分だけ。
 *
 * ⚠️ **判定を DB 側に置いている。** 「取り消し済みで、相手が知っていて、
 * まだ取消の知らせが無い」は記録から導ける。別に待ち行列を作ると、
 * その行列自体がずれていく。
 */

/** 取消の知らせが足りない受取権 1 件ぶんの材料。 */
export interface MissingRevocation {
  readonly entitlementId: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly artworkId: string;
  /** 受取権の列。付与イベントから取れないときの控え。 */
  readonly claimedCommonUserId: string | null;
  /** 付与イベントの本文に入れた値。⚠️ **こちらが正**（相手へ伝えた値）。 */
  readonly grantedCommonUserId: string | null;
  readonly grantedCorrelationId: string | null;
  /**
   * イベントの発生時刻。
   *
   * ⚠️ **現在時刻ではない。** その注文の全額返金が成立した時刻を使う。
   * いま埋めているからといって「いま取り消した」ことにすると、
   * 相手の記録では取消が何日も後にずれる。
   */
  readonly occurredAt: Date;
}

export interface RevocationReconcileRepository {
  /**
   * 取消の知らせが足りない受取権を、古い順に返す。
   *
   * ⚠️ **付与の知らせが無いものは含めない。** 相手が知らない受取権の
   * 取消を送ると、相手には「知らないIDの取消」が届き続ける。
   */
  listMissing(limit: number): Promise<readonly MissingRevocation[]>;
}
