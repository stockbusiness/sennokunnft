import { PageHeader } from '@sengoku/ui';
import { LOGIN_COPY } from '../../src/auth/copy';
import { LoginForm } from './form';

/**
 * ログイン画面。
 *
 * ⚠️ **合言葉の門の内側にある。** 門は「関係者以外を入れない」ためのもので、
 * これは「誰が操作しているか」を決めるためのもの。役割が違うので両方要る。
 *
 * ⚠️ **検索に出さない。**
 */
export const dynamic = 'force-dynamic';

export const metadata = { robots: { index: false, follow: false } };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; expired?: string }>;
}) {
  const params = await searchParams;
  return (
    <>
      <PageHeader title={LOGIN_COPY.title} description={LOGIN_COPY.description} />
      <LoginForm next={params.next ?? '/creator'} expired={params.expired === '1'} />
    </>
  );
}
