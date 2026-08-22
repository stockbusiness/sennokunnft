import {
  staffListResponseSchema,
  staffInvitationSchema,
  staffMemberSchema,
  type CreateStaffInvitationRequest,
  type StaffInvitationView,
  type StaffListResponse,
  type StaffMemberView,
  type UpdateStaffMemberRequest,
  auditLogListResponseSchema,
  integrationListResponseSchema,
  integrationStatusSchema,
  type IntegrationListResponse,
  type IntegrationStatusView,
  type RegisterSecretRequest,
  type UpdateIntegrationRequest,
  resendWalletDeliveriesResponseSchema,
  walletDeliveryListResponseSchema,
  walletDeliverySchema,
  type AuditLogListResponse,
  type ResendWalletDeliveriesResponse,
  type WalletDeliveryListResponse,
  type WalletDeliveryView,
  adminArtworkListResponseSchema,
  adminArtworkSchema,
  adminListingListResponseSchema,
  adminListingSchema,
  uploadImageResponseSchema,
  type AdminArtwork,
  type AdminArtworkListResponse,
  type AdminListing,
  type AdminListingListResponse,
  adminOrderListResponseSchema,
  adminOrderDetailSchema,
  adminOrderTimelineResponseSchema,
  adminOrderNotesResponseSchema,
  refundListResponseSchema,
  refundResultSchema,
  type CreateRefundRequest,
  type RefundListResponse,
  type RefundResult,
  payoutListResponseSchema,
  negativeCarryListResponseSchema,
  type NegativeCarryListResponse,
  payoutDetailResponseSchema,
  adminPayoutAccountResponseSchema,
  salesReportResponseSchema,
  creatorDirectoryResponseSchema,
  creatorDirectoryDetailResponseSchema,
  payoutSchema,
  closePayoutPeriodResponseSchema,
  type AdminPayoutAccountResponse,
  type CreatorDirectoryDetailResponse,
  type CreatorDirectoryResponse,
  type SalesReportResponse,
  type ClosePayoutPeriodResponse,
  type PayoutDetailResponse,
  type PayoutListResponse,
  type PayoutViewDto,
  orderNoteViewSchema,
  settlementSettingsSchema,
  settlementSettingsResponseSchema,
  type SettlementSettingsResponse,
  type SettlementSettingsView,
  type UpdateSettlementSettingsRequest,
  type AdminOrderTimelineResponse,
  type AdminOrderNotesResponse,
  type OrderNoteView,
  paymentCredentialListResponseSchema,
  type PaymentCredentialListResponse,
  type RegisterPaymentCredentialRequest,
  legalVersionListResponseSchema,
  legalVersionSchema,
  type LegalVersionListResponse,
  type LegalVersionView,
  type PublishLegalVersionRequest,
  type SaveLegalDraftRequest,
  type AdminOrderListResponse,
  type AdminOrderDetail,
  consistencyResponseSchema,
  entitlementAdminDetailSchema,
  entitlementAdminListResponseSchema,
  notificationHistoryListResponseSchema,
  operationsDashboardResponseSchema,
  redeliverResponseSchema,
  retryIssuanceResponseSchema,
  attestationListResponseSchema,
  mailCheckResponseSchema,
  productionReadinessResponseSchema,
  customerDetailResponseSchema,
  customerEmailResponseSchema,
  customerSearchResponseSchema,
  type ConsistencyResponse,
  type CustomerDetailResponse,
  type CustomerEmailResponse,
  type CustomerSearchResponse,
  type EntitlementAdminDetailView,
  type EntitlementAdminListResponse,
  type NotificationHistoryListResponse,
  type OperationsDashboardResponse,
  type RedeliverResponse,
  type RetryIssuanceResponse,
  type AttestationListResponse,
  type MailCheckResponse,
  type ProductionReadinessResponse,
} from '@sengoku/contracts';
import { z } from '@sengoku/validation';
import { getWebEnv } from './env';
import { currentAccessToken } from './auth/current';

/**
 * 管理 API の呼び出し。
 *
 * ⚠️ **サーバー側でのみ使う。** 資格情報をブラウザへ渡さないため。
 *
 * ⚠️ **画面を隠すことは保護ではない。**
 * 管理画面を出さなくても API は直接叩ける。認可は必ず API 側で判定する。
 * ここは「操作するための入口」を用意しているだけで、
 * 権限が無ければサーバーが 401/403 を返す。
 */

export type AdminResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly reason: 'unauthorized' | 'not_found' | 'rejected' | 'unavailable';
      readonly message?: string;
      /**
       * API が返した符号（`{ error: { code } }`）。
       *
       * ⚠️ **本文の文言をそのまま画面へ出さない。** 内部情報が混ざりうる。
       * 画面へ出す言葉は、こちらの符号から**web 側で**引き当てる。
       * 符号だけなら、何が起きたかを伝えつつ、中身は漏れない。
       */
      readonly code?: string;
    };

/**
 * 運営の資格情報（環境変数の共有トークン）。
 *
 * ⚠️ **これは 1 本しか無く、使った全員が同じ人として扱われる。**
 * 監査ログの「誰が」がひとつに潰れる。
 *
 * ⚠️ **ログイン機能が有効な環境では使わない**（2026-08-18 に変更）。
 * 以前は「ログインが断られたときの逃げ道」として残していたが、それだと
 * `SUPABASE_*` を外したときに**黙って「全員が同じ人」へ戻る**。
 * 静かに弱くなる経路は、いつか誰も気づかないまま本番に残る。
 *
 * 残してあるのは、ログイン機能を有効にしていない手元のため。
 * `SUPABASE_URL` と `SUPABASE_ANON_KEY` が入っていれば、こちらは使われない。
 * これは出品者向け（`creator-client`）と同じ規則にそろえてある。
 */
function sharedOperatorToken(): string | null {
  const env = getWebEnv();
  if (env.SUPABASE_URL !== undefined && env.SUPABASE_ANON_KEY !== undefined) {
    return null;
  }
  const token = env.ADMIN_DEV_TOKEN;
  return token === undefined || token === '' ? null : token;
}

/**
 * 使う資格情報を、優先順に並べる。
 *
 * ⚠️ **ログイン済みなら、まずその人のトークンを試す。**
 * 共有トークンを先に使うと、誰が操作したのかが監査ログに残らない。
 *
 * ⚠️ **ログイン機能が有効な環境では、共有トークンが並びに入らない。**
 * `sharedOperatorToken` が `null` を返すため、本番では実質この 1 本だけ。
 * 手元（ログイン未設定）では今までどおり共有トークンが使える。
 */
async function credentials(): Promise<string[]> {
  const tokens: string[] = [];
  const session = await currentAccessToken();
  if (session !== null) {
    tokens.push(session);
  }
  const shared = sharedOperatorToken();
  if (shared !== null) {
    tokens.push(shared);
  }
  return tokens;
}

/**
 * `{ error: { code } }` の符号だけを取り出す。
 *
 * ⚠️ **`message` は読まない。** 画面へ出す言葉は web 側で決める。
 * 本文をそのまま流すと、いつか内部の詳細が画面に出る。
 */
async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    const error = (body as { error?: { code?: unknown } }).error;
    return typeof error?.code === 'string' ? error.code : undefined;
  } catch {
    return undefined;
  }
}

/** 応答の状態コードを、画面が扱える理由に翻訳する。 */
function reasonFor(status: number): 'unauthorized' | 'not_found' | 'rejected' | 'unavailable' {
  if (status === 401 || status === 403) {
    return 'unauthorized';
  }
  if (status === 404) {
    return 'not_found';
  }
  if (status >= 400 && status < 500) {
    // 入力の誤りと、こちら側の不調を分ける。利用者に見せる言葉が違うため。
    return 'rejected';
  }
  return 'unavailable';
}

async function callAdmin<T>(
  path: string,
  schema: z.ZodType<T> | null,
  init: RequestInit = {},
): Promise<AdminResult<T>> {
  const tokens = await credentials();
  if (tokens.length === 0) {
    return { ok: false, reason: 'unauthorized', message: '運営用の資格情報が設定されていません。' };
  }

  const { WEB_API_BASE_URL } = getWebEnv();
  let lastReason: 'unauthorized' | 'not_found' | 'rejected' | 'unavailable' = 'unauthorized';

  for (const token of tokens) {
    let response: Response;
    try {
      response = await fetch(`${WEB_API_BASE_URL}${path}`, {
        ...init,
        headers: {
          ...init.headers,
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
        cache: 'no-store',
      });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }

    if (!response.ok) {
      lastReason = reasonFor(response.status);
      // 断られたときだけ次の資格情報を試す。それ以外は理由が変わらない。
      if (lastReason === 'unauthorized') {
        continue;
      }
      // ⚠️ エラー本文はそのまま画面へ出さない。符号だけを取り出す。
      return { ok: false, reason: lastReason, code: await errorCode(response) };
    }

    if (schema === null) {
      // 204 のように本文を返さない応答。読み取ろうとしない。
      return { ok: true, data: undefined as T };
    }

    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true, data: parsed.data };
  }

  return { ok: false, reason: lastReason };
}

function json(body: unknown, method: 'POST' | 'PATCH' | 'PUT'): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// --- 読み取り --------------------------------------------------------------

export function fetchAdminArtworks(): Promise<AdminResult<AdminArtworkListResponse>> {
  return callAdmin('/api/v1/admin/artworks?limit=50', adminArtworkListResponseSchema);
}

export function fetchAdminArtwork(id: string): Promise<AdminResult<AdminArtwork>> {
  return callAdmin(`/api/v1/admin/artworks/${encodeURIComponent(id)}`, adminArtworkSchema);
}

export function fetchAdminListings(): Promise<AdminResult<AdminListingListResponse>> {
  return callAdmin('/api/v1/admin/listings?limit=50', adminListingListResponseSchema);
}

export function fetchAdminListing(id: string): Promise<AdminResult<AdminListing>> {
  return callAdmin(`/api/v1/admin/listings/${encodeURIComponent(id)}`, adminListingSchema);
}

/** 指定した作品の出品だけを取る。詳細画面で販売状態を見せるため。 */
export function fetchAdminListingsOfArtwork(
  artworkId: string,
): Promise<AdminResult<AdminListingListResponse>> {
  return callAdmin(
    `/api/v1/admin/listings?limit=50&artworkId=${encodeURIComponent(artworkId)}`,
    adminListingListResponseSchema,
  );
}

// --- 書き込み --------------------------------------------------------------

export function updateAdminArtwork(
  id: string,
  input: { title?: string; description?: string; maxSupply?: number },
): Promise<AdminResult<AdminArtwork>> {
  return callAdmin(
    `/api/v1/admin/artworks/${encodeURIComponent(id)}`,
    adminArtworkSchema,
    json(input, 'PATCH'),
  );
}

/**
 * 画像を差し替える。
 *
 * ⚠️ **生のバイト列で送る。** multipart にしないのは、境界の解析を
 * 増やさないため。種別の判定は API 側が**中身のマジックナンバー**で行う。
 */
export function uploadAdminArtworkImage(
  id: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<AdminResult<{ imageKey: string; imageUrl: string }>> {
  return callAdmin(
    `/api/v1/admin/artworks/${encodeURIComponent(id)}/image`,
    uploadImageResponseSchema,
    {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: bytes,
    },
  );
}

export function publishAdminArtwork(id: string): Promise<AdminResult<AdminArtwork>> {
  return callAdmin(`/api/v1/admin/artworks/${encodeURIComponent(id)}/publish`, adminArtworkSchema, {
    method: 'POST',
  });
}

export function archiveAdminArtwork(id: string): Promise<AdminResult<AdminArtwork>> {
  return callAdmin(`/api/v1/admin/artworks/${encodeURIComponent(id)}/archive`, adminArtworkSchema, {
    method: 'POST',
  });
}

/**
 * 作品を完全に消す。
 *
 * ⚠️ **元に戻せない。** 呼ぶ前に、画面側で必ず確認を挟むこと。
 * 応答は 204（本文なし）なので、読み取るスキーマを渡さない。
 */
export function deleteAdminArtwork(id: string): Promise<AdminResult<undefined>> {
  return callAdmin<undefined>(`/api/v1/admin/artworks/${encodeURIComponent(id)}`, null, {
    method: 'DELETE',
  });
}

export function suspendAdminListing(id: string): Promise<AdminResult<AdminListing>> {
  return callAdmin(`/api/v1/admin/listings/${encodeURIComponent(id)}/suspend`, adminListingSchema, {
    method: 'POST',
  });
}

export function endAdminListing(id: string): Promise<AdminResult<AdminListing>> {
  return callAdmin(`/api/v1/admin/listings/${encodeURIComponent(id)}/end`, adminListingSchema, {
    method: 'POST',
  });
}

// --- 運営スタッフ（`UD-803`）------------------------------------------------
//
// ⚠️ **これらはオーナーの印を持つ人しか通らない。** 印が無ければ API が
//    403 を返し、画面には「権限がありません」と出る。画面側で隠すのは
//    導線を分かりやすくするためであって、保護ではない。

export function fetchStaff(): Promise<AdminResult<StaffListResponse>> {
  return callAdmin('/api/v1/admin/staff', staffListResponseSchema);
}

export function inviteStaff(
  request: CreateStaffInvitationRequest,
): Promise<AdminResult<StaffInvitationView>> {
  return callAdmin('/api/v1/admin/staff/invitations', staffInvitationSchema, json(request, 'POST'));
}

export function revokeStaffInvitation(id: string): Promise<AdminResult<StaffInvitationView>> {
  return callAdmin(
    `/api/v1/admin/staff/invitations/${encodeURIComponent(id)}`,
    staffInvitationSchema,
    { method: 'DELETE' },
  );
}

export function updateStaffMember(
  accountId: string,
  request: UpdateStaffMemberRequest,
): Promise<AdminResult<StaffMemberView>> {
  return callAdmin(
    `/api/v1/admin/staff/${encodeURIComponent(accountId)}`,
    staffMemberSchema,
    json(request, 'PATCH'),
  );
}

// --- 送信の運用と監査ログ（管理画面・外部連携 指示書 §5）---------------------
//
// ⚠️ **本文（payload）を取る経路をここに作らない。** API がそもそも
//    返さないので取りようが無い——という状態を保つ。

export interface WalletDeliveryFilter {
  readonly statuses?: readonly string[];
  readonly eventId?: string;
  readonly cursor?: string;
}

export function fetchWalletDeliveries(
  filter: WalletDeliveryFilter = {},
): Promise<AdminResult<WalletDeliveryListResponse>> {
  const params = new URLSearchParams();
  for (const status of filter.statuses ?? []) {
    params.append('status', status);
  }
  if (filter.eventId !== undefined && filter.eventId !== '') {
    params.set('eventId', filter.eventId);
  }
  if (filter.cursor !== undefined && filter.cursor !== '') {
    params.set('cursor', filter.cursor);
  }
  const query = params.toString();
  return callAdmin(
    `/api/v1/admin/wallet-deliveries${query === '' ? '' : `?${query}`}`,
    walletDeliveryListResponseSchema,
  );
}

export function fetchWalletDelivery(id: string): Promise<AdminResult<WalletDeliveryView>> {
  return callAdmin(
    `/api/v1/admin/wallet-deliveries/${encodeURIComponent(id)}`,
    walletDeliverySchema,
  );
}

/**
 * 手で送り直す。
 *
 * ⚠️ **結果を 1 件ずつ受け取る。** 「成功しました」で丸めると、
 * 戻せなかった行があっても押した人には分からない。
 */
export function resendWalletDeliveries(
  ids: readonly string[],
): Promise<AdminResult<ResendWalletDeliveriesResponse>> {
  return callAdmin(
    '/api/v1/admin/wallet-deliveries/resend',
    resendWalletDeliveriesResponseSchema,
    json({ ids }, 'POST'),
  );
}

export function fetchAuditLogs(
  filter: { readonly action?: string; readonly cursor?: string } = {},
): Promise<AdminResult<AuditLogListResponse>> {
  const params = new URLSearchParams();
  if (filter.action !== undefined && filter.action !== '') {
    params.set('action', filter.action);
  }
  if (filter.cursor !== undefined && filter.cursor !== '') {
    params.set('cursor', filter.cursor);
  }
  const query = params.toString();
  return callAdmin(
    `/api/v1/admin/audit-logs${query === '' ? '' : `?${query}`}`,
    auditLogListResponseSchema,
  );
}

// --- 外部連携の設定（管理画面・外部連携 指示書 §4・§6・§9）------------------
//
// ⚠️ **登録済みの資格情報を取る経路をここに作らない。** API がそもそも
//    返さないので取りようが無い——という状態を保つ。

export function fetchIntegrations(): Promise<AdminResult<IntegrationListResponse>> {
  return callAdmin('/api/v1/admin/integrations', integrationListResponseSchema);
}

export function fetchIntegration(service: string): Promise<AdminResult<IntegrationStatusView>> {
  return callAdmin(
    `/api/v1/admin/integrations/${encodeURIComponent(service)}`,
    integrationStatusSchema,
  );
}

export function updateIntegration(
  service: string,
  request: UpdateIntegrationRequest,
): Promise<AdminResult<IntegrationStatusView>> {
  return callAdmin(
    `/api/v1/admin/integrations/${encodeURIComponent(service)}`,
    integrationStatusSchema,
    json(request, 'PATCH'),
  );
}

/**
 * 接続先へ届くかどうかを確かめる。
 *
 * ⚠️ **接続先を引数で渡さない。** 保存済みの設定に対してだけ行う。
 * 自由に指定できると、この画面が「任意の宛先へ通信させる道具」になる。
 */
export function checkIntegration(service: string): Promise<AdminResult<IntegrationStatusView>> {
  return callAdmin(
    `/api/v1/admin/integrations/${encodeURIComponent(service)}/check`,
    integrationStatusSchema,
    { method: 'POST' },
  );
}

export function setIntegrationEnabled(
  service: string,
  enabled: boolean,
): Promise<AdminResult<IntegrationStatusView>> {
  return callAdmin(
    `/api/v1/admin/integrations/${encodeURIComponent(service)}/${enabled ? 'enable' : 'disable'}`,
    integrationStatusSchema,
    { method: 'POST' },
  );
}

/**
 * 資格情報を登録する。
 *
 * ⚠️ **この値をどこにも残さない。** 通知にも、状態にも、ログにも。
 * 画面へ返るのは末尾 4 文字までで、それ以上は API が返さない。
 */
export function registerIntegrationSecret(
  service: string,
  request: RegisterSecretRequest,
): Promise<AdminResult<IntegrationStatusView>> {
  return callAdmin(
    `/api/v1/admin/integrations/${encodeURIComponent(service)}/secrets`,
    integrationStatusSchema,
    json(request, 'POST'),
  );
}

export function activateIntegrationSecret(
  secretId: string,
): Promise<AdminResult<IntegrationStatusView>> {
  return callAdmin(
    `/api/v1/admin/integrations/secrets/${encodeURIComponent(secretId)}/activate`,
    integrationStatusSchema,
    { method: 'POST' },
  );
}

export function discardIntegrationSecret(
  secretId: string,
): Promise<AdminResult<IntegrationStatusView>> {
  return callAdmin(
    `/api/v1/admin/integrations/secrets/${encodeURIComponent(secretId)}/discard`,
    integrationStatusSchema,
    { method: 'POST' },
  );
}

/**
 * 注文の一覧（指示書 §9.1）。
 *
 * ⚠️ **書き換える口をここへ足さない。** 金額の修正・お支払い済みへの変更・
 * 注文の削除は API 側に存在しない（指示書 §9.3）。呼び出し側だけ用意すると、
 * 「画面にはあるのに動かない」操作が生まれる。
 */
export interface AdminOrderSearchQuery {
  readonly limit?: number;
  readonly status?: string;
  readonly paymentStatus?: string;
  readonly orderNumber?: string;
  readonly createdFrom?: string;
  readonly createdTo?: string;
  readonly minTotalAmount?: string;
  readonly maxTotalAmount?: string;
  readonly artworkTitle?: string;
}

/**
 * 一覧と検索（`UD-121`）。
 *
 * ⚠️ **メールアドレスをここへ渡さない。** 問い合わせ文字列はアクセスログや
 * ブラウザ履歴に残る。メールからの照合は `lookupAdminOrdersByEmail` を使う。
 */
export function fetchAdminOrders(
  query: AdminOrderSearchQuery = {},
): Promise<AdminResult<AdminOrderListResponse>> {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit ?? 20));
  const optional: readonly (readonly [string, string | undefined])[] = [
    ['status', query.status],
    ['paymentStatus', query.paymentStatus],
    ['orderNumber', query.orderNumber],
    ['createdFrom', query.createdFrom],
    ['createdTo', query.createdTo],
    ['minTotalAmount', query.minTotalAmount],
    ['maxTotalAmount', query.maxTotalAmount],
    ['artworkTitle', query.artworkTitle],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined && value !== '') {
      params.set(key, value);
    }
  }
  return callAdmin(`/api/v1/admin/orders?${params.toString()}`, adminOrderListResponseSchema);
}

/**
 * 聞き取ったメールアドレスから注文を辿る（`UD-121`）。
 *
 * ⚠️ **本文で送る。** URL へ置くとアクセスログに残る。平文を保持しない
 * 決定（`UD-503`）を、保持しない代わりにログへ撒くことになる。
 */
export function lookupAdminOrdersByEmail(
  email: string,
  limit = 20,
): Promise<AdminResult<AdminOrderListResponse>> {
  return callAdmin(
    '/api/v1/admin/orders/search',
    adminOrderListResponseSchema,
    json({ email, limit }, 'POST'),
  );
}

// --- 返金と精算の設定（`UD-104` / `UD-119`）---------------------------------

/**
 * いまの設定。
 *
 * ⚠️ **未設定なら `settings` が `null`。** 既定値を作らない。作ると、
 * 決めていないのに「決まっている」ように見える。
 */
export function fetchSettlementSettings(): Promise<AdminResult<SettlementSettingsResponse>> {
  return callAdmin('/api/v1/admin/settlement-settings', settlementSettingsResponseSchema);
}

/**
 * 設定を書き換える。
 *
 * ⚠️ **オーナー限定＋再認証**（API 側で縛る）。ここで変わるのは
 * 「これから」だけで、過去の注文の返金期限も確定した精算も動かない。
 */
export function updateSettlementSettings(
  request: UpdateSettlementSettingsRequest,
): Promise<AdminResult<SettlementSettingsView>> {
  return callAdmin(
    '/api/v1/admin/settlement-settings',
    settlementSettingsSchema,
    json(request, 'PUT'),
  );
}

export function fetchAdminOrder(orderId: string): Promise<AdminResult<AdminOrderDetail>> {
  return callAdmin(`/api/v1/admin/orders/${encodeURIComponent(orderId)}`, adminOrderDetailSchema);
}

/** 注文の経過（`UD-121`）。⚠️ 古い順に並んでいる。 */
export function fetchAdminOrderTimeline(
  orderId: string,
): Promise<AdminResult<AdminOrderTimelineResponse>> {
  return callAdmin(
    `/api/v1/admin/orders/${encodeURIComponent(orderId)}/timeline`,
    adminOrderTimelineResponseSchema,
  );
}

// --- 返金（`UD-104` / `UD-120`）------------------------------------------

/** その注文の返金の記録。⚠️ 新しい順。 */
export function fetchAdminOrderRefunds(orderId: string): Promise<AdminResult<RefundListResponse>> {
  return callAdmin(
    `/api/v1/admin/orders/${encodeURIComponent(orderId)}/refunds`,
    refundListResponseSchema,
  );
}

/**
 * 返金する。
 *
 * ⚠️ **金額を渡さない。** 返すのは常に残額の全部（一部返金は自動処理
 * しない決定）。額を渡せる形にすると、桁を 1 つ多く打った操作が通る。
 *
 * ⚠️ **取り消せない。** 呼ぶ前に、画面側で必ず確認を挟むこと。
 */
export function refundAdminOrder(
  orderId: string,
  request: CreateRefundRequest,
): Promise<AdminResult<RefundResult>> {
  return callAdmin(
    `/api/v1/admin/orders/${encodeURIComponent(orderId)}/refund`,
    refundResultSchema,
    json(request, 'POST'),
  );
}

export function fetchAdminOrderNotes(
  orderId: string,
): Promise<AdminResult<AdminOrderNotesResponse>> {
  return callAdmin(
    `/api/v1/admin/orders/${encodeURIComponent(orderId)}/notes`,
    adminOrderNotesResponseSchema,
  );
}

/**
 * 対応メモを足す（`UD-121`）。
 *
 * ⚠️ **直す口も消す口もここへ足さない。** API 側に存在しない。
 * 呼び出し側だけ用意すると「画面にはあるのに動かない」操作が生まれる。
 */
export function addAdminOrderNote(
  orderId: string,
  body: string,
): Promise<AdminResult<OrderNoteView>> {
  return callAdmin(
    `/api/v1/admin/orders/${encodeURIComponent(orderId)}/notes`,
    orderNoteViewSchema,
    json({ body }, 'POST'),
  );
}

// --- 作家さまへの精算（`UD-119`）--------------------------------------------
//
// ⚠️ **金額を渡す口をここへ足さない。** API 側にも無い。合計も明細も、
//    集計が決めた値だけ。訂正は次の期間での調整として行う。

export function fetchPayouts(
  query: { readonly periodKey?: string; readonly status?: string } = {},
): Promise<AdminResult<PayoutListResponse>> {
  const params = new URLSearchParams();
  params.set('limit', '100');
  if (query.periodKey !== undefined && query.periodKey !== '') {
    params.set('periodKey', query.periodKey);
  }
  if (query.status !== undefined && query.status !== '') {
    params.set('status', query.status);
  }
  return callAdmin(`/api/v1/admin/payouts?${params.toString()}`, payoutListResponseSchema);
}

/**
 * 繰越がマイナスのまま残っている作家さま（決定 2026-08-22）。
 *
 * ⚠️ **取り立てるための一覧ではない。** 見えるようにするだけである。
 * 請求書を作る口も、金額を書き換える口もここには無い。
 */
export function fetchNegativeCarries(): Promise<AdminResult<NegativeCarryListResponse>> {
  return callAdmin('/api/v1/admin/payouts/negative-carries', negativeCarryListResponseSchema);
}

export function fetchPayout(id: string): Promise<AdminResult<PayoutDetailResponse>> {
  return callAdmin(`/api/v1/admin/payouts/${encodeURIComponent(id)}`, payoutDetailResponseSchema);
}

/**
 * 振込のために、お振込先を伏せずに読む（決定 2026-08-21）。
 *
 * ⚠️ **画面を開いたときに呼ばない。** 押されたときだけ呼ぶ。開くたびに
 * 呼ぶと、監査ログが「開いた人」で埋まり、**本当に読んだ人が埋もれる**。
 *
 * ⚠️ **返ってきた値を保存も再利用もしない。** 次に要るときは、また読む。
 */
export function fetchPayoutAccount(
  payoutId: string,
): Promise<AdminResult<AdminPayoutAccountResponse>> {
  return callAdmin(
    `/api/v1/admin/payouts/${encodeURIComponent(payoutId)}/payout-account`,
    adminPayoutAccountResponseSchema,
  );
}

/**
 * その月を締めて、作家さまごとの下書きを作る。
 *
 * ⚠️ **作家さまを指定しない。** その期間に売上か繰越のある方は API が
 * 洗い出す。指定できると、指定し忘れた方がいつまでも支払われない。
 */
export function closePayoutPeriod(
  periodKey: string,
): Promise<AdminResult<ClosePayoutPeriodResponse>> {
  return callAdmin(
    '/api/v1/admin/payouts/close',
    closePayoutPeriodResponseSchema,
    json({ periodKey }, 'POST'),
  );
}

/** ⚠️ 確定した内容は変更できない。呼ぶ前に画面で確認を挟むこと。 */
export function confirmPayout(id: string): Promise<AdminResult<PayoutViewDto>> {
  return callAdmin(`/api/v1/admin/payouts/${encodeURIComponent(id)}/confirm`, payoutSchema, {
    method: 'POST',
  });
}

/**
 * お支払い済みとして記録する。
 *
 * ⚠️ **これは「振り込んだ」という宣言であって、振込そのものではない。**
 * API 側でオーナー限定＋再認証にしてある。
 */
export function markPayoutPaid(id: string): Promise<AdminResult<PayoutViewDto>> {
  return callAdmin(`/api/v1/admin/payouts/${encodeURIComponent(id)}/mark-paid`, payoutSchema, {
    method: 'POST',
  });
}

// --- 法務文書（利用規約・プライバシーポリシー・特商法表記）------------------

/**
 * 版の一覧。下書きも含む。
 *
 * ⚠️ **削除する口をここへ足さない。** API 側に存在しない。過去の版は
 * 「その注文の時点でどう書いてあったか」を示すために残す。
 */
export function fetchLegalVersions(kind: string): Promise<AdminResult<LegalVersionListResponse>> {
  return callAdmin(
    `/api/v1/admin/legal/${encodeURIComponent(kind)}`,
    legalVersionListResponseSchema,
  );
}

export function saveLegalDraft(
  kind: string,
  request: SaveLegalDraftRequest,
): Promise<AdminResult<LegalVersionView>> {
  return callAdmin(`/api/v1/admin/legal/${encodeURIComponent(kind)}/draft`, legalVersionSchema, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
}

/**
 * 下書きを公開する。
 *
 * ⚠️ **取り消せない。** 公開した版は書き換えも削除もできず、誤りは
 * 新しい版で直す。画面側で必ず確認を挟むこと。
 */
export function publishLegalVersion(
  kind: string,
  request: PublishLegalVersionRequest,
): Promise<AdminResult<LegalVersionView>> {
  return callAdmin(
    `/api/v1/admin/legal/${encodeURIComponent(kind)}/publish`,
    legalVersionSchema,
    json(request, 'POST'),
  );
}

// --- 決済資格情報の世代（`UD-118`）----------------------------------------

/**
 * ⚠️ **鍵を返す口はない。** 取得できるのは状態と事業者アカウント識別子まで。
 * 値・先頭・末尾 4 文字のいずれも返らない（2026-08-19 決定）。
 */
export function fetchPaymentCredentials(): Promise<AdminResult<PaymentCredentialListResponse>> {
  return callAdmin('/api/v1/admin/payment-credentials', paymentCredentialListResponseSchema);
}

/**
 * 世代を登録する。
 *
 * ⚠️ **この値をどこにも残さない。** 通知にも、状態にも、ログにも。
 * 登録したあとは二度と表示できない。
 */
export function registerPaymentCredential(
  request: RegisterPaymentCredentialRequest,
): Promise<AdminResult<PaymentCredentialListResponse>> {
  return callAdmin(
    '/api/v1/admin/payment-credentials',
    paymentCredentialListResponseSchema,
    json(request, 'POST'),
  );
}

/** 接続テスト。⚠️ 有効化の前に必ず通す。 */
export function checkPaymentCredential(
  id: string,
): Promise<AdminResult<PaymentCredentialListResponse>> {
  return callAdmin(
    `/api/v1/admin/payment-credentials/${encodeURIComponent(id)}/check`,
    paymentCredentialListResponseSchema,
    { method: 'POST' },
  );
}

/** 有効化・受付切替・退役。⚠️ 本番では確認の入力が要る。 */
export function actOnPaymentCredential(
  id: string,
  action: 'activate' | 'stop-accepting' | 'resume-accepting' | 'retire',
  confirmation: string | null,
): Promise<AdminResult<PaymentCredentialListResponse>> {
  return callAdmin(
    `/api/v1/admin/payment-credentials/${encodeURIComponent(id)}/${action}`,
    paymentCredentialListResponseSchema,
    json({ confirmation }, 'POST'),
  );
}

// --- 運営ダッシュボード（P0-6） -------------------------------------------

/** 朝いちばんに見る画面。⚠️ 個人情報は返らない。 */
export function fetchOperationsDashboard(): Promise<AdminResult<OperationsDashboardResponse>> {
  return callAdmin('/api/v1/admin/operations/dashboard', operationsDashboardResponseSchema);
}

/** 記録どうしの食い違い。⚠️ 直さない。数えるだけ。 */
export function fetchConsistency(): Promise<AdminResult<ConsistencyResponse>> {
  return callAdmin('/api/v1/admin/operations/consistency', consistencyResponseSchema);
}

export interface EntitlementFilter {
  readonly status?: string;
  readonly walletDeliveryStatus?: string;
  readonly orderId?: string;
  readonly cursor?: string;
}

export function fetchEntitlements(
  filter: EntitlementFilter = {},
): Promise<AdminResult<EntitlementAdminListResponse>> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (typeof value === 'string' && value !== '') {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return callAdmin(
    `/api/v1/admin/operations/entitlements${query === '' ? '' : `?${query}`}`,
    entitlementAdminListResponseSchema,
  );
}

export function fetchEntitlement(id: string): Promise<AdminResult<EntitlementAdminDetailView>> {
  return callAdmin(
    `/api/v1/admin/operations/entitlements/${encodeURIComponent(id)}`,
    entitlementAdminDetailSchema,
  );
}

/** 発行をやり直す。⚠️ 何度押しても増えない。 */
export function retryIssuance(orderId: string): Promise<AdminResult<RetryIssuanceResponse>> {
  return callAdmin(
    `/api/v1/admin/operations/orders/${encodeURIComponent(orderId)}/retry-issuance`,
    retryIssuanceResponseSchema,
    { method: 'POST' },
  );
}

/** その方ぶんをまとめて送り直す。 */
export function redeliverForAccount(accountId: string): Promise<AdminResult<RedeliverResponse>> {
  return callAdmin(
    `/api/v1/admin/operations/accounts/${encodeURIComponent(accountId)}/redeliver`,
    redeliverResponseSchema,
    { method: 'POST' },
  );
}

/** 知らせの送信履歴（P0-4）。⚠️ 宛先は伏せた表記しか返らない。 */
export function fetchNotificationHistory(
  filter: { readonly status?: string; readonly eventType?: string; readonly cursor?: string } = {},
): Promise<AdminResult<NotificationHistoryListResponse>> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (typeof value === 'string' && value !== '') {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return callAdmin(
    `/api/v1/admin/notifications/deliveries${query === '' ? '' : `?${query}`}`,
    notificationHistoryListResponseSchema,
  );
}

/** 知らせを送り直す。⚠️ 送り直せるのは失敗したものだけ（API が断る）。 */
export function resendNotification(id: string): Promise<AdminResult<{ requeued: boolean }>> {
  return callAdmin(
    `/api/v1/admin/notifications/deliveries/${encodeURIComponent(id)}/resend`,
    resendNotificationResponseSchema,
    { method: 'POST' },
  );
}

/**
 * 知らせの再送の応答。
 *
 * ⚠️ **`{ requeued: false }` を成功として黙らせない。** 押したのに
 * 戻らなかったことを、押した人に伝える必要がある。
 */
const resendNotificationResponseSchema = z.object({ requeued: z.boolean() });

/**
 * 本番販売ガード（P0-7）。
 *
 * ⚠️ **画面を隠すことは保護ではない。** 条件未達で支払い口を作らせない
 * のは API 側の仕事で、ここは「いま何が足りないか」を見せるだけ。
 */
export function fetchProductionReadiness(): Promise<AdminResult<ProductionReadinessResponse>> {
  return callAdmin('/api/v1/admin/production/readiness', productionReadinessResponseSchema);
}

export function fetchAttestations(): Promise<AdminResult<AttestationListResponse>> {
  return callAdmin('/api/v1/admin/production/attestations', attestationListResponseSchema);
}

/**
 * 証跡を残す。
 *
 * ⚠️ **決済世代を送らない。** サーバー側でいまの世代へ紐づける。
 * 送れると、いま受付中でない世代を指す証跡を作れてしまう。
 */
export function recordAttestation(input: {
  readonly kind: string;
  readonly succeeded: boolean;
  readonly note: string | null;
}): Promise<AdminResult<{ readonly id: string }>> {
  return callAdmin(
    '/api/v1/admin/production/attestations',
    attestationCreatedSchema,
    json(input, 'POST'),
  );
}

/** メールの試し送り。⚠️ 宛先は送らない（押した本人へ届く）。 */
export function runMailCheck(): Promise<AdminResult<MailCheckResponse>> {
  return callAdmin('/api/v1/admin/production/mail-check', mailCheckResponseSchema, {
    method: 'POST',
  });
}

const attestationCreatedSchema = z.object({ id: z.string() });
// --- 顧客サポート（P1-1） -------------------------------------------------

/**
 * 顧客を探す。
 *
 * ⚠️ **`POST` で送る。** 手がかりに平文のアドレスを含むので、URL に載せると
 * アクセスログと履歴と Referer に残る。
 */
export function searchCustomers(criteria: {
  readonly email?: string;
  readonly commonUserId?: string;
  readonly orderNumber?: string;
  readonly accountId?: string;
}): Promise<AdminResult<CustomerSearchResponse>> {
  return callAdmin(
    '/api/v1/admin/customers/search',
    customerSearchResponseSchema,
    json(criteria, 'POST'),
  );
}

export function fetchCustomer(accountId: string): Promise<AdminResult<CustomerDetailResponse>> {
  return callAdmin(
    `/api/v1/admin/customers/${encodeURIComponent(accountId)}`,
    customerDetailResponseSchema,
  );
}

/**
 * ご連絡先そのものを取り寄せる（決定 2026-08-21）。
 *
 * ⚠️ **画面を開いたときに呼ばない。** 押されたときだけ呼ぶ。開くたびに
 * 呼ぶと、監査ログが「開いた人」で埋まり、**本当に読んだ人が埋もれる**。
 *
 * ⚠️ **返ってきた値を保存も再利用もしない。** サーバー側でも保存して
 * いない（`UD-503`）。次に要るときは、また取り寄せる。
 */
export function fetchCustomerEmail(accountId: string): Promise<AdminResult<CustomerEmailResponse>> {
  return callAdmin(
    `/api/v1/admin/customers/${encodeURIComponent(accountId)}/email`,
    customerEmailResponseSchema,
  );
}

/** 申し送りを書く。⚠️ 追記のみ。直す口も消す口も無い。 */
export function addCustomerNote(
  accountId: string,
  body: string,
): Promise<AdminResult<{ ok: true }>> {
  return callAdmin(
    `/api/v1/admin/customers/${encodeURIComponent(accountId)}/notes`,
    okResponseSchema,
    json({ body }, 'POST'),
  );
}

/** ご連絡先の変更を申し出として受ける。⚠️ **この操作でアドレスは変わらない。** */
export function openEmailChange(
  accountId: string,
  newEmail: string,
): Promise<AdminResult<{ id: string }>> {
  return callAdmin(
    `/api/v1/admin/customers/${encodeURIComponent(accountId)}/email-changes`,
    z.object({ id: z.string() }),
    json({ newEmail }, 'POST'),
  );
}

/** 本人確認を記録する。⚠️ 「誰が」が必ず残る。 */
export function verifyEmailChangeIdentity(
  id: string,
  method: string,
  note: string | null,
): Promise<AdminResult<{ ok: true }>> {
  return callAdmin(
    `/api/v1/admin/customers/email-changes/${encodeURIComponent(id)}/verify`,
    okResponseSchema,
    json({ method, note }, 'POST'),
  );
}

/** 決着させる。⚠️ **本人確認を飛ばして「済」にはできない**（API が断る）。 */
export function settleEmailChange(
  id: string,
  status: 'completed' | 'rejected',
  note: string | null,
): Promise<AdminResult<{ ok: true }>> {
  return callAdmin(
    `/api/v1/admin/customers/email-changes/${encodeURIComponent(id)}/settle`,
    okResponseSchema,
    json({ status, note }, 'POST'),
  );
}

const okResponseSchema = z.object({ ok: z.literal(true) });

/**
 * 運営の売上レポート（`UD-123` の一部）。
 *
 * ⚠️ **粒度以外の条件を受け取らない。** 期間は API 側が決める。画面から
 * 自由に指定できるようにすると、全期間を舐める要求を作れてしまう。
 */
export function fetchSalesReport(
  granularity: 'daily' | 'monthly',
): Promise<AdminResult<SalesReportResponse>> {
  return callAdmin(
    `/api/v1/admin/sales-report?granularity=${granularity}`,
    salesReportResponseSchema,
  );
}

/** 作家さまの一覧（`UD-124` の一部）。⚠️ お振込先の値は返ってこない。 */
export function fetchCreatorDirectory(
  keyword: string,
): Promise<AdminResult<CreatorDirectoryResponse>> {
  const params = new URLSearchParams();
  if (keyword !== '') {
    params.set('keyword', keyword);
  }
  const query = params.toString();
  return callAdmin(
    `/api/v1/admin/creators${query === '' ? '' : `?${query}`}`,
    creatorDirectoryResponseSchema,
  );
}

export function fetchCreatorDetail(
  accountId: string,
): Promise<AdminResult<CreatorDirectoryDetailResponse>> {
  return callAdmin(
    `/api/v1/admin/creators/${encodeURIComponent(accountId)}`,
    creatorDirectoryDetailResponseSchema,
  );
}

/**
 * 売上レポートの CSV を受け取る。
 *
 * ⚠️ **`callAdmin` を通さない。** あちらは JSON を読む。CSV は本文を
 * そのまま渡す（route handler がダウンロードとして返す）。
 *
 * ⚠️ **本文を画面へ埋め込まない。** 受け取ったものを、そのまま渡す。
 */
export async function fetchSalesReportCsv(
  granularity: 'daily' | 'monthly',
): Promise<AdminResult<{ body: string }>> {
  const tokens = await credentials();
  if (tokens.length === 0) {
    return { ok: false, reason: 'unauthorized', message: '運営用の資格情報が設定されていません。' };
  }

  const { WEB_API_BASE_URL } = getWebEnv();
  let lastReason: 'unauthorized' | 'not_found' | 'rejected' | 'unavailable' = 'unauthorized';

  for (const token of tokens) {
    let response: Response;
    try {
      response = await fetch(
        `${WEB_API_BASE_URL}/api/v1/admin/sales-report/csv?granularity=${granularity}`,
        {
          headers: { authorization: `Bearer ${token}`, accept: 'text/csv' },
          cache: 'no-store',
        },
      );
    } catch {
      return { ok: false, reason: 'unavailable' };
    }

    if (!response.ok) {
      lastReason = reasonFor(response.status);
      // 断られたときだけ次の資格情報を試す。それ以外は理由が変わらない。
      if (lastReason === 'unauthorized') {
        continue;
      }
      return { ok: false, reason: lastReason };
    }

    return { ok: true, data: { body: await response.text() } };
  }

  return { ok: false, reason: lastReason };
}
