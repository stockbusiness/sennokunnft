import {
  buildGrantedEvent,
  TARGET_SITE_KEY,
  type ClaimArtworkSnapshot,
  type ClaimDeliveryEnqueue,
  type IdGeneratorPort,
  type StoragePort,
} from '@sengoku/domain';
import type { ContentHasher } from '../common/content-hash';
import { DomainErrorException } from '../common/domain-error.filter';

/**
 * 受取確定と同時に載せる配送本文を組み立てる。
 *
 * ⚠️ **ここで本文を確定させ、以後は触らない。**
 * 配送のたびに作り直すと、そのあいだに作品名や画像が差し替わった場合に、
 * **同じイベントIDで別の内容**が送られる。相手は冪等キーで弾くので、
 * どちらの内容が保存されたのかを誰も特定できない。
 *
 * ⚠️ **公開URLの解決を配送側へ回さない。**
 * 送る時刻の設定に依存させると、設定を変えた瞬間に過去の再試行が
 * 別の URL を送り出す。
 */
export class WalletDeliveryPlanner {
  constructor(
    private readonly ids: IdGeneratorPort,
    private readonly storage: StoragePort,
    private readonly hashContent: ContentHasher,
  ) {}

  plan(input: {
    readonly entitlementId: string;
    readonly commonUserId: string;
    readonly correlationId: string;
    readonly snapshot: ClaimArtworkSnapshot;
    readonly now: Date;
  }): ClaimDeliveryEnqueue {
    const { snapshot } = input;
    if (snapshot.imageKey === null || snapshot.imageHash === null) {
      // 画像の無い作品は売れない前提だが、確かめずに送ると
      // 相手側に画像の壊れた Holding が残る。手前で落とす。
      throw new DomainErrorException('WALLET_EVENT_INVALID');
    }

    const event = buildGrantedEvent({
      eventId: `evt_${this.ids.generate()}`,
      occurredAt: input.now,
      correlationId: input.correlationId,
      commonUserId: input.commonUserId,
      entitlementId: input.entitlementId,
      orderId: snapshot.orderId,
      orderLineId: snapshot.orderLineId,
      artworkId: snapshot.artworkId,
      artworkTitle: snapshot.artworkTitle,
      artworkDescription: snapshot.artworkDescription,
      imageUrl: this.storage.publicUrl(snapshot.imageKey),
      // サムネイルは MVP で作らない。列も生成処理も無い。
      thumbnailUrl: null,
      imageHash: snapshot.imageHash,
      serialNo: snapshot.serialNo,
    });
    if (!event.ok) {
      throw new DomainErrorException(event.error.code);
    }

    // ⚠️ **ここで 1 回だけ文字列にする。**
    //    保存・ハッシュ・署名・送信のすべてがこの同じ文字列を使う。
    //    どこかで作り直すと、署名対象と送信内容がずれる。
    const payload = JSON.stringify(event.value);

    return {
      eventId: event.value.event_id,
      eventType: 'entitlement.granted',
      targetSiteKey: TARGET_SITE_KEY,
      payload,
      payloadHash: this.hashContent(payload),
      correlationId: input.correlationId,
    };
  }
}
