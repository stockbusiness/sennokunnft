'use client';

import { useActionState } from 'react';
import { Notice } from '@sengoku/ui';
import {
  RESERVED_COUNT_REPAIR_REASON_MIN_LENGTH,
  RESERVED_COUNT_REPAIR_RESOLUTION_MIN_LENGTH,
} from '@sengoku/contracts';
import { repairReservedCountAction, resolveReservedCountRepairAction } from './actions';
import type { AdminActionState } from '../actions';

const INITIAL: AdminActionState = {};

/**
 * 押さえのずれを 1 件だけ直す（`ADMIN_OPERATIONS_GAP.md` §I・2026-08-24）。
 *
 * ⚠️ **文字数の下限は `@sengoku/contracts` から読む。** 画面側で別に
 * 持つと、**画面は通すのにサーバーが弾く**という一番わかりにくい形になる。
 *
 * ⚠️ **直す先の数を入力させない。** 送るのは「画面が見ていた数」だけで、
 * 直す先はサーバーが仮引当と受取権から計算で出す。
 *
 * ⚠️ **原因が分かっているかを、既定で「分かっている」にしない。** 既定を
 * 楽なほうに置くと、急いでいる人がそのまま押して**積み残しが残らない。**
 */
export function RepairReservedCountForm({
  artworkId,
  observedReservedCount,
  expectedReservedCount,
}: {
  readonly artworkId: string;
  readonly observedReservedCount: number;
  readonly expectedReservedCount: number;
}) {
  const [state, action, pending] = useActionState(repairReservedCountAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined ? null : (
        <Notice tone="info" title={state.notice} hint={state.noticeHint ?? ''} />
      )}

      <input type="hidden" name="artworkId" value={artworkId} />
      {/*
        ⚠️ **これが要の歯止め。** 画面を開いてから押すまでにご注文が
           入っていたら、サーバーがこの値との食い違いで気づいて断る。
      */}
      <input type="hidden" name="observedReservedCount" value={String(observedReservedCount)} />

      <p className="sengoku-form__hint">
        お取り置きの数を <strong>{String(observedReservedCount)}</strong> から{' '}
        <strong>{String(expectedReservedCount)}</strong> へ直します。
        数はご注文の記録から数え直したもので、手で決めることはできません。
      </p>

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor={`reason-${artworkId}`}>
          なぜ直すのか（{String(RESERVED_COUNT_REPAIR_REASON_MIN_LENGTH)} 文字以上）
        </label>
        <textarea
          className="sengoku-form__input"
          id={`reason-${artworkId}`}
          name="reason"
          rows={3}
          minLength={RESERVED_COUNT_REPAIR_REASON_MIN_LENGTH}
          required
        />
        <p className="sengoku-form__hint">
          あとから読む方が、原因を追う手がかりにします。分かっていることをそのまま書いてください。
        </p>
      </div>

      <div className="sengoku-form__field">
        <span className="sengoku-form__label">原因は分かっていますか</span>
        <label className="sengoku-radio">
          <input type="radio" name="causeState" value="unknown" defaultChecked />
          <span>まだ分かっていない（先に直す）</span>
        </label>
        <label className="sengoku-radio">
          <input type="radio" name="causeState" value="identified" />
          <span>分かっている</span>
        </label>
        <p className="sengoku-form__hint">
          {/*
            ⚠️ **「分かっていない」を選んでも押せることを、隠さずに書く。**
               押さえが足りない側はいま売り越しが起きうる状態で、原因究明が
               済むまで待たせるほうが危ない。そのかわり残ることを伝える。
          */}
          分かっていない場合も直せます。ただし「原因が分からないまま直した記録」に残り続け、
          原因が分かって閉じるまで管理画面に出続けます。
        </p>
      </div>

      <button className="sengoku-button" type="submit" disabled={pending}>
        {pending ? '直しています…' : 'この作品のお取り置きの数を直す'}
      </button>
    </form>
  );
}

/**
 * 原因未特定の積み残しを閉じる。
 *
 * ⚠️ **消す操作ではない。** 直したときの数と内訳は残る。閉じるのは
 * 「原因が分かった」と言うことなので、何が分かったのかを必ず書かせる。
 */
export function ResolveReservedCountRepairForm({ repairId }: { readonly repairId: string }) {
  const [state, action, pending] = useActionState(resolveReservedCountRepairAction, INITIAL);
  return (
    <form className="sengoku-form" action={action}>
      {state.error === undefined ? null : <Notice tone="alert" title={state.error} />}
      {state.notice === undefined ? null : (
        <Notice tone="info" title={state.notice} hint={state.noticeHint ?? ''} />
      )}

      <input type="hidden" name="repairId" value={repairId} />

      <div className="sengoku-form__field">
        <label className="sengoku-form__label" htmlFor={`note-${repairId}`}>
          何が原因でしたか（{String(RESERVED_COUNT_REPAIR_RESOLUTION_MIN_LENGTH)} 文字以上）
        </label>
        <textarea
          className="sengoku-form__input"
          id={`note-${repairId}`}
          name="note"
          rows={3}
          minLength={RESERVED_COUNT_REPAIR_RESOLUTION_MIN_LENGTH}
          required
        />
        <p className="sengoku-form__hint">
          書けない場合は、まだ閉じるときではありません。分かるまで残しておいてください。
        </p>
      </div>

      <button className="sengoku-button sengoku-button--quiet" type="submit" disabled={pending}>
        {pending ? '閉じています…' : '原因が分かったものとして閉じる'}
      </button>
    </form>
  );
}
