import { PageHeader } from '@sengoku/ui';
import { CREATOR_COPY } from '../../../../src/creator-copy';
import { NewArtworkForm } from './form';

export default function NewArtworkPage() {
  return (
    <>
      <PageHeader title={CREATOR_COPY.newTitle} description={CREATOR_COPY.newDescription} />
      <NewArtworkForm />
      <p>
        <a href="/creator">{CREATOR_COPY.backToList}</a>
      </p>
    </>
  );
}
