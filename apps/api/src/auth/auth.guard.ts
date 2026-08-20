import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  ANONYMOUS,
  canAtRoleLevel,
  type AccountLookupPort,
  type Action,
  type Actor,
  type TokenVerifierPort,
} from '@sengoku/auth';
import type { ClockPort, EmailHashPort } from '@sengoku/domain';

export const PUBLIC_KEY = 'sengoku:public';
export const REQUIRED_ACTION_KEY = 'sengoku:required-action';
export const FRESH_AUTH_KEY = 'sengoku:fresh-auth';

/**
 * 再認証の有効時間（`UD-118` 決定 2026-08-19）。
 *
 * ⚠️ **パスワードを再入力させない。** 認証は Supabase 側にあり、こちらで
 * パスワードを受け取る経路を作るべきではない。「最近ログインし直したか」
 * をトークンの発行時刻で見る。
 */
export const FRESH_AUTH_WINDOW_MS = 5 * 60 * 1000;

/**
 * 取り返しのつかない操作の前に、最近の認証を求める（`UD-118`）。
 *
 * ⚠️ **権限の代わりにしない。** 新しいトークンであることは、権限が
 * あることを意味しない。`RequireAction` と併せて使う。
 */
export const RequireFreshAuth = (): MethodDecorator & ClassDecorator =>
  SetMetadata(FRESH_AUTH_KEY, true);

/**
 * 認証を要求しないエンドポイントの印。
 *
 * ⚠️ **既定は deny。** 印が無いエンドポイントは認証を要求する。
 * 「印を付け忘れたら公開されてしまう」ではなく
 * 「付け忘れたら閉じる」向きにしてある（AUTHORIZATION_DESIGN.md §2.2）。
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

/** そのエンドポイントを呼ぶのに必要な操作。 */
export const RequireAction = (action: Action): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_ACTION_KEY, action);

export interface AuthenticatedRequest extends Request {
  actor?: Actor;
  /**
   * 認証プロバイダが確認済みのメールアドレス（`UD-803`）。
   *
   * ⚠️ **`Actor` へ入れない。** `Actor` は認可判定に渡る値なので、
   * そこにアドレスがあると、いつか誰かが「このドメインの人は運営」
   * のような判定を書く。権限の根拠になりうる場所へ置かない。
   * ここに置いてよい用途は、招待の宛先との突き合わせだけ。
   */
  verifiedEmail?: string;
  /**
   * トークンの発行時刻（`UD-118` の再認証）。
   *
   * ⚠️ **`Actor` へ入れない。** 認可判定に渡る値へ混ぜると、いつか
   * 「新しいトークンなら権限あり」という判定が書かれる。
   */
  tokenIssuedAt?: Date;
}

/** ハンドラの引数として現在のアクターを受け取る。 */
export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Actor => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.actor ?? ANONYMOUS;
  },
);

/**
 * 確認済みのメールアドレスを受け取る（`UD-803`）。
 *
 * ⚠️ **認可に使わない。** 使ってよいのは招待の宛先との突き合わせだけ。
 */
export const CurrentVerifiedEmail = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().verifiedEmail,
);

/**
 * 認証と、ロールに対する認可を行う。
 *
 * ここでやるのは 2 段目まで（AUTHORIZATION_DESIGN.md §2.2）。
 * 3 段目の所有権チェックは、対象リソースを読み込まないと判定できないので
 * 各ハンドラ側で行う。ガードだけで済ませると、他人のIDを指定して
 * 読める脆弱性（IDOR）が残る。
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenVerifier: TokenVerifierPort,
    private readonly accounts: AccountLookupPort,
    /**
     * ⚠️ **`Date.now()` を直に呼ばない。** 再認証の判定に現在時刻が要るが、
     * 直に読むと試験で時刻を動かせず、「いつでも古い」か「いつでも新しい」
     * かのどちらかしか試せない。
     */
    private readonly clock: ClockPort,
    /**
     * 照合用のメール値を作る口（`UD-121`）。
     *
     * ⚠️ **平文をここから先へ持ち出さない。** 変換した値だけをアカウントへ
     * 残す。鍵の無い配備では `null` が返り、照合値は付かない（`UD-503`）。
     */
    private readonly emailHasher: EmailHashPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets) ?? false;
    const requiredAction = this.reflector.getAllAndOverride<Action | undefined>(
      REQUIRED_ACTION_KEY,
      targets,
    );
    const needsFreshAuth =
      this.reflector.getAllAndOverride<boolean>(FRESH_AUTH_KEY, targets) ?? false;

    const actor = await this.resolveActor(request, isPublic);
    request.actor = actor;

    if (isPublic && requiredAction === undefined) {
      return true;
    }

    if (requiredAction === undefined) {
      // 必要な操作を宣言していないエンドポイントは通さない。
      // 宣言漏れが「誰でも通る」ではなく「誰も通らない」に倒れるようにする。
      throw new ForbiddenException('required action is not declared for this endpoint');
    }

    // ⚠️ 所有権（3 段目）はここで見ない。対象を読み込む前なので所有者が
    //    分からず、`can()` を対象なしで呼ぶと所有権の要る操作が常に拒否になる。
    //    **所有権は対象を読み込んだハンドラ側で必ず確かめること。**
    const decision = canAtRoleLevel(actor, requiredAction);
    if (!decision.allowed) {
      if (decision.reason === 'unauthenticated') {
        throw new UnauthorizedException();
      }
      throw new ForbiddenException();
    }

    /*
      ⚠️ **認可のあとに見る。** 先に見ると、権限の無い人へ
         「ログインし直してください」と案内してしまう。
      ⚠️ **401 で返す。** 403 だと「権限が無い」と読まれ、ログインし直せば
         通ることが伝わらない。
    */
    if (needsFreshAuth && !this.isFreshlyAuthenticated(request)) {
      throw new UnauthorizedException('re-authentication required');
    }
    return true;
  }

  /**
   * 最近ログインし直したか。
   *
   * ⚠️ **発行時刻が分からなければ通さない。** 「無いから通す」にすると、
   * `iat` を落としたトークンで再認証を素通りできる。
   */
  private isFreshlyAuthenticated(request: AuthenticatedRequest): boolean {
    const issuedAt = request.tokenIssuedAt;
    if (issuedAt === undefined) {
      return false;
    }
    const age = this.clock.now().getTime() - issuedAt.getTime();
    // ⚠️ 未来に発行されたトークンも通さない（時計のずれを装った引き延ばし）。
    return age >= 0 && age <= FRESH_AUTH_WINDOW_MS;
  }

  private async resolveActor(request: AuthenticatedRequest, isPublic: boolean): Promise<Actor> {
    // ⚠️ 毎回消してから始める。前の要求の値が残ると、別人の宛先で
    //    招待を引き取れてしまう（同じ request が再利用されることは無いが、
    //    ここを暗黙の前提にしない）。
    request.verifiedEmail = undefined;
    request.tokenIssuedAt = undefined;
    const token = extractBearerToken(request.headers.authorization);
    if (token === null) {
      if (isPublic) {
        return ANONYMOUS;
      }
      throw new UnauthorizedException();
    }

    const verified = await this.tokenVerifier.verify(token);
    if (!verified.ok) {
      // ⚠️ 失敗理由を応答に含めない。どのクレームで落ちたかを教えると
      //    トークン偽造の手掛かりになる。
      if (isPublic) {
        return ANONYMOUS;
      }
      throw new UnauthorizedException();
    }

    const { provider, subject } = verified.identity;
    // 招待の突き合わせにだけ使う。認可には渡さない（`AuthenticatedRequest` 参照）。
    request.verifiedEmail = verified.identity.email;
    request.tokenIssuedAt = verified.identity.issuedAt;
    // ⚠️ ここで平文から照合値へ変換し、以後は平文を触らない（`UD-121`）。
    const emailHash =
      verified.identity.email === undefined ? null : this.emailHasher.hash(verified.identity.email);
    const existing = await this.accounts.findByAuthSubject(provider, subject);
    // 初回アクセスならここで作る。作られるロールは常に buyer。
    const account = existing ?? (await this.accounts.provision(provider, subject, emailHash));
    // ⚠️ **変わったときだけ書く。** 毎回書くと、読むだけの要求まで
    //    書き込みになり、負荷も監査も膨らむ。
    //    ⚠️ 消さない側へ倒す（`rememberEmailHash` の注記）。
    if (emailHash !== null && account.emailHash !== emailHash) {
      await this.accounts.rememberEmailHash(account.id, emailHash);
    }

    return {
      // ロールは DB の値。トークンのクレームは使わない。
      role: account.role,
      accountId: account.id,
      isActive: account.status === 'active',
      // 人事の印も DB の値（`UD-803`）。ここもトークンから読まない。
      isOwner: account.isOwner,
    };
  }
}

/** `Authorization: Bearer <token>` からトークンを取り出す。 */
export function extractBearerToken(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || value === undefined || value.length === 0) {
    return null;
  }
  return value;
}
