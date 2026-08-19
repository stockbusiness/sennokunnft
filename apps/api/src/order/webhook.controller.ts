import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/auth.guard';
import { PaymentWebhookService } from './webhook.service';

/** `rawBody: true` で起動したときに Express の要求へ生えるフィールド。 */
type RawBodyRequest = Request & { readonly rawBody?: Buffer };

/**
 * 決済事業者からの知らせを受ける口（指示書 §5.4）。
 *
 * ⚠️ **`@Public()` を付けているが、誰でも通るわけではない。** 通すのは
 * 署名が合う知らせだけ。ログインを要求しないのは、送ってくるのが
 * 人ではなく決済事業者だから（指示書 §5.4）。
 *
 * ⚠️ **この経路は、鍵が設定されていない環境では生えない。** 「鍵が無ければ
 * 素通し」にすると、誰でも「決済成功」を送れる口ができる。
 */
@Controller('api/v1/webhooks')
export class PaymentWebhookController {
  constructor(private readonly webhooks: PaymentWebhookService) {}

  @Post('stripe')
  @Public()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() request: RawBodyRequest,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ readonly received: true }> {
    /*
      ⚠️ **生のバイト列を使う。** `@Body()` の解釈済みオブジェクトを
         組み直したものでは、空白や鍵の順序が変わって署名が合わない。
         合わせるために署名検証を緩めると、誰でも決済成功を送れる。
    */
    const rawBody = request.rawBody;
    if (rawBody === undefined) {
      // 起動時に `rawBody: true` を外すとここへ来る。黙って通さない。
      throw new BadRequestException();
    }

    const accepted = await this.webhooks.handle(rawBody, signature);
    if (!accepted) {
      // ⚠️ 理由を返さない。「署名が古い」と「署名が違う」を区別すると、
      //    総当たりの手がかりになる。
      throw new BadRequestException();
    }

    /*
      ⚠️ **処理できなかったときも 200。** 署名さえ正しければ受け取った
         事実は残っている。4xx/5xx を返すと事業者が再送し続け、
         いずれ宛先ごと無効化される。
    */
    return { received: true };
  }
}
