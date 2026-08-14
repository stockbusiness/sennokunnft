# HMAC_TEST_VECTORS.md — 千ノ国共通 HMAC v1.1 FINAL 固定テストベクトル

記法は [README.md](./README.md) に従う。

---

## 1. この文書の目的

✅ **事実:** 千ノ国NFTマーケットと OVEW Wallet は、
**同じ入力から同じ署名を作れなければ通信できない。**

署名方式は文章で書くと合っているように見えても、
区切り文字・大文字小文字・空文字の扱いといった細部で食い違う。
食い違いは「実装が終わってから、繋いだときに初めて分かる」ため、
**両システムが同じ固定値でテストする**ことで先に潰す。

⚠️ **この値を片方だけで変更しない。** テストは通るのに通信が成立しなくなる。

---

## 2. 正準文字列（v1.1 FINAL）

```
key_id \n timestamp \n nonce \n METHOD \n path \n raw_body
```

| 項目         | 規則                                                     |
| ------------ | -------------------------------------------------------- |
| 区切り       | LF（`\n`）。CRLF ではない                                |
| `key_id`     | そのまま                                                 |
| `timestamp`  | UNIX 秒の**文字列**。数値へ変換して比較しない            |
| `nonce`      | 使い捨て。**再利用は拒否**                               |
| `METHOD`     | **大文字**（`POST` / `GET`）                             |
| `path`       | **クエリ文字列を含めない**                               |
| `raw_body`   | **受信した生の文字列**。`GET` など本文が無いときは空文字 |
| アルゴリズム | HMAC-SHA256                                              |
| ヘッダ値     | `sha256=<hex>`（小文字 hex）                             |

⚠️ **JSON を `parse` して `stringify` した文字列で署名しない。**
キーの順序や空白が変わり、送信側と受信側で別の文字列になる。
署名は「送られてきたバイト列そのもの」に対して行う。

---

## 3. ベクトル 1 — POST（Claim 確定）

| 項目        | 値                                                         |
| ----------- | ---------------------------------------------------------- |
| `key_id`    | `test-key-001`                                             |
| `timestamp` | `1786660000`                                               |
| `nonce`     | `nonce-fixed-001`                                          |
| `method`    | `POST`                                                     |
| `path`      | `/api/collectible-claims/test-token/confirm`               |
| `raw_body`  | `{"common_user_id":"cu_0123456789abcdef0123456789abcdef"}` |
| `secret`    | `test-secret`                                              |

正準文字列（`⏎` は LF）:

```
test-key-001⏎
1786660000⏎
nonce-fixed-001⏎
POST⏎
/api/collectible-claims/test-token/confirm⏎
{"common_user_id":"cu_0123456789abcdef0123456789abcdef"}
```

**期待される署名:**

```
sha256=5d5dff59f51f7de3df54b541eb636e47b91cde8a0a79ccaccfcf34c0c28f9fe1
```

---

## 4. ベクトル 2 — GET（Claim 状態取得・本文なし）

| 項目        | 値                                   |
| ----------- | ------------------------------------ |
| `key_id`    | `test-key-001`                       |
| `timestamp` | `1786660000`                         |
| `nonce`     | `nonce-fixed-002`                    |
| `method`    | `GET`                                |
| `path`      | `/api/collectible-claims/test-token` |
| `raw_body`  | **空文字**（`""`）                   |
| `secret`    | `test-secret`                        |

⚠️ **本文が無くても、正準文字列の最後の区切り（`\n`）は入る。**
`path` の後ろに `\n` を置き、そのあとへ空文字を連結する。
ここを省くと GET だけ署名が合わなくなる。

**期待される署名:**

```
sha256=2b059e010615116377299b3526bf20e33161ad9c1cbce4ee552eb38a55e269ec
```

---

## 5. 確認方法

任意の言語で、上記の値から同じ署名が出ることを確認する。

```bash
printf 'test-key-001\n1786660000\nnonce-fixed-001\nPOST\n/api/collectible-claims/test-token/confirm\n{"common_user_id":"cu_0123456789abcdef0123456789abcdef"}' \
  | openssl dgst -sha256 -hmac 'test-secret' -hex
```

> `printf` を使うのは、`echo` が末尾に改行を足す実装があるため。
> 末尾に改行が入ると署名が変わる。

本システム側の検証は
`packages/integrations/tests/sennokuni-hmac.test.ts` にある。

---

## 6. 適用範囲（`UD-1005` 確定・2026-08-14）

| 方向                                             | 方式                                |
| ------------------------------------------------ | ----------------------------------- |
| OVEW Wallet → 本システム（Claim API）            | **v1.1 FINAL**                      |
| 本システム → OVEW Wallet（entitlement イベント） | **v1.1 FINAL**                      |
| 代理店システム → 本システム（Webhook）           | 旧 3 要素形式。**今回は実装しない** |

⚠️ **代理店システムの方向は正準文字列が異なる**
（`timestamp \n nonce \n raw_json_body`）。
同じ検証器を流用すると通らない。実装するときは別物として扱う。

---

## 7. 本文書の未決定事項

| ID      | 概要                                                     |
| ------- | -------------------------------------------------------- |
| UD-1004 | 鍵の配布・ローテーション手順（実装は新旧併存に対応済み） |
