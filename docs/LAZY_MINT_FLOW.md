# LAZY_MINT_FLOW.md — 遅延発行（Lazy Mint）フロー

記法は [README.md](./README.md) に従う。

✅ **事実:** Phase 1 では本フローを**実装しない**（ドメイン層の状態遷移のみ実装）。

---

## 1. 「遅延発行」の定義

🟡 **仮決定:** 本システムにおける Lazy Mint は次を指す。

> **購入の時点ではトークンを発行せず、購入者が Claim（受取）を実行した時点で初めて発行する方式。**

利点:

| #   | 利点                                                                   |
| --- | ---------------------------------------------------------------------- |
| 1   | 購入者が受け取らなかった分の発行費用が発生しない                       |
| 2   | 決済処理とチェーン処理を分離でき、決済がチェーン障害に引きずられない   |
| 3   | 購入者がアカウントを持つ前に販売できる（Claim 時に本人性を確定させる） |
| 4   | チェーン仕様が未確定でも、Claim までのフローを先に完成させられる       |

トレードオフ: 「買ったのにまだ手元にない」期間が生じる。
→ UI で「受取り待ち」を明示し、Claim を促す導線が必要。

---

## 2. 全体フロー

```
 ① 運営: 作品登録              artworks (draft)
        │
 ② 運営: 出品                  listings (active)
        │
 ③ 購入者: 注文                orders (pending) + 在庫仮引当
        │
 ④ 購入者: カード決済           外部決済事業者へ遷移
        │
 ⑤ 決済事業者 → 本システム      Webhook（署名検証）
        │                       ┌──────────────────────────┐
        │                       │ トランザクション          │
        ├──────────────────────▶│ webhook_events INSERT     │
        │                       │ orders → paid             │
        │                       │ 在庫: reserved→issued     │
        │                       │ entitlements を N 件作成   │  ← 1枚単位
        │                       │ outbox_events INSERT      │
        │                       └──────────────────────────┘
        │
 ⑥ 購入者: Claim URL を開く      GET /claims/{token}（状態を変えない）
        │
 ⑦ 購入者: 受取を実行            POST /claims/{token}/accept
        │                       ┌──────────────────────────┐
        │                       │ トランザクション          │
        │                       │ 認証・本人照合            │
        │                       │ entitlement → claimed     │  ← 条件付きUPDATE
        │                       │ mint_jobs INSERT (queued) │  ← UNIQUE(entitlement_id)
        │                       │ outbox_events INSERT      │
        │                       └──────────────────────────┘
        │
 ⑧ worker: 発行ジョブ実行        排他取得 → MintingPort.submit()
        │                       成功 → nft_tokens INSERT（UNIQUE で多重防止）
        │                       失敗 → バックオフして再試行
        │
 ⑨ 購入者: コレクション表示       GET /me/collection
```

---

## 3. 各ステップの詳細

### 3.1 ③ 注文作成（在庫の仮引当）

```
BEGIN;
  SELECT * FROM artworks WHERE id = $artworkId FOR UPDATE;   -- 行ロック
  -- 販売可能数 = max_supply - reserved_count - issued_count
  IF 販売可能数 < quantity THEN ROLLBACK; → INSUFFICIENT_SUPPLY
  UPDATE artworks SET reserved_count = reserved_count + $quantity WHERE id = $artworkId;
  INSERT INTO orders (..., status='pending', reserved_until = now() + interval '30 minutes');
  INSERT INTO order_lines (...);   -- 価格・作品名をスナップショット
COMMIT;
```

**なぜ行ロックが必要か:** 同時に2件の注文が来ると、
両方が「販売可能数 = 1」を読んでから両方が加算し、オーバーセルになる。
`FOR UPDATE` で直列化する。加えて DB の CHECK 制約（`reserved + issued <= max_supply`）が
最終防壁として機能する。

### 3.2 ⑤ 決済確定 Webhook

✅ **事実:** 決済確定は Webhook のみで判定する。成功画面の到達で確定させない。

```
1. raw body を取得（JSON パーサより前）
2. 署名検証 → 失敗なら 400（記録も処理もしない）
3. BEGIN;
     INSERT INTO webhook_events (provider, event_id, ...) ;
     -- ここで UNIQUE 違反 → ROLLBACK して 200 を返す（既に処理済み）
4.   注文を特定（metadata.orderId → provider_payment_ref → provider_session_ref）
     特定不能 → status='ignored' で COMMIT し 200
5.   SELECT * FROM orders WHERE id=$orderId FOR UPDATE;
     status != 'pending' → status='ignored' で COMMIT し 200（既に確定済み）
6.   UPDATE orders SET status='paid', paid_at=now();
     UPDATE artworks SET reserved_count = reserved_count - $q,
                         issued_count   = issued_count   + $q;
     INSERT INTO entitlements (...) × $q;      -- ★ 1枚単位で N 行
     INSERT INTO outbox_events ('order.paid'), ('entitlement.issued') × $q;
     UPDATE webhook_events SET status='processed', processed_at=now();
   COMMIT;
7. 200 を返す
```

**★ 受取権の生成が本フローの核心。**
数量 N の注文は entitlements を **N 行**作る。
各行は独立した `serial_no` と `claim_token_hash` を持つ。

**シリアル番号の採番（🟡 仮決定）:**

```sql
-- artworks を FOR UPDATE で押さえた状態で採番する
-- serial_no = issued_count(更新前) + 1 .. issued_count + quantity
```

`UNIQUE(artwork_id, serial_no)` があるため、万一の競合でも重複は物理的に発生しない。

### 3.3 ⑥ Claim 内容の確認（GET）

🟡 **仮決定:** GET は**一切状態を変えない**。

理由: メールクライアント・チャットアプリ・セキュリティ製品が
URL をプリフェッチすることがある。GET で Claim が確定すると、
**購入者が開く前に受取済みになる**事故が起きる。

応答内容（未認証でも作品名程度は返すか、認証必須にするかは 🟡）:

```json
{
  "claimable": true,
  "artworkTitle": "作品名",
  "serialNo": 7,
  "requiresLogin": true
}
```

> ⚠️ `claimable: false` の理由を詳細に返さない（列挙の手がかりになる）。
> 存在しないトークンは 404 で統一する（[API_DESIGN.md](./API_DESIGN.md) §2.1）。

### 3.4 ⑦ Claim 実行（POST）— 冪等性の中核

```sql
BEGIN;

-- (1) 受取権を取得し、本人性を検証（AUTHORIZATION_DESIGN §2.4 の6条件）

-- (2) ★ 条件付きUPDATE。更新行数が1のときのみ成功。
UPDATE entitlements
   SET status='claimed', claimed_by_account_id=$actor, claimed_at=now(), updated_at=now()
 WHERE id=$id
   AND status='issued'
   AND (expires_at IS NULL OR expires_at > now());
-- 更新行数 = 0 → ROLLBACK → ENTITLEMENT_NOT_CLAIMABLE (409)

-- (3) 発行ジョブを作成。UNIQUE(entitlement_id) が多重投入を防ぐ。
INSERT INTO mint_jobs (entitlement_id, status, next_attempt_at, idempotency_key)
VALUES ($id, 'queued', now(), $derivedKey)
ON CONFLICT (entitlement_id) DO NOTHING;

INSERT INTO outbox_events ('entitlement.claimed');
COMMIT;
```

**同時に2リクエストが来た場合:**

|               | リクエストA       | リクエストB      |
| ------------- | ----------------- | ---------------- |
| (2) の UPDATE | 更新行数 1 → 成功 | 更新行数 0 → 409 |
| (3) の INSERT | 実行される        | 到達しない       |

**冪等キーの導出（🟡 仮決定）:**
`idempotency_key = HMAC(secret, "mint:" + entitlementId)` とし、
**受取権IDから決定論的に導出**する。再試行しても同じキーになるため、
外部Mint APIが冪等をサポートしていれば多重発行を防げる。

> ⚠️ ランダムなキーを毎回生成しない。再試行のたびに別依頼として扱われ、多重発行の原因になる。

### 3.5 ⑧ 発行ジョブの実行（worker）

```
[取得] UPDATE mint_jobs SET status='processing', locked_at=now(),
                            attempt_count=attempt_count+1
        WHERE id IN (SELECT id FROM mint_jobs
                      WHERE status='queued' AND next_attempt_at <= now()
                      ORDER BY next_attempt_at
                      FOR UPDATE SKIP LOCKED LIMIT $batch)
        RETURNING *;

[実行] MintingPort.submit({ entitlementId, idempotencyKey, metadataRef, recipientRef })

[成功] BEGIN;
         INSERT INTO nft_tokens (entitlement_id, ...) ;  -- UNIQUE で多重防止
         UPDATE mint_jobs SET status='succeeded';
         INSERT INTO outbox_events ('mint.succeeded');
       COMMIT;

[失敗] IF attempt_count >= max_attempts THEN
         UPDATE mint_jobs SET status='failed', last_error_code=$code;
         INSERT INTO outbox_events ('mint.failed');   -- 運用アラート
       ELSE
         UPDATE mint_jobs SET status='queued',
                              next_attempt_at = now() + backoff(attempt_count),
                              last_error_code=$code;
       END IF;
```

**多重Mint防止の三重化:**

| 層  | 手段                                                                        |
| --- | --------------------------------------------------------------------------- |
| 1   | `mint_jobs UNIQUE(entitlement_id)` — ジョブが1つしか作られない              |
| 2   | `FOR UPDATE SKIP LOCKED` + 条件付きUPDATE — 同じジョブを2ワーカーが掴まない |
| 3   | `nft_tokens UNIQUE(entitlement_id)` — 万一2回実行されても記録は1件          |
| 4   | 決定論的 `idempotency_key` — 外部API側でも重複を弾ける                      |

✅ **事実:** 「1つの受取権から複数Mintできない設計」は、この4層で担保される。

**バックオフ（🟡 仮決定）:** 1分 → 5分 → 15分 → 60分 → 180分、最大5回。

### 3.6 スタックしたジョブの回収

🟡 **仮決定:** `status='processing'` のまま `locked_at` が閾値（🟡 15分）を
超えた行は、**自動で `queued` に戻さない**。

理由: `processing` の行は**外部へ送信済みの可能性**がある。
自動で戻すと、外部側が冪等でない場合に二重発行が起きる。

代わりに:

1. 監視アラートを上げる
2. `MintingPort.getStatus()` で外部側の実際の状態を照会する
3. 外部側で「未受付」と確認できた場合のみ `queued` に戻す

> ⚠️ ここは**安全側に倒す**。多重発行（回復不能）よりも、
> 発行遅延（人手で回復可能）を選ぶ。

---

## 4. 返金との相互作用

| 状況                                      | 受取権             | 発行ジョブ                                  | 根拠                              |
| ----------------------------------------- | ------------------ | ------------------------------------------- | --------------------------------- |
| 全額返金・**未Claim**                     | `issued → revoked` | 作成されていない                            | 発行されていないので取消可能      |
| 全額返金・**Claim済み / ジョブ `queued`** | `claimed` のまま   | `queued → cancelled`                        | まだ外部へ送っていない            |
| 全額返金・ジョブ **`processing`**         | `claimed` のまま   | **`cancelled` にしない。`note` に注記のみ** | 送信済みの可能性がある（INV-M4）  |
| 全額返金・**発行済み**                    | `claimed` のまま   | `succeeded` のまま                          | 発行済み資産の回収可否は `UD-511` |
| 一部返金                                  | 変更なし           | 変更なし                                    | 自動処理しない（`UD-104`）        |

❓ **未決定 `UD-104` / `UD-511`:** 発行済みトークンの回収可否と、
返金後の顧客への説明。**推測で実装しない。**

---

## 5. 失敗シナリオと期待挙動

| #   | シナリオ                                      | 期待される挙動                                                         |
| --- | --------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | 同一 Webhook を2回受信                        | 2回目は `webhook_events` の UNIQUE 違反で即 200。受取権は増えない      |
| 2   | Webhook 処理中にプロセスが落ちた              | トランザクション全体がロールバック。送信元が再送し、再処理される       |
| 3   | 同一 Claim URL を同時に2回 POST               | 1回だけ成功、もう1回は 409                                             |
| 4   | Claim 後に worker が2台同時起動               | `SKIP LOCKED` で片方のみが処理                                         |
| 5   | Mint API がタイムアウト（実際は成功していた） | 再試行時に同じ冪等キーで送信 → 外部側が既存結果を返す                  |
| 6   | Mint API が恒久的に失敗                       | 5回試行後 `failed`。`mint.failed` で運用アラート                       |
| 7   | 決済確定したがチェーンが停止中                | Claim までは正常に進む。ジョブが `queued` で滞留し、復旧後に処理される |
| 8   | Claim トークンを総当たりされる                | レート制限＋404統一＋32バイト乱数で実用上不可能                        |
| 9   | 他人の Claim URL を入手して開いた             | 認証は通っても購入者ID不一致で 403                                     |
| 10  | 在庫1に対し同時に2注文                        | 行ロックで直列化、片方が `INSUFFICIENT_SUPPLY`。CHECK 制約が最終防壁   |

これらはすべて [TEST_STRATEGY.md](./TEST_STRATEGY.md) の必須テストケースに対応する。

---

## 6. Phase 1 での実装範囲

✅ **事実:** 本 Phase で実装するのは次のみ。

| 実装する                                               | 実装しない                   |
| ------------------------------------------------------ | ---------------------------- |
| `Entitlement` / `MintJob` の状態遷移を表す**純粋関数** | HTTP エンドポイント          |
| 遷移の不変条件（INV-E1〜E4, INV-M1〜M5）の単体テスト   | DB への実際の書き込み        |
| `MintingPort` の interface                             | 実 Mint プロバイダのアダプタ |
| `FakeMintingAdapter`（決定論的）                       | 外部通信                     |
| バックオフ計算関数とそのテスト                         | worker の実ジョブループ      |

---

## 7. 本文書の未決定事項

本書固有の新規未決定事項はない。
参照: `UD-104`（返金）、`UD-505`（Claim期限）、`UD-511`（是正手段）、`UD-703`（完了通知方式）。
