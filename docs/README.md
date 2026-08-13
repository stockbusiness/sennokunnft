# 千ノ国NFTマーケット ドキュメント索引

本ディレクトリは Phase 0（要件・アーキテクチャ設計）の成果物を格納する。

## 記法ルール（全文書共通）

各文書内の記述は、必ず次の3分類のいずれかに属する。分類をまたいで曖昧に書かない。

| 記号 | 分類       | 意味                                                     | 変更時の扱い                                  |
| ---- | ---------- | -------------------------------------------------------- | --------------------------------------------- |
| ✅   | **事実**   | 発注指示・技術的制約・法令等により既に確定している事項   | 変更には発注者の指示が必要                    |
| 🟡   | **仮決定** | 本設計で暫定的に置いた判断。根拠を併記する               | 設計レビューで変更可。変更時は影響文書を追記  |
| ❓   | **未決定** | 判断材料が不足しており、**推測で確定してはならない**事項 | `UD-xxx` の採番で追跡。決定するまで実装しない |

> **重要:** ❓ 未決定事項をコード上の既定値として黙って埋めることを禁止する。
> やむを得ずコードを書く場合は「差し替え可能なポート＋Fake実装」に留め、`UD-xxx` を TODO コメントで参照する。

## 文書一覧

| #   | 文書                                                               | 目的                                                                |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 1   | [PRODUCT_REQUIREMENTS.md](./PRODUCT_REQUIREMENTS.md)               | 誰の何の課題を解くか。機能／非機能要件                              |
| 2   | [MVP_SCOPE.md](./MVP_SCOPE.md)                                     | MVPに入れるもの／入れないものの線引き                               |
| 3   | [ARCHITECTURE.md](./ARCHITECTURE.md)                               | システム構成、パッケージ責務、依存方向                              |
| 4   | [DOMAIN_MODEL.md](./DOMAIN_MODEL.md)                               | ドメイン用語、集約、状態遷移、不変条件                              |
| 5   | [DATABASE_DESIGN.md](./DATABASE_DESIGN.md)                         | 論理・物理データモデル、制約、インデックス                          |
| 6   | [API_DESIGN.md](./API_DESIGN.md)                                   | HTTP API 契約、エラー規約、冪等性                                   |
| 7   | [EVENT_CATALOG.md](./EVENT_CATALOG.md)                             | ドメインイベント／外部Webhookの一覧と契約                           |
| 8   | [AUTHORIZATION_DESIGN.md](./AUTHORIZATION_DESIGN.md)               | 認証・ロール・権限マトリクス                                        |
| 9   | [SECURITY_DESIGN.md](./SECURITY_DESIGN.md)                         | 脅威モデルと対策、秘密情報の扱い                                    |
| 10  | [BLOCKCHAIN_DECISION_RECORD.md](./BLOCKCHAIN_DECISION_RECORD.md)   | チェーン・規格・カストディの選択肢と判断基準（**未確定**）          |
| 11  | [LAZY_MINT_FLOW.md](./LAZY_MINT_FLOW.md)                           | 購入→受取権→Claim→Mint の詳細フロー                                 |
| 12  | [EXTERNAL_INTEGRATION_POLICY.md](./EXTERNAL_INTEGRATION_POLICY.md) | 既存システム（Sengoku Market / OVEW Wallet / 代理店）との疎結合方針 |
| 13  | [TEST_STRATEGY.md](./TEST_STRATEGY.md)                             | テストの層構成と必須ケース                                          |
| 14  | [OPERATIONS_AND_ROLLBACK.md](./OPERATIONS_AND_ROLLBACK.md)         | 運用手順、監視、ロールバック基準                                    |
| 15  | [IMPLEMENTATION_ROADMAP.md](./IMPLEMENTATION_ROADMAP.md)           | Phase 分割と、**全未決定事項の統合一覧**                            |

未決定事項（`UD-xxx`）の**マスタ一覧は [IMPLEMENTATION_ROADMAP.md](./IMPLEMENTATION_ROADMAP.md) の「未決定事項レジスタ」**。
各文書には該当分の抜粋のみを置く。

## リポジトリについて

✅ **事実:** 本プロジェクトの正式なリポジトリは `stockbusiness/sennokunnft`。

✅ **事実:** 既存の Sengoku Market・OVEW Wallet・代理店システムとはリポジトリを分けている。
コードの流用は行わず、連携は API と Webhook で行う
（[EXTERNAL_INTEGRATION_POLICY.md](./EXTERNAL_INTEGRATION_POLICY.md)）。

> 補足: Phase 0-1 の実装は、本リポジトリが未用意だった時点では既存リポジトリ内の
> サブディレクトリで進められた。その履歴は保持したまま本リポジトリへ移送してある。
