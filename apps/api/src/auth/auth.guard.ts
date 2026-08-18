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

export const PUBLIC_KEY = 'sengoku:public';
export const REQUIRED_ACTION_KEY = 'sengoku:required-action';

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
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets) ?? false;
    const requiredAction = this.reflector.getAllAndOverride<Action | undefined>(
      REQUIRED_ACTION_KEY,
      targets,
    );

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
    return true;
  }

  private async resolveActor(request: AuthenticatedRequest, isPublic: boolean): Promise<Actor> {
    // ⚠️ 毎回消してから始める。前の要求の値が残ると、別人の宛先で
    //    招待を引き取れてしまう（同じ request が再利用されることは無いが、
    //    ここを暗黙の前提にしない）。
    request.verifiedEmail = undefined;
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
    const existing = await this.accounts.findByAuthSubject(provider, subject);
    // 初回アクセスならここで作る。作られるロールは常に buyer。
    const account = existing ?? (await this.accounts.provision(provider, subject));

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
