-- 接続確認に「何を確かめたか」を持たせる（指示書 §4.3・§9）。
--
-- ⚠️ **「成功」の 2 文字だけでは、何を確かめたのか分からない。**
--    いま行えるのは到達性の確認だけで、資格情報が正しいかどうかは
--    確かめていない（要決定 06：安全なテスト手段が確認できるまで
--    実送信のテストイベントを作らない）。その区別を行に残す。

ALTER TABLE "integration_connection_checks"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'reachability',
  -- 相手が返した HTTP の状態コード。⚠️ 応答本文は保存しない。
  ADD COLUMN "http_status" INTEGER;

-- ⚠️ **既定値はここで外す。** 列を足すときだけ既定値が要る（既存行のため）。
--    残したままにすると、書き手が種別を指定し忘れても黙って通る。
ALTER TABLE "integration_connection_checks" ALTER COLUMN "kind" DROP DEFAULT;

-- ⚠️ **知らない種別を入れさせない。** 種別を増やすときは、
--    要決定 06 の再確認とセットでこの制約も直すこと。
--    「制約を直さないと入らない」ことが、確認を促す仕掛けになる。
ALTER TABLE "integration_connection_checks"
  ADD CONSTRAINT "integration_connection_checks_kind_known"
  CHECK ("kind" IN ('reachability'));

ALTER TABLE "integration_connection_checks"
  ADD CONSTRAINT "integration_connection_checks_http_status_range"
  CHECK ("http_status" IS NULL OR ("http_status" >= 100 AND "http_status" <= 599));

-- 送信に使う鍵の識別子。
--
-- ⚠️ **これは秘密ではない。** HMAC の鍵そのものは `integration_secrets` に
--    暗号化して置く。ここに置くのは「どの鍵か」を相手へ伝える名前で、
--    署名ヘッダにそのまま載る値。秘密と同じ扱いにすると、
--    画面で確認できず、取り違えに気づけなくなる。
ALTER TABLE "integration_settings" ADD COLUMN "key_id" TEXT;
