import type { StaffInvitationView, StaffMemberView } from '@sengoku/contracts';

/**
 * スタッフ管理の文言（`UD-803`）。
 *
 * ⚠️ **「オーナー」と「運営」を言い分ける。** 同じ言葉にすると、
 * 人事を配れる人とそうでない人の区別が画面から消える。
 */
export const STAFF_COPY = {
  title: 'スタッフの管理',
  description:
    '運営を手伝う方を招待し、できることを決めます。招待すると、その宛先にログイン用のメールをお送りします。',

  membersHeading: 'いまのスタッフ',
  invitationsHeading: '招待の状況',
  inviteHeading: 'スタッフを招待する',

  fieldEmail: '招待する方のメールアドレス',
  fieldEmailHint:
    'この宛先にログイン用のメールをお送りします。そのメールから入っていただくと、スタッフになります。',
  fieldRole: 'お任せすること',
  fieldRoleHint: 'あとから変更できます。',
  submitInvite: 'この内容で招待する',

  noMembers: 'まだスタッフがいません',
  noMembersHint: '下の欄から招待してください。',
  noInvitations: '送った招待はありません',
  noInvitationsHint: '',

  columnEmail: 'メールアドレス',
  columnRole: 'できること',
  columnStatus: '状態',
  columnActions: ' ',
  columnExpires: '期限',

  submitRevoke: '招待を取り消す',
  submitSuspend: '一時的に止める',
  submitResume: '元に戻す',
  submitRemove: 'スタッフから外す',
  submitMakeOwner: 'オーナーにする',

  emailUnknown: '（未登録）',

  /**
   * ⚠️ **自分の行では操作を出さない。** 押しても必ず断られる。
   * 押せるが何も起きないものを置かない。
   */
  selfNote: 'ご自身の権限は、この画面からは変更できません',
  selfNoteHint:
    '押し間違いでご自身を締め出さないためです。変更が必要なときは、ほかのオーナーにお願いしてください。',

  lastOwnerNote: 'オーナーはいつも 1 名以上必要です',
  lastOwnerHint:
    'オーナーが居なくなると、以後どなたも権限を変更できなくなります。交代するときは、先に新しいオーナーを立ててください。',

  ownerBadge: 'オーナー',

  /**
   * 招待したあとに出す言葉。
   *
   * ⚠️ **「送りました」と「記録しました」を言い分ける。** メールが
   * 出ていないのに送ったと伝えると、相手が来ないことに気づけない。
   */
  inviteSent: (email: string): string => `${email} にログイン用のメールをお送りしました`,
  inviteMailFailed: (email: string): string =>
    `招待は登録しましたが、${email} へメールをお送りできませんでした。少し時間をおいて招待を取り消し、もう一度お送りいただくか、下のご案内を直接お伝えください。`,
  inviteMailDisabled: (email: string): string =>
    `招待を登録しました。メールの送信が有効になっていないため、${email} の方へ下のご案内を直接お伝えください。`,
  /** 送れなかったときに、運営が相手へ伝える内容。 */
  inviteManualHint:
    'ログイン画面（/login）を開いて、招待した宛先のメールアドレスを入れてログインしてください。そのままスタッフになります。',
} as const;

export function memberRoleLabel(role: StaffMemberView['role']): string {
  switch (role) {
    case 'operator':
      return '運営（作品と販売を扱えます）';
    case 'auditor':
      return '閲覧のみ（見るだけです）';
    case 'buyer':
      return '会員';
  }
}

export function invitationRoleLabel(role: StaffInvitationView['role']): string {
  return role === 'operator' ? '運営' : '閲覧のみ';
}

export function memberStatusLabel(status: StaffMemberView['status']): string {
  return status === 'active' ? '利用中' : '停止中';
}

/**
 * 招待の状態。
 *
 * ⚠️ **`status` だけで判断しない。** 期限を過ぎた `pending` は、
 * まだ生きているように見えてしまう。API が計算した `isOpen` を使う。
 */
export function invitationStatusLabel(invitation: StaffInvitationView): string {
  if (invitation.status === 'accepted') {
    return '参加済み';
  }
  if (invitation.status === 'revoked') {
    return '取り消し済み';
  }
  if (!invitation.isOpen) {
    return '期限切れ';
  }
  return 'お返事待ち';
}

/** 日付だけを和暦を使わずに出す。時刻まで出すと運営が読む情報が増える。 */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
